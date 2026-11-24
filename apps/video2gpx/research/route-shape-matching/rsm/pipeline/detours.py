# SPDX-License-Identifier: AGPL-3.0-or-later
"""Skipped spans: parts of the video that are not part of the route. They are held at 0 km/h in the result, so a player that follows the GPX
(Incyclist, ridrs Scenic) passes over them.

Two kinds:
  detour  the decoded path leaves a junction, comes back to the SAME graph node after DETOUR_MIN_M..DETOUR_MAX_M of road and DETOUR_MIN_S..DETOUR_MAX_S
          video seconds, and then goes on in the direction it came from (not back the way it came: that is a turnaround, part of the route). A spur to a
          viewpoint or a parking place and back, a loop round a block or a roundabout, turning in a car park. The odometry has to agree: its own heading
          turns round by at least DETOUR_ODO_TURN_DEG inside the excursion (a U-turn or a loop). A decoder wiggle into a side road and back on a straight
          drive has no such turn in the video and stays as it is.
          The excursion is cut out of the path (sg, xy and every per-metre array) and the position is held at the junction from the moment the path
          leaves it until it is back there.
  insert  a shot between two scene cuts that is not riding (cuts.plan `inserted`: shorter than CUT_MIN_PIECE_S, or up to PANO_MAX_S when the road scene
          after it continues the one before it: a panorama or drone shot cut into the drive). The position is held from the first cut to the second;
          the cut jump after it stays.
Both kinds are written as sure standstills of the result (still_*, in_still, with still_kind), so the GPX, route_points.json and the Scenic payload carry
them like any standstill.
"""
from __future__ import annotations

import numpy as np

from . import config as C

KIND = {"standstill": 0, "insert": 1, "detour": 2}
KIND_NAME = {v: k for k, v in KIND.items()}


def node_visits(edge_u, edge_v, occ, start):
    """the graph nodes the path passes, in order -> (arc, node, edge in, edge out, piece). edge in / out: -1 at the path ends and at a disconnected
    cut seam (piece counts the connected pieces, so no excursion is searched across a seam)"""
    occ = np.asarray(occ, np.int64)
    u, v = np.asarray(edge_u)[occ], np.asarray(edge_v)[occ]
    conn = np.r_[True, v[:-1] == u[1:]]
    piece = np.cumsum(~conn)
    arc = np.r_[np.asarray(start, float)[:len(occ)], float(start[len(occ)])]
    node = np.r_[u, v[-1]]
    ein = np.r_[-1, occ[:-1]]
    ein[:len(occ)][~conn] = -1
    eout = np.r_[occ, -1]
    eout[:-1][np.r_[~conn[1:], False]] = -1
    return arc, node.astype(np.int64), ein, eout, np.r_[piece, piece[-1]]


def _reverse(edge_u, edge_v, a: int, b: int) -> bool:
    """edge b runs back along edge a (u/v swapped): leaving that way is a turnaround"""
    return a >= 0 and b >= 0 and (a == b or (edge_u[b] == edge_v[a] and edge_v[b] == edge_u[a]))


def cross_time(t: np.ndarray, s: np.ndarray, a: float) -> float:
    """first time the arc s(t) (made monotone) reaches a, linear between the samples; nan if never"""
    sm = np.maximum.accumulate(np.asarray(s, float))
    i = int(np.searchsorted(sm, a, side="left"))
    if i >= len(sm):
        return float("nan")
    if i == 0 or sm[i] <= sm[i - 1]:
        return float(t[i])
    f = (a - sm[i - 1]) / (sm[i] - sm[i - 1])
    return float(t[i - 1] + f * (t[i] - t[i - 1]))


def odo_turn_deg(st_t, st_dth, t0: float, t1: float) -> float:
    """range of the odometry heading (cumulated raw dth of the steps, no emission = 0) between t0 and t1, degrees"""
    t = np.asarray(st_t, float)
    m = (t > t0) & (t <= t1)
    if not m.any():
        return 0.0
    c = np.cumsum(np.nan_to_num(np.asarray(st_dth, float)[m]))
    c = np.r_[0.0, c]
    return float(np.degrees(c.max() - c.min()))


