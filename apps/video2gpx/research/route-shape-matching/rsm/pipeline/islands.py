# SPDX-License-Identifier: AGPL-3.0-or-later
"""Island refinement ("good middle, bad end", GOTTHARD_DIAGNOSIS section 4 and 7), a step at the end of the local pass (local.py), behind LOCAL_ISL_ON.

Islands: stretches the search and the local pass agree on (<= LOCAL_SAME_M), with all turn landmarks explained by the local route, local posterior >=
LOCAL_ISL_CONF, odometry usable >= LOCAL_ISL_USABLE, at least LOCAL_ISL_MIN_LM landmarks or LOCAL_ISL_CURVE_M of curved road. They stay fixed.
Everything else is re-decided part by part with MORE road classes (LOCAL_EXT_CLASSES_*: the search map keeps few classes to stay small; a start in a
residential street, a short detour or an end through a pedestrian zone is not in it):

- bridge = between two islands (both ends anchored: the part's steps start and end at the island steps next to it);
- tail = between an island and the start / end of the video (one anchor; the free end is searched in the reach disc: nominal distance x kappa x
  LOCAL_ISL_REACH_X around the anchor, at most LOCAL_ISL_REACH_MAX_M, not the 300 m corridor of a route that may be wrong by kilometres);
- hypotheses: the search route, the local route, and up to LOCAL_ISL_K alternatives (free decode, then again with the previous best forbidden in the middle
  of the part); every hypothesis is scored with the same HMM and the anchors, with a separate distance scale for the part only (LOCAL_ISL_SCALES, log-normal
  prior LOCAL_ISL_SCALE_SD; never a separate f_eff);
- decision: (1) fewer unexplained landmarks, (2) otherwise higher score by >= LOCAL_ACCEPT_NATS, (3) otherwise the search route stays and the part is marked
  uncertain (local.kept_search -> confidence cap and status route_disputed in steps_c).
The final route is one decode on the union grid with the islands and the chosen hypotheses as step anchors.
"""
from __future__ import annotations

import dataclasses
from pathlib import Path

import numpy as np

from rsm.hmm import grid
from rsm.hmm_cal import dp
from rsm.network.graph import NetGraph
from rsm.refine import pathctx

from . import config as C, hints as HI, osm
from .common import data_dir, file_sig, sha


EXTRA_HYP = None


def runs_of(mask, t, min_s=0.0):
    e = np.diff(np.concatenate([[0], np.asarray(mask, np.int8), [0]]))
    return [(int(a), int(b) - 1) for a, b in zip(np.flatnonzero(e == 1), np.flatnonzero(e == -1)) if t[b - 1] - t[a] >= min_s]


def island_mask(st, near_search, p_vit, usable, lm_ok, curved_m, n_lm) -> np.ndarray:
    """islands over the steps. near_search, lm_ok (False on the steps of an unexplained landmark): bool (T,); p_vit, usable: (T,); curved_m(i, j) -> metres of
    curved road in steps i..j; n_lm(i, j) -> landmarks inside"""
    good = np.asarray(near_search, bool) & (np.nan_to_num(np.asarray(p_vit, float)) >= C.LOCAL_ISL_CONF) & (np.asarray(usable, float) >= C.LOCAL_ISL_USABLE) & np.asarray(lm_ok, bool)
    out = np.zeros(len(good), bool)
    for a, b in runs_of(good, st.t):
        if n_lm(a, b) >= C.LOCAL_ISL_MIN_LM or curved_m(a, b) >= C.LOCAL_ISL_CURVE_M:
            out[a:b + 1] = True
    return out


def parts_of(isl: np.ndarray, t) -> list[tuple[str, int, int]]:
    """(kind, a, b) of the open parts as step slices a..b INCLUDING the anchor steps: a bridge starts at the last island step before it and ends at the first
    after it; a tail has one anchor (start tail: a = 0, end tail: b = T - 1)"""
    T_ = len(isl)
    out = []
    for i, j in runs_of(~isl, t):
        if t[min(j + 1, T_ - 1)] - t[max(i - 1, 0)] < C.LOCAL_EXT_MIN_S:
            continue
        if i == 0 and j == T_ - 1:
            continue                                             # no island at all
        kind = "start" if i == 0 else "end" if j == T_ - 1 else "bridge"
        out.append((kind, max(i - 1, 0), min(j + 1, T_ - 1)))
    return out


