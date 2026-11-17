# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage A (chains) + unbounded stage B for one video input / decoy / angle-scale hypothesis F, then the tight re-fit.

Windows: all quanta, no GPS mask (as rsm.decoy.pipe). GPS enters only `label()` (the `correct` flag of a candidate, evaluation only) and only for
the real runs of the three GPS videos.
"""
from __future__ import annotations

import multiprocessing as mp_
import pickle
import time
from types import SimpleNamespace

import numpy as np

from rsm.decoy import pipe
from rsm.decoy.signals import Decoy
from rsm.network.graph import NetGraph
from rsm.plaus import path as pathmod, pipeline as P, stagea
from rsm.quanta import area as qarea, evalrun as ev, legs
from rsm.quanta.chain import MapIndex

from . import cfg, fit as VF

G: dict = {}
KF = 50
LENGTHS = (5, 10, 20)


def load_env(video: str) -> dict:
    if video == "amalfi":
        from rsm.nogps import mapbuild
        sctx = mapbuild.load_ctx(log=lambda *a: None)
        truth = None
    else:
        g = NetGraph.load(qarea.WORK / "cache" / f"graph_{video}.npz")
        m = legs.load(qarea.WORK / f"map_{video}_45.npz")
        sctx = SimpleNamespace(g=g, m=m, video=video, thr=45.0)
        truth = ev.load_ctx(video, 45.0)
    ix = MapIndex(sctx.m, P.qparams("wider"))
    return dict(sctx=sctx, ix=ix, gi=pathmod.GraphIdx(sctx.g), truth=truth)


class Labeller:
    """GPS truth of the video quanta of one source (evaluation only)."""

    def __init__(self, truth, q):
        self.p1, self.p2 = ev.turn_positions(truth, q)

    def correct(self, ix, ch, q, lo) -> bool:
        fr, nm, _ = ev.chain_quality(ix, ch, q, lo, self.p1, self.p2)
        return bool(nm >= ev.MIN_MATCHED and fr >= ev.FRAC_OK)


def make_source(env, video, F, decoy: Decoy | None = None):
    label = cfg.install(video, F)
    return pipe.Source(env["sctx"], video, label, env["ix"], env["gi"], decoy)


def eval_window(src, L, lo, hi, F, lab: Labeller | None, K=200, kf=KF, compact=False):
    t0 = time.time()
    q = src.q
    chains = stagea.match_window_k(src.ix, q, lo, hi, K=K)
    sec_a = time.time() - t0
    wspan = float(q["t1"][hi - 1] - q["t0"][lo])
    cands, pts = [], []
    for rk, ch in enumerate(chains):
        c = dict(rank=rk, scoreA=ch.score, nm=ch.n_matched, correct=(lab.correct(src.ix, ch, q, lo) if lab else False), legs=ch.legs, fits={})
        cands.append(c)
        if rk >= kf:
            continue
        st, vw, mp, anc = P.prep(src, c, lo, wspan)
        c["fit_status"] = st
        if st != "ok":
            continue
        f = VF.fit_free(vw, mp, anc)
        c["fits"]["free"] = P.lite(f)
        if f.ok:
            pts.append((rk, f.rho, f.kappa, f.snorm, float(f.atbound), c["nm"], float(c["correct"])))
    first_true = next((c["rank"] for c in cands if c["correct"]), None)
    rec = dict(video=src.video, F=F, L=L, lo=lo, hi=hi, t0=float(q["t0"][lo]), t1=float(q["t1"][hi - 1]), n_chains=len(chains), first_true=first_true, sec_a=sec_a,
               sec=time.time() - t0)
    if compact:
        rec["pts"] = np.array(pts, float).reshape(-1, 7)
    else:
        rec["cands"] = cands
    return rec


def _work(task):
    key, L, lo, hi, F, compact = task
    S = G[key]
    return eval_window(S["src"], L, lo, hi, F, S["lab"], compact=compact)


def run_windows(src, lab, F, key, procs=4, compact=False, lengths=LENGTHS):
    G[key] = dict(src=src, lab=lab)
    tasks = [(key, L, lo, hi, F, compact) for L in lengths for lo, hi in src.windows(L)]
    with mp_.get_context("fork").Pool(procs) as pool:
        out = pool.map(_work, tasks, chunksize=1)
    G.pop(key, None)
    return out


def run_one(env, video, F, family, seed, procs=4, force=False):
    """one run -> res/<video>__F<F>__<family>__<seed>.pkl (real: full records + labels; decoy: compact points)"""
    cfg.RES.mkdir(parents=True, exist_ok=True)
    f = cfg.RES / f"{video}__F{int(F)}__{family}__{seed}.pkl"
    if f.exists() and not force:
        return None
    t0 = time.time()
    dec = None if family == "real" else Decoy(family, seed)
    src = make_source(env, video, F, dec)
    lab = Labeller(env["truth"], src.q) if (family == "real" and env["truth"] is not None) else None
    recs = run_windows(src, lab, F, f"{video}/{F}/{family}/{seed}", procs=procs, compact=(family != "real"))
    out = dict(video=video, F=F, family=family, seed=seed, recs=recs, n_quanta=int(len(src.q["t0"])), sec=time.time() - t0, signal=dec.info if dec else {})
    with open(f, "wb") as fh:
        pickle.dump(out, fh)
    n = sum(len(r["pts"]) if "pts" in r else sum(1 for c in r["cands"] if "free" in c["fits"]) for r in recs)
    print(f"{video} F{int(F)} {family} {seed}: {out['sec']:.0f}s quanta {out['n_quanta']} windows {len(recs)} fits {n}", flush=True)
    return out


def points(recs) -> np.ndarray:
    """-> (n, 8) rows: F, rank, rho, kappa, snorm, atbound, nm, correct   for every fitted candidate of the records (compact or full)"""
    rows = []
    for r in recs:
        if "pts" in r:
            for p in r["pts"]:
                rows.append([r["F"], *p])
        else:
            for c in r["cands"]:
                f = c["fits"].get("free")
                if f and f["ok"]:
                    rows.append([r["F"], c["rank"], f["rho"], f["kappa"], f["snorm"], float(f["atbound"]), c["nm"], float(c["correct"])])
    return np.array(rows, float).reshape(-1, 8)


def run_foreign(env_map, video, map_name, F=cfg.F_REF, procs=4, force=False):
    """CONTROL (not in the brief): the vms input of `video` against the map of ANOTHER video (no true route exists) -> res/<video>__F<F>__foreign-<map>__0.pkl"""
    cfg.RES.mkdir(parents=True, exist_ok=True)
    f = cfg.RES / f"{video}__F{int(F)}__foreign-{map_name}__0.pkl"
    if f.exists() and not force:
        return None
    t0 = time.time()
    src = make_source(env_map, video, F)
    recs = run_windows(src, None, F, f"{video}/{F}/foreign-{map_name}", procs=procs, compact=True)
    out = dict(video=video, F=F, family="foreign-" + map_name, seed=0, recs=recs, n_quanta=int(len(src.q["t0"])), sec=time.time() - t0, signal={})
    with open(f, "wb") as fh:
        pickle.dump(out, fh)
    print(f"{video} F{int(F)} foreign map {map_name}: {out['sec']:.0f}s windows {len(recs)}", flush=True)
    return out
