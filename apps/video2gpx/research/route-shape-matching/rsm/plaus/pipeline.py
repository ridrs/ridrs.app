# SPDX-License-Identifier: AGPL-3.0-or-later
"""Windows -> stage A candidates -> truth labels -> stage B fits, in worker processes.

Records are plain dicts (pickled). GPS is used only for the `correct` label of a candidate (rsm.quanta.evalrun.chain_quality) and for the
scorable mask; neither stage sees it.
"""
from __future__ import annotations

import json
import pickle
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

from rsm.quanta import evalrun as ev
from rsm.quanta.area import WORK as QWORK
from rsm.quanta.chain import MapIndex, Params
from rsm.quanta.qdef import mirror

from . import data, fit as fitmod, path as pathmod, stagea

WORK = Path(__file__).resolve().parents[2] / "work" / "plaus"
QPARAMS = QWORK / "params.json"
SPLITS = json.loads((WORK / "splits.json").read_text()) if (WORK / "splits.json").exists() else {}
LENGTHS = (5, 10, 20)
MIN_NM = 3  # matched quanta needed for a plausibility fit (2 was tried on DEV-A: short two-quantum chains let the mirrored control through)
MIN_COVER = 0.4  # matched video time / window video time
VARIANTS = {
    "base": dict(),
    "wide": dict(wa=0.45, soft_a=0.30, sig_a=0.30),
    "skip4": dict(kf=4),
    "wide_skip4": dict(wa=0.45, soft_a=0.30, sig_a=0.30, kf=4),
    "wider": dict(wa=0.6, soft_a=0.4, sig_a=0.4, beam=600),
    "wide_b600": dict(wa=0.45, soft_a=0.30, sig_a=0.30, beam=600),
}
G: dict = {}  # per-process globals (set before fork)


def qparams(variant: str = "base") -> Params:
    return replace(Params(**json.loads(QPARAMS.read_text())), **VARIANTS[variant])


def half_of(video: str, t0: float, t1: float) -> str:
    """DEV-A / TEST-B for Grimone and Roanne (None for straddling windows), TEST for Rousset."""
    if video == "col-de-rousset":
        return "TEST"
    tm = SPLITS[video]["t_mid"]
    if t1 <= tm:
        return "DEV-A"
    if t0 >= tm:
        return "TEST-B"
    return "straddle"