def decide(hyps: list[dict], nats: float | None = None) -> tuple[int, bool]:
    """hyps: dict(name, unexplained, score); hyps[0] is the search route. -> (index chosen, uncertain). (1) fewer unexplained landmarks, (2) >= nats better,
    (3) otherwise the search route, uncertain if another hypothesis comes close"""
    nats = C.LOCAL_ACCEPT_NATS if nats is None else nats
    ok = [i for i, h in enumerate(hyps) if np.isfinite(h["score"])]
    if not ok:
        return 0, True
    m = min(hyps[i]["unexplained"] for i in ok)
    best_lm = [i for i in ok if hyps[i]["unexplained"] == m]
    best = max(best_lm, key=lambda i: hyps[i]["score"])
    s0 = hyps[0]
    if 0 not in best_lm:                                         # the search route leaves more landmarks unexplained
        return best, False
    if best != 0 and hyps[best]["score"] >= s0["score"] + nats:
        return best, False
    close = any(i != 0 and hyps[i]["score"] > s0["score"] - nats and not hyps[i].get("same_as_search") for i in best_lm)
    return 0, bool(close)


def slice_steps(st, a: int, b: int, scale: float = 1.0):
    kw = {f: np.asarray(getattr(st, f))[a:b + 1] for f in ("t", "dth", "mu", "rel", "v", "gap", "seg")}
    kw["mu"] = kw["mu"] * scale
    if getattr(st, "jump", None) is not None:
        jm = np.asarray(st.jump, bool)[a:b + 1].copy()
        jm[0] = False
        kw["jump"] = jm if jm.any() else None
    return st.copy(**kw)


def ext_graph(d, P, box, cls):
    f = data_dir(d) / f"graph_localx_{sha(file_sig(P['pbf']), box, list(cls), 'local_graphx1', *osm.rules_token(cls))}.npz"
    if f.exists():
        return NetGraph.load(f)
    gx = osm.build_graph(*osm.extract(P["pbf"], cls, {"x": box})["x"])
    gx.save(f)
    return gx


