# SPDX-License-Identifier: AGPL-3.0-or-later
"""Workers of steps 3 to 5: map (local pbf -> graphs, decoy boxes), route search (wide f_eff x kappa scan, decode, posterior), plausibility (19 decoys, verdict)."""
from __future__ import annotations

import dataclasses
import multiprocessing as mp
import pickle
import resource
import time
from pathlib import Path

import numpy as np

from rsm.hmm import grid, seq
from rsm.hmm_cal import dp
from rsm.network.graph import NetGraph

from . import anchors as AN, calib as CB, config as C, hints as HI, odofail as OF, osm, tracks as T, verdict as V
from .common import Worker, data_dir, file_sig, jdump, jload, sha


# ------------------------------------------------------------------ 3 map
def map_step(d: Path, P: dict, W: Worker):
    out = d / "map"
    out.mkdir(exist_ok=True)
    vj = jload(d / "rotation" / "vehicle.json")
    veh = vj["effective"]
    roads = C.CLASSES_BIKE if veh == "bike" else C.CLASSES_MOTOR
    paths_search, paths_fallback = bike_paths_mode(vj, P.get("bike_paths"))
    if P.get("bike_paths") in ("on", "fallback") and veh != "bike":
        W.log("info", f"--bike-paths {P['bike_paths']} has no effect: the vehicle is a {veh} (bike paths are searched for a bike only)")
    classes = C.CLASSES_BIKE_PATHS if paths_search else roads
    pbf, bbox = P["pbf"], P["bbox"]
    cache = data_dir(d)
    info = osm.pbf_info(pbf)
    if info["box"]:
        b = info["box"]
        if not (bbox["west"] >= b["west"] and bbox["east"] <= b["east"] and bbox["south"] >= b["south"] and bbox["north"] <= b["north"]):
            raise RuntimeError(f"the area {bbox} is not inside the extract {b}: download the map data for this area")
    D = osm.density(pbf, roads, cache, lambda f: W.progress(20 * f, "read"))      # road density only: foreign boxes as before, also with paths
    real_km = osm._box_km(D, bbox)
    if not np.isfinite(real_km) or real_km < 5:
        raise RuntimeError(f"no road data in the area ({real_km} km of {veh} roads): wrong area or extract")
    fb = osm.foreign_boxes(D, bbox, info["box"])
    if len(fb) < C.N_FOREIGN:
        W.log("warn", f"only {len(fb)} foreign decoy boxes of similar road density found in the extract (3 wanted); more shuffles replace the missing ones")
    boxes = {"real": bbox, **{f["name"]: f["bbox"] for f in fb}}
    sets = {k: (b, classes) for k, b in boxes.items()}
    if paths_fallback:
        sets["paths"] = (bbox, C.CLASSES_BIKE_PATHS)
    gkey = {k: sha(file_sig(pbf), b, sorted(cl), "graph1", *osm.rules_token(cl)) for k, (b, cl) in sets.items()}
    has = lambda k: (cache / f"graph_{gkey[k]}.npz").exists() and (not osm.rules_token(sets[k][1]) or (cache / f"tiers_{gkey[k]}.npy").exists())
    need = {k: v for k, v in sets.items() if not has(k)}
    if need:
        union = tuple(sorted(set().union(*(cl for _, cl in need.values()))))
        ex = osm.extract(pbf, union, {k: b for k, (b, _) in need.items()}, lambda f: W.progress(20 + 40 * f, "filter"))   # one pass for all class sets
        for i, (k, (ways, nodes)) in enumerate(ex.items()):
            ways, nodes = osm.subset(ways, nodes, need[k][1])
            g = osm.build_graph(ways, nodes)
            g.save(cache / f"graph_{gkey[k]}.npz")
            if osm.rules_token(need[k][1]):
                np.save(cache / f"tiers_{gkey[k]}.npy", osm.edge_tiers(g, ways))
            W.progress(60 + 35 * (i + 1) / len(ex), "graph")
    tiers_of = lambda k, g: np.load(cache / f"tiers_{gkey[k]}.npy") if osm.rules_token(sets[k][1]) else np.zeros(g.n_edges, np.int8)
    st = OF.route_steps(d)
    res = dict(vehicle=veh, classes=list(classes), bbox=bbox, pbf=file_sig(pbf), pbf_timestamp=info["timestamp"], real_road_km=real_km, foreign=[], steps=int(st.T))
    tmax = None                                   # bike-path tier kept in the real box (None: all); the decoy boxes keep the same tiers
    for k, b in boxes.items():
        g = NetGraph.load(cache / f"graph_{gkey[k]}.npz")
        E = osm.edges_in_bbox(g, b)
        if len(E) == 0:
            raise RuntimeError(f"no road edges in box {k}")
        tiers = tiers_of(k, g)
        if k == "real":
            E_all = E
            try:
                E, tmax = fit_search(g, E, tiers, st.T)
            except MemoryError:
                if not P.get("hint"):
                    raise                         # with a hint the corridor may still fit (the fallback on the whole frame is then not possible, logged)
            if P.get("hint"):                     # the corridor is cut from ALL tiers of the frame, then fitted to the cap on its own (F1)
                E = _corridor(d, P, W, g, E_all, st.T, res, out, E_fallback=E)
                if paths_search:
                    E, tc = fit_search(g, E, tiers, st.T)
                    res["bike_paths"] = dict(_tier_info(g, E, tiers, tc, mode="search"), area="hint corridor", frame_kept=tmax)
                    _tier_status(W, res["bike_paths"])
            elif paths_search:
                res["bike_paths"] = dict(_tier_info(g, E, tiers, tmax, mode="search"), area="search frame")
                _tier_status(W, res["bike_paths"])
        else:
            E = keep_tiers(g, E, tiers, tmax)
        try:
            plan = osm.memory_plan(g, E, st.T)
        except MemoryError as e:
            if k == "real":
                raise
            W.log("warn", f"decoy box {k} dropped: {e}")
            continue
        g.save(out / f"graph_{k}.npz")
        np.save(out / f"edges_{k}.npy", E)
        rec = dict(name=k, bbox=b, edges=int(len(E)), directed_km=float(np.asarray(g.edge_len)[E].sum() / 1000), plan=plan)
        if k == "real":
            res["real"] = rec
            W.log("info", f"map: {rec['edges']} edges, {rec['directed_km']:.0f} directed km, HMM arrays <= {plan['gb']:.2f} GB (cap {C.HMM_CAP_GB})")
        else:
            meta = next(f for f in fb if f["name"] == k)
            res["foreign"].append(dict(rec, road_km=meta["km"], density_ratio=meta["ratio"]))
    if paths_fallback:                            # map for the bike-path fallback of route_search (whole frame, or the hint corridor with a hint; no decoys)
        g = NetGraph.load(cache / f"graph_{gkey['paths']}.npz")
        E = osm.edges_in_bbox(g, bbox)
        tiers = tiers_of("paths", g)
        area = "search frame"
        if P.get("hint"):
            Ec = HI.corridor_edges(g, E, HI.project_lines(HI.read_hint(P["hint"]), g.crs), float(P["hint_buffer_m"]))
            if len(Ec):
                E, area = Ec, "hint corridor"
        try:
            E, tp = fit_search(g, E, tiers, st.T)
        except MemoryError as e:
            W.log("warn", f"no bike-path fallback possible: {e}")
            res["bike_paths"] = dict(mode="fallback", possible=False, area=area)
        else:
            g.save(out / "graph_paths.npz")
            np.save(out / "edges_paths.npy", E)
            res["bike_paths"] = dict(_tier_info(g, E, tiers, tp, mode="fallback"), possible=True, area=area, edges=int(len(E)), directed_km=float(np.asarray(g.edge_len)[E].sum() / 1000),
                                     plan=osm.memory_plan(g, E, st.T))
    res["peak_rss_gb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2 ** 30
    jdump(out / "map.json", res)
    W.progress(100.0, "done", force=True)
    return dict(edges=res["real"]["edges"], directed_km=res["real"]["directed_km"], n_foreign=len(res["foreign"]), vehicle=veh)


def fit_tiers(g, E, tiers, T_steps: int, cap_gb: float = C.HMM_CAP_GB):
    """RULE. The edges of the frame that fit the HMM memory cap: all of them if they fit, else the bike-path tiers (osm.bike_tier) are given up from the
    highest down until the plan fits; tier 0 (roads, cycleways, bicycle=designated) is never given up (then the MemoryError of memory_plan stands).
    -> (edges, highest tier kept or None when nothing was given up)"""
    try:
        osm.memory_plan(g, E, T_steps, cap_gb)
        return E, None
    except MemoryError:
        if len(E) == 0 or int(tiers[E].max()) == 0:
            raise
    for t in range(int(tiers[E].max()) - 1, -1, -1):
        Et = E[tiers[E] <= t]
        try:
            osm.memory_plan(g, Et, T_steps, cap_gb)
            return Et, t
        except MemoryError:
            if t == 0:
                raise
    raise AssertionError("unreachable")


def fit_search(g, E, tiers, T_steps: int, cap_gb: float = C.HMM_CAP_GB):
    """fit_tiers, and if even tier 0 is too large while the map holds bike paths: the roads alone (tier -1: no path class at all), so an area too large for
    paths still gets the road search (status bike_paths, problem). Without paths in E this is fit_tiers (MemoryError when the roads do not fit)."""
    try:
        return fit_tiers(g, E, tiers, T_steps, cap_gb)
    except MemoryError:
        road = ~np.isin(np.asarray(g.edge_highway)[E], C.BIKE_PATH_CLASSES)
        if road.all() or not road.any():
            raise
        osm.memory_plan(g, E[road], T_steps, cap_gb)
        return E[road], -1


def keep_tiers(g, E, tiers, tmax):
    """the edges of E within the kept bike-path tier (fit_search): all for None, the roads only for -1"""
    if tmax is None:
        return E
    if tmax < 0:
        return E[~np.isin(np.asarray(g.edge_highway)[E], C.BIKE_PATH_CLASSES)]
    return E[tiers[E] <= tmax]


def bike_paths_mode(vj: dict, mode: str | None = None) -> tuple[bool, bool]:
    """RULE (maintainer, 2026-11-13). -> (search with paths, fallback with paths). Paths only for a bike. `mode` = the run option --bike-paths (F1): "on" = the
    search map holds the paths, "fallback" = a second search with paths when the road result is not confident, "off" = roads only; for a bike whether explicit
    or estimated. Without the option (None) the config decides as before: in the search map when the user chose the bike profile (C.BIKE_PATHS_ON); as a second
    search when the vehicle was estimated (auto) as a bike (C.BIKE_PATHS_FALLBACK). Motorcycle and car never."""
    if vj["effective"] != "bike":
        return False, False
    if mode is not None:
        if mode not in C.BIKE_PATHS_MODES:
            raise ValueError(f"bike_paths must be one of {C.BIKE_PATHS_MODES}, not {mode!r}")
        return mode == "on", mode == "fallback"
    if vj.get("requested") == "bike":
        return bool(C.BIKE_PATHS_ON), False
    return False, bool(C.BIKE_PATHS_FALLBACK)


_TIER_TEXT = ("roads, cycleways and paths signed bicycle=designated", "those and ways with bicycle=yes", "those and grade 1-2 tracks", "those and paved paths")
_TIER_ROADS = -1                                  # fit_search: not even tier 0 fits, the roads alone are searched


def _tier_info(g, E, tiers, tmax, mode: str) -> dict:
    ln = np.asarray(g.edge_len)
    on_path = np.isin(np.asarray(g.edge_highway)[E], C.BIKE_PATH_CLASSES)
    return dict(mode=mode, kept=tmax, path_km=float(ln[E][on_path].sum() / 2000))


def res_score(info: dict, k: str) -> str:
    return f"{info[k + '_score_per_km']:.1f} nats/km"


def _tier_status(W: Worker, info: dict):
    """status `bike_paths` when paths were given up for the memory cap (only for a map that is searched)"""
    where = "the route-hint corridor" if info.get("area") == "hint corridor" else "the search area"
    if info.get("kept") == _TIER_ROADS:
        msg = f"{where} is too large for bike paths within the memory limit: only roads are searched; a smaller area or a route hint keeps the paths"
        W.log("warn", msg)
        W.status("bike_paths", "problem", -1.0, msg)
    elif info.get("kept") is not None:
        msg = (f"{where} is too large for all bike paths within the memory limit: only {_TIER_TEXT[info['kept']]} are searched ({info['path_km']:.0f} km of paths); "
               "a smaller area or a route hint keeps them all")
        W.log("warn", msg)
        W.status("bike_paths", "difficult", float(info["kept"]), msg)


def _corridor(d: Path, P: dict, W: Worker, g, E_full, T_steps: int, res: dict, out: Path, E_fallback=None):
    """route hint: keep the edges within the buffer of the hint (plus connections). The edge set of the whole frame (E_fallback: the frame cut to the memory
    cap by fit_tiers; default E_full) stays in edges_full.npy for the fallback. -> the edge set of the 'real' box"""
    E_fb = E_full if E_fallback is None else E_fallback
    lines = HI.read_hint(P["hint"])
    lxy = HI.project_lines(lines, g.crs)
    buf = float(P["hint_buffer_m"])
    Ec = HI.corridor_edges(g, E_full, lxy, buf)
    ln = np.asarray(g.edge_len)
    ms = jload(d / "motion" / "summary.json")
    nominal = float(ms["nominal_km"])
    need = nominal * C.K_LO
    full_km = float(ln[E_full].sum() / 2000)
    info = dict(buffer_m=buf, file=Path(P["hint"]).name, n_lines=len(lines), full_edges=int(len(E_full)), full_km=full_km, nominal_km=nominal, needed_km=need, empty=len(Ec) == 0)
    if len(Ec) == 0:
        if P.get("hint_fallback", "auto") == "off":
            raise RuntimeError(f"no road within {buf:.0f} m of the route hint in the search area: check the hint or widen the buffer")
        W.log("warn", f"no road within {buf:.0f} m of the route hint: the hint is ignored and the full search frame is used")
        W.status("hint_corridor", "problem", 0.0, f"no road within {buf:.0f} m of the route hint; hint ignored, full search frame used")
        info.update(corridor_edges=0, corridor_km=0.0, level="problem")
        Ec = E_fb
    else:
        ckm = float(ln[Ec].sum() / 2000)
        q = ckm / max(need, 1e-9)
        lev = "good" if q >= 1.2 else "difficult"
        info.update(corridor_edges=int(len(Ec)), corridor_km=ckm, ratio=q, level=lev)
        W.status("hint_corridor", lev, q, f"corridor of {buf:.0f} m around the route hint: {ckm:.0f} road km (of {full_km:.0f} km in the frame), the route needs at least {need:.0f} km"
                 + ("" if lev == "good" else ": the corridor is thin, the hint may be too narrow or wrong"))
    try:
        osm.memory_plan(g, E_fb, T_steps)
        np.save(out / "edges_full.npy", E_fb)
    except MemoryError as e:
        W.log("warn", f"hint fallback not possible: {e}")
        info["full_frame_possible"] = False
    res["hint"] = info
    return Ec


# ------------------------------------------------------------------ HMM scan helpers
_G: dict = {}


def load_map(d: Path, name: str):
    g = NetGraph.load(d / "map" / f"graph_{name}.npz")
    return g, np.load(d / "map" / f"edges_{name}.npy")


def grid_for(g, E, k):
    return grid.build(g, E, h=C.H * k, sm=10.0 * k)


def _job(a):
    pre, st = _G["pre"], _G["st"]
    fi, f = a
    par = dataclasses.replace(pre.par, a_ang=C.F_REF / f)
    p = dp.Prepared(pre.grid, par)
    p.par = par
    return fi, dp.viterbi(p, st, start_ok=_G.get("sm"), end_ok=_G.get("em"))["score"]


def frame_masks(g, G, cons):
    """(start_ok, end_ok) bool arrays over the cells of grid G for the start / end frame (None when not given); cons = dict(start, end, tol) or None"""
    if not cons:
        return None, None
    return HI.cell_mask(g, G, cons.get("start"), cons.get("tol", 0.0)), HI.cell_mask(g, G, cons.get("end"), cons.get("tol", 0.0))


def _memo_key(pre, st, masks) -> str:
    """DEVELOPMENT ONLY (RSM_SCAN_MEMO=1, set by the regression bench): exact key of a scan score without f: the transition tables of the grid, the HMM
    parameters except a_ang, the steps and the frame masks, and the code of the HMM. The app never sets the variable, so its behaviour is unchanged."""
    import hashlib
    h = hashlib.sha256()
    G = pre.grid
    for a in (G.xy, G.edges, G.cell_ei, G.phi):
        h.update(np.ascontiguousarray(a).tobytes())
    for gr in G.groups:
        for a in (gr.src, gr.ud, gr.D, gr.dphi, gr.w, gr.starts):
            h.update(np.ascontiguousarray(a).tobytes())
    h.update(repr(dataclasses.replace(pre.par, a_ang=0.0)).encode())
    for a in (st.t, st.dth, st.mu, st.rel, st.v, st.gap):
        h.update(np.ascontiguousarray(a).tobytes())
    for m in (masks or (None, None)):
        h.update(b"-" if m is None else np.packbits(np.asarray(m, bool)).tobytes())
    for f in (dp.__file__, grid.__file__, seq.__file__):
        h.update(Path(f).read_bytes())
    h.update(repr(C.F_REF).encode())
    h.update(AN.key().encode())
    return h.hexdigest()[:20]


def scan_kappa(pre, st, k, fvals, on_done=None, procs=C.MAX_WORKERS, masks=None):
    """best-path log score for every f in fvals at one kappa (+ ln kappa per transition: probability per cell, comparable across kappa).
    With RSM_SCAN_MEMO=1 (bench only) scores already computed for the same key are reused (docs/CONCEPT_fast_testing.md, block B)."""
    import json
    import os
    memo_f, memo = None, {}
    if os.environ.get("RSM_SCAN_MEMO") == "1":
        memo_f = data_dir(Path(os.environ.get("RSM_DATA_DIR", "."))) / "scan_memo" / f"{_memo_key(pre, st, masks)}.json"
        memo = json.loads(memo_f.read_text()) if memo_f.exists() else {}
    out = np.full(len(fvals), np.nan)
    todo = []
    for fi, f in enumerate(fvals):
        if repr(float(f)) in memo:
            out[fi] = memo[repr(float(f))] + (st.T - 1) * np.log(k)
            if on_done:
                on_done()
        else:
            todo.append((fi, f))
    if todo:
        _G["pre"], _G["st"] = pre, st
        _G["sm"], _G["em"] = masks if masks else (None, None)
        with mp.get_context("fork").Pool(min(procs, C.MAX_WORKERS, len(todo))) as pool:
            for fi, sc in pool.imap_unordered(_job, todo):
                out[fi] = sc + (st.T - 1) * np.log(k)
                memo[repr(float(fvals[fi]))] = float(sc)
                if on_done:
                    on_done()
        if memo_f is not None:
            memo_f.parent.mkdir(parents=True, exist_ok=True)
            tmp = memo_f.with_suffix(".tmp")
            tmp.write_text(json.dumps(memo))
            tmp.replace(memo_f)
    return out


def scan_full(pres_or_gen, st, on_done=None, g=None, cons=None, kg=None):
    kg = C.K_GRID if kg is None else kg
    S = np.full((len(C.F_GRID), len(kg)), np.nan)
    for ki, pre in enumerate(pres_or_gen):
        S[:, ki] = scan_kappa(pre, st, kg[ki], C.F_GRID, on_done, masks=frame_masks(g, pre.grid, cons) if cons else None)
    return S


def prepared_gen(g, E, kg=None):
    for k in (C.K_GRID if kg is None else kg):
        yield dp.prepare(grid_for(g, E, k), dp.Par(kappa=k))


def base_k_grid(vehicle: str | None) -> tuple:
    """F5: the base kappa grid of the scan for the effective vehicle: C.K_GRID_BIKE (one step below K_LO) for a bike, C.K_GRID otherwise"""
    return C.K_GRID_BIKE if vehicle == "bike" else C.K_GRID


def surface(S, km, fg=None, kg=None) -> dict:
    fg = C.F_GRID if fg is None else fg
    kg = C.K_GRID if kg is None else kg
    A = S / km
    fi, ki = np.unravel_index(np.nanargmax(A), A.shape)
    nb = [A[a, b] for a, b in ((fi - 1, ki), (fi + 1, ki), (fi, ki - 1), (fi, ki + 1)) if 0 <= a < A.shape[0] and 0 <= b < A.shape[1]]
    return dict(best=float(A[fi, ki]), fi=int(fi), ki=int(ki), f=fg[fi], kappa=kg[ki], interior_f=bool(0 < fi < A.shape[0] - 1), interior_kappa=bool(0 < ki < A.shape[1] - 1),
                neighbour_mean=float(np.mean(nb)), median_all=float(np.nanmedian(A)), best_minus_median=float(A[fi, ki] - np.nanmedian(A)))


def extend_scan(S, fg, kg, score, km, kappa_ok=None, cell_ok=None):
    """Adaptive calibration grid. If the best cell lies on the edge of the f_eff or kappa grid, add C.EXT_STEPS rows / columns beyond that edge in log steps of the same ratio
    (hard limits C.F_EXT / C.K_EXT), repeat while the peak stays on an edge, at most C.EXT_MAX rounds. score(f_list, k_list) -> matrix (len f, len k) of best-path scores
    (with the ln kappa term). kappa_ok(k) may refuse a kappa (memory). cell_ok(f, k) marks the physically plausible cells (calib.py): then the best PLAUSIBLE cell
    decides whether an edge is extended, and a new row / column without any plausible cell is not scanned. -> (S, f_grid, k_grid, notes)"""
    rf = C.F_GRID[1] / C.F_GRID[0]
    rk = C.K_GRID[1] / C.K_GRID[0]
    fg, kg, notes = list(fg), list(kg), []
    for rnd in range(C.EXT_MAX):
        sf = surface(S, km, fg, kg)
        if cell_ok is not None:
            fi_, ki_ = CB.best_cell(S, np.array([[cell_ok(f, k) for k in kg] for f in fg], bool))
            sf = dict(fi=fi_, ki=ki_)
        new_f, f_low, new_k, k_low = [], False, [], False
        if sf["fi"] == 0:
            new_f = [fg[0] / rf ** j for j in range(C.EXT_STEPS, 0, -1) if fg[0] / rf ** j >= C.F_EXT[0] * 0.999]
            f_low = True
        elif sf["fi"] == len(fg) - 1:
            new_f = [fg[-1] * rf ** j for j in range(1, C.EXT_STEPS + 1) if fg[-1] * rf ** j <= C.F_EXT[1] * 1.001]
        if sf["ki"] == 0:
            new_k = [kg[0] / rk ** j for j in range(C.EXT_STEPS, 0, -1) if kg[0] / rk ** j >= C.K_EXT[0] * 0.999 and (kappa_ok is None or kappa_ok(kg[0] / rk ** j))]
            k_low = True
        elif sf["ki"] == len(kg) - 1:
            new_k = [kg[-1] * rk ** j for j in range(1, C.EXT_STEPS + 1) if kg[-1] * rk ** j <= C.K_EXT[1] * 1.001 and (kappa_ok is None or kappa_ok(kg[-1] * rk ** j))]
        if cell_ok is not None:
            new_f = [f for f in new_f if any(cell_ok(f, k) for k in kg)]
            new_k = [k for k in new_k if any(cell_ok(f, k) for f in fg + new_f)]
        if not new_f and not new_k:
            break
        if new_f:
            rows = score(new_f, kg)
            S, fg = (np.vstack([rows, S]), new_f + fg) if f_low else (np.vstack([S, rows]), fg + new_f)
        if new_k:
            cols = score(fg, new_k)
            S, kg = (np.hstack([cols, S]), new_k + kg) if k_low else (np.hstack([S, cols]), kg + new_k)
        notes.append(f"round {rnd + 1}: " + ", ".join(x for x in (f"f_eff {'down' if f_low else 'up'} to {(fg[0] if f_low else fg[-1]):.0f}" if new_f else "", f"kappa {'down' if k_low else 'up'} to {(kg[0] if k_low else kg[-1]):.2f}" if new_k else "") if x))
    return S, fg, kg, notes


def decode_route(G, st, cell_path):
    ok = cell_path >= 0
    t = st.t[ok] + 1e-6 * np.arange(int(ok.sum()))
    return t, cell_path[ok]


# ------------------------------------------------------------------ 4 route search
def _cons_of(P: dict, active: bool = True):
    """frame constraints of the run (None when there are none or they were dropped)"""
    if not active or not (P.get("start_bbox") or P.get("end_bbox")):
        return None
    return dict(start=P.get("start_bbox"), end=P.get("end_bbox"), tol=float(P.get("start_tol_m", C.START_TOL_M)))


class _Ticks:
    """progress of one route search: finished HMM runs of the expected total (the total grows when the grid is extended); the scan takes 0 to 88 %"""

    def __init__(self, W: Worker, label: str, total: int):
        self.W, self.label, self.total, self.n = W, label, total, 0

    def __call__(self):
        self.n += 1
        self.W.progress(min(88.0, 88.0 * self.n / self.total), self.label)


def _scan(g, E, st, cons, tick, cell_ok=None, kg0=None):
    """the calibration surface: coarse scan over C.F_GRID x kg0 (default C.K_GRID; a bike: base_k_grid) plus the adaptive grid extension. A kappa of kg0 below
    C.K_GRID[0] is scanned only if its HMM arrays fit the memory cap. -> (S, f_grid, k_grid, notes), or None if the frames make the problem infeasible.
    S[fi, ki] = best-path score (with the ln kappa term). The speed work may reorder or parallelise this freely as long as S stays bit-identical."""

    def kappa_ok(k):
        return osm.n_cells(g, E, C.H * k) * st.T * 4 / 1e9 <= C.HMM_CAP_GB       # same memory rule as the map step, for kappa below the scan

    kg = [k for k in (C.K_GRID if kg0 is None else kg0) if k >= C.K_GRID[0] or kappa_ok(k)]
    tick.total += len(C.F_GRID) * (len(kg) - len(C.K_GRID))
    S = scan_full(prepared_gen(g, E, kg), st, tick, g=g, cons=cons, kg=kg)
    if cons and not np.isfinite(np.nanmax(S)):
        return None

    def score(fv, kv):
        tick.total += len(fv) * len(kv)
        out = np.full((len(fv), len(kv)), np.nan)
        for j, k in enumerate(kv):
            pre = dp.prepare(grid_for(g, E, k), dp.Par(kappa=k))
            out[:, j] = scan_kappa(pre, st, k, fv, tick, masks=frame_masks(g, pre.grid, cons) if cons else None)
        return out

    return extend_scan(S, C.F_GRID, kg, score, st.km, kappa_ok, cell_ok)


def _refine_at(g, E, st, cons, s0: float, f0: float, k0: float, tick):
    """local refinement around one scan cell (f0, k0) with score s0: C.REFINE_K x C.REFINE_F. -> (score, f_eff, kappa) of the best"""
    best = (s0, f0, k0)
    for kr in C.REFINE_K:
        k = k0 * kr
        pre = dp.prepare(grid_for(g, E, k), dp.Par(kappa=k))
        fv = [f0 * x for x in C.REFINE_F]
        sc = scan_kappa(pre, st, k, fv, tick, masks=frame_masks(g, pre.grid, cons) if cons else None)
        for f, s_ in zip(fv, sc):
            if s_ > best[0]:
                best = (s_, f, k)
    return best


def _decode_at(P: dict, W: Worker, g, E, st, cons, f_eff: float, kappa: float):
    """decode (Viterbi with back pointers) and posterior (forward-backward) at one calibration. -> the decode part of the result dict, or None if infeasible"""
    W.progress(88.0, "decode", force=True)
    G = grid_for(g, E, kappa)
    par = dataclasses.replace(dp.Par(), a_ang=C.F_REF / f_eff, kappa=kappa)
    pre = dp.prepare(G, par)
    sm, em = frame_masks(g, G, cons)
    grid.check_budget(G.N, st.T, cap_gb=C.HMM_CAP_GB, bp_bytes=2, forward_backward=True)
    r = dp.viterbi(pre, st, backptr=True, start_ok=sm, end_ok=em)
    if r["cell_path"] is None or not np.isfinite(r["score"]):
        return None
    W.progress(93.0, "posterior", force=True)
    fb = dp.forward_backward(pre, st, r["cell_path"], start_ok=sm, end_ok=em)
    t, cells = decode_route(G, st, r["cell_path"])
    xy = G.xy[cells]
    ll = g.to_wgs84(xy)
    bb = P["bbox"]
    cosl = np.cos(np.radians(0.5 * (bb["north"] + bb["south"])))
    dmin = 111195 * np.minimum.reduce([(ll[:, 0] - bb["west"]) * cosl, (bb["east"] - ll[:, 0]) * cosl, ll[:, 1] - bb["south"], bb["north"] - ll[:, 1]])
    edge_share = float((dmin < 300).mean())
    return dict(step_t=t, step_cell=cells, f_eff=f_eff, kappa=kappa, a_ang=par.a_ang, score=float(r["score"]), score_per_km=float(r["score"] / st.km), km=float(st.km),
                cells=int(G.N), steps=int(st.T),
                post=dict(t=st.t, p_vit=fb["p_vit"], p_max=fb["p_max"]), conf_mean=float(np.nanmean(fb["p_vit"])), conf_below_half=float(np.nanmean(fb["p_vit"] < 0.5)),
                edge_share=edge_share, _ll=ll, _xy=xy)


def vehicle_from_calibration(kappa: float, v90_nominal: float, estimate: str) -> str:
    """the vehicle the calibration says (config VEH_*): "motorcycle" (motor vehicle) if kappa or the real p90 speed is high, "bike" if both are low,
    else the estimate"""
    v90 = float(v90_nominal) * float(kappa)
    if kappa >= C.VEH_K_MOTOR or v90 >= C.VEH_V90_MOTOR:
        return "motorcycle"
    if kappa <= C.VEH_K_BIKE and v90 <= C.VEH_V90_BIKE:
        return "bike"
    return estimate


def motor_posterior(d, P, W, g, E, st, res, xy, cons_used):
    """GOTTHARD_DIAGNOSIS 3 / 7: --vehicle auto estimated a bike (search map with residential streets) but the calibration says motor vehicle
    (vehicle_from_calibration, as vehicle_final.json). The bike map's posterior then spreads over dense residential meshes far away (Gotthard: 0.00 on the right route,
    the mass in Ulrichen) and the verdict says no_route. The motor classes are a subset of the bike map (no map rebuild): decode once more on that subset at
    the same calibration; if the route stays the same (>= VERDICT_MOTOR_SAME of the steps within LOCAL_SAME_M), its posterior is the one the verdict uses.
    The route itself is not changed. -> dict(same_share, conf_mean, conf_below_half, used, post) or None"""
    f_veh = Path(d) / "rotation" / "vehicle.json"
    if not C.VERDICT_MOTOR_POST or not f_veh.exists():
        return None
    vj = jload(f_veh)
    if vj.get("requested") != "auto" or vj.get("effective") != "bike":
        return None
    if vehicle_from_calibration(float(res["kappa"]), float(jload(Path(d) / "motion" / "summary.json").get("v_nom_p90", 0.0)), "bike") == "bike":
        return None
    Em = np.asarray(E)[np.isin(np.asarray(g.edge_highway)[np.asarray(E)], list(C.CLASSES_MOTOR))]
    if len(Em) == 0 or len(Em) == len(E):
        return None
    dec = _decode_at(P, W, g, Em, st, cons_used, float(res["f_eff"]), float(res["kappa"]))
    if dec is None:
        return None
    from scipy.spatial import cKDTree
    same = float((cKDTree(np.asarray(xy)).query(dec["_xy"])[0] <= C.LOCAL_SAME_M).mean())
    out = dict(same_share=same, conf_mean=dec["conf_mean"], conf_below_half=dec["conf_below_half"], used=bool(same >= C.VERDICT_MOTOR_SAME))
    if out["used"]:
        out["post"] = dec["post"]
    return out


def _result(dec: dict, S, fg, kg, ext_notes, sf, st, t0: float) -> dict:
    """the route_search result: the decode at the chosen calibration plus the scan surface (key order as in route.pkl since search1)"""
    head = {k: dec[k] for k in ("step_t", "step_cell", "f_eff", "kappa", "a_ang", "score", "score_per_km", "km")}
    return dict(**head, scan=S, f_grid=tuple(fg), k_grid=tuple(kg), grid_extended=bool(ext_notes), ext_notes=ext_notes, surface=sf, coarse_best_per_km=float(np.nanmax(S) / st.km),
                cells=dec["cells"], steps=dec["steps"], post=dec["post"], conf_mean=dec["conf_mean"], conf_below_half=dec["conf_below_half"],
                edge_share=dec["edge_share"], seconds=time.time() - t0, peak_rss_gb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2 ** 30,
                _ll=dec["_ll"], _xy=dec["_xy"])


def _routes_differ(xy_a, xy_b, tol: float = 300.0, share: float = 0.8) -> bool:
    """two decoded routes are different if less than `share` of the points of one lies within tol m of the other"""
    from scipy.spatial import cKDTree
    return bool((cKDTree(xy_b).query(xy_a)[0] <= tol).mean() < share or (cKDTree(xy_a).query(xy_b)[0] <= tol).mean() < share)


def _search(d: Path, P: dict, W: Worker, g, E, st, cons, label: str = "scan"):
    """one route search (coarse scan, refinement, decode, posterior) on the edge set E with optional start / end frame. None if the frames make the problem infeasible.
    Calibration candidates (calib.py): the first candidate is the best physically plausible cell of the scan (the global maximum on every good dev video). Only if its
    decode is not confident, the other plausible peaks of the surface are decoded too and the best by (verdict, plausible, interior peak) is used.
    The effective vehicle (rotation/vehicle.json) sets the speed limit of the plausibility check (F2, calib.vmax_for) and the base kappa grid (F5, base_k_grid)."""
    tick = _Ticks(W, label, len(C.F_GRID) * len(C.K_GRID) + len(C.REFINE_K) * len(C.REFINE_F))
    t0 = time.time()
    AN.ensure(W, g, E, st, cons)                 # user anchors: drop those no route can satisfy (anchors.py); the rest are masks of every decode
    W.progress(0.0, label, force=True)
    f_tr = Path(d) / "rotation" / "tracks.pkl"
    stats = CB.motion_stats(pickle.load(open(f_tr, "rb"))) if f_tr.exists() else None
    f_veh = Path(d) / "rotation" / "vehicle.json"
    vehicle = jload(f_veh)["effective"] if f_veh.exists() else None
    vmax = CB.vmax_for(vehicle)
    ok = (lambda f, k: CB.plausible(stats, f, k, vmax=vmax)) if stats and stats["n"] else None
    sc = _scan(g, E, st, cons, tick, ok, base_k_grid(vehicle))
    if sc is None:
        return None
    S, fg, kg, ext_notes = sc
    for n_ in ext_notes:
        W.log("info", "calibration grid extended: " + n_)
    mask = CB.plausible_mask(stats, fg, kg, vmax) if ok else np.ones(S.shape, bool)
    cells = CB.candidates(S, mask)
    gfi, gki = CB.best_cell(S)
    W.log("info", f"coarse scan done: best f_eff {fg[cells[0][0]]:.0f} kappa {kg[cells[0][1]]:.2f} at {S[cells[0]] / st.km:.2f} per km, {time.time() - t0:.0f} s"
          + ("" if cells[0] == (gfi, gki) else f" (the highest cell, f_eff {fg[gfi]:.0f} kappa {kg[gki]:.2f} at {S[gfi, gki] / st.km:.2f}, is physically implausible)"))
    ms = rot = None
    if len(cells) > 1:
        ms, rot = jload(d / "motion" / "summary.json"), jload(d / "rotation" / "summary.json")["features"]
    found = []
    for i, (fi, ki) in enumerate(cells):
        if i:
            tick.total += len(C.REFINE_K) * len(C.REFINE_F)
        sf = CB.surface_at(S, st.km, fg, kg, fi, ki)
        _, f_eff, kappa = _refine_at(g, E, st, cons, S[fi, ki], sf["f"], sf["kappa"], tick)
        dec = _decode_at(P, W, g, E, st, cons, f_eff, kappa)
        if dec is None:
            if i == 0:
                return None
            continue
        res = _result(dec, S, fg, kg, ext_notes, sf, st, t0)
        pl = bool(ok(f_eff, kappa)) if ok else True
        if not pl:
            res["calibration_implausible"] = True
        m = CB.at(stats, f_eff, kappa) if ok else {}
        v = V.verdict_from(res, ms, rot)["verdict"] if ms is not None else None
        found.append(dict(res=res, info=dict(f_eff=float(f_eff), kappa=float(kappa), cell_f=float(sf["f"]), cell_kappa=float(sf["kappa"]), score_per_km=res["score_per_km"],
                                             coarse_per_km=sf["best"], conf_mean=res["conf_mean"], verdict=v, interior=bool(sf["interior_f"] and sf["interior_kappa"]), plausible=pl,
                                             alat_p95=m.get("alat95"), v_p99=m.get("v99"))))
        if len(cells) == 1 or (i == 0 and v == "confident" and pl):
            break
        W.log("info", f"calibration candidate {i + 1} of {len(cells)}: f_eff {f_eff:.0f} kappa {kappa:.2f}, {res['score_per_km']:.2f} per km, mean posterior {res['conf_mean']:.2f}, {v}")
    pick = CB.choose([dict(rank=V.RANK.get(c["info"]["verdict"], 0), interior=c["info"]["interior"], plausible=c["info"]["plausible"], score_per_km=c["info"]["score_per_km"]) for c in found]) if len(found) > 1 else 0
    res = found[pick]["res"]
    for j, c in enumerate(found):
        c["info"]["chosen"] = j == pick
        if j != pick and c["info"]["verdict"] == "confident" and found[pick]["info"]["verdict"] == "confident" and _routes_differ(res["_xy"], c["res"]["_xy"]):
            res["rival_confident"] = True
    res["candidates"] = [c["info"] for c in found]
    res["calibration"] = dict(n_cells=int(mask.size), n_plausible=int(mask.sum()), global_max=dict(f=float(fg[gfi]), kappa=float(kg[gki]), per_km=float(S[gfi, gki] / st.km), plausible=bool(mask[gfi, gki])),
                              motion=stats, limits=dict(alat_max=C.CAL_ALAT_MAX, vmax=vmax), n_candidates=len(cells), n_decoded=len(found))
    res["k_base"] = tuple(k for k in base_k_grid(vehicle) if k in kg)    # the base kappa grid actually scanned (the decoys scan the same)
    res["seconds"] = time.time() - t0
    return res


def _outside_m(lon, lat, b: dict) -> float:
    """distance in m of a point to a frame (0 inside)"""
    cl = np.cos(np.radians(0.5 * (b["north"] + b["south"])))
    dx = max(b["west"] - lon, 0.0, lon - b["east"]) * 111195 * cl
    dy = max(b["south"] - lat, 0.0, lat - b["north"]) * 111195
    return float(np.hypot(dx, dy))


def _frame_status(W: Worker, name: str, label: str, ll_pt, frame: dict, tol: float):
    dm = _outside_m(ll_pt[0], ll_pt[1], frame)
    if dm <= 0:
        W.status(name, "good", 0.0, f"the decoded {label} lies inside the {label} frame")
    else:
        W.status(name, "difficult", dm, f"the decoded {label} lies {dm:.0f} m outside the {label} frame (within the tolerance of {tol:.0f} m)")


def route_search(d: Path, P: dict, W: Worker):
    out = d / "route_search"
    out.mkdir(exist_ok=True)
    tr = pickle.load(open(d / "rotation" / "tracks.pkl", "rb"))
    st, odo = OF.build(tr, str(d / "motion" / "motion.csv"))
    if odo["spans"]:
        mm = lambda t: f"{int(t) // 60}:{int(t) % 60:02d}"
        W.status("odometry_gaps", "difficult", odo["fail_s"], "the image distance failed (few usable frame pairs) in " + ", ".join(f"{mm(a)}-{mm(b)}" for a, b in odo["spans"][:6])
                 + (f" and {len(odo['spans']) - 6} more" if len(odo["spans"]) > 6 else "") + "; the distance there is estimated from the speeds before and after")
        W.log("info", f"odometry failure: {len(odo['spans'])} stretches, {odo['fail_s']:.0f} s, bridged as gaps; {odo['low_usable_steps']} steps with low usable share widened")
    g, E = load_map(d, "real")
    ms = jload(d / "motion" / "summary.json")
    rot = jload(d / "rotation" / "summary.json")["features"]
    cons = _cons_of(P)
    AN.start(P)
    hint = P.get("hint")
    f_full = d / "map" / "edges_full.npy"
    have_full = bool(hint) and f_full.exists()
    notes = []                                   # what happened with the hints, for the result

    def solve(E_, cons_, label):
        """-> (res, cons_used). Infeasible frames: clear status and the same search without them."""
        r = _search(d, P, W, g, E_, st, cons_, label)
        if r is None and cons_:
            msg = "the start / end frame cannot be reached by any route of this video in the search area; the frames are ignored for this run"
            W.status("start_frame" if cons_.get("start") else "end_frame", "problem", None, msg)
            W.log("warn", msg)
            notes.append("frames_infeasible")
            r = _search(d, P, W, g, E_, st, None, label)
            cons_ = None
        if r is None:
            raise RuntimeError("no route found (the search is infeasible)")
        return r, cons_

    res, cons_used = solve(E, cons, "scan")
    edge_set = "real"
    hint_info = None
    if hint:
        mj = jload(d / "map" / "map.json").get("hint", {})
        v1 = V.verdict_from(res, ms, rot)
        hint_info = dict(file=Path(hint).name, buffer_m=float(P["hint_buffer_m"]), corridor_verdict=v1["verdict"], corridor_score_per_km=res["score_per_km"], corridor_km=mj.get("corridor_km"),
                         fallback=P.get("hint_fallback", "auto"), fallback_used=False, chosen="corridor" if not mj.get("empty") else "full")
        if mj.get("empty"):
            hint_info["chosen"] = "full"
        elif v1["verdict"] != "confident" and P.get("hint_fallback", "auto") == "auto":
            if not have_full:
                W.log("warn", "the corridor result is poor but the full search frame is too large for a fallback run")
                hint_info["fallback_skipped"] = "full frame too large"
            else:
                W.log("warn", f"corridor result is {v1['verdict']}: rerunning the route search once on the full search frame")
                Ef = np.load(f_full)
                res2, cons2 = solve(Ef, cons_used, "fallback")
                v2 = V.verdict_from(res2, ms, rot)
                hint_info.update(fallback_used=True, full_verdict=v2["verdict"], full_score_per_km=res2["score_per_km"])
                better = (V.RANK[v2["verdict"]], res2["score_per_km"]) > (V.RANK[v1["verdict"]], res["score_per_km"])
                if better:
                    res, cons_used, edge_set = res2, cons2, "full"
                    hint_info["chosen"] = "full"
                W.status("hint_corridor", "difficult", None,
                         f"the route search in the hint corridor was {v1['verdict']} ({hint_info['corridor_score_per_km']:.1f} nats/km); the full search frame gave {v2['verdict']} "
                         f"({res2['score_per_km']:.1f} nats/km): the {'full-frame' if better else 'corridor'} result is used")
    paths_info = None
    if (d / "map" / "edges_paths.npy").exists():   # bike-path fallback (map_step, bike_paths_mode): the road result is not confident -> once more with paths
        v1 = V.verdict_from(res, ms, rot)
        paths_info = dict(road_verdict=v1["verdict"], road_score_per_km=res["score_per_km"], used=False, chosen="roads")
        if v1["verdict"] != "confident":
            W.log("warn", f"the road result is {v1['verdict']}: rerunning the route search once with bike paths")
            gp, Ep = load_map(d, "paths")
            r2 = _search(d, P, W, gp, Ep, st, cons_used, "paths")
            if r2 is not None:
                v2 = V.verdict_from(r2, ms, rot)
                paths_info.update(used=True, paths_verdict=v2["verdict"], paths_score_per_km=r2["score_per_km"])
                better = (V.RANK[v2["verdict"]], r2["score_per_km"]) > (V.RANK[v1["verdict"]], res["score_per_km"])
                if better:
                    res, g, edge_set = r2, gp, "paths"
                    paths_info["chosen"] = "paths"
                mp = jload(d / "map" / "map.json").get("bike_paths") or {}
                if better:
                    _tier_status(W, mp)
                W.status("bike_paths", "good" if better and v2["verdict"] == "confident" else "difficult", None,
                         f"the route search on roads was {v1['verdict']} ({res_score(paths_info, 'road')}); with cycleways, paths and tracks it was {v2['verdict']} "
                         f"({res_score(paths_info, 'paths')}): the {'bike-path' if better else 'road'} result is used")
    # ---- statuses of the chosen result
    ll = res.pop("_ll"); xy = res.pop("_xy")
    if cons:
        tol = cons["tol"]
        if cons_used is None:
            pass                                    # a problem status was sent
        else:
            if cons.get("start"):
                _frame_status(W, "start_frame", "start", ll[0], cons["start"], tol)
            if cons.get("end"):
                _frame_status(W, "end_frame", "end", ll[-1], cons["end"], tol)
    if hint:
        from . import hints as H2
        lxy = H2.project_lines(H2.read_hint(hint), g.crs)
        ag = H2.agreement(xy, lxy, float(P["hint_buffer_m"]))
        hint_info["agreement"] = ag
        W.status("hint_agreement", "good" if ag >= 0.8 else "difficult", ag, f"{100 * ag:.0f} % of the decoded route lies within {float(P['hint_buffer_m']):.0f} m of the route hint (information only)")
        if not hint_info["fallback_used"] and hint_info["chosen"] == "corridor":
            W.status("hint_corridor", "good" if (mj.get("level") == "good") else "difficult", mj.get("ratio"),
                     f"route found inside the {float(P['hint_buffer_m']):.0f} m corridor of the hint ({mj.get('corridor_km', 0):.0f} road km)")
    res["edge_set"] = edge_set
    res["bike_paths"] = paths_info
    res["cons"] = cons_used
    if edge_set == "real":
        mpost = motor_posterior(d, P, W, g, E, st, res, xy, cons_used)
        if mpost is not None:
            res["motor_post"] = {k_: v_ for k_, v_ in mpost.items() if k_ != "post"}
            if mpost["used"]:
                res["conf_bikemap"] = dict(conf_mean=res["conf_mean"], conf_below_half=res["conf_below_half"])
                res.update(conf_mean=mpost["conf_mean"], conf_below_half=mpost["conf_below_half"], post=mpost["post"])
            W.log("info", f"vehicle by calibration: motor vehicle (distance scale {res['kappa']:.2f}) on a bike map: posterior on the motor roads {mpost['conf_mean']:.2f} "
                          f"(bike map {res.get('conf_bikemap', {}).get('conf_mean', res['conf_mean']):.2f}), same route {100 * mpost['same_share']:.0f} %: "
                          + ("used for the verdict" if mpost["used"] else "not used"))
    res["hints_used"] = dict(
        start_bbox=[P["start_bbox"][k] for k in ("south", "west", "north", "east")] if P.get("start_bbox") else None,
        end_bbox=[P["end_bbox"][k] for k in ("south", "west", "north", "east")] if P.get("end_bbox") else None,
        frames_applied=bool(cons_used), tol_m=float(P.get("start_tol_m", C.START_TOL_M)) if (P.get("start_bbox") or P.get("end_bbox")) else None,
        hint_file=Path(hint).name if hint else None, buffer_m=float(P["hint_buffer_m"]) if hint else None, fallback_used=bool(hint_info and hint_info["fallback_used"]),
        route_hint_applied=bool(hint_info and hint_info["chosen"] == "corridor"), hint=hint_info, notes=notes) if (hint or cons) else None
    res["anchors"] = AN.report(W, P)
    pickle.dump(res, open(out / "route.pkl", "wb"))
    if res["hints_used"]:
        jdump(out / "hints.json", res["hints_used"])
    sf, f_eff, kappa = res["surface"], res["f_eff"], res["kappa"]
    edge_share = res["edge_share"]
    flat = sf["best_minus_median"]
    inter = sf["interior_f"] and sf["interior_kappa"]
    if not inter and flat < C.PEAK_FLAT[1]:
        lev = "problem"
    elif inter and flat >= C.PEAK_FLAT[0]:
        lev = "good"
    else:
        lev = "difficult"
    ext = f"; scan grid extended to f_eff {min(res['f_grid']):.0f}-{max(res['f_grid']):.0f}, kappa {min(res['k_grid']):.2f}-{max(res['k_grid']):.2f}" if res.get("grid_extended") else ""
    W.status("calibration_peak", lev, flat, f"peak at f_eff {f_eff:.0f}, distance scale {kappa:.2f}; {'interior' if inter else 'at the edge of the scan' + (' (hard limit of the extended grid)' if res.get('grid_extended') else '')}, {flat:.1f} nats/km above the surface median" + ext)
    cal, cands = res.get("calibration"), res.get("candidates") or []
    if cal and (len(cands) > 1 or not cal["global_max"]["plausible"]):
        gm, ch = cal["global_max"], next(c for c in cands if c["chosen"])
        others = [c for c in cands if not c["chosen"]]
        msg = (f"the highest point of the calibration scan (f_eff {gm['f']:.0f}, distance scale {gm['kappa']:.2f}) is physically implausible and was not used; " if not gm["plausible"] else "") \
            + (f"{len(cands)} calibration candidates were decoded; used: f_eff {ch['f_eff']:.0f}, distance scale {ch['kappa']:.2f} ({ch['verdict']}, mean posterior {ch['conf_mean']:.2f}); rejected: "
               + ", ".join(f"f_eff {c['f_eff']:.0f} / {c['kappa']:.2f} ({c['verdict']}, {c['conf_mean']:.2f})" for c in others) if others else f"used: f_eff {ch['f_eff']:.0f}, distance scale {ch['kappa']:.2f}")
        W.status("calibration_choice", "difficult" if (res.get("rival_confident") or ch["verdict"] != "confident") else "good", len(cands), msg)
    elev = "good" if edge_share <= 0.05 else "difficult" if edge_share <= 0.2 else "problem"
    W.status("area_size", elev, edge_share, f"the route is within 300 m of the area edge for {100 * edge_share:.0f} % of the time" + ("" if elev == "good" else ": it may leave the area, try a larger one"))
    veh = jload(d / "rotation" / "vehicle.json")
    if veh["requested"] == "auto":
        k_veh = vehicle_from_calibration(kappa, float(jload(d / "motion" / "summary.json").get("v_nom_p90", 0.0)), veh["effective"])
        if k_veh != veh["effective"]:
            W.log("warn", f"distance scale {kappa:.2f} suggests a {k_veh} but the road classes were chosen for a {veh['effective']}; driving-line default follows the calibration")
        jdump(out / "vehicle_final.json", dict(vehicle=k_veh, from_kappa=True))
    else:
        jdump(out / "vehicle_final.json", dict(vehicle=veh["effective"], from_kappa=False))
    W.progress(100.0, "done", force=True)
    return dict(f_eff=f_eff, kappa=kappa, score_per_km=res["score_per_km"], conf_mean=res["conf_mean"], edge_set=edge_set, hints_used=res["hints_used"], candidates=res.get("candidates"), bike_paths=paths_info, anchors=res["anchors"])


# ------------------------------------------------------------------ 5 plausibility
def families(st, nf):
    n_shuffle = 19 - 2 * nf - 1
    fam = [dict(name=f"shuffle:{i}", fam="shuffle", map="real", st=seq.block_shuffle(st, np.random.default_rng(C.SEED0 + i))) for i in range(n_shuffle)]
    fam.append(dict(name="mirror", fam="mirror", map="real", st=seq.mirror(st)))
    for i in range(nf):
        fam.append(dict(name=f"foreign:f{i}", fam="foreign", map=f"f{i}", st=st))
        fam.append(dict(name=f"foreign+shuffle:f{i}", fam="foreign+shuffle", map=f"f{i}", st=seq.block_shuffle(st, np.random.default_rng(C.SEED0 + 50 + i))))
    return fam


def select_families(fams, n):
    """the first n decoys in the priority order foreign, mirror, foreign+shuffle, shuffle (original order kept for speed: same map consecutive)"""
    if n >= len(fams):
        return fams
    pri = sorted(range(len(fams)), key=lambda i: (C.DECOY_ORDER.index(fams[i]["fam"]), i))[:n]
    return [fams[i] for i in sorted(pri)]


def rank(done: dict) -> dict:
    dec = {k: v["per_km"] for k, v in done.items() if k != "real"}
    real = done["real"]["per_km"]
    n_ge = sum(v >= real for v in dec.values())
    by = {}
    for k, v in done.items():
        if k != "real":
            by.setdefault(v["fam"], []).append(v["per_km"])
    best = max(dec.values())
    sd = float(np.std(list(dec.values())))
    return dict(n=len(dec), rank=1 + n_ge, p=(1 + n_ge) / (1 + len(dec)), real=real, best_decoy=best, best_decoy_name=max(dec, key=dec.get), margin=real - best, decoy_sd=sd,
                by_family={k: [float(np.mean(v)), float(np.max(v))] for k, v in by.items()})


def verdict_of(rk: dict) -> str:
    if rk["rank"] == 1 and rk["margin"] >= C.VERDICT_CONFIDENT_MARGIN:
        return "confident"
    return "uncertain" if rk["rank"] == 1 else "no_route"


def plausibility(d: Path, P: dict, W: Worker):
    out = d / "plausibility"
    out.mkdir(exist_ok=True)
    st = OF.route_steps(d)
    mp_ = jload(d / "map" / "map.json")
    nf = len(mp_["foreign"])
    real = pickle.load(open(d / "route_search" / "route.pkl", "rb"))
    pkl = out / "decoys.pkl"
    done = pickle.load(open(pkl, "rb")) if pkl.exists() else {}
    done["real"] = dict(per_km=float(np.nanmax(real["scan"]) / st.km), scan=real["scan"])
    fams = select_families(families(st, nf), int(P.get("decoys", 19)))
    n = len(fams)
    kg = tuple(real.get("k_base") or C.K_GRID)  # the base grid of the real route search (F5: one more kappa for a bike)
    nruns = len(C.F_GRID) * len(kg)
    already = sum(f["name"] in done for f in fams)
    if already:
        W.log("info", f"resuming: {already} of {n} decoys already done")
    cur = [0]
    base = [already]

    def tick():
        cur[0] += 1
        W.progress(100.0 * (base[0] + cur[0] / nruns) / n, "decoys")

    pre_cache: dict[str, list] = {}
    for fam in fams:
        if fam["name"] in done:
            continue
        t0 = time.time()
        m = fam["map"]
        if m not in pre_cache:
            pre_cache.clear()
            g, E = load_map(d, m)
            pre_cache[m] = list(prepared_gen(g, E, kg))
        cur[0] = 0
        S = scan_full(pre_cache[m], fam["st"], tick, kg=kg)
        done[fam["name"]] = dict(per_km=float(np.nanmax(S) / st.km), scan=S, fam=fam["fam"])
        pickle.dump(done, open(pkl, "wb"))
        base[0] += 1
        W.log("info", f"decoy {fam['name']:24s} {done[fam['name']]['per_km']:.2f}/km (real {done['real']['per_km']:.2f}) {time.time() - t0:.0f} s")
    rk = rank(done)
    ver = verdict_of(rk)
    rk.update(verdict=ver, basis=f"with {rk['n']} decoys", thresholds=dict(confident_margin=C.VERDICT_CONFIDENT_MARGIN, provisional=True), peak_rss_gb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2 ** 30)
    jdump(out / "summary.json", rk)
    lev = "good" if ver == "confident" else "difficult" if ver == "uncertain" else "problem"
    W.status("decoy_margin", lev, rk["margin"], f"real route ranks {rk['rank']} of {rk['n'] + 1}, margin {rk['margin']:.1f} nats/km over the best decoy ({rk['best_decoy_name']}); verdict {ver}")
    W.progress(100.0, "done", force=True)
    return dict(verdict=ver, rank=rk["rank"], margin=rk["margin"], n=rk["n"])
