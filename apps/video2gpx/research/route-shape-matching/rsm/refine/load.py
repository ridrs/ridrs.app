# SPDX-License-Identifier: AGPL-3.0-or-later
"""Load the stored dense-HMM results (work/fable3/res, work/amalfi_cal/res/scan_base.pkl) into a RouteCtx and run the posterior-mean stage.
python -m rsm.refine.load post <Grimone|Roanne|Rousset|Amalfi>"""
from __future__ import annotations

import pickle
import sys
from pathlib import Path

import numpy as np

from rsm.hmm import exp, grid
from rsm.network.graph import NetGraph
from rsm.plaus import data

from . import pathctx, post

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "refine"
RES = WORK / "res"
GPS_VIDEOS = {"Grimone": "col-de-grimone-1", "Roanne": "vallee-de-roanne", "Rousset": "col-de-rousset"}
ALL = list(GPS_VIDEOS) + ["Amalfi"]


def _setup(name: str):
    """-> g, edges (None = all), h, sm, st, tracks, stored result, dp module"""
    if name == "Amalfi":
        from rsm.hmm_cal import dp as dpm, run as crun
        from rsm.nogps import cfg
        r = pickle.load(open(ROOT / "work" / "amalfi_cal" / "res" / "scan_base.pkl", "rb"))
        g, E = crun.load_amalfi()
        st = crun.load_steps("base")
        tracks = data.vms_tracks(cfg.VIDEO, cfg.install("base"))
        k = r["par"].kappa
        return g, E, 30.0 * k, 10.0 * k, st, tracks, r, dpm
    from rsm.hmm import dp as dpm
    video = GPS_VIDEOS[name]
    g, _ = exp.load(video) if False else (NetGraph.load(exp.graphs.WORK / "cache" / f"graph_{video}.npz"), None)
    r = pickle.load(open(exp.WORK / "res" / f"vms_{name}_b0.0.pkl", "rb"))
    return g, None, 30.0, 10.0, exp.vms_steps(video), data.vms_tracks(video, "refined"), r, dpm


def build_ctx(name: str, with_post: bool = True) -> pathctx.RouteCtx:
    g, E, h, sm, st, tracks, r, dpm = _setup(name)
    rt = r["route"]
    ok = np.zeros(st.T, bool)
    # valid steps: those of the stored route (times match st.t[ok] up to the 1e-6 tie-break)
    tt = rt.step_t
    idx = np.searchsorted(st.t, tt - 0.01)
    idx = np.clip(idx, 0, st.T - 1)
    assert np.allclose(st.t[idx], tt, atol=0.01), "stored route and rebuilt steps differ"
    ok[idx] = True
    cell_edge, cell_off = pathctx.cell_layout(g, E, h)
    c = rt.step_cell
    path, s = pathctx.build_path(g, cell_edge[c], cell_off[c])
    s_pm = None
    f = RES / f"post_{name}.pkl"
    if with_post and f.exists():
        s_pm = pickle.load(open(f, "rb"))["s_pm"][idx]
    ctx = pathctx.RouteCtx(name, path, st, ok, st.t[idx], s, s_pm, cell_edge[c], float(r["par"].kappa), float(r["par"].a_ang), tracks)
    ctx.extra.update(idx=idx, g=g, mass=None)
    return ctx


def post_stage(name: str, log=print):
    g, E, h, sm, st, tracks, r, dpm = _setup(name)
    ctx = build_ctx(name, with_post=False)
    G = grid.build(g, E, h=h, sm=sm)
    cell_edge, cell_off = pathctx.cell_layout(g, E, h)
    assert G.N == len(cell_edge)
    pre = dpm.prepare(G, r["par"])
    s_full = np.interp(st.t, ctx.t_step, ctx.s_vit)
    cb = post.PathMean(ctx.path, cell_edge, cell_off, s_full)
    log(f"{name}: cells {G.N} steps {st.T} path cells {len(cb.cells)} multi-visit {cb.multi}", flush=True)
    res = post.forward_backward_cb(dpm, pre, st, cb)
    s_pm = np.array([x[0] for x in res]); mass = np.array([x[1] for x in res])
    # steps where the mass on the path is negligible: fall back to the Viterbi arc
    bad = ~np.isfinite(s_pm) | (mass < 0.2)
    s_pm[bad] = s_full[bad]
    RES.mkdir(parents=True, exist_ok=True)
    pickle.dump(dict(s_pm=s_pm, mass=mass, t=st.t, bad=bad), open(RES / f"post_{name}.pkl", "wb"))
    log(f"{name}: posterior mean done, steps with <20 % mass on the path: {int(bad.sum())} of {st.T}; mean mass {np.nanmean(mass):.3f}", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "post":
        post_stage(sys.argv[2])
