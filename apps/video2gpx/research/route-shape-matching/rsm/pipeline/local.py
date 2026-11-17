# SPDX-License-Identifier: AGPL-3.0-or-later
"""Local pass: the route of the search is decoded once more, in a corridor around it, with all drivable road classes and finer steps.

Why: the search map keeps only the main road classes for a motorised vehicle (it must stay small over a large area), and its step is 30 m nominal
(about 80 m for a motorcycle). In town that loses the true way (a roundabout whose exits are residential streets is a dead end in the search map)
and two turns 15 s apart fall into one step and cancel. Inside a narrow corridor both are cheap.

Same model and calibration as the search (f_eff, kappa fixed from it); the corridor only adds roads near the found route, so the pass cannot move the
route far away. If the corridor problem is infeasible (start / end frame unreachable, broken corridor) the search route is kept.
"""
from __future__ import annotations

import dataclasses
import time
from pathlib import Path

import numpy as np

from rsm.hmm import grid
from rsm.hmm_cal import dp
from rsm.network.graph import NetGraph
from rsm.refine import pathctx

from . import config as C, hints as HI, odofail as OF, osm, tracks as T
from .common import Worker, data_dir, file_sig, sha
from .steps_b import decode_route, frame_masks


def search_path(g, E, route):
    """polyline (graph CRS) of the decoded search route"""
    cell_edge, cell_off = pathctx.cell_layout(g, E, C.H * route["kappa"])
    c = route["step_cell"]
    path, _ = pathctx.build_path(g, cell_edge[c], cell_off[c])
    return path.xy


def minor_cost(gl, Ec, vehicle: str):
    """nats per metre on the roads the search map leaves out (residential etc. for a motor vehicle): a through-route prefers the main road, so a parallel side
    street of the same direction (Menton: Avenue Cernuschi next to Cours René Coty, 7.5 nats apart over 1 km) needs evidence of its own. None if off."""
    if C.LOCAL_MINOR_NATS_PER_KM <= 0:
        return None
    base = set(C.CLASSES_BIKE if vehicle == "bike" else C.CLASSES_MOTOR)
    minor = ~np.isin(np.asarray(gl.edge_highway)[Ec], list(base))
    return np.where(minor, C.LOCAL_MINOR_NATS_PER_KM / 1000.0, 0.0)


def classes_for(vehicle: str) -> tuple:
    base = C.CLASSES_BIKE if vehicle == "bike" else C.CLASSES_MOTOR
    return tuple(sorted(set(base) | set(C.LOCAL_EXTRA)))


def corridor_graph(d: Path, P: dict, W: Worker, g, E, route, vehicle: str, progress):
    """-> (local graph, corridor edge ids, info). Reads the pbf once for the route's box (cached in the data dir)."""
    xy = search_path(g, E, route)
    ll = g.to_wgs84(xy)
    buf = C.LOCAL_BUF_M
    m_lat = (buf + 300.0) / 111195.0
    m_lon = m_lat / np.cos(np.radians(ll[:, 1].mean()))
    box = dict(south=float(ll[:, 1].min() - m_lat), north=float(ll[:, 1].max() + m_lat), west=float(ll[:, 0].min() - m_lon), east=float(ll[:, 0].max() + m_lon))
    box = {k: round(v, 4) for k, v in box.items()}
    cls = classes_for(vehicle)
    cache = data_dir(d)
    key = sha(file_sig(P["pbf"]), box, list(cls), "local_graph1", *osm.rules_token(cls))   # rule token only for bike-path classes: road keys unchanged
    f = cache / f"graph_local_{key}.npz"
    if f.exists():
        gl = NetGraph.load(f)
        progress(1.0)
    else:
        ex = osm.extract(P["pbf"], cls, {"local": box}, progress)
        gl = osm.build_graph(*ex["local"])
        gl.save(f)
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", gl.crs, always_xy=True)
    lx, ly = tr.transform(ll[:, 0], ll[:, 1])
    Ec = HI.corridor_edges(gl, np.arange(gl.n_edges), [np.column_stack([lx, ly])], buf)
    info = dict(box=box, classes=list(cls), buffer_m=buf, graph_edges=int(gl.n_edges), corridor_edges=int(len(Ec)),
                corridor_km=float(np.asarray(gl.edge_len)[Ec].sum() / 2000), search_path_km=float(np.hypot(*np.diff(xy, axis=0).T).sum() / 1000))
    return gl, Ec, np.column_stack([lx, ly]), info


