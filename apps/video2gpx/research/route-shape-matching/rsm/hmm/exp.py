# SPDX-License-Identifier: AGPL-3.0-or-later
"""Experiments of the dense HMM. GPS is scoring truth everywhere, and the INPUT only in `gps_fed` (step 1, go/no-go).

python -m rsm.hmm.exp gps <video|all> [--h 30] [--radius 10000]
"""
from __future__ import annotations

import copy
import dataclasses
import json
import pickle
import sys
import time
from pathlib import Path

import numpy as np

from rsm.network.graph import NetGraph
from rsm.plaus import data
from rsm.quanta import gps
from rsm.track2 import graphs, score

from . import dp, grid, route, seq

VIDEOS = ["col-de-grimone-1", "vallee-de-roanne", "col-de-rousset"]
SHORT = {"col-de-grimone-1": "Grimone", "vallee-de-roanne": "Roanne", "col-de-rousset": "Rousset"}
WORK = Path(__file__).resolve().parents[2] / "work" / "fable3"
(WORK / "res").mkdir(parents=True, exist_ok=True)
(WORK / "figs").mkdir(parents=True, exist_ok=True)


def load(video: str):
    g = NetGraph.load(graphs.WORK / "cache" / f"graph_{video}.npz")
    truth = score.Truth(video, g, route.SuccOnly(g), log=lambda *a: None)
    return g, truth


def scored(rt: route.Route, truth: score.Truth) -> dict:
    sc = score.score_route(rt, truth)
    return {k: sc[k] for k in ("on30", "on100", "on_road", "median_d", "junc_correct", "junc_wrong", "junc_off")}


def fork_report(video: str, rt: route.Route, truth, G, post=None, t_fork=3626.0, span=60.0) -> dict:
    mm = truth.mm
    m = (np.abs(mm["t"] - t_fork) <= span) & (mm["edge"] >= 0)
    true_edges = []
    for e in mm["edge"][m]:
        if not true_edges or true_edges[-1] != int(e):
            true_edges.append(int(e))
    s = (np.abs(rt.t - t_fork) <= span)
    route_edges = []
    for e in rt.E[s]:
        if not route_edges or route_edges[-1] != int(e):
            route_edges.append(int(e))
    d = truth.dist(rt.t[s], rt.xy[s])
    out = dict(t=t_fork, gps_edges=true_edges, route_edges=route_edges, dist_m_median=float(np.median(d)) if s.any() else None, dist_m_max=float(d.max()) if s.any() else None)
    if post is not None and s.any():
        i = np.flatnonzero(s)
        out["posterior_route_edge_min"] = float(np.nanmin(np.interp(rt.t[i], post["t"], post["p_vit"])))
    return out


def gps_fed(video: str, h: float = 30.0, radius: float = 10_000.0, d0: float = 30.0, par: dp.Par | None = None, posterior: bool = True, log=print) -> dict:
    g, truth = load(video)
    gc = truth.gc
    xy = np.column_stack([gc["x"], gc["y"]])
    E = route.edges_near(g, xy, radius)
    t0 = time.time()
    G = grid.build(g, E, h=h)
    tr = data.gps_tracks(gc)
    st = seq.make_steps(tr, d0=d0)
    par = par or dp.Par()
    est = grid.check_budget(G.N, st.T)
    pre = dp.prepare(G, par)
    r = dp.viterbi(pre, st, backptr=True)
    rt = route.decode(G, st, r["cell_path"])
    out = dict(video=video, h=h, radius=radius, cells=G.N, steps=st.T, km=st.km, edges=len(E), directed_km=float(g.edge_len[E].sum() / 1000), mem=est, score=r["score"],
               score_per_km=r["score"] / st.km, **scored(rt, truth))
    if posterior:
        fb = dp.forward_backward(pre, st, r["cell_path"])
        fb["t"] = st.t
        out["post"] = fb
        out["logev_per_km"] = fb["logev"] / st.km
        cf, on, d = route.correct_flags(rt, truth)
        pv = np.interp(rt.t, st.t, np.nan_to_num(fb["p_vit"], nan=0.0))
        out["conf_correct"] = dict(mean_conf_correct=float(pv[on].mean()) if on.any() else None, mean_conf_wrong=float(pv[~on].mean()) if (~on).any() else None)
    out["fork"] = fork_report(video, rt, truth, G, out.get("post"))
    out["route"] = rt
    out["seconds"] = time.time() - t0
    log(f"{SHORT[video]:8s} h={h:.0f} cells {G.N} steps {st.T} | on edges {out['on_road']:.3f} | within 30 m {out['on30']:.3f} | within 100 m {out['on100']:.3f} | junctions {out['junc_correct']}/{out['junc_wrong']}/{out['junc_off']} | {out['seconds']:.1f}s")
    return out