def refine_islands(d: Path, P: dict, W, g, E, route: dict, vehicle: str, st, tracks, gl, G, r, fb, lxy, dense, box, cons):
    """-> (dict(gl, Ec, G, pre, r, fb, step_ok, sm, em, cost, lxy, uncertain=[dict(t0, t1)]) or None, info)"""
    from pyproj import Transformer
    from scipy.spatial import cKDTree

    from . import local as L
    from . import odofail as OF
    k, a_ang = float(route["kappa"]), float(route["a_ang"])
    cp = r["cell_path"]
    okc = cp >= 0
    info = dict(islands=[], parts=[])
    # --- islands
    near = np.zeros(st.T, bool)
    near[okc] = cKDTree(dense).query(G.xy[cp[okc]])[0] <= C.LOCAL_SAME_M
    csv = Path(d) / "motion" / "motion.csv"
    if csv.exists():
        from rsm.odometry import gating
        from rsm.odometry.vms_csv import load_pairs
        p = load_pairs(str(csv))
        usable = OF.quality(p, gating.pair_flags(p))["usable"](st.t, C.ODO_LOW_WIN_S)
    else:
        usable = np.ones(st.T)
    lms = L.turn_landmarks(tracks, a_ang, k)
    line_l = _line_of_grid(gl, G, cp, st.t)
    lm_ok = np.ones(st.T, bool)
    for x in lms:
        if not L.explains(line_l, x):
            lm_ok[(st.t >= x["t0"] - 1) & (st.t <= x["t1"] + 1)] = False
    dth = np.abs(np.nan_to_num(a_ang * np.asarray(st.dth, float)))
    curved = (dth >= np.radians(C.LOCAL_ISL_CURVE_DEG)) * np.asarray(st.mu, float) * k
    n_lm = lambda i, j: sum(1 for x in lms if x["t0"] >= st.t[i] and x["t1"] <= st.t[j])
    isl = island_mask(st, near, fb["p_vit"], usable, lm_ok, lambda i, j: float(curved[i:j + 1].sum()), n_lm)
    info["islands"] = [[float(np.floor(st.t[i])), float(np.ceil(st.t[j]))] for i, j in runs_of(isl, st.t)]
    parts = parts_of(isl, st.t)
    if not isl.any() or not parts:
        return None, dict(info, skipped="no island" if not isl.any() else "nothing open")
    # --- one graph with all extra classes for the union box of the parts (tails: reach disc)
    cls = L.ext_classes_for(vehicle)
    ll_loc = gl.to_wgs84(G.xy[np.maximum(cp, 0)])
    reach = {}
    for kind, a, b in parts:
        if kind != "bridge":
            nom = float(np.asarray(st.mu)[a + 1:b + 1].sum())
            reach[(a, b)] = min(nom * k * C.LOCAL_ISL_REACH_X, C.LOCAL_ISL_REACH_MAX_M)
    pad = max([C.LOCAL_EXT_BUF_M] + list(reach.values())) + 300.0
    m = pad / 111195.0
    cosl = np.cos(np.radians(0.5 * (box["south"] + box["north"])))
    bx = {kk: round(v, 4) for kk, v in dict(south=box["south"] - m, north=box["north"] + m, west=box["west"] - m / cosl, east=box["east"] + m / cosl).items()}
    gx = ext_graph(d, P, bx, cls)
    to_x = Transformer.from_crs("EPSG:4326", gx.crs, always_xy=True)
    loc_xy = np.column_stack(to_x.transform(ll_loc[:, 0], ll_loc[:, 1]))
    sll = gl.to_wgs84(lxy)
    sxy = np.column_stack(to_x.transform(sll[:, 0], sll[:, 1]))
    line_s = L._route_line(g, E, C.H * k, route["step_cell"], route["step_t"])
    s_at = np.interp(st.t, line_s[2], line_s[1])
    sll_t = g.to_wgs84(line_s[0].xy_at(s_at))
    srch_xy = np.column_stack(to_x.transform(sll_t[:, 0], sll_t[:, 1]))     # search route position per step
    allE = np.arange(gx.n_edges)
    hw_all = np.asarray(gx.edge_highway)
    loc_cls = set(L.classes_for(vehicle))

    def cost_of(Ex):
        return L.class_cost(gx, Ex, vehicle, ext=True)
    h = C.LOCAL_D0 * k
    par = dataclasses.replace(dp.Par(**C.UTURN_PAR), a_ang=a_ang, kappa=k)
    R = C.LOCAL_ACCEPT_R_M
    choice_xy = {}                        # step -> position the final decode must be near
    uncertain = []
    part_edges = []
    exy = None
    for kind, a, b in parts:
        if kind == "bridge":
            Ex = HI.corridor_edges(gx, allE, [srch_xy[a:b + 1], loc_xy[a:b + 1]], C.LOCAL_EXT_BUF_M)
        else:
            anc = loc_xy[b] if kind == "start" else loc_xy[a]
            if exy is None:
                mids = np.array([0.5 * (gx.geom(e)[0] + gx.geom(e)[-1]) for e in allE])
                exy = mids
            Ex = allE[np.hypot(*(exy - anc).T) <= reach[(a, b)]]
            Ex = np.union1d(Ex, HI.corridor_edges(gx, allE, [srch_xy[a:b + 1], loc_xy[a:b + 1]], C.LOCAL_EXT_BUF_M))
        if len(Ex) == 0:
            continue
        Gp = grid.build(gx, Ex, h=h, sm=10.0 * k, edge_cost=cost_of(Ex), **C.UTURN)
        try:
            grid.check_budget(Gp.N, b - a + 1, cap_gb=C.HMM_CAP_GB, bp_bytes=2, forward_backward=False, checkpointed=True)
        except MemoryError:
            info["parts"].append(dict(kind=kind, t0=float(st.t[a]), t1=float(st.t[b]), skipped="too large"))
            continue
        pre = dp.prepare(Gp, par)
        nb = lambda xy: np.hypot(Gp.xy[:, 0] - xy[0], Gp.xy[:, 1] - xy[1]) <= R
        fsm, fem = L.frame_masks(gx, Gp, cons)
        base_m = {}
        if kind in ("bridge", "end"):
            base_m[0] = nb(loc_xy[a])
        if kind in ("bridge", "start"):
            base_m[b - a] = nb(loc_xy[b])
        s_ok = fsm if kind == "start" else None
        e_ok = fem if kind == "end" else None
        if kind == "start":
            disc = (np.hypot(*(Gp.xy - loc_xy[b]).T) <= reach[(a, b)]) | nb(srch_xy[0]) | nb(loc_xy[0])   # the search and local starts stay possible
            s_ok = disc if s_ok is None else (s_ok & disc)
        along = lambda P_: {jj - a: nb(P_[jj]) for jj in range(a + 1, b, 2)}
        lm_in = [x for x in lms if x["t1"] >= st.t[a] and x["t0"] <= st.t[b]]

        def run(masks, scale):
            ss = slice_steps(st, a, b, scale)
            rr = dp.viterbi(pre, ss, backptr=True, start_ok=s_ok, end_ok=e_ok, step_ok={**base_m, **masks})
            sc = float(rr["score"]) - 0.5 * (np.log(scale) / C.LOCAL_ISL_SCALE_SD) ** 2 if np.isfinite(rr["score"]) else -np.inf
            return sc, rr["cell_path"]

        def best_over_scales(masks):
            res = [(run(masks, s), s) for s in C.LOCAL_ISL_SCALES]
            (sc, cpath), s = max(res, key=lambda x: x[0][0])
            return sc, cpath, s
        hyps = []
        for name, masks in (("search", along(srch_xy)), ("local", along(loc_xy)), ("free", {})):
            sc, cpath, s = best_over_scales(masks)
            hyps.append(dict(name=name, score=sc, path=cpath, scale=s))
        # diverse alternatives: the best decode that may not use the roads of any route found so far (cells within LOCAL_SAME_M of them) during one window
        # of LOCAL_ISL_ALT_WIN of the part; the windows spread over the part (two routes usually share roads near the anchors and differ in between)
        n_ = b - a
        for q in range(C.LOCAL_ISL_K):
            used = np.concatenate([x["path"] for x in hyps if x["path"] is not None])
            excl = cKDTree(Gp.xy[np.unique(used)]).query(Gp.xy)[0] > C.LOCAL_SAME_M
            c0 = (q + 0.5) / C.LOCAL_ISL_K
            j0, j1 = max(1, int(n_ * (c0 - C.LOCAL_ISL_ALT_WIN / 2))), min(n_ - 1, int(n_ * (c0 + C.LOCAL_ISL_ALT_WIN / 2)))
            sc, cpath, s = best_over_scales({jj: excl for jj in range(j0, j1 + 1)})
            if cpath is not None:
                hyps.append(dict(name=f"alt{q + 1}", score=sc, path=cpath, scale=s))
        # shape hypothesis: decoded with the distance nearly free (relative sd LOCAL_ISL_SHAPE_REL on every step), so the turns choose the roads and not a
        # distance the odometry may have missed (Gotthard: the shorter bypass absorbs the missing kilometre); then scored like the others, forced along it
        ss = slice_steps(st, a, b).copy(rel=np.maximum(np.asarray(st.rel)[a:b + 1], C.LOCAL_ISL_SHAPE_REL))
        rs = dp.viterbi(pre, ss, backptr=True, start_ok=s_ok, end_ok=e_ok, step_ok=base_m)
        if rs["cell_path"] is not None and np.isfinite(rs["score"]):
            pxy = np.zeros((st.T, 2))
            pxy[a:b + 1] = Gp.xy[rs["cell_path"]]
            sc, cpath, s = best_over_scales(along(pxy))
            hyps.append(dict(name="shape", score=sc, path=cpath, scale=s))
        if EXTRA_HYP is not None:                                  # diagnostics only (a reference route per step, ext CRS); never set by the pipeline
            sc, cpath, s = best_over_scales(along(EXTRA_HYP(gx.crs, st.t)))
            hyps.append(dict(name="reference", score=sc, path=cpath, scale=s))
        ts = st.t[a:b + 1]
        sline = _xy_line(srch_xy[a:b + 1])
        for x in hyps:
            if x["path"] is None:
                x["unexplained"] = len(lm_in) + 1
                continue
            line = _line_of_grid(gx, Gp, x["path"], ts)
            x["unexplained"] = int(sum(not L.explains(line, y) for y in lm_in))
            x["same_as_search"] = bool(np.median(cKDTree(sline).query(Gp.xy[x["path"]])[0]) <= C.LOCAL_SAME_M)
        i, unc = decide(hyps)
        ch = hyps[i]
        names = np.asarray(gx.edge_name)
        ce = Gp.cell_edge

        def name_of(pth):
            nm = [str(z) for z in names[ce[pth]] if str(z)] if pth is not None else []
            return max(sorted(set(nm)), key=nm.count) if nm else ""
        info["parts"].append(dict(kind=kind, t0=float(np.floor(st.t[a])), t1=float(np.ceil(st.t[b])), chosen=ch["name"], uncertain=unc, scale=ch["scale"],
                                  landmarks=len(lm_in), hyps=[dict(name=x["name"], score=round(x["score"], 1), unexplained=x["unexplained"], scale=x["scale"],
                                                                   road=name_of(x["path"])) for x in hyps]))
        if ch["path"] is None:
            continue
        pxy = Gp.xy[ch["path"]]
        for jj in range(a + 1, b, 2):
            choice_xy[jj] = pxy[jj - a]
        if kind == "start":
            choice_xy[0] = pxy[0]
        if kind == "end":
            choice_xy[st.T - 1] = pxy[-1]
        if unc:
            uncertain.append(dict(t0=float(np.floor(st.t[a])), t1=float(np.ceil(st.t[b])), margin_nats=float(max([x["score"] for x in hyps[1:]] or [-np.inf]) - hyps[0]["score"]),
                                  landmarks=len(lm_in), unexplained_local=int(hyps[1]["unexplained"]), unexplained_search=int(hyps[0]["unexplained"]), accepted=False,
                                  name_local=name_of(hyps[1]["path"])))
        part_edges.append(Ex)
    if not part_edges:
        return None, dict(info, skipped="no part decoded")
    changed = [p_ for p_ in info["parts"] if p_.get("chosen") not in (None, "local") or p_.get("uncertain")]
    if not changed:
        return None, dict(info, skipped="local route chosen everywhere")
    # --- final decode on the union grid with the islands and the chosen hypotheses as anchors
    Ef = np.union1d(HI.corridor_edges(gx, allE[np.isin(hw_all, list(loc_cls))], [sxy, loc_xy], C.LOCAL_BUF_M), np.unique(np.concatenate(part_edges)))
    cost = cost_of(Ef)
    Gf = grid.build(gx, Ef, h=h, sm=10.0 * k, edge_cost=cost, **C.UTURN)
    grid.check_budget(Gf.N, st.T, cap_gb=C.HMM_CAP_GB, bp_bytes=2, forward_backward=True, checkpointed=True)
    pref = dp.prepare(Gf, par)
    nbf = lambda xy: np.hypot(Gf.xy[:, 0] - xy[0], Gf.xy[:, 1] - xy[1]) <= R
    step_ok = {j: nbf(loc_xy[j]) for j in range(1, st.T, 2) if isl[j] and cp[j] >= 0}
    step_ok.update({j: nbf(xy) for j, xy in choice_xy.items() if j > 0})
    fsm, fem = L.frame_masks(gx, Gf, cons)
    sm = nbf(choice_xy[0]) if 0 in choice_xy else nbf(loc_xy[0])
    sm = sm if fsm is None else sm & fsm
    rf = dp.viterbi(pref, st, backptr=True, start_ok=sm, end_ok=fem, step_ok=step_ok)
    if rf["cell_path"] is None or not np.isfinite(rf["score"]):
        return None, dict(info, skipped="final decode infeasible")
    fbf = dp.forward_backward(pref, st, rf["cell_path"], start_ok=sm, end_ok=fem, step_ok=step_ok)
    return dict(gl=gx, Ec=Ef, G=Gf, pre=pref, r=rf, fb=fbf, step_ok=step_ok, sm=sm, em=fem, cost=cost, lxy=sxy, uncertain=uncertain), info


def _xy_line(xy):
    from . import local as L
    return L._densify(np.asarray(xy, float), 2.0) if len(xy) > 1 else np.asarray(xy, float)


def _line_of_grid(gx, Gp, cells, t):
    """(Path, arc per step, times) of a decoded path on grid Gp (as local._route_line, from the grid's own cell layout)"""
    cells = np.asarray(cells)
    ok = cells >= 0
    path, s = pathctx.build_path(gx, Gp.cell_edge[cells[ok]], Gp.off[cells[ok]])
    return path, np.asarray(s, float), np.asarray(t, float)[ok] + 1e-6 * np.arange(int(ok.sum()))
