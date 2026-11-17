# SPDX-License-Identifier: AGPL-3.0-or-later
"""POST HOC (after the frozen TEST run): does a window's share of uncertain-length quanta explain the confident-wrong windows and control failures?
python -m rsm.quanta.posthoc <runs_dir> <video> <rule.json> -> json. Nothing here changes the frozen rule; numbers are labelled post hoc in RESULTS.md."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from . import evalrun as ev


def main(runs: str, vid: str, rule_path: str) -> dict:
    res = json.loads((Path(runs) / f"{vid}.json").read_text())
    rule = json.loads(Path(rule_path).read_text())
    thr = float(res.get("thr", 45.0))
    q = ev.video_q(vid, "refined", thr)
    unc = q["unc"].astype(float)
    out = {}
    for src, by_L in res["runs"].items():
        if src == "gps":
            continue
        qq = q if src != "baseline" else ev.video_q(vid, "baseline", thr)
        u = qq["unc"].astype(float)
        row = {}
        for cut in (1.01, 0.5, 0.3):
            c = w = n = 0
            for L, recs in by_L.items():
                for r in recs:
                    if src == "shuffle":
                        continue  # shuffled order has no meaningful window position
                    share = float(u[r["lo"]:r["hi"]].mean()) if r["hi"] <= len(u) else 0.0
                    if ev.confident(r, rule) and share <= cut:
                        c += r["ok1"]
                        w += not r["ok1"]
                    n += 1
            row[f"unc_share<={cut}" if cut < 1 else "frozen rule"] = dict(conf_correct=c, conf_wrong=w)
        out[src] = row
    out["uncertain_quanta_share_of_all"] = float(unc.mean())
    return out


if __name__ == "__main__":
    print(json.dumps(main(*sys.argv[1:4]), indent=1))


def any_time(runs: str, vid: str, rule_path: str) -> dict:
    """POST HOC alternative truth: a matched quantum counts when both map turn positions lie within 50 m of the GPS track at ANY video time
    (the Rousset track passes many places twice); window correct when >= 70 % of >= 2 matched quanta do. Same confident rule as the frozen one."""
    from scipy.spatial import cKDTree

    from .chain import MapIndex, Params
    res = json.loads((Path(runs) / f"{vid}.json").read_text())
    rule = json.loads(Path(rule_path).read_text())
    ctx = ev.load_ctx(vid, float(res.get("thr", 45.0)))
    ix = MapIndex(ctx.m, Params(**res["params"]))
    tree = cKDTree(np.column_stack([ctx.gc["x"], ctx.gc["y"]]))
    out = {}
    for src in ("refined", "baseline", "gps"):
        row = {}
        for L, recs in res["runs"][src].items():
            top1 = conf_ok = conf_bad = 0
            for r in recs:
                if not r["legs"]:
                    continue
                d = [max(tree.query(ix.ev_mid[ix.A[l]])[0], tree.query(ix.ev_mid[ix.B[l]])[0]) for _, l in r["legs"]]
                ok = len(d) >= ev.MIN_MATCHED and np.mean(np.array(d) <= ev.TOL_M) >= ev.FRAC_OK
                top1 += ok
                if ev.confident(r, rule):
                    conf_ok += ok
                    conf_bad += not ok
            row[L] = dict(windows=len(recs), top1_any_time=int(top1), conf_correct=int(conf_ok), conf_wrong=int(conf_bad))
        out[src] = row
    return out