class Source:
    """quanta + tracks + truth positions of one video input; optionally against another video's map."""

    def __init__(self, video, src, ctl=None, map_video=None, variant="base"):
        self.video, self.src, self.ctl = video, src, ctl
        self.ctx = ev.load_ctx(video, 45.0)
        mv = map_video or video
        self.mctx = self.ctx if mv == video else ev.load_ctx(mv, 45.0)
        self.map_video = mv
        self.ix = MapIndex(self.mctx.m, qparams(variant))
        self.gi = pathmod.GraphIdx(self.mctx.g)
        label = "refined" if src in ("refined", "gps") else src
        if src == "gps":
            self.q = ev.gps_q(self.ctx, 45.0)
            self.tracks = data.gps_tracks(self.ctx.gc)
        else:
            self.q = ev.video_q(video, src, 45.0)
            self.tracks = data.vms_tracks(video, src)
        self.mask = ev.scorable(self.ctx, self.q)
        self.p1, self.p2 = ev.turn_positions(self.ctx, self.q)
        if ctl == "mirror":
            self.q = mirror(self.q)
            self.tracks = data.mirror_tracks(self.tracks)
        self.tmax = max(float(x["t"][-1]) for x in self.tracks)

    def windows(self, L):
        out = []
        for lo, hi in ev.windows(self.mask, L, max(1, L // 4)):
            h = half_of(self.video, float(self.q["t0"][lo]), float(self.q["t1"][hi - 1]))
            out.append((lo, hi, h))
        return out


def anchors_of(src: Source, mp, chain_legs, lo):
    """(video time of turn midpoint, map arc length of the matched event) for both turns of every matched leg."""
    A = []
    for qi, lg in chain_legs:
        for tq, ev_id in ((src.q["tm1"][lo + qi], src.ix.A[lg]), (src.q["tm2"][lo + qi], src.ix.B[lg])):
            _, i = mp.tree.query(src.ix.ev_mid[ev_id])
            A.append((float(tq), float(mp.u[i])))
    return A


def span_of(src, chain_legs, lo):
    qs = [lo + qi for qi, _ in chain_legs]
    return float(src.q["t0"][min(qs)]), float(src.q["t1"][max(qs)])


def shuffle_shift(ta, tb, tmax):
    d = tb - ta
    for sh in (1.7 * d + 60, -(1.7 * d + 60), 3.3 * d + 120, -(3.3 * d + 120)):
        if ta + sh >= 0 and tb + sh <= tmax:
            return sh
    return 0.0


def lite(f: fitmod.Fit) -> dict:
    return dict(ok=f.ok, cost=f.cost, data=f.data, pen=f.pen, n=f.n, snorm=f.snorm, kappa=f.kappa, rho=f.rho, lam=f.lam, u0=f.u0, gam=f.gam, c=f.c, rate=f.rate,
                rms=f.rms, maxdev=f.maxdev, frechet=f.frechet, atbound=f.atbound, sec=f.sec, trace=f.trace, stretch=f.stretch)


def prep(src: Source, c: dict, lo, wspan, shuffle=False):
    """-> (status, vw, mp, anchors) for candidate c of a window."""
    if c["nm"] < MIN_NM:
        return "few_matched", None, None, None
    ta, tb = span_of(src, c["legs"], lo)
    if tb - ta < MIN_COVER * wspan:
        return "coverage", None, None, None
    mp = pathmod.build_path(src.mctx.m, src.ix, src.gi, c["legs"])
    if mp is None:
        return "nopath", None, None, None
    sh = shuffle_shift(ta, tb, src.tmax) if shuffle else 0.0
    vw = data.cut(src.tracks, ta + sh, tb + sh)
    if vw is None:
        return "novideo", None, None, None
    anc = [(t + sh, u) for t, u in anchors_of(src, mp, c["legs"], lo)]
    c["edges"] = frozenset(mp.edges)
    c["span"] = (ta, tb)
    c["n_jump"] = mp.n_jump
    return "ok", vw, mp, anc


def fit_cand(src, c, lo, wspan, settings, priors, shuffle=False, with_route=False):
    st, vw, mp, anc = prep(src, c, lo, wspan, shuffle)
    c["fit_status"] = st
    if st != "ok":
        return None
    for s in settings:
        f = fitmod.fit_candidate(vw, mp, priors[s], anc, with_route=with_route)
        c["fits"][s] = lite(f) if not with_route else f
    return vw, mp, anc


def eval_window(src: Source, L, lo, hi, settings, priors, K=200, KF=50, chains=None, only=None, shuffle=False, seed_tag=0):
    """Stage A (unless `chains` given) + labels + fits of the first KF chains (or those with rank in `only`) for each setting in `settings`.
    priors: {setting: Prior}. -> record dict."""
    t0 = time.time()
    q = src.q
    if chains is None:
        chains = stagea.match_window_k(src.ix, q, lo, hi, K=K)
    sec_a = time.time() - t0
    wspan = float(q["t1"][hi - 1] - q["t0"][lo])
    first_true = None
    cands = []
    for rk, ch in enumerate(chains):
        fr, nm, _ = ev.chain_quality(src.ix, ch, q, lo, src.p1, src.p2)
        correct = bool(nm >= ev.MIN_MATCHED and fr >= ev.FRAC_OK) and src.ctl in (None, "") and src.map_video == src.video
        if correct and first_true is None:
            first_true = rk
        cands.append(dict(rank=rk, scoreA=ch.score, nm=nm, frac=fr, correct=correct, legs=ch.legs, fits={}))
    todo = [rk for rk in (only if only is not None else range(min(KF, len(chains))))]
    for rk in todo:
        fit_cand(src, cands[rk], lo, wspan, settings, priors, shuffle)
    return dict(video=src.video, src=src.src, ctl=src.ctl, map=src.map_video, L=L, lo=lo, hi=hi, t0=float(q["t0"][lo]), t1=float(q["t1"][hi - 1]),
                first_true=first_true, n_chains=len(chains), cands=cands, sec_a=sec_a, sec=time.time() - t0)


def _work(task):
    key, L, lo, hi, settings, priors, kw = task
    src = G[key]
    r = eval_window(src, L, lo, hi, settings, priors, **kw)
    r["half"] = half_of(src.video, r["t0"], r["t1"])
    return r


def run_source(src: Source, key, lengths, halves, settings, priors, procs=11, **kw):
    """All windows of the given halves ('DEV-A', 'TEST-B', 'TEST') for each L."""
    import multiprocessing as mp_
    G[key] = src
    tasks = []
    for L in lengths:
        for lo, hi, h in src.windows(L):
            if h in halves:
                tasks.append((key, L, lo, hi, settings, priors, kw))
    ctx = mp_.get_context("fork")
    with ctx.Pool(procs) as pool:
        out = pool.map(_work, tasks, chunksize=1)
    return out


def save(recs, name):
    (WORK / "res").mkdir(parents=True, exist_ok=True)
    with open(WORK / "res" / f"{name}.pkl", "wb") as fh:
        pickle.dump(recs, fh)


def load(name):
    with open(WORK / "res" / f"{name}.pkl", "rb") as fh:
        return pickle.load(fh)


def _refit(task):
    key, rec, settings, priors, ranks, shuffle = task
    src = G[key]
    wspan = rec["t1"] - rec["t0"]
    for rk in ranks.get(id_key(rec), ranks.get("*", [])):
        fit_cand(src, rec["cands"][rk], rec["lo"], wspan, settings, priors, shuffle)
    return rec


def id_key(rec):
    return (rec["L"], rec["lo"])


def refit_source(src: Source, key, recs, settings, priors_of, ranks_of, shuffle=False, procs=11):
    """Pass 2: new fits (settings -> Prior) for the given candidate ranks. priors_of(rec) -> {setting: Prior}; ranks_of(rec) -> [rank]."""
    import multiprocessing as mp_
    G[key] = src
    tasks = [(key, r, list(priors_of(r)), priors_of(r), {id_key(r): ranks_of(r)}, shuffle) for r in recs]
    with mp_.get_context("fork").Pool(procs) as pool:
        return pool.map(_refit, tasks, chunksize=1)
