# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fast interactive route editing (drag/drop route, start, end on the Ergebnis page).

Given a finished run directory and user waypoints (optional moved start/end and ordered via dots without fixed timestamps):
  1. Load (and cache) the local road+path graph covering the route and waypoints.
  2. Find a clean directed road/path route through [start, ...vias, end] that follows the original detected route on
     untouched stretches and detours smoothly through the dragged dots (no U-turn loops).
  3. Arrange the video timeline s(t) along the new route with the best fit to the video's heading & odometry
     (monotone 1D Viterbi alignment + RTS fusion, preserving cuts and standstills).
  4. Update refine/result.npz (backing up the original once as result.orig.npz for instant reset) and run gpx_step.
"""
from __future__ import annotations

import heapq
import json
import pickle
import shutil
import time
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

from rsm.fusion import rts
from rsm.network.graph import NetGraph
from rsm.refine.pathctx import Path as RoutePath

from . import align as AL, config as C, cuts as K, odofail as OF, osm, steps_c as SC, steps_d as SD, tracks as T
from .common import Worker, data_dir, file_sig, jdump, jload, sha

# All drivable streets plus paths, cycleways and tracks so the user can drag onto any street or path
CLASSES_REROUTE = tuple(sorted(set(C.CLASSES_MOTOR) | set(C.CLASSES_BIKE) | set(C.LOCAL_EXTRA) | set(C.BIKE_PATH_CLASSES)))


# ------------------------------------------------------------------ graph loading & caching

def _route_box(ll_pts: np.ndarray, margin_m: float = 600.0) -> dict:
    """WGS84 bbox around lon/lat points with a margin in metres, rounded to 3 decimals for cache reuse."""
    m_lat = margin_m / 111195.0
    m_lon = m_lat / max(float(np.cos(np.radians(ll_pts[:, 1].mean()))), 0.1)
    return dict(
        south=round(float(ll_pts[:, 1].min() - m_lat), 3),
        north=round(float(ll_pts[:, 1].max() + m_lat), 3),
        west=round(float(ll_pts[:, 0].min() - m_lon), 3),
        east=round(float(ll_pts[:, 0].max() + m_lon), 3),
    )


def _box_covers(outer: dict, inner: dict) -> bool:
    return outer["south"] <= inner["south"] and outer["west"] <= inner["west"] and outer["north"] >= inner["north"] and outer["east"] >= inner["east"]


def load_reroute_graph(d: Path, P: dict, ll_pts: np.ndarray) -> NetGraph:
    """Load or extract+cache a NetGraph with all road+path classes covering ll_pts (lon, lat)."""
    need = _route_box(ll_pts, margin_m=600.0)
    cache = data_dir(d)
    pbf = P.get("pbf")
    if pbf and Path(pbf).is_file():
        psig = file_sig(pbf)
        # Reuse any already-cached reroute graph for this PBF whose box covers `need`
        meta_f = cache / "graph_reroute_index.json"
        idx = jload(meta_f) if meta_f.exists() else []
        for entry in idx:
            if entry.get("pbf") == psig and entry.get("rules") == C.BIKE_PATH_RULES and _box_covers(entry["box"], need):
                f = cache / entry["file"]
                if f.exists():
                    return NetGraph.load(f)
        # Extract with a generous 1.2 km margin so subsequent drags nearby hit the cache immediately
        box = _route_box(ll_pts, margin_m=1200.0)
        key = sha(psig, box, list(CLASSES_REROUTE), "reroute_graph1", *osm.rules_token(CLASSES_REROUTE))
        fname = f"graph_reroute_{key}.npz"
        f = cache / fname
        if f.exists():
            gl = NetGraph.load(f)
        else:
            ex = osm.extract(pbf, CLASSES_REROUTE, {"reroute": box}, lambda _f: None)
            gl = osm.build_graph(*ex["reroute"])
            gl.save(f)
        idx = [e for e in idx if e.get("file") != fname][-15:]
        idx.append(dict(pbf=psig, rules=C.BIKE_PATH_RULES, box=box, file=fname))
        jdump(meta_f, idx)
        return gl
    # Fallback when PBF is not on disk (e.g. unit tests or moved PBF): use the run's map graph
    for cand in (d / "map" / "graph_paths.npz", d / "map" / "graph.npz"):
        if cand.exists():
            return NetGraph.load(cand)
    raise FileNotFoundError("Kartendatei (.osm.pbf) und Kartengraph nicht gefunden.")


# ------------------------------------------------------------------ geometry & snapping

def _densify(xy: np.ndarray, step_m: float = 5.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Densify polyline xy -> (pts (M,2), arc (M,), unit_tan (M,2))."""
    if len(xy) < 2:
        return xy.copy(), np.zeros(len(xy)), np.tile([1.0, 0.0], (len(xy), 1))
    d = np.hypot(*np.diff(xy, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(d)])
    total = float(s[-1])
    if total < 1e-6:
        return xy[:1].copy(), np.zeros(1), np.array([[1.0, 0.0]])
    sg = np.arange(0.0, total + 0.5 * step_m, step_m)
    sg[-1] = total
    pts = np.column_stack([np.interp(sg, s, xy[:, 0]), np.interp(sg, s, xy[:, 1])])
    grad = np.gradient(pts, axis=0)
    gn = np.maximum(np.hypot(grad[:, 0], grad[:, 1]), 1e-9)
    return pts, sg, grad / gn[:, None]


