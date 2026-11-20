# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY clip bench, T1 of docs/CONCEPT_test_strategy.md (block B): the image analysis (motion, rotation with scene cuts and standstills)
on short clips of the test sources, scored against the frozen stage of the source, the verified track and the events read from the frames.

    .venv/bin/python -m rsm.bench.clips cut [--only id,...]                              # stream copy from a keyframe -> test-data/clips/<id>/
    scripts/heavy.sh .venv/bin/python -m rsm.bench.clips run [--only ...] [--save NAME] [--baseline NAME]   # motion + rotation, score, check
    .venv/bin/python -m rsm.bench.clips score [--only ...]                               # score the runs again, no pipeline

The clips are listed in clip_set.json (committed); the videos are git-ignored. A clip is cut by stream copy from the last keyframe at or before the
wanted start, so it holds the source's own coded frames and decodes to the same pixels as the full video (checked on the first frame when cut).
Each clip runs as `python -m rsm.pipeline _step` workers through the step cache (rsm.bench.regress.run_case), with the horizon calibration of the
source's stage (P["calibration"] = stages/<source>/motion/motion.json), except the clips marked `calibrate`.

Scores of a clip (`score`):
  parity     against the same window of the stage: per-second speed correlation and ratio, yaw correlation (vs_full_*), for every clip;
  verified   Pontaix only, against the verified track (`<time>` = video time, no clock alignment): v_fail, v_err_med, v_scale, rot_rms_deg, turn_err;
             the other Van Gestel GPS tracks are coarse truth (place only) and give no timed score here;
  events     the scene cuts (rotation/cuts.json) and the sure standstills (rotation/standstill.json) against `cut_at` and `still` of the clip.
`check` holds a row against the clip's `checks` (min / max per score); the T1 tests (tests/test_t1_clips.py, marker `clips`) run the same."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from .regress import ROOT, box, run_case

HERE = Path(__file__).resolve().parent
APP = HERE.parents[3]                                    # apps/video2gpx
CLIPS = APP / "test-data" / "clips"
STAGES = APP / "test-data" / "stages"
RESULTS = ROOT / "work" / "clips"
V_MIN = 1.5          # m/s: seconds slower than this (truth) are not scored for speed
FAIL_LOG = np.log(1.3)
LAG_SPAN = 20.0      # GPS clock search of the stage alignment (rsm.bench.stages.gps_align): +-20 s
CUT_TOL = 0.3        # s: a detected cut within this of an expected one is found
STILL_SHARE = 0.7    # an expected standstill is found when the detected spans cover this share of it
STILL_EDGE = 1.5     # s: a detected standstill further than this outside every expected one is a false standstill
EPOCH_2000 = 946684800.0                                 # the verified track counts video seconds from 2000-01-01T00:00:00Z

for _k, _d in (("V2G_TEST_DATA", str(APP / "test-data")), ("RSM_VIDEOS", str(APP / "test-data" / "sources")), ("RSM_OSM_DIR", "~/rsm-data/osm")):
    os.environ.setdefault(_k, os.path.expanduser(_d))


def _x(s: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars(s)))


def sources() -> dict:
    return {s["id"]: s for s in json.loads((HERE / "clip_sources.json").read_text())["sources"]}


def clip_set(only=None) -> list[dict]:
    cl = json.loads((HERE / "clip_set.json").read_text())["clips"]
    return [c for c in cl if not only or c["id"] in only or c["source"] in only]


def _utm(lon: float) -> str:
    return f"EPSG:{32600 + int((lon + 180) // 6) + 1}"


# ------------------------------------------------------------------ cut
def keyframe_at_or_before(times: list[float], t0: float) -> float:
    """the last keyframe time <= t0 (+1 ms for rounding); the first keyframe if none is"""
    ks = sorted(times)
    before = [k for k in ks if k <= t0 + 1e-3]
    return before[-1] if before else ks[0]


def _keyframes(video: Path, t0: float) -> list[float]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0",
                          "-read_intervals", f"{max(0.0, t0 - 20.0):.3f}%{t0 + 20.0:.3f}", str(video)], capture_output=True, text=True, check=True)
    return [float(x.strip().rstrip(",")) for x in out.stdout.split() if x.strip().rstrip(",")]


