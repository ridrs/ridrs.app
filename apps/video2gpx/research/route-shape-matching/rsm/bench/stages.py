# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY (not frozen, not in the sidecar): frozen image-analysis results in test-data/stages/ (docs/CONCEPT_test_strategy.md, A and step 2).

    scripts/heavy.sh .venv/bin/python -m rsm.bench.stages make [--only roanne,gotthard]   # T4: motion + rotation of the full sources, then freeze
    .venv/bin/python -m rsm.bench.stages check [--verify-source]                         # fresh / stale / missing per stage (exit 1 if not all fresh)
    .venv/bin/python -m rsm.bench.stages rekey --reason "..."                             # new keys without T4, for a change shown to change no result
    scripts/heavy.sh .venv/bin/python -m rsm.bench.stages reinterp [--only pontaix]      # motion + rotation again from the stored extraction (minutes)
    .venv/bin/python -m rsm.bench.stages truth                                            # copy the truth files of the sources to test-data/truth/ (T4, also done by make)

A stage is the contract between the image side and the route side: motion/ and rotation/ of one whole source video (rotation/ includes the sure
standstills), plus stage.json (source sha256, window, params, horizon, step keys of motion and rotation by the source hash, frozen.json hash, GPS
clock alignment for the Van Gestel rides, timings). The route tests (T2) read stages, never the video; a stage whose keys differ from the current
code is stale, and T4 (`make`) rebuilds it; a stage that holds its extraction (extract/, docs/CONCEPT_extraction.md phase 4) and whose extraction
is still current only needs `reinterp` after an interpretation change (status `reinterpret`). The sources and their truth come from clip_sources.json; motion and rotation run as
`python -m rsm.pipeline _step` workers (rsm.bench.regress.run_case) in work/stages/<id>/, which is removed after the freeze.

