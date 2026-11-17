# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage A (quanta chains) and stage B (plausibility fit) without GPS truth, then the frozen acceptance rule of work/plaus/frozen.json.

Same objects as rsm.plaus.pipeline.Source (duck type: video, q, tracks, ix, gi, mctx, tmax, windows); `correct` is always False, every quantum is "in the area".
"""
from __future__ import annotations

import json
import multiprocessing as mp_
import pickle
import time

import numpy as np

from rsm.plaus import data, decide as D, fit as fitmod, pipeline as P, stagea, path as pathmod
from rsm.quanta import evalrun as ev
from rsm.quanta.chain import MapIndex
from rsm.quanta.qdef import mirror

from . import cfg

SETTING = "measured"
VARIANT = "wider"  # stage-A variant of the frozen plaus run (work/plaus/frozen.json "variant")
LENGTHS = P.LENGTHS
G: dict = {}


def frozen():
    """(tau, m) of the refined/measured setting of work/plaus/frozen.json and the code hash check."""
    fz = json.loads((P.WORK / "frozen.json").read_text())
    c = fz["cal"]["refined"][SETTING]
    return c["tau"], c["m"]


class Source:
    def __init__(self, ctx, label="refined", ctl=None):
        self.video, self.src, self.ctl, self.map_video = cfg.VIDEO, label, ctl, cfg.VIDEO
        self.mctx = self.ctx = ctx
        self.ix = MapIndex(ctx.m, P.qparams(VARIANT))
        self.gi = pathmod.GraphIdx(ctx.g)
        self.q = ev.video_q(cfg.VIDEO, label, cfg.THR)
        self.tracks = data.vms_tracks(cfg.VIDEO, label)
        if ctl == "mirror":
            self.q = mirror(self.q)
            self.tracks = data.mirror_tracks(self.tracks)
        self.tmax = max(float(x["t"][-1]) for x in self.tracks)

    def windows(self, L):
        n = len(self.q["t0"])
        return ev.windows(np.ones(n, bool), L, max(1, L // 4))


def eval_window(src, L, lo, hi, setting, prior, K=200, KF=50):
    """Stage A top-K chains, stage B fits of the first KF (the frozen decision reads rank < 50). Copy of rsm.plaus.pipeline.eval_window minus truth."""
    t0 = time.time()
    q = src.q
    chains = stagea.match_window_k(src.ix, q, lo, hi, K=K)
    sec_a = time.time() - t0
    wspan = float(q["t1"][hi - 1] - q["t0"][lo])
    cands = [dict(rank=rk, scoreA=ch.score, nm=ch.n_matched, frac=np.nan, correct=False, legs=ch.legs, fits={}) for rk, ch in enumerate(chains)]
    for rk in range(min(KF, len(chains))):
        P.fit_cand(src, cands[rk], lo, wspan, [setting], {setting: prior})
    return dict(video=src.video, src=src.src, ctl=src.ctl, L=L, lo=lo, hi=hi, t0=float(q["t0"][lo]), t1=float(q["t1"][hi - 1]), n_chains=len(chains),
                cands=cands, sec_a=sec_a, sec=time.time() - t0)


def _work(task):
    key, L, lo, hi = task
    return eval_window(G[key], L, lo, hi, SETTING, fitmod.PRIORS[SETTING])


def run_windows(src, key, lengths=LENGTHS, procs=4, log=print):
    G[key] = src
    tasks = [(key, L, lo, hi) for L in lengths for lo, hi in src.windows(L)]
    log(f"  {len(tasks)} windows ({', '.join(f'L={L}: {len(src.windows(L))}' for L in lengths)})")
    t0 = time.time()
    with mp_.get_context("fork").Pool(procs) as pool:
        out = pool.map(_work, tasks, chunksize=1)
    log(f"  stage A+B {time.time()-t0:.0f}s")
    return out


def save(recs, name):
    (cfg.WORK / "res").mkdir(parents=True, exist_ok=True)
    with open(cfg.WORK / "res" / f"{name}.pkl", "wb") as fh:
        pickle.dump(recs, fh)


def load(name):
    with open(cfg.WORK / "res" / f"{name}.pkl", "rb") as fh:
        return pickle.load(fh)


def decisions(recs, tau=None, m=None):
    """frozen acceptance + margin rule -> list of (rec, cand, fit, margin)"""
    if tau is None:
        tau, m = frozen()
    out = []
    for r in recs:
        d = D.decide(r, SETTING, tau, m)
        if d is not None:
            out.append((r, d[0], d[1], d[2]))
    return out


def video_cal(recs, tau=None):
    tau = frozen()[0] if tau is None else tau
    return D.estimate_video_level(recs, SETTING, tau)


def window_stats(recs, tau=None) -> dict:
    """how the frozen thresholds behave on this video: per L, windows, windows with >= 1 fitted candidate, with >= 1 accepted (snorm <= tau), distinct decisions"""
    tau, m = frozen() if tau is None else (tau, frozen()[1])
    out = {}
    for L in sorted({r["L"] for r in recs}):
        rs = [r for r in recs if r["L"] == L]
        fitted = [r for r in rs if any(True for _ in D.fits_of(r, SETTING))]
        acc = [r for r in rs if D.accepted(r, SETTING, tau)]
        dec = [r for r in rs if D.decide(r, SETTING, tau, m) is not None]
        best = [min(f["snorm"] for _, f in D.fits_of(r, SETTING)) for r in fitted]
        out[L] = dict(windows=len(rs), fitted=len(fitted), accepted=len(acc), decided=len(dec), best_snorm_median=float(np.median(best)) if best else np.nan,
                      best_snorm_p10=float(np.percentile(best, 10)) if best else np.nan, mean_sec=float(np.mean([r["sec"] for r in rs])) if rs else np.nan)
    return out
