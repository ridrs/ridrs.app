#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn a checked spot into a fast regression case of the snippet suite (video2gpx-runs/_testsuite/<name>/).

    $PY make_test.py <run> --name nice-monaco-tunnel-louis2 --t0 3960 --t1 4100 --checkpoints cps.json \
        --kind error|uncertain_correct --spot S16 --cause rotation.tunnel_wall_bias --why "..." [--focus 3993,4023]

cps.json: [{"name", "t" (ORIGINAL video seconds), "lat", "lon", "tol_m" (50 at sharp junctions, 100 elsewhere), "why" (what the frames show)}]
The first checkpoint becomes the start frame of the case (start_bbox, +-200 m) when it lies within 30 s of t0: the snippet then starts
from a known position, as the full run did, and the case tests the problem spot, not a cold start.

Writes clip.mp4 (frame-accurate x264 crf 23 re-encode at most 480p, video only, same frame rate), case.json, and bench.json (the same case in the format of
rsm/bench/regress_cases.json + regress_landmarks.json, score "checkpoints", for adoption into the repo bench).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from _lib import SUITE, Path1D, ffmpeg, jdump, jload, run_dir, transformer, video_of  # noqa: E402


def box_around(lat, lon, m):
    dla = m / 111320
    dlo = m / (111320 * max(np.cos(np.radians(np.mean(lat))), 0.2))
    return [round(float(np.min(lat) - dla), 6), round(float(np.min(lon) - dlo), 6), round(float(np.max(lat) + dla), 6), round(float(np.max(lon) + dlo), 6)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--name", required=True, help="<video>-<place>-<problem>, lowercase with hyphens")
    ap.add_argument("--t0", type=float, default=None, help="snippet start, original video seconds")
    ap.add_argument("--t1", type=float, default=None)
    ap.add_argument("--checkpoints", required=True)
    ap.add_argument("--kind", required=True, choices=["error", "uncertain_correct", "control"])
    ap.add_argument("--spot", default=None)
    ap.add_argument("--cause", default=None, help="cause id from references/causes.md, e.g. rotation.tunnel_wall_bias")
    ap.add_argument("--why", default="", help="one sentence: what goes wrong (or is uncertain) and why")
    ap.add_argument("--focus", default=None, help="t0,t1 of the problem itself (original seconds); default: the spot")
    ap.add_argument("--no-start-frame", action="store_true")
    ap.add_argument("--no-backtrack", action="store_true",
                    help="the frames show no U-turn in the focus window: the decoded path must not run backwards there (chord >= 15 m over 40 m of path)")
    ap.add_argument("--bbox-margin-km", type=float, default=2.0)
    ap.add_argument("--vehicle", default=None, help="default: the vehicle the full run settled on")
    ap.add_argument("--video", default=None, help="source video (default: the run's video)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--full-from", default=None, choices=["route_search", "plausibility", "refine", "gpx"],
                    help="no snippet: the WHOLE video, seeded with the finished run (motion, rotation, map reused); reruns from this step. For causes a "
                         "snippet cannot reproduce because it loses the full run's calibration. --t0/--t1 are ignored; checkpoint t are video seconds.")
    ap.add_argument("--no-backtrack-windows", default=None, help="'t0,t1[,max_turn];...' video seconds where the frames show no U-turn; max_turn = the largest total path turn (deg) the video allows there")
    a = ap.parse_args()
    if a.full_from:
        return full_case(a)
    if a.t0 is None or a.t1 is None:
        sys.exit("--t0 and --t1 are needed for a snippet case")

    rd = run_dir(a.run)
    Pj = jload(rd / "run" / "project.json")
    A = jload(rd / "review" / "analysis.json") if (rd / "review" / "analysis.json").exists() else {}
    R = np.load(rd / "run" / "refine" / "result.npz")
    video = Path(a.video) if a.video else video_of(rd)
    cps = jload(Path(a.checkpoints))
    if not cps:
        sys.exit("no checkpoints")
    for c in cps:
        if not (a.t0 <= c["t"] <= a.t1):
            sys.exit(f"checkpoint {c['name']} at {c['t']} s lies outside the snippet {a.t0}-{a.t1}")
    dur = a.t1 - a.t0
    if dur > 420:
        print(f"warning: snippet is {dur:.0f} s; the suite aims at <= 7 min of video per case (runtime about 1-5 min)", file=sys.stderr)

    case = SUITE / a.name
    if case.exists() and not a.force:
        sys.exit(f"{case} exists (use --force to rebuild)")
    case.mkdir(parents=True, exist_ok=True)

    # snippet: frame-accurate re-encode (seek before input is exact with re-encoding), keep every frame and its rate
    fps = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(video)],
                         capture_output=True, text=True).stdout.strip()
    ffmpeg("-ss", f"{a.t0:.3f}", "-i", str(video), "-t", f"{dur:.3f}", "-an", "-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
           "-vf", "scale=-2:'min(480,ih)'", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-movflags", "+faststart", str(case / "clip.mp4"))

    # area: the decoded positions of the full run in the snippet window plus every checkpoint, grown by the margin
    path = Path1D(R["sg"], R["xy"])
    tt = R["t"][(R["t"] >= a.t0) & (R["t"] <= a.t1)]
    xy = path.xy_at(np.interp(tt, R["t"], R["s"]))
    lon, lat = transformer(str(R["crs"])).transform(xy[:, 0], xy[:, 1])
    lat = np.concatenate([lat, [c["lat"] for c in cps]]); lon = np.concatenate([lon, [c["lon"] for c in cps]])
    bbox = box_around(lat, lon, a.bbox_margin_km * 1000)

    cps = sorted(cps, key=lambda c: c["t"])
    start = None
    if not a.no_start_frame and cps[0]["t"] - a.t0 <= 30:
        start = box_around([cps[0]["lat"]], [cps[0]["lon"]], 200)
    rel = [dict(c, t=round(c["t"] - a.t0, 2), t_video=c["t"]) for c in cps]
    if start:
        rel[0]["start_frame"] = True
    spot = next((s for s in A.get("spots", []) + A.get("controls", []) if s.get("id") == a.spot), None)
    f0, f1 = (map(float, a.focus.split(","))) if a.focus else ((spot["t0"], spot["t1"]) if spot else (a.t0, a.t1))
    eff = Pj.get("effective", {})
    vehicle = a.vehicle or eff.get("vehicle") or "auto"

    c = dict(
        name=a.name, created=dt.date.today().isoformat(), kind=a.kind, cause=a.cause, why=a.why,
        expect=dict(checkpoints="all", now=("fail" if a.kind == "error" else "pass"), no_backtrack=bool(a.no_backtrack),
                    improve="focus_conf" if a.kind == "uncertain_correct" else None),
        source=dict(run=str(rd), youtube_id=rd.name, video=str(video), t0=a.t0, t1=a.t1, spot=a.spot, pipeline_hash=Pj.get("pipeline_hash"),
                    full_run_conf_focus=float(np.mean(R["conf"][(R["t"] >= f0) & (R["t"] <= f1)])) if np.any((R["t"] >= f0) & (R["t"] <= f1)) else None),
        video="clip.mp4", fps=fps, duration_s=round(dur, 2), pbf=Pj["params"]["pbf"], bbox=bbox, start_bbox=start, vehicle=vehicle,
        params=dict(intro_end=0.01, decoys=0), focus=[round(f0 - a.t0, 2), round(f1 - a.t0, 2)], checkpoints=rel)
    jdump(c, case / "case.json")
    bench = dict(
        case=dict(name=a.name, video=str(case / "clip.mp4"), source_video=str(video), cut=f"{a.t0:.2f}-{a.t1:.2f} s, x264 crf 23 re-encode, video only",
                  pbf=Pj["params"]["pbf"], bbox=bbox, **({"start_bbox": start} if start else {}), vehicle=vehicle, params=dict(intro_end=0.01),
                  bbox_rule=f"decoded positions of {rd.name} in the window + checkpoints, +{a.bbox_margin_km} km", score="checkpoints",
                  why=f"{a.kind}: {a.why} (video2gpx-review {rd.name} {a.spot or ''})"),
        landmarks=[{k: v for k, v in cp.items() if k in ("name", "t", "lat", "lon", "tol_m", "why")} for cp in rel])
    jdump(bench, case / "bench.json")
    size = (case / "clip.mp4").stat().st_size / 1e6
    print(f"{case}: {dur:.0f} s clip ({size:.0f} MB), {len(rel)} checkpoints, start frame {'yes' if start else 'no'}, bbox {bbox}")


def full_case(a):
    """a case on the whole video, seeded with the finished run: the expensive motion and rotation steps are reused, the run's own calibration
    context is kept, and only the steps from --full-from on are recomputed (route_search + refine: about 8 min for 75 min of video)"""
    rd = run_dir(a.run)
    Pj = jload(rd / "run" / "project.json")
    R = np.load(rd / "run" / "refine" / "result.npz")
    P = Pj["params"]
    cps = sorted(jload(Path(a.checkpoints)), key=lambda c: c["t"])
    case = SUITE / a.name
    if case.exists() and not a.force:
        sys.exit(f"{case} exists (use --force to rebuild)")
    case.mkdir(parents=True, exist_ok=True)
    b = P["bbox"]
    box = lambda x: ",".join(str(x[k]) for k in ("south", "west", "north", "east")) if isinstance(x, dict) else ",".join(map(str, x))
    args = []
    if P.get("hint"):
        args += ["--hint", P["hint"], "--hint-buffer-m", str(P.get("hint_buffer_m", 300)), "--hint-fallback", P.get("hint_fallback", "auto")]
    if P.get("anchors"):
        anc = [dict(t=x["t"], bbox=[x["bbox"][k] for k in ("south", "west", "north", "east")] if isinstance(x["bbox"], dict) else x["bbox"]) for x in P["anchors"]]
        args += ["--anchors", json.dumps(anc)]
    for k, f in (("start_bbox", "--start-bbox"), ("end_bbox", "--end-bbox")):
        if P.get(k):
            args += [f, box(P[k])]
    win = [[float(v) for v in w.split(",")] for w in a.no_backtrack_windows.split(";")] if a.no_backtrack_windows else []
    f0, f1 = map(float, a.focus.split(",")) if a.focus else (0.0, float(R["t"][-1]))
    sel = (R["t"] >= f0) & (R["t"] <= f1)
    c = dict(
        name=a.name, created=dt.date.today().isoformat(), kind=a.kind, cause=a.cause, why=a.why, mode="full_seeded",
        expect=dict(checkpoints="all", now=("fail" if a.kind == "error" else "pass"), no_backtrack_windows=win,
                    improve="focus_conf" if a.kind == "uncertain_correct" else None),
        source=dict(run=str(rd), youtube_id=rd.name, video=str(video_of(rd)), spot=a.spot, pipeline_hash=Pj.get("pipeline_hash"),
                    full_run_conf_focus=float(R["conf"][sel].mean()) if sel.any() else None),
        video=str(video_of(rd)), seed_dir=str(rd / "run"), from_step=a.full_from, duration_s=float(R["t"][-1]),
        pbf=P["pbf"], bbox=[b[k] for k in ("south", "west", "north", "east")] if isinstance(b, dict) else b, start_bbox=None,
        vehicle=P.get("vehicle") or "auto", params=dict(intro_end=P.get("intro_end") or 0.01, decoys=P.get("decoys", 0)), args=args,
        focus=[f0, f1], checkpoints=[dict(cp, t_video=cp["t"]) for cp in cps])
    jdump(c, case / "case.json")
    print(f"{case}: whole video seeded from {rd / 'run'}, rerun from {a.full_from}; {len(cps)} checkpoints, {len(win)} no-backtrack windows")


if __name__ == "__main__":
    main()