# ----------------------------------------------------------------------------------------------- vms input, scale scan, decoys
F_REF = 449.0  # the stored vms tracks were integrated with f360 = 449
F_GRID = tuple(float(x) for x in 270.0 * (600.0 / 270.0) ** (np.arange(8) / 7.0))
K_GRID = (0.88, 1.0, 1.13)
_G: dict = {}


def _job(args):
    pre, st = _G["pre"], _G["st"]
    fi, ki, f, k, bs = args
    par = dataclasses.replace(pre.par, a_ang=F_REF / f, kappa=k, b_speed=bs)
    p = dp.Prepared(pre.grid, par) if par.sv > 0 else copy.copy(pre)  # the emission scale depends on a_ang only through sv
    p.par = par
    return fi, ki, dp.viterbi(p, st)["score"]


def scan(pre: dp.Prepared, st: seq.Steps, procs: int = 4, b_speed: float = 0.0, fgrid=None, kgrid=None) -> np.ndarray:
    """best-path log score on the (f_eff x kappa) grid -> array [len(fgrid), len(kgrid)]"""
    import multiprocessing as mp
    fgrid = F_GRID if fgrid is None else fgrid
    kgrid = K_GRID if kgrid is None else kgrid
    out = np.full((len(fgrid), len(kgrid)), np.nan)
    _G["pre"], _G["st"] = pre, st
    tasks = [(i, j, fgrid[i], kgrid[j], b_speed) for i in range(len(fgrid)) for j in range(len(kgrid))]
    with mp.get_context("fork").Pool(min(procs, 4)) as pool:
        for fi, ki, sc in pool.imap_unordered(_job, tasks):
            out[fi, ki] = sc
    return out


def vms_steps(video: str, d0: float = 30.0) -> seq.Steps:
    return seq.make_steps(data.vms_tracks(video, "refined"), d0=d0)


def vms_run(video: str, h: float = 30.0, d0: float = 30.0, b_speed: float = 0.0, procs: int = 4, posterior: bool = True, log=print, par0: dp.Par | None = None, g=None, truth=None, st=None, tag: str = "", fgrid=None, kgrid=None, edges=None) -> dict:
    """scale scan on the whole track2 area, then the full decode (Viterbi + forward-backward) at the best scale"""
    if g is None:
        g, truth = load(video)
    t0 = time.time()
    fgrid = F_GRID if fgrid is None else tuple(fgrid)
    kgrid = K_GRID if kgrid is None else tuple(kgrid)
    G = grid.build(g, edges, h=h)
    st = vms_steps(video, d0) if st is None else st
    est = grid.check_budget(G.N, st.T)
    par0 = par0 or dp.Par()
    pre = dp.prepare(G, par0)
    S = scan(pre, st, procs, b_speed, fgrid, kgrid)
    fi, ki = np.unravel_index(np.nanargmax(S), S.shape)
    par = dataclasses.replace(par0, a_ang=F_REF / fgrid[fi], kappa=kgrid[ki], b_speed=b_speed)
    p2 = dp.prepare(G, par)
    r = dp.viterbi(p2, st, backptr=True)
    rt = route.decode(G, st, r["cell_path"])
    out = dict(video=video, h=h, d0=d0, b_speed=b_speed, cells=G.N, steps=st.T, km=st.km, mem=est, scan=S, fgrid=fgrid, kgrid=kgrid, f_best=fgrid[fi], kappa_best=kgrid[ki],
               score=r["score"], score_per_km=r["score"] / st.km, **(scored(rt, truth) if truth is not None else {}))
    if posterior:
        fb = dp.forward_backward(p2, st, r["cell_path"])
        fb["t"] = st.t
        out["post"] = fb
        pv = np.interp(rt.t, st.t, np.nan_to_num(fb["p_vit"], nan=0.0))
        out["conf"] = dict(t=rt.t, p=pv)
        if truth is not None:
            cf, on, d = route.correct_flags(rt, truth)
            out["conf"].update(on_edge=on, within30=cf)
    if truth is not None:
        out["fork"] = fork_report(video, rt, truth, G, out.get("post"))
    out["route"] = rt
    out["seconds"] = time.time() - t0
    out["par"] = par
    msg = f"{SHORT.get(video, video):8s}{tag} vms best f_eff {fgrid[fi]:.0f} kappa {kgrid[ki]} b {b_speed} | score/km {r['score'] / st.km:.2f}"
    if truth is not None:
        msg += f" | on edges {out['on_road']:.3f} | within 30 m {out['on30']:.3f} | within 100 m {out['on100']:.3f} | junctions {out['junc_correct']}/{out['junc_wrong']}/{out['junc_off']}"
    log(msg + f" | {out['seconds']:.0f}s")
    return out