def _project_point_to_polyline(p: np.ndarray, poly: np.ndarray) -> tuple[float, float, np.ndarray]:
    """Project 2D point p onto polyline poly -> (dist_m, arc_offset_m, proj_xy)."""
    a = poly[:-1]
    b = poly[1:]
    ab = b - a
    len2 = (ab[:, 0] ** 2 + ab[:, 1] ** 2)
    lens = np.sqrt(len2)
    t = np.where(len2 > 1e-12, ((p[0] - a[:, 0]) * ab[:, 0] + (p[1] - a[:, 1]) * ab[:, 1]) / np.maximum(len2, 1e-12), 0.0)
    t = np.clip(t, 0.0, 1.0)
    proj = a + t[:, None] * ab
    dists = np.hypot(proj[:, 0] - p[0], proj[:, 1] - p[1])
    i = int(np.argmin(dists))
    arc_before = float(lens[:i].sum())
    return float(dists[i]), arc_before + float(t[i] * lens[i]), proj[i]


def _build_edge_index(g: NetGraph) -> tuple[cKDTree, np.ndarray]:
    """Spatial index over edge sample points (endpoints + midpoints every ~25 m) -> (tree, edge_id_per_sample)."""
    pts_list, eid_list = [], []
    for e in range(g.n_edges):
        poly = g.geom(e)
        L = float(g.edge_len[e])
        if L <= 30.0 or len(poly) <= 2:
            # endpoints + midpoint
            mid = 0.5 * (poly[0] + poly[-1])
            pts = np.vstack([poly[0], mid, poly[-1]])
        else:
            d = np.hypot(*np.diff(poly, axis=0).T)
            s = np.concatenate([[0.0], np.cumsum(d)])
            n = max(3, int(np.ceil(L / 25.0)) + 1)
            sg = np.linspace(0.0, s[-1], n)
            pts = np.column_stack([np.interp(sg, s, poly[:, 0]), np.interp(sg, s, poly[:, 1])])
        pts_list.append(pts)
        eid_list.append(np.full(len(pts), e, np.int32))
    return cKDTree(np.vstack(pts_list)), np.concatenate(eid_list)


def _snap_candidates(g: NetGraph, tree: cKDTree, sample_eid: np.ndarray, p: np.ndarray, max_cands: int = 6) -> list[tuple[int, float, float]]:
    """Snap point p=(x,y) to candidate directed edges -> list of (edge_id, off_m, dist_m), sorted by dist_m."""
    k = min(48, len(sample_eid))
    _, idxs = tree.query(p, k=k)
    eids = np.unique(sample_eid[np.atleast_1d(idxs)])
    cands = []
    for e in eids:
        dist, off, _ = _project_point_to_polyline(p, g.geom(int(e)))
        cands.append((int(e), float(off), float(dist)))
    cands.sort(key=lambda x: x[2])
    if not cands:
        return []
    best_d = cands[0][2]
    # Keep candidates close to the nearest road (covers both directions of a two-way street and nearby junctions)
    kept = [c for c in cands if c[2] <= best_d + 20.0][:max_cands]
    return kept


def _base_edge_weights(g: NetGraph, orig_xy: np.ndarray) -> np.ndarray:
    """Per-edge cost multiplier: 0.35 for edges aligned with orig_xy in position & direction, 1.0 otherwise."""
    if len(orig_xy) < 2:
        return np.ones(g.n_edges, float)
    dense, _, tang = _densify(orig_xy, 5.0)
    otree = cKDTree(dense)
    scale = np.ones(g.n_edges, float)
    for e in range(g.n_edges):
        poly = g.geom(e)
        p0, p1 = poly[0], poly[-1]
        pm = poly[len(poly) // 2]
        dists, idxs = otree.query(np.vstack([p0, pm, p1]))
        if float(dists.max()) <= 18.0:
            v = p1 - p0
            vn = float(np.hypot(v[0], v[1]))
            if vn < 1e-6 or float(np.dot(v / vn, tang[idxs[1]])) >= 0.45:
                scale[e] = 0.35
    return scale


# ------------------------------------------------------------------ Dijkstra & multi-waypoint DP

def _build_adj(g: NetGraph, w_scale: np.ndarray) -> list[list[tuple[int, float, int]]]:
    adj: list[list[tuple[int, float, int]]] = [[] for _ in range(g.n_nodes)]
    el = g.edge_len
    eu, ev = g.edge_u, g.edge_v
    for e in range(g.n_edges):
        w = max(float(el[e]) * float(w_scale[e]), 0.01)
        adj[int(eu[e])].append((int(ev[e]), w, e))
    return adj


def _dijkstra_targets(adj: list[list[tuple[int, float, int]]], src: int, targets: set[int], max_cost: float = float("inf")) -> dict[int, tuple[float, list[int]]]:
    """Single-source Dijkstra stopping as soon as all `targets` are settled. Returns {tgt: (cost, edge_list)}."""
    if not targets:
        return {}
    dist: dict[int, float] = {src: 0.0}
    prev: dict[int, tuple[int, int]] = {}
    pq: list[tuple[float, int]] = [(0.0, src)]
    rem = set(targets)
    found: dict[int, tuple[float, list[int]]] = {}
    while pq and rem:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float("inf")) or d > max_cost:
            continue
        if u in rem:
            rem.remove(u)
            edges: list[int] = []
            cur = u
            while cur != src:
                pu, pe = prev[cur]
                edges.append(pe)
                cur = pu
            edges.reverse()
            found[u] = (d, edges)
            if not rem:
                break
        for v, w, e in adj[u]:
            nd = d + w
            if nd < dist.get(v, float("inf")) and nd <= max_cost:
                dist[v] = nd
                prev[v] = (u, e)
                heapq.heappush(pq, (nd, v))
    return found


