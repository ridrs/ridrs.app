# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.quanta.inspect_wrong <runs_dir> <video> [--source refined]: confident wrong windows and why (scoring side, uses GPS)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from . import diag
from . import evalrun as ev
from .chain import MapIndex, Params


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs")
    ap.add_argument("video")
    ap.add_argument("--source", default="refined")
    ap.add_argument("--rule")
    a = ap.parse_args()
    res = json.loads((Path(a.runs) / f"{a.video}.json").read_text())
    rule = json.loads(Path(a.rule).read_text()) if a.rule else res["rule"]
    thr = float(res.get("thr", 45.0))
    ctx = ev.load_ctx(a.video, thr)
    ix = MapIndex(ctx.m, Params(**res["params"]))
    q = ev.gps_q(ctx, thr) if a.source == "gps" else ev.video_q(a.video, a.source, thr)
    p1, p2 = ev.turn_positions(ctx, q)
    tree = cKDTree(ix.ev_mid)
    E = ctx.m["events"]
    out = []
    for L, recs in res["runs"][a.source].items():
        for r in recs:
            if not ev.confident(r, rule) or r["ok1"]:
                continue
            d = []
            for qi, lg in r["legs"]:
                d.append(max(float(np.hypot(*(ix.ev_mid[ix.A[lg]] - p1[qi]))), float(np.hypot(*(ix.ev_mid[ix.B[lg]] - p2[qi])))))
            has_true = [len(diag.true_legs(ix, E, tree, q, i, p1, p2)) > 0 for i in range(r["lo"], r["hi"])]
            out.append(dict(L=int(L), lo=r["lo"], gap=round(r["gap"], 1), n_matched=r["n_matched"], frac_ok=round(r["frac_ok"], 2), dist_m=[round(x) for x in d],
                            window_quanta_with_true_leg_in_map=f"{sum(has_true)}/{len(has_true)}", unc=int(q["unc"][r["lo"]:r["hi"]].sum())))
    print(json.dumps(out, indent=0))


if __name__ == "__main__":
    main()
