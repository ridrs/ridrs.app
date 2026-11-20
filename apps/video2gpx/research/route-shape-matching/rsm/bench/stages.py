# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY (not frozen, not in the sidecar): frozen image-analysis results in test-data/stages/ (docs/CONCEPT_test_strategy.md, A and step 2).

    scripts/heavy.sh .venv/bin/python -m rsm.bench.stages make [--only roanne,gotthard]   # T4: motion + rotation of the full sources, then freeze
    .venv/bin/python -m rsm.bench.stages check [--verify-source]                         # fresh / stale / missing per stage (exit 1 if not all fresh)

A stage is the contract between the image side and the route side: motion/ and rotation/ of one whole source video (rotation/ includes the sure
standstills), plus stage.json (source sha256, window, params, horizon, step keys of motion and rotation by the source hash, frozen.json hash, GPS
clock alignment for the Van Gestel rides, timings). The route tests (T2) read stages, never the video; a stage whose keys differ from the current
code is stale, and T4 (`make`) rebuilds it. The sources and their truth come from clip_sources.json; motion and rotation run as
`python -m rsm.pipeline _step` workers (rsm.bench.regress.run_case) in work/stages/<id>/, which is removed after the freeze."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import sys
import time
from pathlib import Path

import numpy as np

from . import stepcache as SC

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                                    # research/route-shape-matching (holds the rsm package)
APP = HERE.parents[3]                                     # apps/video2gpx
SOURCES = APP / "test-data" / "sources"
STAGES = APP / "test-data" / "stages"
WORK = ROOT / "work" / "stages"
VERSION = 1
IMAGE_STEPS = ["motion", "rotation"]
# the sources with a truth (GPS, checkpoints or landmarks); Cayolle has none and no stage (docs/CONCEPT_test_strategy.md, step 2)
STAGE_IDS = ["roanne", "pontaix", "rousset", "grimone", "cdp", "pennes", "lahntal", "marburg", "madone", "amalfi", "gotthard", "bavaria"]

for _k, _d in (("V2G_TEST_DATA", str(APP / "test-data")), ("RSM_VIDEOS", str(SOURCES))):
    os.environ.setdefault(_k, _d)


def _x(s: str) -> str:
    return os.path.expanduser(os.path.expandvars(s))