def _probe(video: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,codec_name:format=duration,start_time",
                          "-of", "json", str(video)], capture_output=True, text=True, check=True)
    j = json.loads(out.stdout)
    st = j["streams"][0]
    a, b = st["r_frame_rate"].split("/")
    return dict(width=int(st["width"]), height=int(st["height"]), fps=float(a) / float(b), codec=st["codec_name"], duration=float(j["format"]["duration"]),
                start=float(j["format"].get("start_time") or 0.0))


def _frame_md5(video: Path, t: float | None) -> str:
    """md5 of one decoded frame at 360 rows grey (the analysis size): the first frame (t None) or the frame at t"""
    seek = ["-ss", f"{t:.6f}"] if t is not None else []
    out = subprocess.run(["ffmpeg", "-v", "error", *seek, "-i", str(video), "-frames:v", "1", "-vf", "scale=-2:360:flags=area,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True)
    return hashlib.md5(out.stdout).hexdigest()


def cut(c: dict, log=print, again: bool = False, root: Path = CLIPS, stem: str = "clip", meta_name: str = "clip.json") -> Path:
    """stream-copy the clip from the source -> test-data/clips/<id>/ (clip.<ext>, clip.json); kept when it exists, unless `again`. The long videos of
    T3 (rsm.bench.long) are cut the same way into test-data/long/<id>/ (video.<ext>, case.json)"""
    d = root / c["id"]
    meta_f = d / meta_name
    if meta_f.exists() and not again:
        return d
    for old in (d.glob(f"{stem}.*") if d.exists() else []):
        old.unlink()
    s = sources()[c["source"]]
    src = _x(s["video"]).resolve()
    info = _probe(src)
    ks = _keyframes(src, float(c["t0"]))
    kf = keyframe_at_or_before(ks, float(c["t0"]))
    nxt = min([k for k in ks if k > kf + 1e-3], default=kf + 2.0)
    t0 = kf - info["start"]                                       # source seconds of the clip's first frame (the pipeline counts from the first frame)
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{stem}{src.suffix}"
    tmp = d / f"{stem}.tmp{src.suffix}"
    t = time.time()
    # a stream-copy seek lands on a keyframe before the target, but with B-frames not on one just before it (Gotthard: 229.26 s fell back to the
    # keyframe at 223.36 s, 229.5 s found 229.24 s): aim at the middle between the keyframe and the next one; the first-frame check below proves it
    aim = 0.5 * (kf + nxt)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{aim:.6f}", "-i", str(src), "-t", f"{float(c['t0']) + float(c['dur']) - aim:.3f}", "-map", "0:v:0", "-c", "copy",
                    "-an", "-avoid_negative_ts", "make_zero", str(tmp)], check=True)
    tmp.rename(f)
    ci = _probe(f)
    same = _frame_md5(f, None) == _frame_md5(src, kf)
    meta = dict(c, file=f.name, source_path=str(src.relative_to(_x("$V2G_TEST_DATA/sources").resolve())), t0_exact=t0, frame0=int(round(t0 * info["fps"])),
                duration=ci["duration"], fps=ci["fps"], codec=ci["codec"], first_frame_equal=same, bytes=f.stat().st_size, made=time.strftime("%Y-%m-%dT%H:%M:%S"))
    meta_f.write_text(json.dumps(meta, indent=1) + "\n")
    log(f"{c['id']}: cut at {t0:.3f} s ({t0 - float(c['t0']):+.2f} s from the wanted start) in {time.time() - t:.1f} s, {meta['bytes'] / 1e6:.0f} MB"
        + ("" if same else ", FIRST FRAME DIFFERS from the source"))
    return d


def meta(c: dict) -> dict:
    return json.loads((CLIPS / c["id"] / "clip.json").read_text())


