# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY T3 of docs/CONCEPT_test_strategy.md (block D): the whole pipeline (motion to gpx) on the two long videos of about 10 min, the only
check that the image side and the route side still fit together.

    .venv/bin/python -m rsm.bench.long cut [--only id,...]                     # stream copy from the source -> test-data/long/<id>/ (video.<ext>, case.json)
    scripts/heavy.sh .venv/bin/python -m rsm.bench.long run [--only ...] [--t2 TAG]   # the whole pipeline, score, check
    .venv/bin/python -m rsm.bench.long score [--only ...] [--t2 TAG]          # score the runs again, no pipeline

The long videos are listed in long_set.json (committed); the videos are git-ignored. Each starts at second 0 of its source, so its seconds are source
seconds. A long video runs through the step cache like a regress case (rsm.bench.regress.run_case, its route case `case` with the video replaced) into
work/regress/t3/<id>/, and is scored as that case (verified track, checkpoints) plus:
  parity   motion and rotation of the run against the same window of the frozen stage (`par_*`: per-second speed correlation and ratio, yaw
           correlation, scene cuts not in both, standstill seconds); a mismatch means the stage no longer stands for the code (T4) or the cut differs;
  t2       with --t2 TAG, the route of the run against the T2 run of the same window on the stage (work/regress/<TAG>/<case>): same road share and the
           median position difference at the same second (`t2_*`).
`check` holds a row against the `checks` of the long video (min / max per score, rsm.bench.clips.check); tests/test_t3_long.py (marker `long`) runs it."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from . import clips as CL
from . import regress as RG
from . import stages as ST

HERE = Path(__file__).resolve().parent
LONG = CL.APP / "test-data" / "long"
TAG = "t3"


def long_set(only=None) -> list[dict]:
    ls = json.loads((HERE / "long_set.json").read_text())["long"]
    return [c for c in ls if not only or c["id"] in only]


def cut(c: dict, log=print, again: bool = False) -> Path:
    if float(c["t0"]) != 0.0:
        raise ValueError(f"{c['id']}: a long video starts at second 0 of its source (its seconds are source seconds)")
    return CL.cut(c, log, again=again, root=LONG, stem="video", meta_name="case.json")


def meta(c: dict) -> dict:
    return json.loads((LONG / c["id"] / "case.json").read_text())


def case(c: dict) -> dict:
    """the regress case of the long video: the route case `case` with the long video, the window [0, dur) of its stage, the checkpoints of `landmarks`"""
    base = [x for x in RG.cases() if x["name"] == c["case"]][0]
    out = {k: v for k, v in base.items() if k not in ("start_bbox", "start_bbox_rule", "known", "seed", "same_route_as")}
    out.update(name=c["id"], video=str(LONG / c["id"] / meta(c)["file"]), stage=c["stage"], window=[0.0, float(c["dur"])])
    if c.get("landmarks"):
        out["landmarks"] = c["landmarks"]
    return out


def run(c: dict, log=print) -> Path:
    cc = case(c)
    return RG.run_case(cc, TAG, RG.ROOT, None, None, log, P=RG.params(cc))


def parity(c: dict, d: Path) -> dict:
    """motion and rotation of the run d against the window [0, dur) of the frozen stage"""
    st = ST.STAGES / c["stage"]
    n = int(np.floor(min(float(c["dur"]), float(meta(c)["duration"]))))
    vs, _ = CL._speed_per_second(d / "motion" / "motion.csv", 0.0, n)
    vf, _ = CL._speed_per_second(st / "motion" / "motion.csv", 0.0, n)
    ok = np.isfinite(vs) & np.isfinite(vf) & (vf > 0)
    t = np.arange(n, dtype=float)
    i1, a1 = CL._increments(*CL._heading_on(CL._tracks(d), t))
    i2, b1 = CL._increments(*CL._heading_on(CL._tracks(st), t))
    both = np.intersect1d(i1, i2)
    er, es = CL.events(d, 0.0), CL.events(st, 0.0)
    cs = [x for x in es["cuts"] if x < n]
    unmatched = sum(not any(abs(x - y) <= CL.CUT_TOL for y in cs) for x in er["cuts"]) + sum(not any(abs(x - y) <= CL.CUT_TOL for y in er["cuts"]) for x in cs)
    still = lambda sp: float(sum(max(0.0, min(b, n) - a) for a, b in sp if a < n))
    return dict(par_v_corr=CL._corr(vs, vf), par_v_ratio=float(np.median(vs[ok] / vf[ok])) if ok.sum() >= 10 else None,
                par_yaw_corr=CL._corr(a1[np.isin(i1, both)], b1[np.isin(i2, both)]) if len(both) >= 10 else None,
                par_cuts_unmatched=int(unmatched), par_still_s=still(er["still"]), par_still_s_stage=still(es["still"]))


