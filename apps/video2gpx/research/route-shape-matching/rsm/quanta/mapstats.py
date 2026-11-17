# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.quanta.mapstats: counts, runtime and self-ambiguity of the map quanta (same quantum key occurring several times)."""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy.spatial import cKDTree

from . import legs
from .area import WORK
from .chain import Params

VIDEOS = ("col-de-grimone-1", "vallee-de-roanne", "col-de-rousset")


def stats(vid: str, thr: int, wa: float = 0.30, wr: float = 0.8) -> dict:
    m = legs.load(WORK / f"map_{vid}_{thr}.npz")
    q = m["q"]
    n = len(q["sign1"])
    sg = (q["sign1"] > 0) * 2 + (q["sign2"] > 0)
    key = np.stack([sg, np.floor(np.log(q["ang1"]) / wa), np.floor(np.log(q["ang2"]) / wa), np.floor(q["lr1"] / wr), np.floor(q["lr2"] / wr)], 1).astype(np.int64)
    _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    mult = cnt[inv.ravel()]
    # tolerance neighbours: legs with the same signs whose ln-angles are within 0.2 and ln-ratios within 0.5 (Chebyshev), sample 4000 legs
    rng = np.random.default_rng(0)
    smp = rng.choice(n, min(4000, n), replace=False)
    nb = []
    for g in range(4):
        idx = np.flatnonzero(sg == g)
        pts = np.stack([np.log(q["ang1"][idx]) / 0.2, np.log(q["ang2"][idx]) / 0.2, q["lr1"][idx] / 0.5, q["lr2"][idx] / 0.5], 1)
        t = cKDTree(pts)
        s_g = np.intersect1d(smp, idx)
        if len(s_g):
            pos = np.searchsorted(idx, s_g)
            nb += [len(x) - 1 for x in t.query_ball_point(pts[pos], 1.0, p=np.inf)]
    st = json.loads((WORK / f"map_{vid}_{thr}.json").read_text())
    return dict(video=vid, thr=thr, events=st["events"], legs=n, build_seconds=round(st["seconds"], 1), distinct_keys=int(len(cnt)), share_legs_with_unique_key=float((mult == 1).mean()),
                key_multiplicity_median=float(np.median(mult)), key_multiplicity_p90=float(np.percentile(mult, 90)), key_multiplicity_max=int(mult.max()),
                legs_within_measured_error_median=float(np.median(nb)), legs_within_measured_error_p90=float(np.percentile(nb, 90)))


if __name__ == "__main__":
    out = [stats(v, t) for t in (45, 30) for v in VIDEOS if (WORK / f"map_{v}_{t}.npz").exists()]
    (WORK / "mapstats.json").write_text(json.dumps(out, indent=1))
    for s in out:
        print(json.dumps(s))