def _cli_vms():
    vids = VIDEOS if sys.argv[2] == "all" else [sys.argv[2]]
    b = float(sys.argv[sys.argv.index("--b") + 1]) if "--b" in sys.argv else 0.0
    res = {}
    for v in vids:
        res[v] = vms_run(v, b_speed=b)
        print(np.array2string(res[v]["scan"] / res[v]["km"], precision=1), flush=True)
        pickle.dump(res[v], open(WORK / "res" / f"vms_{SHORT[v]}_b{b}.pkl", "wb"))


def _cli_pass2():
    """pass 2: speed slope b fitted on the model's own decoded route of pass 1 (no GPS), then the scan again with b"""
    from . import resid
    vids = VIDEOS if sys.argv[2] == "all" else [sys.argv[2]]
    for v in vids:
        r1 = pickle.load(open(WORK / "res" / f"vms_{SHORT[v]}_b0.0.pkl", "rb"))
        g, truth = load(v)
        G = grid.build(g, None, h=30.0)
        st = vms_steps(v)
        sl = resid.speed_slope(G, st, r1["route"].step_cell)
        del G
        r2 = vms_run(v, b_speed=sl["b"], g=g, truth=truth, st=st, tag=f" [pass 2, b {sl['b']:+.4f}]")
        r2["slope_fit"] = sl
        print(np.array2string(r2["scan"] / r2["km"], precision=1), flush=True)
        pickle.dump(r2, open(WORK / "res" / f"vms_{SHORT[v]}_bself.pkl", "wb"))


def main():
    cmd = sys.argv[1]
    if cmd == "vms":
        return _cli_vms()
    if cmd == "pass2":
        return _cli_pass2()
    if cmd == "gps":
        vids = VIDEOS if sys.argv[2] == "all" else [sys.argv[2]]
        h = float(sys.argv[sys.argv.index("--h") + 1]) if "--h" in sys.argv else 30.0
        rad = float(sys.argv[sys.argv.index("--radius") + 1]) if "--radius" in sys.argv else 10000.0
        d0 = float(sys.argv[sys.argv.index("--d0") + 1]) if "--d0" in sys.argv else 30.0
        res = {v: gps_fed(v, h=h, radius=rad, d0=d0) for v in vids}
        pickle.dump(res, open(WORK / "res" / f"gps_h{int(h)}_d{int(d0)}_r{int(rad/1000)}.pkl", "wb"))
        for v in vids:
            print(v, json.dumps(res[v]["fork"], default=float), res[v]["conf_correct"], "logev/km", res[v]["logev_per_km"], "mem", res[v]["mem"])




if __name__ == "__main__":
    main()
