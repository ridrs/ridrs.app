# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.vote.decide_run <video> ...   (heavy: memguard, 4 workers)
For each GPS video: (a) plaus rule as it was (bounded 'measured' fits, thresholds tau / m) at F = 449; (b) vote-calibrated tight re-fit at F = 449 (peak of the F=449 vote);
(c) vote-calibrated tight re-fit for every hypothesis F at the pooled peak (f*, kappa*) -> decisions per hypothesis and in distinct 60 s bins.
Outcome labels (correct / wrong) come from the GPS truth carried in the stage records; they are evaluation only.  -> work/fable2/decisions_<video>.json"""
from __future__ import annotations

import json
import sys

import numpy as np

from . import analyze, cfg, decide as DC, stage, vote


def peak_of(video, Fs):
    P = vote.select(np.vstack([stage.points(analyze.load_run(video, F, "real", 0)["recs"]) for F in Fs]))
    return vote.peak(P)


def main():
    fz = DC.frozen()
    for video in sys.argv[1:]:
        env = stage.load_env(video)
        Fs = cfg.hypotheses(video)
        pk_all = peak_of(video, Fs)
        pk_449 = peak_of(video, [cfg.F_REF])
        out = dict(video=video, frozen=fz, peak_pooled=pk_all, peak_449=pk_449, per_F={})
        for F in Fs:
            recs = analyze.load_run(video, F, "real", 0)["recs"]
            n = len(recs)
            res = {}
            # (c) at the pooled peak
            r1 = DC.refit(env, video, F, recs, pk_all["f_eff"], pk_all["kappa"], plaus=(F == cfg.F_REF))
            d = DC.decisions(r1, "fixed", fz["tau2"], fz["m2"])
            res["pooled_peak"] = dict(DC.tally(d, n), bins=DC.bins(d), by_L={L: DC.tally(DC.decisions([r for r in r1 if r["L"] == L], "fixed", fz["tau2"], fz["m2"]), sum(1 for r in r1 if r["L"] == L)) for L in (5, 10, 20)})
            if F == cfg.F_REF:
                dp = DC.decisions(r1, "measured", fz["tau"], fz["m"])
                res["plaus_rule"] = dict(DC.tally(dp, n), bins=DC.bins(dp), by_L={L: DC.tally(DC.decisions([r for r in r1 if r["L"] == L], "measured", fz["tau"], fz["m"]), sum(1 for r in r1 if r["L"] == L)) for L in (5, 10, 20)})
                r2 = DC.refit(env, video, F, recs, pk_449["f_eff"], pk_449["kappa"])
                d2 = DC.decisions(r2, "fixed", fz["tau2"], fz["m2"])
                res["peak449"] = dict(DC.tally(d2, n), bins=DC.bins(d2))
            out["per_F"][int(F)] = res
            print(video, int(F), {k: (v["correct"], v["wrong"], v["none"]) for k, v in res.items()}, flush=True)
        json.dump(out, open(cfg.WORK / f"decisions_{video}.json", "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
