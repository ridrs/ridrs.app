# SPDX-License-Identifier: AGPL-3.0-or-later
"""Vote statistics: real against decoys (experiment 1 at F = 449, experiment 2 pooled over the hypotheses), criteria table, figures."""
from __future__ import annotations

import json
import pickle

import numpy as np

from . import cfg, stage, vote

FAMS = ("shuffle", "flip")


def load_run(video, F, family, seed):
    f = cfg.RES / f"{video}__F{int(F)}__{family}__{seed}.pkl"
    return pickle.load(open(f, "rb")) if f.exists() else None


def run_points(video, Fs, family, seed):
    Ps = []
    for F in Fs:
        d = load_run(video, F, family, seed)
        if d is None:
            return None
        Ps.append(stage.points(d["recs"]))
    return vote.select(np.vstack(Ps))


def decoy_peaks(video, Fs, seeds_by_family):
    out = []
    for fam in FAMS:
        for s in seeds_by_family[fam]:
            P = run_points(video, Fs, fam, s)
            if P is None:
                continue
            pk = vote.peak(P)
            pk.update(family=fam, seed=s)
            out.append(pk)
    return out


def rank_row(real_pk, decs, key="mass"):
    d = np.array([x[key] for x in decs], float)
    n_ge = int((d >= real_pk[key]).sum())
    best = float(d.max()) if len(d) else np.nan
    return dict(real=real_pk[key], decoy_max=best, decoy_median=float(np.median(d)) if len(d) else np.nan, ratio=real_pk[key] / best if best else np.inf, rank=1 + n_ge,
                p=(1 + n_ge) / (len(d) + 1), n=len(d), by_family={f: float(max(x[key] for x in decs if x["family"] == f)) for f in FAMS if any(x["family"] == f for x in decs)})


def available_seeds(video, F):
    return {fam: sorted(int(p.stem.split("__")[3]) for p in cfg.RES.glob(f"{video}__F{int(F)}__{fam}__*.pkl")) for fam in FAMS}


def exp1(video):
    """F = 449, real unmasked run against shuffle / flip decoys"""
    P = vote.select(stage.points(load_run(video, cfg.F_REF, "real", 0)["recs"]))
    real = vote.peak(P)
    seeds = available_seeds(video, cfg.F_REF)
    decs = decoy_peaks(video, [cfg.F_REF], seeds)
    return dict(real=real, mass=rank_row(real, decs, "mass"), kde=rank_row(real, decs, "kde"), decoys=decs)


def exp2(video):
    """pooled over the hypotheses of the video; decoys: seeds present for every hypothesis"""
    Fs = cfg.hypotheses(video)
    P = vote.select(np.vstack([stage.points(load_run(video, F, "real", 0)["recs"]) for F in Fs]))
    real = vote.peak(P)
    seeds = {fam: sorted(set.intersection(*[set(available_seeds(video, F)[fam]) for F in Fs])) for fam in FAMS}
    decs = decoy_peaks(video, Fs, seeds)
    return dict(real=real, mass=rank_row(real, decs, "mass"), kde=rank_row(real, decs, "kde"), decoys=decs, Fs=Fs)


def window_mass(P, f0, kap0=None, half=0.10):
    """weight mass within +-half (relative) of f_eff = f0 (and of kappa kap0 if given)"""
    lf, lk = vote.coords(P)
    w = vote.weights(P[:, 4])
    m = np.abs(lf - np.log(f0)) < np.log(1 + half)
    if kap0 is not None:
        m &= np.abs(lk - np.log(kap0)) < np.log(1 + half)
    return float(w[m].sum())


def stored_criteria(video):
    A = pickle.load(open(cfg.RES / f"stored_{video}.pkl", "rb"))["rows"]
    ok = A[:, 5] < 0.5
    tau = vote.TAU
    T = A[ok & (A[:, 7] > .5) & (A[:, 4] <= tau)]
    W3 = A[ok & (A[:, 7] < .5) & (A[:, 4] <= 3 * tau)]
    Wall = A[ok & (A[:, 7] < .5)]
    rm = float(np.median(T[:, 2]))
    hw = lambda X: float((np.percentile(X[:, 2], 90) - np.percentile(X[:, 2], 10)) / 2 / rm)
    r = dict(n_all=int(len(A)), frac_at_bound=float(1 - ok.mean()), n_true=int(len(T)), n_wrong_3tau=int(len(W3)), n_wrong=int(len(Wall)), rho_true_median=rm, f_eff_true_median=449 / rm,
             true_within5=float(np.mean(np.abs(T[:, 2] / rm - 1) < .05)), true_p10_p90_rel=[float(np.percentile(T[:, 2], 10) / rm - 1), float(np.percentile(T[:, 2], 90) / rm - 1)],
             wrong3_halfwidth=hw(W3), wrongall_halfwidth=hw(Wall), wrong3_within30=float(np.mean(np.abs(W3[:, 2] / rm - 1) < .30)), wrong3_within5=float(np.mean(np.abs(W3[:, 2] / rm - 1) < .05)),
             wrongall_within5=float(np.mean(np.abs(Wall[:, 2] / rm - 1) < .05)), kappa_true_median=float(np.median(T[:, 3])), kappa_true_p10_p90=[float(np.percentile(T[:, 3], 10)), float(np.percentile(T[:, 3], 90))],
             kappa_wrong3_p10_p90=[float(np.percentile(W3[:, 3], 10)), float(np.percentile(W3[:, 3], 90))])
    r["peak"] = vote.peak(A[ok][:, :8])
    return r, A