def case(sid: str) -> dict:
    """the source entry of clip_sources.json"""
    for c in json.loads((HERE / "clip_sources.json").read_text())["sources"]:
        if c["id"] == sid:
            return c
    raise KeyError(sid)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def params(c: dict) -> dict:
    b = c["bbox"]
    return dict(video=str(Path(_x(c["video"])).resolve()), bbox=dict(south=b[0], west=b[1], north=b[2], east=b[3]), pbf=None, vehicle=c.get("vehicle", "auto"), offset_m=None,
                start_time=None, traffic_side="auto", decoys=0, start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")


def gps_align(c: dict, motion_csv: Path) -> dict:
    """GPS clock against video clock for a GPS case: windowed correlation of the vms yaw rate with the GPS heading rate (rsm.bench.gps_truth)"""
    from . import clips as CL, gps_truth as GT
    _, lon, _ = GT.load_gpx(c["gps"])
    gb = GT.gps_base(c["gps"], CL._utm(float(np.median(lon))))
    rows, used = GT.estimate_lags(GT.vms_rate(motion_csv), gb, span=CL.LAG_SPAN)
    return dict(method="rsm.bench.gps_truth.estimate_lags: 300 s windows every 150 s, corr >= 0.7", gps=c["gps"], span_s=CL.LAG_SPAN, windows=rows,
                used=[list(u) for u in used])


def freeze(sid: str, work: Path, src: Path, sources: Path, P: dict, out_root: Path, root: Path = ROOT, gps_align: dict | None = None) -> Path:
    """copy motion/ and rotation/ of a finished image side (work) to out_root/<sid>/ and write stage.json -> that directory"""
    out = Path(out_root) / sid
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for sub in IMAGE_STEPS:
        shutil.copytree(Path(work) / sub, out / sub)
    mj = json.loads((Path(work) / "motion" / "summary.json").read_text())           # duration_s, fps, horizon of the motion step
    sha = sha256(Path(src))
    fz = json.loads((Path(root) / "rsm" / "pipeline" / "frozen.json").read_text())
    secs = {s: json.loads((Path(work) / "steps" / f"{s}.done.json").read_text()).get("seconds") for s in IMAGE_STEPS}
    stage = dict(version=VERSION, case=sid,
                 source=dict(id=Path(src).parent.name, path=str(Path(src).resolve().relative_to(Path(sources).resolve())), sha256=sha,
                             duration_s=float(mj["duration_s"]), fps=float(mj["fps"])),
                 window=[0.0, float(mj["duration_s"])],
                 params=dict(vehicle=P.get("vehicle", "auto"), intro_end=P.get("intro_end"), bbox=P["bbox"]),
                 code=SC.step_keys(root, P, IMAGE_STEPS, video_sig=sha),
                 frozen=dict(code_hash=fz.get("code_hash"), version=fz.get("version")),
                 horizon=mj.get("horizon"),
                 gps_align=gps_align,
                 made=dict(date=time.strftime("%Y-%m-%dT%H:%M:%S"), host=socket.gethostname(), seconds=secs))
    (out / "stage.json").write_text(json.dumps(stage, indent=1, default=float) + "\n")
    return out


def status(d: Path, root: Path = ROOT) -> str:
    """fresh (keys equal the current code's), stale, or missing"""
    f = Path(d) / "stage.json"
    if not f.exists():
        return "missing"
    s = json.loads(f.read_text())
    P = dict(s["params"], video=str(SOURCES / s["source"]["path"]))
    return "fresh" if SC.step_keys(root, P, IMAGE_STEPS, video_sig=s["source"]["sha256"]) == s["code"] else "stale"


def make(sid: str, root: Path = ROOT, out_root: Path = STAGES, log=print, reuse_work: bool = False) -> Path:
    """T4 for one source: motion + rotation of the whole video with the code under root, then freeze. reuse_work: freeze a finished
    work/stages/<id>/ of an earlier make (after a failed freeze) instead of running the steps again"""
    from . import regress as R
    c = case(sid)
    P = params(c)
    src = Path(P["video"])
    if not src.exists():
        raise FileNotFoundError(src)
    work = WORK / sid
    t0 = time.time()
    if not (reuse_work and all((work / "steps" / f"{s}.done.json").exists() for s in IMAGE_STEPS)):
        if work.exists():
            shutil.rmtree(work)
        R.run_case(dict(name=f"stage-{sid}"), "stages", root, None, None, log, d=work, P=P, until="rotation", cache=False)
    ga = gps_align(c, work / "motion" / "motion.csv") if c.get("truth") == "gps" else None
    out = freeze(sid, work, src, SOURCES, P, out_root, root=root, gps_align=ga)
    shutil.rmtree(work)
    log(f"{sid}: frozen in {time.time() - t0:.0f} s -> {out}" + (f" (GPS clock: {len(ga['used'])} of {len(ga['windows'])} windows)" if ga else ""))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rsm.bench.stages")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    m.add_argument("--only", default=None, help="comma-separated stage ids (default: all of STAGE_IDS)")
    m.add_argument("--reuse-work", action="store_true", help="freeze a finished work/stages/<id>/ instead of running motion and rotation again")
    ch = sub.add_parser("check")
    ch.add_argument("--verify-source", action="store_true", help="also hash the source videos (slow) and compare with stage.json")
    ch.add_argument("--only", default=None, help="comma-separated stage ids (default: all of STAGE_IDS)")
    a = ap.parse_args(argv)
    ids = a.only.split(",") if getattr(a, "only", None) else STAGE_IDS
    if a.cmd == "make":
        failed = []
        for sid in ids:
            try:
                make(sid, reuse_work=a.reuse_work)
            except Exception as e:                       # one failed source must not stop the others; reported at the end
                print(f"{sid}: FAILED {type(e).__name__}: {e}", flush=True)
                failed.append(sid)
        print("failed: " + ", ".join(failed) if failed else "all stages frozen")
        return 1 if failed else 0
    bad = 0
    for sid in ids:
        st = status(STAGES / sid)
        note = ""
        if st != "missing" and a.verify_source:
            s = json.loads((STAGES / sid / "stage.json").read_text())
            p = SOURCES / s["source"]["path"]
            if not p.exists() or sha256(p) != s["source"]["sha256"]:
                st, note = "stale", " (source changed or missing)"
        bad += st != "fresh"
        print(f"{sid:10s} {st}{note}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