def _segment_paths(g: NetGraph, adj, w_scale: np.ndarray, cands_a: list[tuple[int, float, float]], cands_b: list[tuple[int, float, float]]) -> dict[tuple[int, int], tuple[float, list[int]]]:
    """Shortest edge chain from each candidate i in cands_a to each candidate j in cands_b.
    Returns {(i, j): (cost, middle_edges)} where middle_edges are strictly between e_a and e_b (or None if same-edge forward)."""
    by_src_node: dict[int, list[int]] = {}
    for i, (ea, _, _) in enumerate(cands_a):
        by_src_node.setdefault(int(g.edge_v[ea]), []).append(i)
    tgt_nodes = {int(g.edge_u[eb]) for eb, _, _ in cands_b}
    # Run one Dijkstra per unique source node
    dijk_cache = {u: _dijkstra_targets(adj, u, tgt_nodes) for u in by_src_node}
    out: dict[tuple[int, int], tuple[float, list[int]]] = {}
    for i, (ea, off_a, _) in enumerate(cands_a):
        va = int(g.edge_v[ea])
        la = float(g.edge_len[ea])
        sa = float(w_scale[ea])
        rem_a = max(la - off_a, 0.0) * sa
        dmap = dijk_cache[va]
        for j, (eb, off_b, _) in enumerate(cands_b):
            if ea == eb and off_b >= off_a - 1e-6:
                out[(i, j)] = (max(off_b - off_a, 0.0) * sa, [])
                continue
            ub = int(g.edge_u[eb])
            if ub in dmap:
                mid_cost, mid_edges = dmap[ub]
                sb = float(w_scale[eb])
                # Slight penalty on immediate U-turn back along the opposite edge of the same way
                uturn = 40.0 if (mid_edges and int(g.edge_v[mid_edges[0]]) == int(g.edge_u[ea]) and int(g.edge_way[mid_edges[0]]) == int(g.edge_way[ea])) else 0.0
                out[(i, j)] = (rem_a + mid_cost + off_b * sb + uturn, mid_edges)
    return out


def _trim_geom(poly: np.ndarray, s0: float | None, s1: float | None) -> np.ndarray:
    """Slice a polyline to arc interval [s0, s1] (None = full end)."""
    d = np.hypot(*np.diff(poly, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(d)])
    L = float(s[-1])
    a = 0.0 if s0 is None else float(np.clip(s0, 0.0, L))
    b = L if s1 is None else float(np.clip(s1, a, L))
    if b - a < 1e-3:
        p = np.array([np.interp(a, s, poly[:, 0]), np.interp(a, s, poly[:, 1])])
        return np.vstack([p, p])
    pa = np.array([[np.interp(a, s, poly[:, 0]), np.interp(a, s, poly[:, 1])]])
    pb = np.array([[np.interp(b, s, poly[:, 0]), np.interp(b, s, poly[:, 1])]])
    mid = poly[(s > a + 1e-6) & (s < b - 1e-6)]
    return np.vstack([pa, mid, pb]) if len(mid) else np.vstack([pa, pb])


def _build_trimmed_path(g: NetGraph, occ: list[int], start_off: float, end_off: float) -> RoutePath:
    """Build a 1 m sampled RoutePath from edge list `occ`, trimmed at start_off on occ[0] and end_off on occ[-1]."""
    occ_arr = np.array(occ, np.int64)
    pts, sg_start = [], [0.0]
    for idx, e in enumerate(occ):
        poly = g.geom(int(e))
        if len(occ) == 1:
            poly = _trim_geom(poly, start_off, end_off)
        elif idx == 0:
            poly = _trim_geom(poly, start_off, None)
        elif idx == len(occ) - 1:
            poly = _trim_geom(poly, None, end_off)
        seg_len = float(np.hypot(*np.diff(poly, axis=0).T).sum())
        sg_start.append(sg_start[-1] + seg_len)
        pts.append(poly if not pts else poly[1:])
    P = np.vstack(pts)
    d = np.hypot(*np.diff(P, axis=0).T)
    keep = np.concatenate([[True], d > 1e-6])
    P = P[keep]
    if len(P) < 2:
        raise RuntimeError("Die neue Route ist zu kurz.")
    d = np.hypot(*np.diff(P, axis=0).T)
    cp = np.concatenate([[0.0], np.cumsum(d)])
    total = float(cp[-1])
    if total < 2.0:
        raise RuntimeError("Die neue Route ist zu kurz (< 2 m).")
    sg = np.arange(0.0, total, 1.0)
    if sg[-1] < total - 1e-3:
        sg = np.append(sg, total)
    xy = np.column_stack([np.interp(sg, cp, P[:, 0]), np.interp(sg, cp, P[:, 1])])
    seg_h = np.unwrap(np.arctan2(np.diff(P[:, 1]), np.diff(P[:, 0])))
    k = np.clip(np.searchsorted(cp, sg, side="right") - 1, 0, len(seg_h) - 1)
    phi = seg_h[k]
    start_arr = np.array(sg_start, float)
    oi = np.clip(np.searchsorted(start_arr, sg, side="right") - 1, 0, len(occ_arr) - 1)
    tun = np.asarray(g.edge_tunnel)[occ_arr][oi]
    return RoutePath(g, occ_arr, start_arr, sg, xy, phi, tun, filled=0)