def local_pass(d: Path, P: dict, W: Worker, g, E, tracks, route: dict, vehicle: str, progress=lambda f, label: None, gap_nom=None):
    """-> (route dict in the format of route_search/route.pkl plus d0 / h / local info, local graph, corridor edges, steps) or None (keep the search route)"""
    t0 = time.time()
    k = float(route["kappa"])
    gl, Ec, lxy, info = corridor_graph(d, P, W, g, E, route, vehicle, lambda f: progress(0.5 * f, "corridor"))
    if len(Ec) == 0:
        W.log("warn", "local pass: no road in the corridor; the search route is kept")
        return None, info
    st = OF.build(tracks, str(d / "motion" / "motion.csv"), d0=C.LOCAL_D0, measure_gaps=True)[0] if C.ODO_FAIL_ON else T.steps_of(tracks, d0=C.LOCAL_D0, gap_nom=gap_nom)
    h = C.LOCAL_D0 * k
    cost = minor_cost(gl, Ec, vehicle)
    G = grid.build(gl, Ec, h=h, sm=10.0 * k, edge_cost=cost)
    grid.check_budget(G.N, st.T, cap_gb=C.HMM_CAP_GB, bp_bytes=2, forward_backward=True)
    par = dataclasses.replace(dp.Par(), a_ang=float(route["a_ang"]), kappa=k)
    pre = dp.prepare(G, par)
    sm, em = frame_masks(gl, G, route.get("cons"))
    progress(0.6, "decode")
    # the corridor fixes the roads but not the time: on a road ridden in both directions the local decode could start kilometres away from the search route and
    # catch up later (Pontaix, FINDINGS "Regression bench"). Its first cell therefore stays within LOCAL_END_TOL_M of the start of the search route. The end stays
    # free: anchoring it too moved the timing of the last 500 s of Roanne (along-track p90 8.6 -> 51 m).
    r, anchored = None, False
    if C.LOCAL_END_TOL_M > 0 and len(lxy) >= 2:
        sa, ea = end_masks(G, lxy, C.LOCAL_END_TOL_M)
        sa, ea = (sa if sm is None else sa & sm), em
        if sa.any():
            r = dp.viterbi(pre, st, backptr=True, start_ok=sa, end_ok=ea)
            anchored = r["cell_path"] is not None and bool(np.isfinite(r["score"]))
            if anchored:
                sm, em = sa, ea
    info["ends_anchored"] = anchored
    if not anchored:
        r = dp.viterbi(pre, st, backptr=True, start_ok=sm, end_ok=em)
    if r["cell_path"] is None or not np.isfinite(r["score"]):
        W.log("warn", "local pass: no route through the corridor (start / end frame or a broken corridor); the search route is kept")
        info["infeasible"] = True
        return None, info
    from scipy.spatial import cKDTree
    dense = _densify(lxy, 2.0)
    # acceptance test: a long change to another road must be supported by the video (turns) and by the score
    step_ok, info["kept_search"], info["accept_tested"] = None, [], []
    if C.LOCAL_ACCEPT_ON:
        progress(0.7, "acceptance test")
        step_ok, info["accept_tested"] = acceptance(g, E, route, gl, Ec, G, pre, st, tracks, r, sm, em, dense)
        info["kept_search"] = [x for x in info["accept_tested"] if not x["accepted"]]
        if step_ok:
            r2 = dp.viterbi(pre, st, backptr=True, start_ok=sm, end_ok=em, step_ok=step_ok)
            if r2["cell_path"] is not None and np.isfinite(r2["score"]):
                r = r2
            else:
                W.log("warn", "local pass: the search route could not be followed in the corridor; the local route is kept")
                step_ok, info["kept_search"] = None, []
    progress(0.8, "posterior")
    fb = dp.forward_backward(pre, st, r["cell_path"], start_ok=sm, end_ok=em, step_ok=step_ok)
    if C.LOCAL_ISL_ON:
        from . import islands as I
        progress(0.85, "islands")
        isl, info["islands"] = I.refine_islands(d, P, W, g, E, route, vehicle, st, tracks, gl, G, r, fb, lxy, dense, info["box"], route.get("cons"))
        if isl is not None:
            gl, Ec, G, pre, r, fb, step_ok, sm, em, cost, lxy = (isl[x] for x in ("gl", "Ec", "G", "pre", "r", "fb", "step_ok", "sm", "em", "cost", "lxy"))
            dense = _densify(lxy, 2.0)
            info["kept_search"] = sorted(info["kept_search"] + isl["uncertain"], key=lambda x: x["t0"])
        for p_ in info["islands"].get("parts", []):
            W.log("info", f"islands: {p_['kind']} {p_['t0']:.0f}-{p_['t1']:.0f} s: " + (p_.get("skipped") or f"{p_['chosen']}{' (uncertain)' if p_['uncertain'] else ''}, scale {p_['scale']:.2f}; "
                  + ", ".join(f"{h['name']} {h['score']:.1f} nats / {h['unexplained']} unexplained ({h['road'] or '?'})" for h in p_["hyps"])))
    t, cells = decode_route(G, st, r["cell_path"])
    # how much of the route changed: local cell centres farther than LOCAL_SAME_M from the search path
    dist, _ = cKDTree(dense).query(G.xy[cells])
    changed = float((dist > C.LOCAL_SAME_M).mean())
    loc = dict(route)
    loc.update(step_t=t, step_cell=cells, score=float(r["score"]), score_per_km=float(r["score"] / st.km), km=float(st.km), cells=int(G.N), steps=int(st.T),
               post=dict(t=st.t, p_vit=fb["p_vit"], p_max=fb["p_max"]), conf_mean=float(np.nanmean(fb["p_vit"])), conf_below_half=float(np.nanmean(fb["p_vit"] < 0.5)),
               d0=C.LOCAL_D0, h=h, local=True)
    info.update(changed_share=changed, changed_max_m=float(dist.max()), cells=int(G.N), steps=int(st.T), conf_mean=loc["conf_mean"])
    # A3: the same decode without the road-class prior. Where the two routes differ, only the prior decided (two parallel streets of the same direction).
    info["prior_decided"] = []
    if cost is not None and np.any(cost > 0):
        progress(0.95, "prior check")
        r0 = dp.viterbi(dp.prepare(grid.build(gl, Ec, h=h, sm=10.0 * k), par), st, backptr=True, start_ok=sm, end_ok=em, step_ok=step_ok)
        if r0["cell_path"] is not None and np.isfinite(r0["score"]):
            _, cells0 = decode_route(G, st, r0["cell_path"])
            info["prior_decided"] = prior_decided(gl, G, Ec, t, cells, cells0, same_m=C.PRIOR_DECIDED_SAME_M)
            info["prior_score_gain_nats"] = float(r0["score"] - r["score"])
    info["seconds"] = time.time() - t0
    return (loc, gl, Ec, st), info