def find(edge_u, edge_v, occ, start, t, s, st_t, st_dth, *, min_m=None, max_m=None, min_s=None, max_s=None, odo_turn=None) -> list[dict]:
    """detours of a decoded path (module doc). occ / start: the path's edge occurrences and their start arcs (rsm.refine.pathctx.Path);
    t, s: the fused arc over video time; st_t, st_dth: the odometry steps. -> [{t0, t1, s0, s1, length_m, node, odo_turn_deg}] in time order,
    non-overlapping (an excursion inside a longer one is part of it)"""
    min_m = C.DETOUR_MIN_M if min_m is None else min_m
    max_m = C.DETOUR_MAX_M if max_m is None else max_m
    min_s = C.DETOUR_MIN_S if min_s is None else min_s
    max_s = C.DETOUR_MAX_S if max_s is None else max_s
    odo_turn = C.DETOUR_ODO_TURN_DEG if odo_turn is None else odo_turn
    if len(occ) < 2:
        return []
    arc, node, ein, eout, piece = node_visits(edge_u, edge_v, occ, start)
    t, s = np.asarray(t, float), np.asarray(s, float)
    s_lo, s_hi = float(np.nanmin(s)), float(np.nanmax(s))
    order = np.argsort(node, kind="stable")
    ns = node[order]
    bounds = np.flatnonzero(np.r_[True, ns[1:] != ns[:-1], True])
    cands = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a < 2:
            continue
        vis = order[a:b]                                     # visits of one node, in path order (stable sort of an increasing index)
        for x in range(len(vis)):
            p = vis[x]
            for y in range(x + 1, len(vis)):
                q = vis[y]
                L = arc[q] - arc[p]
                if L > max_m:
                    break
                if L < min_m or piece[p] != piece[q] or ein[p] < 0 or eout[q] < 0:
                    continue
                if _reverse(edge_u, edge_v, int(ein[p]), int(eout[q])):
                    continue                                 # back the way it came: a turnaround, not a detour
                if arc[p] < s_lo or arc[q] > s_hi:
                    continue                                 # outside the decoded part
                cands.append((float(L), float(arc[p]), float(arc[q]), int(node[p])))
    out: list[dict] = []
    for L, sa, sb, n in sorted(cands, reverse=True):         # the longest first: an excursion inside a longer one is part of it
        if any(sa < x["s1"] and sb > x["s0"] for x in out):
            continue
        ta, tb = cross_time(t, s, sa), cross_time(t, s, sb)
        if not (np.isfinite(ta) and np.isfinite(tb)) or not (min_s <= tb - ta <= max_s):
            continue
        turn = odo_turn_deg(st_t, st_dth, ta, tb)
        if turn < odo_turn:
            continue                                         # the video does not turn round: a decoder wiggle, not a detour
        out.append(dict(t0=ta, t1=tb, s0=sa, s1=sb, length_m=L, node=n, odo_turn_deg=turn))
    return sorted(out, key=lambda x: x["t0"])


def excise(sg: np.ndarray, per_m: dict, spans: list[tuple[float, float]]) -> tuple[np.ndarray, dict, list[float]]:
    """the path without the arcs [s0, s1) of the spans: every per-metre array (same length as sg) loses those samples and the arc after a span moves
    back by its length -> (sg, per_m, shift of every span in metres)"""
    sg = np.asarray(sg, float)
    keep = np.ones(len(sg), bool)
    shifts = []
    for s0, s1 in spans:
        ia, ib = int(np.searchsorted(sg, s0 - 1e-6)), int(np.searchsorted(sg, s1 - 1e-6))
        shifts.append(float(sg[ib] - sg[ia]) if ib < len(sg) and ib > ia else 0.0)
        keep[ia:ib] = False
    new = sg.copy()
    for (s0, s1), sh in zip(spans, shifts):
        new[sg >= s1 - 1e-6] -= sh
    return new[keep], {k: np.asarray(v)[keep] for k, v in per_m.items()}, shifts


def remap(s: np.ndarray, spans: list[tuple[float, float]], shifts: list[float]) -> np.ndarray:
    """an arc of the old path on the path without the spans: inside a span the junction (its start), after it moved back by the shifts before it"""
    s = np.asarray(s, float)
    out = s.copy()
    for (s0, s1), sh in zip(spans, shifts):
        out = np.where((s > s0) & (s < s1), out - (s - s0), out)
        out = np.where(s >= s1, out - sh, out)
    return out


def merge_spans(spans: list[tuple[float, float]], kinds: list[int]) -> tuple[list[tuple[float, float]], list[int]]:
    """time spans of several kinds sorted and merged where they overlap (the merged span keeps the kind of the longest part)"""
    items = sorted(zip(spans, kinds), key=lambda x: x[0][0])
    out_s: list[list[float]] = []
    out_k: list[int] = []
    best: list[float] = []
    for (a, b), k in items:
        if out_s and a <= out_s[-1][1] + 1e-9:
            if b - a > best[-1]:
                out_k[-1], best[-1] = k, b - a
            out_s[-1][1] = max(out_s[-1][1], b)
        else:
            out_s.append([a, b]); out_k.append(k); best.append(b - a)
    return [(float(a), float(b)) for a, b in out_s], out_k