def score(c: dict, t2: str | None = None) -> dict:
    d = RG.WORK / TAG / c["id"]
    row = RG.score_case(case(c), d)
    row.update(parity(c, d))
    ref = RG.WORK / t2 / c["case"] if t2 else None
    if ref is not None and (ref / "refine" / "result.npz").exists():
        row.update({f"t2_{k}": v for k, v in RG.same_route(d, ref).items()})
    row["first_frame_equal"] = meta(c).get("first_frame_equal")
    if row.get("checkpoints"):
        row["cp_missed"] = sum(not cp["ok"] for cp in row["checkpoints"])
    if c.get("known"):
        row["known"] = c["known"]
    return row


def check(row: dict, c: dict) -> list[str]:
    bad = CL.check(row, c)
    if c.get("verdict") and row.get("verdict") not in c["verdict"]:
        bad.append(f"verdict {row.get('verdict')} (allowed {', '.join(c['verdict'])})")
    if row.get("error"):
        bad.append(row["error"])
    return bad


def fmt(rows: list[dict]) -> str:
    cols = ["verdict", "correct_road", "along_median", "along_p90", "cp_ok", "cp_max_m", "par_v_corr", "par_v_ratio", "par_yaw_corr", "par_cuts_unmatched",
            "par_still_s", "par_still_s_stage", "t2_same_road_share", "t2_position_diff_median_m", "check"]
    out = ["| long | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
    for r in rows:
        out.append(f"| {r['case']} | " + " | ".join(CL._f(r.get(k)) for k in cols) + " |")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rsm.bench.long")
    ap.add_argument("cmd", choices=["cut", "run", "score", "list"])
    ap.add_argument("--only", default=None)
    ap.add_argument("--again", action="store_true", help="cut: cut again, replacing the videos that exist")
    ap.add_argument("--t2", default=None, help="T2 tag whose run of the same window the route is compared with (e.g. t2base)")
    a = ap.parse_args(argv)
    log = lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)
    ls = long_set(a.only.split(",") if a.only else None)
    if a.cmd == "list":
        for c in ls:
            print(c["id"], c["why"], "cut" if (LONG / c["id"] / "case.json").exists() else "not cut")
        return 0
    if a.cmd == "cut":
        for c in ls:
            cut(c, log, again=a.again)
        return 0
    rows, failed = [], 0
    for c in ls:
        try:
            if a.cmd == "run":
                log(f"long {c['id']}")
                run(c, log)
            r = score(c, a.t2)
            r["check"] = "; ".join(check(r, c)) or "ok"
        except Exception as e:                  # noqa: BLE001  one video must not stop the other
            log(f"  {c['id']} FAILED: {type(e).__name__}: {e}")
            r = dict(case=c["id"], check=f"{type(e).__name__}: {e}")
        failed += r["check"] != "ok"
        rows.append(r)
    txt = fmt(rows)
    print(txt)
    (RG.WORK / TAG).mkdir(parents=True, exist_ok=True)
    (RG.WORK / TAG / "table.md").write_text(txt + "\n")
    (RG.WORK / TAG / "table.json").write_text(json.dumps(rows, indent=1, default=float))
    print(f"\n{len(rows) - failed} of {len(rows)} long videos pass their checks")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
