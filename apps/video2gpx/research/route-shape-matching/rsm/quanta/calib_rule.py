# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.quanta.calib_rule --thr 45 --params work/quanta/params.json -o work/quanta/rule_45.json

Decision rule from DEV only (Grimone, Roanne): 'confident' needs gap >= thr(L) and >= 3 matched quanta. thr(L) = 1.1 x the largest gap seen on DEV
among (a) controls: mirrored video quanta, 8 shuffles of the quantum order, the other DEV video's map, and (b) DEV windows whose top chain is wrong,
per window length L in 3, 5, 10, 20, 40 (linear in L between them). The TEST video is never read here.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import evalrun as ev
from . import tune
from .chain import MapIndex, Params
from .qdef import mirror, take

LS = (3, 5, 10, 20, 40)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--thr", type=float, default=45.0)
    ap.add_argument("--params", default="work/quanta/params.json")
    ap.add_argument("-o", required=True)
    a = ap.parse_args()
    p = Params(**json.loads(Path(a.params).read_text()))
    D = tune.DevData(thr=a.thr)
    out = D.evaluate(p, controls=True, lengths=LS)
    null: dict[int, list[float]] = {L: [] for L in LS}
    wrong: dict[int, list[float]] = {L: [] for L in LS}
    for (v, src, L), rs in out.items():
        if src in ("mirror", "foreign"):
            null[L] += [r["gap"] for r in rs]
        if src == "refined":
            wrong[L] += [r["gap"] for r in rs if not r["ok1"]]
    for vid, d in D.v.items():
        ix = MapIndex(d["ctx"].m, p)
        q, mask, _, _ = d["refined"]
        for seed in range(8):
            perm = np.random.default_rng(100 + seed).permutation(np.flatnonzero(mask))
            qs = take(q, perm)
            s1, s2 = ev.turn_positions(d["ctx"], qs)
            for L in LS:
                null[L] += [r["gap"] for r in ev.run_windows(ix, qs, ev.windows(np.ones(len(perm), bool), L), s1, s2)]
    raw = [1.1 * max(null[L] + wrong[L] + [0.0]) for L in LS]
    tab = {str(L): round(float(v), 1) for L, v in zip(LS, np.maximum.accumulate(raw))}  # non-decreasing in L (few long windows give noisy maxima)
    rule = dict(gap_table=tab, min_matched=3, min_score=-1e9, thr=a.thr, null_max={str(L): round(max(null[L] + [0.0]), 1) for L in LS},
                wrong_real_max={str(L): round(max(wrong[L] + [0.0]), 1) for L in LS}, n_null={str(L): len(null[L]) for L in LS},
                note="gap threshold = 1.1 x max(gap over DEV controls, gap of DEV wrong real windows) per window length, made non-decreasing in L")
    Path(a.o).write_text(json.dumps(rule, indent=1))
    print(json.dumps(rule))


if __name__ == "__main__":
    main()