def route_through_waypoints(
    g: NetGraph,
    orig_xy: np.ndarray,
    start_xy: np.ndarray,
    end_xy: np.ndarray,
    vias: list[tuple[np.ndarray, float | None]],
    start_moved: bool,
    end_moved: bool,
) -> RoutePath:
    """Find a directed road/path route on `g` through [start, ...vias, end], preserving untouched stretches of orig_xy."""
    w_scale = _base_edge_weights(g, orig_xy)
    adj = _build_adj(g, w_scale)
    tree, sample_eid = _build_edge_index(g)
    dense_orig, orig_sg, _ = _densify(orig_xy, 5.0)
    otree = cKDTree(dense_orig)
    L_orig = float(orig_sg[-1]) if len(orig_sg) else 0.0

    def _orig_pos(xy: np.ndarray, hint_s: float | None) -> tuple[float, float]:
        dist, idx = otree.query(xy)
        return (float(hint_s) if hint_s is not None else float(orig_sg[int(idx)])), float(dist)

    # Assemble user anchors with their approximate arc on orig_xy & distance off orig_xy
    s0, d0 = (0.0, 0.0) if not start_moved else _orig_pos(start_xy, None)
    s1, d1 = (L_orig, 0.0) if not end_moved else _orig_pos(end_xy, None)
    user_pts: list[tuple[np.ndarray, float, float, bool]] = [(start_xy, s0, d0, True)]
    for v_xy, hint_s in vias:
        sv, dv = _orig_pos(v_xy, hint_s)
        user_pts.append((v_xy, sv, dv, True))
    user_pts.append((end_xy, s1, d1, True))

    # Insert automatic base-route guide points between consecutive user waypoints so untouched loops stay intact
    seq: list[tuple[np.ndarray, bool]] = []
    for i, (pt, sa, da, _) in enumerate(user_pts):
        seq.append((pt, True))
        if i + 1 >= len(user_pts):
            break
        _, sb, db, _ = user_pts[i + 1]
        exc_a = max(250.0, 1.8 * da)
        exc_b = max(250.0, 1.8 * db)
        lo, hi = sa + exc_a, sb - exc_b
        if hi > lo + 100.0 and L_orig > 0.0:
            n_guides = max(1, int((hi - lo) // 500.0))
            for gs in np.linspace(lo, hi, n_guides + 2)[1:-1]:
                gxy = np.array([np.interp(gs, orig_sg, dense_orig[:, 0]), np.interp(gs, orig_sg, dense_orig[:, 1])])
                seq.append((gxy, False))

    # Snap every point in seq to candidate directed edges
    snapped: list[tuple[list[tuple[int, float, float]], bool]] = []
    for pt, is_user in seq:
        cands = _snap_candidates(g, tree, sample_eid, pt, max_cands=6 if is_user else 3)
        if not cands:
            if is_user:
                raise RuntimeError("Kein Weg oder keine Straße in der Nähe des gesetzten Punkts gefunden.")
            continue
        snapped.append((cands, is_user))

    # Dynamic programming over candidate snaps across the sequence (skipping unreachable guide points)
    dp_cost = [c[2] * 2.0 for c in snapped[0][0]]  # small snap distance tie-breaker
    dp_chain: list[tuple[int, list[int]]] = [(c[0], []) for c in snapped[0][0]]  # (start_cand_idx_unused -> start_off tracked below)
    dp_start_cand = list(range(len(snapped[0][0])))
    dp_edges: list[list[int]] = [[c[0]] for c in snapped[0][0]]
    cur_cands = snapped[0][0]

    for nxt_cands, is_user in snapped[1:]:
        segs = _segment_paths(g, adj, w_scale, cur_cands, nxt_cands)
        new_cost = [float("inf")] * len(nxt_cands)
        new_edges: list[list[int]] = [[] for _ in nxt_cands]
        new_start = [0] * len(nxt_cands)
        for j, (eb, _off_b, dist_b) in enumerate(nxt_cands):
            best_c = float("inf")
            best_i = -1
            for i in range(len(cur_cands)):
                if not np.isfinite(dp_cost[i]) or (i, j) not in segs:
                    continue
                sc, _ = segs[(i, j)]
                tot = dp_cost[i] + sc + dist_b * 2.0
                if tot < best_c:
                    best_c = tot
                    best_i = i
            if best_i >= 0:
                new_cost[j] = best_c
                new_start[j] = dp_start_cand[best_i]
                _, mid = segs[(best_i, j)]
                ea = cur_cands[best_i][0]
                chain = list(dp_edges[best_i])
                if ea == eb and not mid:
                    pass  # still on the same edge
                else:
                    chain.extend(mid)
                    chain.append(eb)
                new_edges[j] = chain
        if not any(np.isfinite(c) for c in new_cost):
            if is_user:
                raise RuntimeError("Keine durchgehende Straßen- oder Wegeverbindung durch die gesetzten Punkte gefunden.")
            continue  # unreachable automatic guide point: skip it
        cur_cands = nxt_cands
        dp_cost = new_cost
        dp_edges = new_edges
        dp_start_cand = new_start

    best_j = int(np.argmin(dp_cost))
    if not np.isfinite(dp_cost[best_j]):
        raise RuntimeError("Keine durchgehende Route durch die gesetzten Punkte gefunden.")
    occ = dp_edges[best_j]
    start_off = snapped[0][0][dp_start_cand[best_j]][1]
    end_off = cur_cands[best_j][1]
    return _build_trimmed_path(g, occ, start_off, end_off)


# ------------------------------------------------------------------ best-fit timeline alignment

def _align_free(
    sg: np.ndarray,
    xy: np.ndarray,
    tracks: list,
    kappa: float,
    a_ang: float,
    gap_nom: list | None,
    start_prior: tuple[float, float] | None,
    end_prior: tuple[float, float] | None,
    ds_nom: float = 4.0,
) -> dict | None:
    """Monotone 1D Viterbi heading+distance alignment of video tracks onto (sg, xy) with optional soft start/end priors.
    Timestamps of intermediate waypoints are completely free."""
    if not tracks:
        return None
    ph_full = AL.path_heading(xy, C.ALIGN_SMOOTH_M)
    DS = C.ALIGN_DS
    L_path = float(sg[-1])
    grid = np.arange(0.0, L_path + 0.5 * DS, DS)
    if len(grid) < 5:
        return None
    grid[-1] = L_path
    N = len(grid)
    ph = np.interp(grid, sg, ph_full)
    obs = AL.observations(tracks, a_ang, gap_nom)
    if len(obs) < 2:
        return None

    # Adapt kappa_eff only if the new route length would otherwise be unreachable by amax
    d_nom_total = sum(float(tr["s"][-1] - tr["s"][0]) for tr in tracks if len(tr["s"]) >= 2)
    kappa_eff = float(kappa)
    if d_nom_total > 10.0 and start_prior is not None and end_prior is not None:
        span = max(end_prior[0] - start_prior[0], 10.0)
        ratio = span / max(d_nom_total * kappa_eff, 10.0)
        if ratio > 1.75 or ratio < 0.55:
            kappa_eff = float(kappa_eff * np.clip(ratio, 0.45, 2.5))

    step = max(ds_nom * kappa_eff, 0.5)
    amax = min(250, max(10, int(np.ceil(step * 2.4 / DS))))
    adv = np.arange(amax + 1)
    lp = -0.5 * ((adv * DS - step) / (C.ALIGN_REL * step)) ** 2
    v_med = float(np.median(np.concatenate([np.diff(k["s"]) / np.maximum(np.diff(k["t"]), 1e-3) for k in tracks]))) * kappa_eff
    vmax = max(C.ALIGN_VMAX, 2.5 * v_med)
    sig0, beta, nu = np.radians(C.ALIGN_SIG0_DEG), C.ALIGN_BETA, C.ALIGN_NU

    if start_prior is not None:
        s0, sd0 = start_prior
        a0 = -0.5 * ((grid - s0) / max(sd0, 5.0)) ** 2
    else:
        a0 = np.zeros(N)
    a = a0.copy()
    NEG = -1e18
    bp = np.zeros((len(obs), N), np.uint8)
    bp_gap = {}
    dphi = [np.zeros(N)] + [np.concatenate([np.zeros(d), ph[d:] - ph[:-d]]) for d in adv[1:]]
    sd = [sig0 + beta * np.abs(x) for x in dphi]
    for j in range(1, len(obs)):
        _tj, dth, gap, gmeas = obs[j]
        best = np.full(N, NEG)
        if dth is None:
            arg = np.zeros(N, np.int32)
            if gmeas is not None:
                mu = gmeas * kappa_eff
                sdg = 0.3 * mu + 10.0
                W = int(np.ceil((mu + 4 * sdg) / DS))
                for d in range(min(W + 1, N)):
                    c = np.full(N, NEG)
                    c[d:] = a[:N - d] - 0.5 * ((d * DS - mu) / sdg) ** 2
                    u = c > best
                    best[u] = c[u]
                    arg[u] = d
            else:
                W = min(N - 1, int(np.ceil(gap * vmax / DS)) + 1)
                best, arg = AL._window_max(a, W)
            bp_gap[j] = arg
            a = best
            continue
        arg = np.zeros(N, np.uint8)
        for i, d in enumerate(adv):
            if d >= N:
                break
            c = np.full(N, NEG)
            c[d:] = a[:N - d] + lp[i] + AL._tlog(dth - dphi[i][d:], sd[i][d:], nu)
            u = c > best
            best[u] = c[u]
            arg[u] = d
        a = best - best.max()
        bp[j] = arg

    if end_prior is not None:
        se, sde = end_prior
        a = a - 0.5 * ((grid - se) / max(sde, 5.0)) ** 2
    c_end = int(np.argmax(a))
    path_idx = np.zeros(len(obs), np.int64)
    path_idx[-1] = c_end
    for j in range(len(obs) - 1, 0, -1):
        d = bp_gap[j][path_idx[j]] if j in bp_gap else bp[j][path_idx[j]]
        path_idx[j - 1] = max(0, path_idx[j] - int(d))
    out = dict(t=np.array([o[0] for o in obs]), s=grid[path_idx], kappa_eff=kappa_eff, n_obs=len(obs))
    if C.ALIGN_POST_BAND_M > 0:
        B = max(2, int(round(C.ALIGN_POST_BAND_M / DS)))
        out["s_mean"], out["s_sd"] = AL.band_posterior(ph, obs, path_idx, a0, DS, step, kappa_eff, vmax, amax, sig0, beta, nu, B)
    return out


def _align_pieces_free(sg, xy, tracks, kappa, a_ang, gap_nom, start_moved: bool, end_moved: bool):
    """Run _align_free per continuous piece between scene cuts."""
    L = float(sg[-1])
    starts = [0] + [i for i, tr in enumerate(tracks) if i > 0 and tr.get("cut_before") is not None] + [len(tracks)]
    s_prior = (0.0, 20.0 if start_moved else 80.0)
    e_prior = (L, 20.0 if end_moved else 80.0)
    if len(starts) == 2:
        return _align_free(sg, xy, tracks, kappa, a_ang, gap_nom, s_prior, e_prior)
    parts = []
    n_p = len(starts) - 1
    for pi, (a, b) in enumerate(zip(starts[:-1], starts[1:])):
        sp = s_prior if pi == 0 else None
        ep = e_prior if pi == n_p - 1 else None
        p = _align_free(sg, xy, tracks[a:b], kappa, a_ang, None if gap_nom is None else gap_nom[a:b], sp, ep)
        if p is not None:
            parts.append(p)
    if not parts:
        return None
    post = {k: np.concatenate([p[k] for p in parts]) for k in ("s_mean", "s_sd") if all(k in p for p in parts)}
    return dict(**post, t=np.concatenate([p["t"] for p in parts]), s=np.concatenate([p["s"] for p in parts]), kappa_eff=parts[0]["kappa_eff"])


def _fuse_on_path(
    t_out: np.ndarray,
    st,
    tracks: list,
    fine,
    kappa_eff: float,
    L_path: float,
    meas: list[rts.Meas],
    cut_spans,
    still,
    s0: float,
) -> tuple[np.ndarray, np.ndarray]:
    """RTS smoother on the new path using alignment measurements + odometry shape + cuts + standstills."""
    fp = rts.FuseParams()
    t_out = np.asarray(t_out, float)
    st_t = np.asarray(st.t, float)
    t_lo, t_hi = float(st_t[0]), float(st_t[-1])
    nodes = np.unique(np.concatenate([t_out, st_t, [m.t for m in meas], np.ravel(still) if still else []]))
    nodes = nodes[(nodes >= t_lo - 1e-9) & (nodes <= t_hi + 1e-9)]
    meas_in = [m for m in meas if t_lo - 1e-9 <= m.t <= t_hi + 1e-9]

    # Build cumulative nominal distance D(t) and gap distance G(t) from st (with per-pair shaping if available)
    Dcum = np.concatenate([[0.0], np.cumsum(st.mu[1:])])
    tt = st_t + 1e-6 * np.arange(len(st_t))
    gapcum = np.concatenate([[0.0], np.cumsum(np.where(st.gap[1:], st.mu[1:], 0.0))])
    D = np.interp(nodes, tt, Dcum)
    if C.FUSE_SHAPE_STEPS and fine is not None and len(st_t) >= 2:
        Te, Se = fine
        i = np.clip(np.searchsorted(st_t, nodes, side="right") - 1, 0, len(st_t) - 2)
        ta, tb = st_t[i], st_t[i + 1]
        m = (ta >= Te[0]) & (tb <= Te[-1]) & (tb > ta) & (st.mu[i + 1] > 0)
        fa, fb, fn = np.interp(ta[m], Te, Se), np.interp(tb[m], Te, Se), np.interp(nodes[m], Te, Se)
        ok = fb - fa > 1e-9
        k = np.flatnonzero(m)[ok]
        D[k] = np.interp(ta[k], tt, Dcum) + st.mu[i[k] + 1] * np.clip((fn[ok] - fa[ok]) / (fb[ok] - fa[ok]), 0.0, 1.0)
    G = np.interp(nodes, tt, gapcum)
    dm = np.concatenate([[0.0], np.diff(D) * kappa_eff])
    dg = np.concatenate([[0.0], np.diff(G) * kappa_eff])
    meas_in = SC.cut_process(nodes, dm, dg, meas_in, cut_spans, fp.gap_rel, kappa_eff)
    meas_in = SC.hold_still(nodes, dm, dg, meas_in, still)
    res = rts.fuse(nodes, dm, dg, meas_in, s0, fp)
    xs, Ps = res["xs"], res["Ps"]
    j = np.clip(np.searchsorted(nodes, t_out), 0, len(nodes) - 1)
    return np.clip(xs[j, 0], 0.0, L_path), np.sqrt(np.maximum(Ps[j, 0, 0], 0.0))


def align_timeline(d: Path, path: RoutePath, orig_R, start_moved: bool, end_moved: bool) -> dict:
    """Align the video timeline to `path` with best fit to heading & odometry -> dict of arrays for refine/result.npz."""
    tracks = pickle.load(open(d / "rotation" / "tracks.pkl", "rb"))
    csv = str(d / "motion" / "motion.csv")
    tracks, _, still = OF.apply_still(tracks, csv)
    st = OF.route_steps(d, tracks)
    route = pickle.load(open(d / "route_search" / "route.pkl", "rb"))
    kappa = float(route["kappa"])
    a_ang = float(route["a_ang"])
    gap_nom = T.gap_nominal(csv, tracks)
    gap_nom = [x if x is not None else g_ for x, g_ in zip(OF.still_gap_nominal(csv, tracks, still), gap_nom)]
    spans = K.spans(st, tracks)
    fine = SC.fine_profile(csv)
    L_path = float(path.sg[-1])

    al = _align_pieces_free(path.sg, path.xy, tracks, kappa, a_ang, gap_nom, start_moved, end_moved)
    kappa_eff = float(al["kappa_eff"]) if al is not None else kappa
    t_lo, t_hi = float(st.t[0]), float(st.t[-1])

    meas: list[rts.Meas] = []
    if al is not None:
        if "s_sd" in al:
            sdm = np.sqrt(al["s_sd"] ** 2 + C.ALIGN_POST_FLOOR_M ** 2) * C.ALIGN_POST_INFL
            last = -1e9
            for t_, s_, sd_, raw in zip(al["t"], al["s"], sdm, al["s_sd"]):
                if raw <= C.ALIGN_POST_MAX_SD_M and s_ - last >= C.ALIGN_MEAS_EVERY_M:
                    meas.append(rts.Meas(float(t_), float(s_), float(sd_) ** 2, "align"))
                    last = float(s_)
        # Always include sparse Viterbi samples so even completely straight detours track the aligned timeline
        step_k = max(1, len(al["t"]) // 80)
        for t_, s_ in zip(al["t"][::step_k], al["s"][::step_k]):
            meas.append(rts.Meas(float(t_), float(s_), 25.0 ** 2, "align_coarse"))
    # Pin start and end cleanly to [0, L_path] (tighter when the user explicitly dragged Start/End)
    meas.append(rts.Meas(t_lo, 0.0, (4.0 if start_moved else 15.0) ** 2, "end"))
    meas.append(rts.Meas(t_hi, L_path, (4.0 if end_moved else 15.0) ** 2, "end"))

    t_all = orig_R["t"].astype(float)
    edges = np.array(sorted({float(x) for sp in still for x in sp}), float)
    edges = edges[(edges >= t_all[0]) & (edges <= t_all[-1])] if len(edges) else edges
    t_fuse = np.unique(np.concatenate([t_all, edges]))
    s_fuse, sd_fuse = _fuse_on_path(t_fuse, st, tracks, fine, kappa_eff, L_path, meas, spans, still, 0.0)
    ix = np.searchsorted(t_fuse, t_all)
    s_all, sd_all = s_fuse[ix], sd_fuse[ix]

    # GPX raster
    gx_hz = int(orig_R["gx_hz"]) if "gx_hz" in orig_R.files else int(C.GPX_HZ)
    t_gx = orig_R["gx_t"].astype(float) if "gx_t" in orig_R.files else np.arange(int(np.floor(t_all[-1])) * gx_hz + 1) / gx_hz
    if gx_hz > 1:
        s_gx, sd_gx = _fuse_on_path(t_gx, st, tracks, fine, kappa_eff, L_path, meas, spans, still, 0.0)
    else:
        s_gx, sd_gx = s_all, sd_all

    # Flags & confidence: preserve original confidence where the new path agrees with the original route,
    # and mark user-adjusted stretches as high confidence (0.95) inside [t_lo, t_hi]
    orig_xy = orig_R["xy"]
    orig_tree = cKDTree(orig_xy) if len(orig_xy) else None

    def _flags_for(t_arr: np.ndarray, s_arr: np.ndarray):
        extrap = (t_arr < t_lo) | (t_arr > t_hi)
        base_conf = np.interp(t_arr, orig_R["t"].astype(float), orig_R["conf"].astype(float))
        if orig_tree is not None and len(path.xy):
            pxy = path.xy_at(s_arr)
            d_orig, _ = orig_tree.query(pxy)
            conf = np.where(extrap, 0.0, np.where(d_orig > 15.0, np.maximum(base_conf, 0.95), base_conf))
        else:
            conf = np.where(extrap, 0.0, np.maximum(base_conf, 0.95))
        in_gap = np.zeros(len(t_arr), bool)
        for j in np.flatnonzero(st.gap):
            if j > 0:
                in_gap |= (t_arr > float(st.t[j - 1])) & (t_arr <= float(st.t[j]))
        for ta, tb, *_ in spans:
            in_gap |= (t_arr > ta) & (t_arr <= np.ceil(tb))
        in_still = np.zeros(len(t_arr), bool)
        for a, b in still:
            in_still |= (t_arr >= a) & (t_arr <= b)
        in_gap &= ~in_still
        return conf, extrap, in_gap, in_still

    conf, extrap, in_gap, in_still = _flags_for(t_all, s_all)
    conf_gx, extrap_gx, in_gap_gx, in_still_gx = _flags_for(t_gx, s_gx)

    # Standstill edges
    lo_s, hi_s = (np.array([a for a, _ in still], float), np.array([b for _, b in still], float)) if still else (np.zeros(0), np.zeros(0))
    s_edge = np.interp(edges, t_fuse, s_fuse) if len(edges) else np.zeros(0)
    sd_edge = np.interp(edges, t_fuse, sd_fuse) if len(edges) else np.zeros(0)
    e_s = dict(zip(edges.tolist(), s_edge.tolist()))
    e_sd = dict(zip(edges.tolist(), sd_edge.tolist()))
    e_conf = dict(zip(edges.tolist(), np.interp(edges, t_all, conf).tolist())) if len(edges) else {}

    # Per-metre road tags for the lane model (steps_d.gpx_step)
    g = path.g
    oi = np.clip(np.searchsorted(path.start, path.sg, side="right") - 1, 0, len(path.occ) - 1)
    eo = np.asarray(path.occ)[oi]
    oneway = np.asarray(g.edge_oneway)[eo]
    bridge = np.asarray(g.edge_bridge, bool)[eo]
    lane = dict(highway=np.asarray(g.edge_highway).astype(str)[eo])
    for k_, fill, dt in (("width", np.nan, np.float32), ("lanes", 0, np.int8), ("lanes_fwd", 0, np.int8), ("roundabout", False, bool), ("marked", -1, np.int8), ("cycle", 0, np.int8)):
        a = getattr(g, "edge_" + k_, None)
        lane[k_] = np.asarray(a, dt)[eo] if a is not None else np.full(len(eo), fill, dt)

    return dict(
        t=t_all, s=s_all, s_sd=sd_all, conf=conf, extrap=extrap, in_gap=in_gap,
        still_t0=lo_s, still_t1=hi_s,
        still_s0=np.array([e_s.get(a, np.nan) for a in lo_s]),
        still_s1=np.array([e_s.get(b, np.nan) for b in hi_s]),
        still_sd=np.array([e_sd.get(a, np.nan) for a in lo_s]),
        still_conf=np.array([e_conf.get(a, 0.0) for a in lo_s]),
        in_still=in_still,
        sg=path.sg, xy=path.xy, oneway=oneway, tunnel=path.tunnel, bridge=bridge, crs=np.array(g.crs),
        **lane,
        gx_hz=np.array(gx_hz), gx_t=t_gx, gx_s=s_gx, gx_s_sd=sd_gx, gx_conf=conf_gx, gx_extrap=extrap_gx, gx_in_gap=in_gap_gx, gx_in_still=in_still_gx,
    )


# ------------------------------------------------------------------ public entry points

def _ensure_backup(d: Path) -> None:
    """Save the original detected refine outputs once so Reset is instant and lossless."""
    for src, bak in (
        (d / "refine" / "result.npz", d / "refine" / "result.orig.npz"),
        (d / "refine" / "summary.json", d / "refine" / "summary.orig.json"),
        (d / "steps" / "refine.done.json", d / "steps" / "refine.done.orig.json"),
    ):
        if src.exists() and not bak.exists():
            shutil.copy2(src, bak)


def _update_path_km(d: Path, path_km: float) -> None:
    for f, key in ((d / "refine" / "summary.json", None), (d / "steps" / "refine.done.json", "summary")):
        if not f.exists():
            continue
        doc = jload(f)
        target = doc.get(key) if key else doc
        if isinstance(target, dict):
            target["path_km"] = float(path_km)
            jdump(f, doc)


def parse_spec(raw: str | dict) -> dict:
    """Parse waypoints spec (JSON string, file path, or dict): {start: {lat,lon}|None, end: {lat,lon}|None, vias: [{lat,lon,orig_s?}]}."""
    if isinstance(raw, str):
        p = Path(raw)
        obj = json.loads(p.read_text()) if (not raw.lstrip().startswith("{") and p.is_file()) else json.loads(raw)
    else:
        obj = raw
    if not isinstance(obj, dict):
        raise ValueError("waypoints must be a JSON object")

    def _dot(x, keep_s=False):
        if x is None:
            return None
        lat, lon = float(x["lat"]), float(x["lon"])
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            raise ValueError(f"invalid coordinates: {lat}, {lon}")
        out = dict(lat=lat, lon=lon)
        if keep_s and x.get("orig_s") is not None:
            out["orig_s"] = float(x["orig_s"])
        return out

    vias = [_dot(v, keep_s=True) for v in (obj.get("vias") or []) if v is not None]
    return dict(start=_dot(obj.get("start")), end=_dot(obj.get("end")), vias=vias)


def reroute(d: Path, spec_raw: str | dict) -> dict:
    """Reroute a finished run through the user's waypoints, fit the timeline, and regenerate GPX / route_points / project.json."""
    t0 = time.time()
    d = Path(d)
    if not (d / "refine" / "result.npz").exists() or not (d / "project.params.json").exists():
        raise FileNotFoundError(f"no finished run in {d}")
    spec = parse_spec(spec_raw)
    if spec["start"] is None and spec["end"] is None and not spec["vias"]:
        return reset_reroute(d)

    _ensure_backup(d)
    P = jload(d / "project.params.json")
    orig_R = np.load(d / "refine" / "result.orig.npz")
    orig_xy_r = orig_R["xy"]
    orig_crs = str(orig_R["crs"])
    tr_to_ll = Transformer.from_crs(orig_crs, "EPSG:4326", always_xy=True)
    olon, olat = tr_to_ll.transform(orig_xy_r[:, 0], orig_xy_r[:, 1])
    orig_ll = np.column_stack([olon, olat])

    extra_ll = []
    for x in [spec["start"], spec["end"], *spec["vias"]]:
        if x is not None:
            extra_ll.append([x["lon"], x["lat"]])
    all_ll = np.vstack([orig_ll, np.array(extra_ll, float)]) if extra_ll else orig_ll

    g = load_reroute_graph(d, P, all_ll)
    tr_to_g = Transformer.from_crs("EPSG:4326", g.crs, always_xy=True)
    gx, gy = tr_to_g.transform(orig_ll[:, 0], orig_ll[:, 1])
    orig_xy = np.column_stack([gx, gy])

    def _to_xy(dot: dict) -> np.ndarray:
        x, y = tr_to_g.transform(dot["lon"], dot["lat"])
        return np.array([float(x), float(y)], float)

    start_moved = spec["start"] is not None
    end_moved = spec["end"] is not None
    start_xy = _to_xy(spec["start"]) if start_moved else orig_xy[0]
    end_xy = _to_xy(spec["end"]) if end_moved else orig_xy[-1]
    vias_xy = [(_to_xy(v), v.get("orig_s")) for v in spec["vias"]]

    path = route_through_waypoints(g, orig_xy, start_xy, end_xy, vias_xy, start_moved, end_moved)
    arrays = align_timeline(d, path, orig_R, start_moved, end_moved)
    np.savez_compressed(d / "refine" / "result.npz", **arrays)

    # Save exact snapped start/end/vias metadata so the UI shows active waypoints after reload
    path_km = float(path.sg[-1] / 1000.0)
    _update_path_km(d, path_km)
    jdump(d / "refine" / "reroute.json", spec)

    SD.gpx_step(d, P, Worker())
    return dict(
        gpx=str(d / "route.gpx"),
        route_points=str(d / "route_points.json"),
        project=str(d / "project.json"),
        path_km=round(path_km, 3),
        seconds=round(time.time() - t0, 3),
        waypoints=spec,
    )


def reset_reroute(d: Path) -> dict:
    """Restore the original detected route before any manual drag/drop edits."""
    t0 = time.time()
    d = Path(d)
    bak = d / "refine" / "result.orig.npz"
    if bak.exists():
        shutil.copy2(bak, d / "refine" / "result.npz")
    for orig, dst in (
        (d / "refine" / "summary.orig.json", d / "refine" / "summary.json"),
        (d / "steps" / "refine.done.orig.json", d / "steps" / "refine.done.json"),
    ):
        if orig.exists():
            shutil.copy2(orig, dst)
    (d / "refine" / "reroute.json").unlink(missing_ok=True)
    P = jload(d / "project.params.json")
    SD.gpx_step(d, P, Worker())
    R = np.load(d / "refine" / "result.npz")
    return dict(
        gpx=str(d / "route.gpx"),
        route_points=str(d / "route_points.json"),
        project=str(d / "project.json"),
        path_km=round(float(R["sg"][-1] / 1000.0), 3),
        seconds=round(time.time() - t0, 3),
        waypoints=None,
    )