# ------------------------------------------------------------------ run
def params(c: dict) -> dict:
    s = sources()[c["source"]]
    m = meta(c)
    P = dict(video=str(CLIPS / c["id"] / m["file"]), bbox=box(s["bbox"]), pbf="", vehicle=s.get("vehicle", "auto"), offset_m=None, start_time=None, traffic_side="auto",
             decoys=0, start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    if not c.get("calibrate"):
        P["calibration"] = str(STAGES / c["source"] / "motion" / "motion.json")
    if m.get("frame0"):
        P["frame0"] = int(m["frame0"])          # seeds the traffic candidate fits as in the whole source (vmsx.motion.pair_row)
    return P


def run_clip(c: dict, log=print) -> Path:
    return run_case(dict(name=f"clip-{c['id']}"), "clips", ROOT, None, None, log, d=RESULTS / "runs" / c["id"], P=params(c), until="rotation")


# ------------------------------------------------------------------ per second
def _speed_per_second(motion_csv: Path, t0: float, n: int):
    """nominal speed per second in [t0, t0 + n) (NaN where fewer than half the pairs are good) and the share of good pairs"""
    from rsm.odometry import gating
    from rsm.odometry.calib import CAMERA_HEIGHT_M
    from rsm.odometry.vms_csv import load_pairs
    from rsm.pipeline import config as C
    p = load_pairs(str(motion_csv))
    good = gating.pair_flags(p) == 0
    v = C.F360 * CAMERA_HEIGHT_M * np.nan_to_num(p.s) / p.dt
    m0 = (p.time >= t0) & (p.time < t0 + n)
    sec = np.floor(p.time[m0] - t0).astype(int)
    vv, gg = v[m0], good[m0]
    vs = np.full(n, np.nan)
    for i in range(n):
        m = sec == i
        if m.any() and gg[m].mean() >= 0.5:
            vs[i] = np.median(vv[m & gg])
    return vs, float(gg.mean()) if len(gg) else 0.0


def _tracks(run: Path) -> list:
    f = run / "rotation" / "tracks.pkl"
    return pickle.load(open(f, "rb")) if f.exists() else []


def _heading_on(tracks, t: np.ndarray):
    """track heading at times t, NaN outside a track, and the track index (-1 outside); only increments inside one track are meaningful"""
    out = np.full(len(t), np.nan)
    seg = np.full(len(t), -1)
    for i, tr in enumerate(tracks):
        m = (t >= tr["t"][0]) & (t <= tr["t"][-1])
        out[m] = np.interp(t[m], tr["t"], tr["th"])
        seg[m] = i
    return out, seg


def _increments(h, seg, lag: int = 2):
    """heading increments over `lag` seconds inside one track: (index, increment)"""
    idx = [i for i in range(len(h) - lag) if seg[i] >= 0 and seg[i] == seg[i + lag]]
    return np.array(idx, dtype=int), np.array([h[i + lag] - h[i] for i in idx])


# ------------------------------------------------------------------ truth
def verified_reference(s: dict, t0: float, n: int) -> dict | None:
    """speed (m/s) and heading (rad, left +, unwrapped) per second of the clip from the verified track, or None without one"""
    if s.get("gps_quality") != "verified":
        return None
    from scipy.ndimage import gaussian_filter1d
    from rsm.bench import gps_truth as GT
    lat, lon, tt = GT.read_gpx(_x("$V2G_TEST_DATA/truth") / s["verified"])
    gb = GT.curve(lat, lon, tt - EPOCH_2000, _utm(float(np.median(lon))))
    t = t0 + np.arange(n + 1, dtype=float)
    tv = np.maximum.accumulate(gb["tg"])
    sg = np.interp(t, tv, gb["s"])
    v = gaussian_filter1d(np.gradient(sg), 1.5, mode="nearest")
    return dict(speed=v[:n], heading=np.interp(t, tv, gb["theta"])[:n], inside=bool(t[0] >= tv[0] and t[-1] <= tv[-1]))


# ------------------------------------------------------------------ score
def _corr(a, b) -> float | None:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 10 or np.std(a[ok]) == 0 or np.std(b[ok]) == 0:
        return None
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def events(run: Path, t0: float) -> dict:
    """detected scene cuts and sure standstills of a clip run, in source seconds"""
    cj = run / "rotation" / "cuts.json"
    sj = run / "rotation" / "standstill.json"
    cuts = [t0 + float(x["t"]) for x in json.loads(cj.read_text())["cuts"]] if cj.exists() else []
    still = [[t0 + float(a), t0 + float(b)] for a, b in json.loads(sj.read_text())["spans"]] if sj.exists() else []
    return dict(cuts=cuts, still=still)


def event_scores(c: dict, ev: dict) -> dict:
    """cuts_missed / cuts_false and still_missed / still_false against `cut_at` / `still` of the clip (only the keys the clip names)"""
    out = {}
    if "cut_at" in c:
        exp = [float(x) for x in c["cut_at"]]
        out["cuts_missed"] = sum(not any(abs(d - e) <= CUT_TOL for d in ev["cuts"]) for e in exp)
        out["cuts_false"] = sum(not any(abs(d - e) <= CUT_TOL for e in exp) for d in ev["cuts"])
    if "still" in c:
        exp = [(float(a), float(b)) for a, b in c["still"]]

        def covered(a, b):
            return sum(max(0.0, min(b, y) - max(a, x)) for x, y in ev["still"]) / max(b - a, 1e-6)
        out["still_missed"] = sum(covered(a, b) < STILL_SHARE for a, b in exp)
        out["still_false"] = sum(not any(x < b + STILL_EDGE and y > a - STILL_EDGE for a, b in exp) for x, y in ev["still"])
    return out


def score(c: dict) -> dict:
    m = meta(c)
    s = sources()[c["source"]]
    run = RESULTS / "runs" / c["id"]
    t0 = float(m["t0_exact"])
    n = int(np.floor(float(m["duration"])))
    vs, usable_pairs = _speed_per_second(run / "motion" / "motion.csv", 0.0, n)
    t = np.arange(n, dtype=float)
    hv, seg = _heading_on(_tracks(run), t)
    row = dict(clip=c["id"], kind=c["kind"], usable=float(np.isfinite(vs).mean()), usable_pairs=usable_pairs, rot_cover=float(np.isfinite(hv).mean()),
               v_nom_p50=float(np.nanmedian(vs)) if np.isfinite(vs).any() else None, first_frame_equal=m.get("first_frame_equal"), t0_exact=t0)
    st = STAGES / c["source"]
    vf, _ = _speed_per_second(st / "motion" / "motion.csv", t0, n)
    row["vs_full_v_corr"] = _corr(vs, vf)
    ok = np.isfinite(vs) & np.isfinite(vf) & (vf > 0)
    row["vs_full_v_ratio"] = float(np.median(vs[ok] / vf[ok])) if ok.sum() >= 10 else None
    hf, segf = _heading_on(_tracks(st), t0 + t)
    i1, a1 = _increments(hv, seg)
    i2, b1 = _increments(hf, segf)
    both = np.intersect1d(i1, i2)
    row["vs_full_yaw_corr"] = _corr(a1[np.isin(i1, both)], b1[np.isin(i2, both)]) if len(both) >= 10 else None
    ref = verified_reference(s, t0, n)
    if ref is not None and ref["inside"]:
        vr = ref["speed"]
        ok = np.isfinite(vs) & (vr > V_MIN) & (vs > 0)
        sc = float(np.median(vr[ok] / vs[ok])) if ok.sum() >= 5 else float("nan")
        e = np.abs(np.log(sc * vs / vr))
        cons = vr > V_MIN
        fail = cons & (~np.isfinite(vs) | ~(e <= FAIL_LOG))
        row.update(v_scale=sc, v_err_med=float(np.nanmedian(e[ok])) if ok.any() else None, v_fail=float(fail.sum() / max(cons.sum(), 1)))
        idx, dv = _increments(hv, seg)
        dr = np.array([ref["heading"][i + 2] - ref["heading"][i] for i in idx])
        if len(dv) >= 5 and np.sum(dv * dv) > 0:
            a = float(np.sum(dv * dr) / np.sum(dv * dv))
            res = dr - a * dv
            big = np.abs(dr) > np.radians(5.0)
            row.update(rot_gain=a, rot_rms_deg=float(np.degrees(np.sqrt(np.mean(res ** 2)))),
                       turn_err=float(np.median(np.abs(res[big]) / np.abs(dr[big]))) if big.sum() >= 3 else None, ref_turn_deg=float(np.degrees(np.sum(np.abs(dr)) / 2)))
    ev = events(run, t0)
    row.update(cuts=[round(x, 2) for x in ev["cuts"]], still=[[round(a, 1), round(b, 1)] for a, b in ev["still"]], **event_scores(c, ev))
    if c.get("known"):
        row["known"] = c["known"]
    return row


def check(row: dict, c: dict) -> list[str]:
    """the failed checks of a scored clip: the events (none missed, none false) and min / max of `checks`"""
    bad = []
    if row.get("first_frame_equal") is False:
        bad.append("the clip's first frame differs from the source")
    for k in ("cuts_missed", "cuts_false", "still_missed", "still_false"):
        if row.get(k):
            bad.append(f"{k} = {row[k]}")
    for op, lim in (c.get("checks") or {}).items():
        for k, v in lim.items():
            x = row.get(k)
            if x is None or not np.isfinite(x) or (op == "min" and x < v) or (op == "max" and x > v):
                bad.append(f"{k} = {x} ({op} {v})")
    return bad


# ------------------------------------------------------------------ table
COLS = ["clip", "usable", "rot_cover", "vs_full_v_corr", "vs_full_v_ratio", "vs_full_yaw_corr", "v_fail", "v_err_med", "rot_rms_deg", "turn_err", "cuts", "still", "check"]


def _f(v):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return ""
    if isinstance(v, float):
        return f"{v:.3g}"
    if isinstance(v, list):
        return " ".join(_f(x) if not isinstance(x, list) else "-".join(_f(y) for y in x) for x in v)
    return str(v)


def fmt(rows: list[dict], base: dict | None = None) -> str:
    out = ["| " + " | ".join(COLS) + " |", "|---" * len(COLS) + "|"]
    for r in rows:
        b = (base or {}).get(r["clip"], {})
        out.append("| " + " | ".join(_f(r.get(k)) if k not in b or _f(b[k]) == _f(r.get(k)) else f"{_f(r.get(k))} ({_f(b[k])})" for k in COLS) + " |")
    for k in ("v_fail", "v_err_med", "rot_rms_deg", "turn_err", "vs_full_yaw_corr"):
        x = [r[k] for r in rows if isinstance(r.get(k), float) and np.isfinite(r[k])]
        if x:
            out.append(f"\nmedian {k}: {np.median(x):.3g} over {len(x)} clips")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rsm.bench.clips")
    ap.add_argument("cmd", choices=["cut", "run", "score", "list"])
    ap.add_argument("--only", default=None, help="clip ids or source ids, comma-separated")
    ap.add_argument("--save", default=None)
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--again", action="store_true", help="cut: cut the clips again, replacing the ones that exist")
    a = ap.parse_args(argv)
    log = lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)
    cl = clip_set(a.only.split(",") if a.only else None)
    if a.cmd == "list":
        for c in cl:
            print(c["id"], c["kind"], "cut" if (CLIPS / c["id"] / "clip.json").exists() else "not cut")
        return 0
    if a.cmd == "cut":
        for c in cl:
            cut(c, log, again=a.again)
        return 0
    rows, failed = [], 0
    for c in cl:
        try:
            if a.cmd == "run":
                log(f"clip {c['id']}")
                run_clip(c, log)
            r = score(c)
            r["check"] = "; ".join(check(r, c)) or "ok"
        except Exception as e:                  # one clip must not stop the bench
            log(f"  {c['id']} FAILED: {type(e).__name__}: {e}")
            r = dict(clip=c["id"], kind=c["kind"], check=f"{type(e).__name__}: {e}")
        failed += r["check"] != "ok"
        rows.append(r)
    base = None
    if a.baseline:
        f = RESULTS / "results" / f"{a.baseline}.json"
        base = {r["clip"]: r for r in json.loads(f.read_text())} if f.exists() else None
    txt = fmt(rows, base)
    print(txt)
    (RESULTS / "results").mkdir(parents=True, exist_ok=True)
    for name in ["last", *([a.save] if a.save else [])]:
        (RESULTS / "results" / f"{name}.md").write_text(txt + "\n")
        (RESULTS / "results" / f"{name}.json").write_text(json.dumps(rows, indent=1, default=float))
    print(f"\n{len(rows) - failed} of {len(rows)} clips pass their checks")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