def ext_classes_for(vehicle: str) -> tuple:
    """road classes of the island refinement (islands.py): the local classes plus LOCAL_EXT_CLASSES_* (service, pedestrian; tracks and paths for a bike)"""
    extra = C.LOCAL_EXT_CLASSES_BIKE if vehicle == "bike" else C.LOCAL_EXT_CLASSES_MOTOR
    return tuple(sorted(set(classes_for(vehicle)) | set(extra)))


def end_masks(G, lxy: np.ndarray, tol_m: float):
    """(start_ok, end_ok) over the cells of G: cell centre within tol_m of the first / last point of the search route"""
    xy = np.asarray(G.xy)
    return np.hypot(*(xy - lxy[0]).T) <= tol_m, np.hypot(*(xy - lxy[-1]).T) <= tol_m


def turn_landmarks(tracks, a_ang: float, kappa: float) -> list[dict]:
    """strong turns of the video: heading change >= LM_MIN_DEG within LM_WIN_M of real distance (LM_WIN_M / kappa nominal), inside one vms track (no gap).
    -> [dict(t0, t1, dth)] (video seconds, rad, left +), strongest first within a track, non-overlapping"""
    out = []
    lim = np.radians(C.LM_MIN_DEG)
    for tr in tracks:
        s, th, t = (np.asarray(tr[x], float) for x in ("s", "th", "t"))
        ds = float(np.median(np.diff(s))) if len(s) > 1 else T.DS
        n = max(1, int(round(C.LM_WIN_M / kappa / ds)))
        if len(s) <= n:
            continue
        d = a_ang * (th[n:] - th[:-n])
        taken = np.zeros(len(d), bool)
        for i in np.argsort(-np.abs(d), kind="stable"):
            if abs(d[i]) < lim:
                break
            if taken[max(0, i - n):i + n + 1].any():
                continue
            taken[i] = True
            out.append(dict(t0=float(t[i]), t1=float(t[i + n]), dth=float(d[i])))
    return sorted(out, key=lambda x: x["t0"])


