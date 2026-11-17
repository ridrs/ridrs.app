# SPDX-License-Identifier: AGPL-3.0-or-later
"""Map-match the GPS track to the directed OSM graph (truth for scoring; never used by the matcher).

Method (simple, robust): the track is resampled every STEP m of arc length; candidates of a sample are the directed edges with a point
within RADIUS m whose local direction is within MAX_DEG of the GPS heading (so the travel direction is resolved); Viterbi over the samples:
emission = squared distance / (2 sigma^2); transition = 0 if on the same edge moving forward, else |network distance over <= 3 edges - step| / 25
for connected edges, JUMP_COST for anything else (counted as a failure). Failures are reported: samples without any candidate (off the
graph or outside the area) and jumps.
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from rsm.network.graph import NetGraph

STEP = 20.0
RADIUS = 40.0
MAX_DEG = 60.0
SIGMA = 15.0
JUMP_COST = 8.0


class EdgeIndex:
    """KD-tree over edge points densified every 5 m: (edge, offset, direction)."""

    def __init__(self, g: NetGraph, dens: float = 5.0):
        pts, eid, off, hd = [], [], [], []
        for e in range(g.n_edges):
            p = g.geom(e)
            d = np.hypot(*np.diff(p, axis=0).T)
            c = np.concatenate([[0], np.cumsum(d)])
            s = np.unique(np.concatenate([np.arange(0, c[-1], dens), [c[-1]]]))
            x, y = np.interp(s, c, p[:, 0]), np.interp(s, c, p[:, 1])
            k = np.clip(np.searchsorted(c, s, side="right") - 1, 0, len(d) - 1)
            h = np.arctan2(p[k + 1, 1] - p[k, 1], p[k + 1, 0] - p[k, 0])
            pts.append(np.column_stack([x, y])); eid.append(np.full(len(s), e, np.int32)); off.append(s); hd.append(h)
        self.pts, self.eid, self.off, self.hd = np.vstack(pts), np.concatenate(eid), np.concatenate(off), np.concatenate(hd)
        self.tree = cKDTree(self.pts)
        self.g = g
        self.out = g.out_edges()

    def candidates(self, xy: np.ndarray, heading: float):
        idx = self.tree.query_ball_point(xy, RADIUS)
        best: dict[int, tuple[float, float]] = {}
        for i in idx:
            dh = abs((self.hd[i] - heading + np.pi) % (2 * np.pi) - np.pi)
            if np.degrees(dh) > MAX_DEG:
                continue
            d = float(np.hypot(*(self.pts[i] - xy)))
            e = int(self.eid[i])
            if e not in best or d < best[e][0]:
                best[e] = (d, float(self.off[i]))
        return [(e, o, d) for e, (d, o) in best.items()]


def _net_dist(ix: EdgeIndex, e1: int, o1: float, e2: int, o2: float, maxd: float = 200.0):
    """Distance from (e1,o1) forward to (e2,o2) over <= 3 edges, else None."""
    g = ix.g
    if e1 == e2:
        return o2 - o1 if o2 >= o1 - 8.0 else None
    frontier = [(int(g.edge_v[e1]), float(g.edge_len[e1]) - o1, 0)]
    best = None
    while frontier:
        node, dist, depth = frontier.pop()
        if dist > maxd:
            continue
        for x in ix.out[node]:
            if x == e2:
                v = dist + o2
                best = v if best is None else min(best, v)
            elif depth < 2:
                frontier.append((int(g.edge_v[x]), dist + float(g.edge_len[x]), depth + 1))
    return best


def match_track(ix: EdgeIndex, gc: dict) -> dict:
    """gc: aligned GPS curve (x, y, s, t). Returns samples (s, t, xy), matched edge/offset per sample (-1 = none), jumps, failures."""
    g = ix.g
    s_all = gc["s"]
    ss = np.arange(0.0, s_all[-1], STEP)
    xs, ys = np.interp(ss, s_all, gc["x"]), np.interp(ss, s_all, gc["y"])
    hd = np.arctan2(np.gradient(ys), np.gradient(xs))
    ts = np.interp(ss, s_all, gc["t"])
    n = len(ss)
    cands = [ix.candidates(np.array([xs[i], ys[i]]), hd[i]) for i in range(n)]
    # Viterbi with a "no candidate" restart: states are candidate lists; an empty sample breaks the chain (new start after it)
    cost: list[np.ndarray] = []
    back: list[np.ndarray] = []
    jumps = 0
    prev = None
    for i in range(n):
        c = cands[i]
        if not c:
            cost.append(np.zeros(0)); back.append(np.zeros(0, int)); prev = None
            continue
        em = np.array([d * d / (2 * SIGMA ** 2) for (_, _, d) in c])
        if prev is None or len(cost[i - 1]) == 0:
            cost.append(em); back.append(-np.ones(len(c), int)); prev = i
            continue
        pc, pcost = cands[i - 1], cost[i - 1]
        cur = np.empty(len(c)); bk = np.empty(len(c), int)
        for j, (e2, o2, _) in enumerate(c):
            tot = np.empty(len(pc))
            for k, (e1, o1, _) in enumerate(pc):
                nd = _net_dist(ix, e1, o1, e2, o2)
                tot[k] = pcost[k] + (abs(nd - STEP) / 25.0 if nd is not None else JUMP_COST)
            k = int(np.argmin(tot)); cur[j] = tot[k] + em[j]; bk[j] = k
        cost.append(cur); back.append(bk)
    # backtrace each run
    edge = -np.ones(n, np.int32); off = np.zeros(n)
    i = n - 1
    while i >= 0:
        if len(cost[i]) == 0:
            i -= 1
            continue
        j = int(np.argmin(cost[i]))
        while i >= 0 and len(cost[i]) > 0:
            e, o, _ = cands[i][j]
            edge[i], off[i] = e, o
            j = back[i][j]
            i -= 1
            if j < 0:
                break
    # jumps: consecutive matched samples not connected
    for i in range(1, n):
        if edge[i] >= 0 and edge[i - 1] >= 0:
            if _net_dist(ix, int(edge[i - 1]), off[i - 1], int(edge[i]), off[i]) is None:
                jumps += 1
    dmin = np.array([min((d for (_, _, d) in c), default=np.inf) for c in cands])
    return dict(s=ss, t=ts, x=xs, y=ys, edge=edge, off=off, jumps=jumps, n=n, no_candidate=int((edge < 0).sum()), dmin=dmin)