The truth files (the Van Gestel track.gpx, the verified Pontaix track) are copied by `truth` from sources/ to test-data/truth/ under the same relative
paths; T1 to T3 read them there, so that no test reads sources/ (docs/CONCEPT_test_strategy.md, step 6)."""
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
TRUTH = APP / "test-data" / "truth"
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
    has_extract = (Path(work) / "extract" / "extract.json").exists()
    if has_extract:                                    # the motion step's extraction (docs/CONCEPT_extraction.md phase 4): re-interpretable without T4
        shutil.copytree(Path(work) / "extract", out / "extract")
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
                 extract=extract_identity(sha, root=root) if has_extract else None,
                 made=dict(date=time.strftime("%Y-%m-%dT%H:%M:%S"), host=socket.gethostname(), seconds=secs))
    (out / "stage.json").write_text(json.dumps(stage, indent=1, default=float) + "\n")
    return out


def truth(sources: Path = SOURCES, out: Path = TRUTH, log=print) -> list[str]:
    """copy the truth files of clip_sources.json (vangestel/<gps>/track.gpx, `verified`) from sources/ to truth/ (same relative paths) -> copied paths"""
    rel = []
    for c in json.loads((HERE / "clip_sources.json").read_text())["sources"]:
        if c.get("gps"):
            rel.append(f"vangestel/{c['gps']}/track.gpx")
        if c.get("verified"):
            rel.append(c["verified"])
    done = []
    for r in rel:
        src, dst = Path(sources) / r, Path(out) / r
        if not src.exists():
            log(f"truth: {r} missing in the sources")
            continue
        if dst.exists() and dst.stat().st_size == src.stat().st_size and dst.read_bytes() == src.read_bytes():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        done.append(r)
    return done


#: the code that shapes the stored extraction beyond extract.VERSION and extract.params() (the decode and the extraction itself); vmsx.motion is
#: left out on purpose (it holds the interpretation; its Destatic and LK settings are in params()), so a change of the destatic filter's code
#: needs extract.VERSION raised
EXTRACT_CODE = ("rsm/pipeline/vmsx/extract.py", "rsm/pipeline/vmsx/decode.py")


def extract_identity(sha: str, root: Path = ROOT) -> dict:
    """what the stored extraction of a stage depends on: the source (sha256), the extraction's version, settings and height, the OpenCV build,
    and the source of its code under root"""
    import cv2

    from rsm.pipeline import config as PC
    from rsm.pipeline.vmsx import extract as EX
    code = hashlib.sha256(b"".join((Path(root) / f).read_bytes() for f in EXTRACT_CODE)).hexdigest()[:16]
    return json.loads(json.dumps(dict(version=EX.VERSION, params=EX.params(), height=int(PC.VMS["height"]), opencv=cv2.__version__, code=code, sha256=sha)))


def status(d: Path, root: Path = ROOT) -> str:
    """fresh (keys equal the current code's); reinterpret (keys differ, the stored extraction is current: `reinterp` rebuilds motion/ and rotation/
    in minutes); stale (T4); missing"""
    f = Path(d) / "stage.json"
    if not f.exists():
        return "missing"
    s = json.loads(f.read_text())
    P = dict(s["params"], video=str(SOURCES / s["source"]["path"]))
    if SC.step_keys(root, P, IMAGE_STEPS, video_sig=s["source"]["sha256"]) == s["code"]:
        return "fresh"
    if s.get("extract") and (Path(d) / "extract" / "extract.json").exists() and s["extract"] == extract_identity(s["source"]["sha256"], root=root):
        return "reinterpret"
    return "stale"


def reinterp(sid: str, root: Path = ROOT, out_root: Path = STAGES, log=print) -> Path:
    """the image side of a stage again from its stored extraction (no full decode; the pixel probes read short windows of the source), then freeze:
    for a stage whose status is `reinterpret`"""
    from rsm.pipeline import config as PC, steps_a as SA

    from . import regress as R
    sd = Path(out_root) / sid
    s = json.loads((sd / "stage.json").read_text())
    if not (s.get("extract") and (sd / "extract" / "extract.json").exists() and s["extract"] == extract_identity(s["source"]["sha256"], root=root)):
        raise RuntimeError(f"stage {sid}: its extraction is missing or made by other extraction code: run T4 (rsm.bench.stages make --only {sid})")
    c = case(sid)
    P = params(c)
    src = Path(P["video"])
    if not src.exists():
        raise FileNotFoundError(src)
    work = WORK / sid
    t0 = time.time()
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    shutil.copytree(sd / "extract", work / "extract")
    mf = work / "extract" / "extract.json"
    m = json.loads(mf.read_text())
    m["key"] = SA.extract_key(str(src), PC.VMS["height"])      # the same extraction (source hash checked above), keyed for this run's video path
    mf.write_text(json.dumps(m, indent=1))
    R.run_case(dict(name=f"stage-{sid}"), "stages", root, None, None, log, d=work, P=P, until="rotation", cache=False)
    ga = gps_align(c, work / "motion" / "motion.csv") if c.get("truth") == "gps" else s.get("gps_align")
    out = freeze(sid, work, src, SOURCES, P, out_root, root=root, gps_align=ga)
    st = json.loads((out / "stage.json").read_text())
    st["made"]["reinterpreted"] = dict(date=st["made"]["date"], extracted=s["made"].get("extracted", s["made"]["date"]))
    st["made"]["extracted"] = st["made"]["reinterpreted"]["extracted"]
    (out / "stage.json").write_text(json.dumps(st, indent=1, default=float) + "\n")
    shutil.rmtree(work)
    log(f"{sid}: re-interpreted in {time.time() - t0:.0f} s -> {out}")
    return out


def rekey(sid: str, reason: str, root: Path = ROOT, out_root: Path = STAGES) -> dict:
    """give a stale stage the step keys of the current code without running T4, for a change that leaves motion/ and rotation/ as they are (a
    pass-through option, a comment); `reason` names the change and how that was shown, and stage.json keeps the old keys in `rekeyed`"""
    f = Path(out_root) / sid / "stage.json"
    s = json.loads(f.read_text())
    P = dict(s["params"], video=str(SOURCES / s["source"]["path"]))
    new = SC.step_keys(root, P, IMAGE_STEPS, video_sig=s["source"]["sha256"])
    if new != s["code"]:
        s.setdefault("rekeyed", []).append(dict(date=time.strftime("%Y-%m-%dT%H:%M:%S"), old=s["code"], reason=reason))
        s["code"] = new
        f.write_text(json.dumps(s, indent=1, default=float) + "\n")
    return s


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
    rk = sub.add_parser("rekey", help="new step keys without T4, for a change shown to leave the image results as they are")
    rk.add_argument("--only", default=None, help="comma-separated stage ids (default: all of STAGE_IDS)")
    rk.add_argument("--reason", required=True, help="the change and how it was shown to leave motion/ and rotation/ unchanged")
    ri = sub.add_parser("reinterp", help="motion and rotation again from the stored extraction of the stages whose status is reinterpret (minutes, no T4)")
    ri.add_argument("--only", default=None, help="comma-separated stage ids (default: every stage whose status is reinterpret)")
    sub.add_parser("truth", help="copy the truth files of the sources to test-data/truth/")
    ch = sub.add_parser("check")
    ch.add_argument("--verify-source", action="store_true", help="also hash the source videos (slow) and compare with stage.json")
    ch.add_argument("--only", default=None, help="comma-separated stage ids (default: all of STAGE_IDS)")
    a = ap.parse_args(argv)
    ids = a.only.split(",") if getattr(a, "only", None) else STAGE_IDS
    if a.cmd == "truth":
        print("\n".join(truth()) or "truth up to date")
        return 0
    if a.cmd == "make":
        truth()
        failed = []
        for sid in ids:
            try:
                make(sid, reuse_work=a.reuse_work)
            except Exception as e:                       # one failed source must not stop the others; reported at the end
                print(f"{sid}: FAILED {type(e).__name__}: {e}", flush=True)
                failed.append(sid)
        print("failed: " + ", ".join(failed) if failed else "all stages frozen")
        return 1 if failed else 0
    if a.cmd == "reinterp":
        todo = a.only.split(",") if a.only else [sid for sid in STAGE_IDS if status(STAGES / sid) == "reinterpret"]
        failed = []
        for sid in todo:
            try:
                reinterp(sid)
            except Exception as e:                       # as make: report at the end
                print(f"{sid}: FAILED {type(e).__name__}: {e}", flush=True)
                failed.append(sid)
        print("failed: " + ", ".join(failed) if failed else f"{len(todo)} stages re-interpreted")
        return 1 if failed else 0
    if a.cmd == "rekey":
        for sid in ids:
            print(f"{sid:10s} {'rekeyed' if rekey(sid, a.reason).get('rekeyed') else 'unchanged'}")
        return 0
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