def _route_line(gl, edges, h, cells, t):
    """(Path, arc of every step, times) of a decoded route on the grid layout (edges, h)"""
    ce, co = pathctx.cell_layout(gl, edges, h)
    ok = np.asarray(cells) >= 0
    path, s = pathctx.build_path(gl, ce[np.asarray(cells)[ok]], co[np.asarray(cells)[ok]])
    return path, np.asarray(s, float), np.asarray(t, float)[ok] + 1e-6 * np.arange(int(ok.sum()))


def explains(line, lm: dict) -> bool:
    """does the road of the route turn like the landmark (same sign and angle within the tolerance), measured over the landmark window or a grown one"""
    path, s, t = line
    if lm["t1"] < t[0] or lm["t0"] > t[-1]:
        return True                                   # outside the decoded span: not judged
    s0, s1 = np.interp([lm["t0"], lm["t1"]], t, s)
    tol = max(np.radians(C.LM_TOL_DEG), C.LM_TOL_REL * abs(lm["dth"]))
    for e in (0.0, C.LM_EXT_M):
        p0, p1 = np.interp([s0 - e, s1 + e], path.sg, path.phi)
        if abs(lm["dth"] - (p1 - p0)) <= tol:
            return True
    return False


def acceptance(g, E, route, gl, Ec, G, pre, st, tracks, r, sm, em, dense):
    """Acceptance test of the local pass. Stretches of at least LOCAL_ACCEPT_MIN_S where the local route is farther than LOCAL_SAME_M from the search route are
    tested: the local route is accepted there only if it leaves no more turn landmarks unexplained than the search route and beats the local decode forced
    along the search route (every second step within LOCAL_ACCEPT_R_M) by LOCAL_ACCEPT_NATS. Why: on Gotthard the local pass replaced the correct way
    through Andermatt by a shorter parallel bypass, bought with the distance the odometry missed on the next road, leaving two right turns of 90-110 degrees
    unexplained (docs/GOTTHARD_DIAGNOSIS.md). -> (step masks for the stretches where the search route is kept, or None; one dict per tested stretch)"""
    from pyproj import Transformer
    from scipy.spatial import cKDTree
    cp = r["cell_path"]
    ok = cp >= 0
    far = np.zeros(st.T, bool)
    far[ok] = cKDTree(dense).query(G.xy[cp[ok]])[0] > C.LOCAL_SAME_M
    runs = []
    for j in np.nonzero(far)[0]:
        if runs and st.t[j] - st.t[runs[-1][1]] < 10.0:      # short agreements (< 10 s) do not split a stretch
            runs[-1][1] = int(j)
        else:
            runs.append([int(j), int(j)])
    runs = [(i, j) for i, j in runs if st.t[j] - st.t[i] >= C.LOCAL_ACCEPT_MIN_S]
    if not runs:
        return None, []
    k, a_ang = float(route["kappa"]), float(route["a_ang"])
    lms = turn_landmarks(tracks, a_ang, k)
    line_l = _route_line(gl, Ec, G.h, cp, st.t)
    line_s = _route_line(g, E, C.H * k, route["step_cell"], route["step_t"])
    tr = Transformer.from_crs("EPSG:4326", gl.crs, always_xy=True)
    names = np.asarray(gl.edge_name)
    ce_l, _ = pathctx.cell_layout(gl, Ec, G.h)
    out, keep = [], {}
    for i, j in runs:
        t0, t1 = float(st.t[i]), float(st.t[j])
        inside = [x for x in lms if x["t1"] >= t0 and x["t0"] <= t1]
        n_l = sum(not explains(line_l, x) for x in inside)
        n_s = sum(not explains(line_s, x) for x in inside)
        masks = {}
        for jj in range(max(i - 1, 1), j + 1, 2):
            ss = np.interp(st.t[jj], line_s[2], line_s[1])
            ll = g.to_wgs84(line_s[0].xy_at(np.array([ss])))
            px, py = tr.transform(ll[:, 0], ll[:, 1])
            masks[jj] = np.hypot(G.xy[:, 0] - px[0], G.xy[:, 1] - py[0]) <= C.LOCAL_ACCEPT_R_M
        fr = dp.viterbi(pre, st, start_ok=sm, end_ok=em, step_ok=masks)
        margin = float(r["score"] - fr["score"]) if np.isfinite(fr["score"]) else float("inf")
        accepted = bool(n_l <= n_s and margin >= C.LOCAL_ACCEPT_NATS)
        nm = [str(x) for x in names[ce_l[cp[i:j + 1][cp[i:j + 1] >= 0]]] if str(x)]
        out.append(dict(t0=float(np.floor(t0)), t1=float(np.ceil(t1)), margin_nats=margin, landmarks=len(inside), unexplained_local=int(n_l), unexplained_search=int(n_s),
                        accepted=accepted, name_local=max(sorted(set(nm)), key=nm.count) if nm else ""))
        if not accepted and np.isfinite(fr["score"]):
            keep.update(masks)
    return (keep or None), out


