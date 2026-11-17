# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tables and figures of Experiment 1 from work/fable1/res.  python -m rsm.decoy.analyze [N]  (N = decoys per family used for the headline, default 19)"""
from __future__ import annotations

import json
import sys

import numpy as np

from . import rank

VIDEOS = ("vallee-de-roanne", "col-de-grimone-1", "col-de-rousset", "amalfi")
FAMS = ("shuffle", "flip", "mirror")
SPLIT = {"col-de-grimone-1": (2100.0, 2400.0)}  # bins [0, 2100) and [2400, end)


def half_scores(o, lo, hi):
    """lowest mean step cost of any route over the bins of the half (a route must cover >= 50 % of them)"""
    best = np.inf
    for r in o.get("rows", []):
        b = np.asarray(r["bins"], float)
        sel = b[lo:hi]
        if len(sel) and np.isfinite(sel).mean() >= 0.5:
            best = min(best, float(np.nanmean(sel)))
    return best


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 19
    seeds = set(range(n))
    out = {}
    for v in VIDEOS:
        out[v] = rank.table(v, FAMS, seeds)
        real = rank.load(v, "real")[0]
        out[v]["_real"] = {k: real.get(k) for k in ("n_anchors", "n_dec_all", "n_forced", "best_cpk", "best_cpk_dec", "good_max", "top_cluster", "top_cluster_dec", "n_routes")}
        out[v]["_real"]["stage_b"] = real["stage_b"]
        out[v]["_decoys"] = {f: [dict(seed=o["seed"], best_cpk=o.get("best_cpk"), good=o.get("good_max"), cluster=o.get("top_cluster"), n_dec=o["stage_b"]["n_decisions"],
                                      n_acc=o["stage_b"]["n_accepted"], min_snorm=o["stage_b"]["min_snorm"], n_forced=o["n_forced"]) for o in rank.load(v, f, seeds)] for f in FAMS + ("reverse",)}
        if v in SPLIT:
            a, b = SPLIT[v]
            halves = {}
            for name, (lo, hi) in (("first_0_2100s", (0, int(a // 300))), ("second_2400s_end", (int(b // 300), 10**6))):
                rv = half_scores(real, lo, hi)
                row = {}
                for fam in FAMS + ("all",):
                    ds = [o for f in (FAMS if fam == "all" else (fam,)) for o in rank.load(v, f, seeds)]
                    dv = [half_scores(o, lo, hi) for o in ds]
                    rk, p = rank.rank_of(rv, dv, False)
                    row[fam] = dict(real=rv, rank=rk, p=p, n=len(dv), decoy_min=float(np.min(dv)), decoy_med=float(np.median(dv)))
                halves[name] = row
            out[v]["_halves"] = halves
    (rank.ROOT / "work" / "fable1" / "decoy_ranks.json").write_text(json.dumps(out, indent=1, default=float))
    for v in VIDEOS:
        print(v, out[v]["_real"])
        for fam in FAMS + ("all",):
            print(" ", fam, {s: (round(r["real"], 1), r["rank"], round(r["p"], 3)) for s, r in out[v][fam].items() if s in ("cpk", "good", "cluster")})


if __name__ == "__main__":
    main()
