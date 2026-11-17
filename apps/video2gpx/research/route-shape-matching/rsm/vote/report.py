# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.vote.report -> work/fable2/summary.json and markdown tables on stdout."""
from __future__ import annotations

import json

import numpy as np

from . import analyze, cfg, stage, vote

F2 = lambda x: f"{x:.2f}"


def breadth(P, top=0.05):
    """spread of log f_eff and log kappa of the best-weighted fits (top share of the weights), P = select(points)"""
    w = vote.weights(P[:, 4])
    k = w >= np.quantile(w, 1 - top)
    lf = np.log(P[k, 0] / P[k, 2]); lk = np.log(P[k, 3])
    return dict(n=int(k.sum()), f_p10_p90=[float(np.exp(np.percentile(lf, 10))), float(np.exp(np.percentile(lf, 90)))], f_halfwidth=float((np.percentile(lf, 90) - np.percentile(lf, 10)) / 2),
                k_halfwidth=float((np.percentile(lk, 90) - np.percentile(lk, 10)) / 2))


def variant_ranks(video):
    real = vote.variants(vote.select(vote.points_tl(analyze.load_run(video, cfg.F_REF, "real", 0)["recs"])))
    seeds = analyze.available_seeds(video, cfg.F_REF)
    dec = [vote.variants(vote.select(vote.points_tl(analyze.load_run(video, cfg.F_REF, f, s)["recs"]))) for f in analyze.FAMS for s in seeds[f]]
    out = {}
    for k in real:
        vals = [d[k] for d in dec]
        out[k] = dict(real=real[k], decoy_max=max(vals), decoy_median=float(np.median(vals)), rank=1 + sum(v >= real[k] for v in vals), n=len(vals))
    return out


def main():
    S = {}
    for v in cfg.VIDEOS:
        s = {}
        if v != "amalfi":
            s["stored"] = analyze.stored_criteria(v)[0]
        s["exp1"] = analyze.exp1(v)
        s["exp2"] = analyze.exp2(v)
        s["variants449"] = variant_ranks(v)
        Pr = vote.select(stage.points(analyze.load_run(v, cfg.F_REF, "real", 0)["recs"]))
        s["breadth449"] = breadth(Pr)
        s["per_F"] = {}
        for F in cfg.hypotheses(v):
            P = stage.points(analyze.load_run(v, F, "real", 0)["recs"]); Pv = vote.select(P)
            s["per_F"][int(F)] = dict(fits=int(len(P)), votes=int(len(Pv)), peak=vote.peak(Pv), n_true=int(P[:, 7].sum()))
        if v == "amalfi":
            ref = cfg.AMALFI_COLMAP
            Pall = vote.select(np.vstack([stage.points(analyze.load_run(v, F, "real", 0)["recs"]) for F in cfg.hypotheses(v)]))
            seeds = s["exp2"]["decoys"]
            s["near_colmap"] = dict(real=analyze.window_mass(Pall, ref, half=0.10), real_5=analyze.window_mass(Pall, ref, half=0.05),
                                    decoys=[analyze.window_mass(vote.select(np.vstack([stage.points(analyze.load_run(v, F, d["family"], d["seed"])["recs"]) for F in cfg.hypotheses(v)])), ref, half=0.10) for d in seeds])
        S[v] = s
    json.dump(S, open(cfg.WORK / "summary.json", "w"), indent=1, default=float)
    return S


if __name__ == "__main__":
    main()