def prior_decided(gl, G, Ec, t, cells, cells0, same_m: float | None = None, min_s: float | None = None) -> list[dict]:
    """stretches where the route decoded WITH the road-class prior (cells) lies more than same_m away from the route decoded WITHOUT it (cells0): there the video
    heading did not choose the street, the prior did. -> [dict(t0, t1, length_m, name_with, name_without)] (video seconds; names = the most frequent street name)"""
    from scipy.spatial import cKDTree
    same_m = C.LOCAL_SAME_M if same_m is None else same_m
    min_s = C.PRIOR_DECIDED_MIN_S if min_s is None else min_s
    xy = np.asarray(G.xy)
    p0 = _densify(xy[cells0], 2.0) if len(cells0) > 1 else xy[cells0]
    tree0 = cKDTree(p0)
    far = tree0.query(xy[cells])[0] > same_m
    cell_edge, _ = pathctx.cell_layout(gl, Ec, G.h)
    names = np.asarray(gl.edge_name)
    aligned = len(cells0) == len(cells)                                        # same steps: the alternative at the same video time

    def name_of(cc):
        nm = [str(x) for x in names[cell_edge[np.asarray(cc, np.int64)]] if str(x)]
        return max(sorted(set(nm)), key=nm.count) if nm else ""

    out, i, n = [], 0, len(cells)
    t = np.asarray(t, float)
    while i < n:
        if not far[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and far[j + 1]:
            j += 1
        if t[j] - t[i] >= min_s:
            seg = xy[cells[i:j + 1]]
            out.append(dict(t0=float(np.floor(t[i])), t1=float(np.ceil(t[j])), length_m=float(np.hypot(*np.diff(seg, axis=0).T).sum()) if len(seg) > 1 else 0.0,
                            name_with=name_of(cells[i:j + 1]), name_without=name_of(cells0[i:j + 1]) if aligned else ""))
        i = j + 1
    return out


def _densify(xy, step):
    out = [xy[:1]]
    for a, b in zip(xy[:-1], xy[1:]):
        n = max(1, int(np.hypot(*(b - a)) // step))
        out.append(a + (b - a) * (np.arange(1, n + 1)[:, None] / n))
    return np.vstack(out)
