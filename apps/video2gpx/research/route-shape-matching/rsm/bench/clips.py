# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY clip bench for the motion and rotation steps (docs/CONCEPT_fast_testing.md, block D).

Short clips (default 75 s) of every source video (clip_sources.json), each run through the real motion and rotation steps (rsm.pipeline _step, through
the step cache of rsm.bench.regress), and scored against a reference. Two classes:
  secured = speed and rotation are known: Van Gestel GPS track aligned to the video (alignment file, or yaw-rate correlation >= 0.7 over the clip);
  open    = the reference is still to be determined (no GPS, or GPS without a secured alignment): the clip is run and described, not scored.

    .venv/bin/python -m rsm.bench.clips select                  # choose the windows -> work/clips/clips.json (deterministic)
    scripts/heavy.sh .venv/bin/python -m rsm.bench.clips make   # cut the clips (640 px wide x 360 rows, grey, x264 crf 8) -> work/clips/<id>/clip.mkv
    scripts/heavy.sh .venv/bin/python -m rsm.bench.clips run [--only id,...] [--class secured|open] [--save NAME] [--baseline NAME]

A clip is cut at the analysis size of the pipeline (both steps read 360 rows, grey, area-scaled), so the steps see nearly the frames of the full video;
`vs_full` compares a clip with the same window of the full run where one exists (speed and yaw correlation, speed ratio).
Windows per source: `turns` (most heading change), `fast` (highest nominal speed), `weak` (lowest usable share of the vms, 10-70 %), `typical`
(closest to the median), from the full run in 15 s steps, at least one clip length apart; without a full run: 25 / 50 / 75 % of the duration.
Plus `manual` windows of the source."""
from __future__ import annotations

import argparse
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
CLIPS = ROOT / "work" / "clips"
DUR = 75.0
SKIP_HEAD, SKIP_TAIL, STEP = 60.0, 30.0, 15.0
CRF = 8
V_MIN = 1.5          # m/s: seconds slower than this (GPS) are not scored for speed
FAIL_LOG = np.log(1.3)
LAG_SPAN, LAG_WIN = 20.0, 300.0   # GPS clock search: +-20 s, over 300 s of the full run around the clip (the clip alone without a full run)


# development data (see docs/README.md): test-data/ of this app (git-ignored), other videos and OSM extracts
for _k, _d in (("V2G_TEST_DATA", str(Path(__file__).resolve().parents[4] / "test-data")), ("RSM_VIDEOS", str(Path(__file__).resolve().parents[4] / "test-data" / "sources")), ("RSM_OSM_DIR", "~/rsm-data/osm")):
    os.environ.setdefault(_k, os.path.expanduser(_d))


def _p(s: str | None) -> Path | None:
    if not s:
        return None
    p = Path(os.path.expanduser(os.path.expandvars(s)))
    return p if p.is_absolute() else ROOT / p


def sources() -> list[dict]:
    return json.loads((HERE / "clip_sources.json").read_text())["sources"]


def _probe(video: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", str(video)],
                         capture_output=True, text=True, check=True)
    j = json.loads(out.stdout)
    st = j["streams"][0]
    a, b = st["r_frame_rate"].split("/")
    return dict(width=int(st["width"]), height=int(st["height"]), fps=float(a) / float(b), duration=float(j["format"]["duration"]))


# ------------------------------------------------------------------ select
def _window_features(full: Path, t_end: float):
    from rsm.odometry import gating
    from rsm.odometry.calib import CAMERA_HEIGHT_M
    from rsm.odometry.vms_csv import load_pairs
    from rsm.pipeline import config as C
    p = load_pairs(str(full / "motion" / "motion.csv"))
    good = gating.pair_flags(p) == 0
    v = C.F360 * CAMERA_HEIGHT_M * np.nan_to_num(p.s) / p.dt
    yaw = np.abs(np.nan_to_num(p.yaw))
    rows = []
    for t0 in np.arange(SKIP_HEAD, t_end - SKIP_TAIL - DUR, STEP):
        m = (p.time >= t0) & (p.time < t0 + DUR)
        if m.sum() < 100:
            continue
        g = good[m]
        rows.append(dict(t0=float(t0), usable=float(g.mean()), speed=float(np.median(v[m][g])) if g.any() else 0.0, turn=float(yaw[m][g].sum() / max(g.sum(), 1))))
    return rows


def _pick(rows: list[dict]) -> list[tuple[str, float]]:
    out = []

    def free(t):
        return all(abs(t - u) >= DUR for _, u in out)

    def take(cat, cand, key, reverse):
        for r in sorted(cand, key=key, reverse=reverse):
            if free(r["t0"]):
                out.append((cat, r["t0"]))
                return

    ok = [r for r in rows if r["usable"] >= 0.8]
    take("turns", ok, lambda r: r["turn"], True)
    take("fast", ok, lambda r: r["speed"], True)
    take("weak", [r for r in rows if 0.1 <= r["usable"] <= 0.7], lambda r: r["usable"], False)
    if ok:
        mt, ms = np.median([r["turn"] for r in ok]), np.median([r["speed"] for r in ok])
        take("typical", ok, lambda r: abs(np.log(max(r["turn"], 1e-9) / max(mt, 1e-9))) + abs(np.log(max(r["speed"], 1e-3) / max(ms, 1e-3))), False)
    return out


def select() -> list[dict]:
    clips = []
    for s in sources():
        video = _p(s["video"])
        if not video.exists():
            print(f"{s['id']}: video missing ({video})", file=sys.stderr)
            continue
        info = _probe(video)
        full = _p(s.get("full"))
        t_end = min(info["duration"], float(s.get("full_until_s") or info["duration"]))
        if full and (full / "motion" / "motion.csv").exists():
            picks = _pick(_window_features(full, t_end))
        else:
            picks = [("uniform", float(round(info["duration"] * q))) for q in (0.25, 0.5, 0.75)]
        man = [(m["cat"], float(m["t0"]), float(m.get("dur", DUR))) for m in s.get("manual", [])]
        picks = [(cat, t0, DUR) for cat, t0 in picks if all(t0 + DUR <= a or t0 >= a + du for _, a, du in man)] + man
        for cat, t0, dur in sorted(picks, key=lambda x: x[1]):
            clips.append(dict(id=f"{s['id']}-{cat}-{int(t0) // 60}m{int(t0) % 60:02d}", source=s["id"], cat=cat, t0=t0, dur=dur, truth=s["truth"], fps=info["fps"]))
    CLIPS.mkdir(parents=True, exist_ok=True)
    (CLIPS / "clips.json").write_text(json.dumps(clips, indent=1))
    return clips


def load_clips(only=None, cls=None) -> list[dict]:
    cl = json.loads((CLIPS / "clips.json").read_text())
    if only:
        cl = [c for c in cl if c["id"] in only or c["source"] in only]
    if cls:
        cl = [c for c in cl if _class_of(c) == cls]
    return cl


# ------------------------------------------------------------------ make
def make(clips: list[dict], log=print) -> None:
    by = {s["id"]: s for s in sources()}
    for c in clips:
        d = CLIPS / c["id"]
        f = d / "clip.mkv"
        if f.exists() and (d / "meta.json").exists():
            continue
        d.mkdir(parents=True, exist_ok=True)
        video = _p(by[c["source"]]["video"])
        info = _probe(video)
        w = round(info["width"] * 360 / info["height"] / 2) * 2
        frame0 = int(round(c["t0"] * info["fps"]))
        t0 = frame0 / info["fps"]
        tmp = d / "clip.tmp.mkv"
        t = time.time()
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t0:.6f}", "-i", str(video), "-t", f"{c['dur']:.3f}", "-an", "-vf", f"scale={w}:360:flags=area,format=gray",
                        "-fps_mode", "passthrough", "-c:v", "libx264", "-crf", str(CRF), "-preset", "veryfast", "-pix_fmt", "gray", str(tmp)], check=True)
        tmp.rename(f)
        (d / "meta.json").write_text(json.dumps(dict(c, source_video=str(video), t0_exact=t0, frame0=frame0, width=w, height=360, crf=CRF, made=time.strftime("%Y-%m-%dT%H:%M:%S")), indent=1))
        log(f"{c['id']}: cut in {time.time() - t:.0f} s, {f.stat().st_size / 1e6:.0f} MB")


# ------------------------------------------------------------------ run
def _class_of(c: dict) -> str:
    rf = CLIPS / c["id"] / "ref.json"
    if rf.exists():
        return json.loads(rf.read_text())["class"]
    return "secured" if c["truth"] == "gps" else "open"


def run_clip(c: dict, log=print) -> Path:
    s = {x["id"]: x for x in sources()}[c["source"]]
    d = CLIPS / c["id"]
    P = dict(video=str(d / "clip.mkv"), bbox=box(s["bbox"]), pbf="", vehicle="auto", offset_m=None, start_time=None, traffic_side="auto", decoys=0,
             start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    return run_case(dict(name=f"clip-{c['id']}"), "clips", ROOT, None, None, log, d=d / "run", P=P, until="rotation")


# ------------------------------------------------------------------ reference
def _utm(lon: float) -> str:
    return f"EPSG:{32600 + int((lon + 180) // 6) + 1}"


def reference(c: dict) -> dict:
    """per second of the clip: GPS speed (m/s) and heading (rad, left +, unwrapped), or class open. Cached in work/clips/<id>/ref.json."""
    d = CLIPS / c["id"]
    rf = d / "ref.json"
    if rf.exists():
        return json.loads(rf.read_text())
    s = {x["id"]: x for x in sources()}[c["source"]]
    meta = json.loads((d / "meta.json").read_text())
    t0 = meta["t0_exact"]
    if s["truth"] != "gps":
        ref = dict(**{"class": "open"}, why=s.get("note", "no reference"), needs=["speed", "rotation"])
    else:
        from rsm.bench import gps_truth as GT
        lat, lon, _ = GT.load_gpx(s["gps"])
        crs = _utm(float(np.median(lon)))
        gb = GT.gps_base(s["gps"], crs)
        full = _p(s.get("full"))
        alf = GT.ALIGN / f"align_{s['gps']}.json"
        if alf.exists():
            u = np.array(json.loads(alf.read_text())["used"])
            lag_src, corr = alf.name, None
        else:
            if full and (full / "motion" / "motion.csv").exists():
                om = GT.vms_rate(full / "motion" / "motion.csv")
                mid = t0 + 0.5 * c["dur"]
                a, b = int(max(0, mid - LAG_WIN / 2)), int(min(len(om) - 1, mid + LAG_WIN / 2, gb["tg"][-1] - LAG_SPAN - 1))
                lag_src = f"yaw-rate correlation, {b - a} s of the full run around the clip"
            else:
                om0 = GT.vms_rate(d / "run" / "motion" / "motion.csv")
                om = np.concatenate([np.full(int(np.floor(t0)), np.nan), om0])
                a, b = int(np.floor(t0)), int(np.floor(t0 + c["dur"]))
                lag_src = "yaw-rate correlation over the clip (clip motion)"
            sh, corr = GT.fine_lag(om, gb, a, b, span=LAG_SPAN)
            if abs(sh) >= LAG_SPAN - 0.5:                    # the peak is at the edge of the search: the lag is not found
                corr = float("nan")
            u = np.array([[0.5 * (a + b), sh]])
        lag = lambda t: np.interp(t, u[:, 0], u[:, 1])
        tv = np.maximum.accumulate(gb["tg"] - lag(gb["tg"]))
        t = np.arange(0.0, c["dur"] + 1e-9, 1.0)
        sg = np.interp(t0 + t, tv, gb["s"])
        from scipy.ndimage import gaussian_filter1d
        v = gaussian_filter1d(np.gradient(sg), 1.5, mode="nearest")
        th = np.interp(t0 + t, tv, gb["theta"])
        inside = (t0 + t >= tv[0]) & (t0 + t <= tv[-1])
        secured = bool(inside.all() and (corr is None or (np.isfinite(corr) and corr >= 0.7)))
        ref = dict(**{"class": "secured" if secured else "open"}, why=("" if secured else f"GPS alignment not secured (corr {corr}, inside {inside.mean():.2f})"),
                   lag_source=lag_src, lag_s=float(lag(t0 + 0.5 * c["dur"])), lag_corr=None if corr is None else float(corr), gps_spacing_m=gb["spacing_m"],
                   t=t.tolist(), speed=v.tolist(), heading=th.tolist())
    rf.write_text(json.dumps(ref))
    return ref


# ------------------------------------------------------------------ score
def _per_second(run: Path, dur: float):
    """nominal speed per second (median of the good pairs, NaN if < half the pairs are good) and the far heading tracks"""
    from rsm.odometry import gating
    from rsm.odometry.calib import CAMERA_HEIGHT_M
    from rsm.odometry.vms_csv import load_pairs
    from rsm.pipeline import config as C
    p = load_pairs(str(run / "motion" / "motion.csv"))
    good = gating.pair_flags(p) == 0
    v = C.F360 * CAMERA_HEIGHT_M * np.nan_to_num(p.s) / p.dt
    n = int(np.ceil(dur))
    vs = np.full(n, np.nan)
    sec = np.floor(p.time).astype(int)
    for i in range(n):
        m = sec == i
        if m.any() and good[m].mean() >= 0.5:
            vs[i] = np.median(v[m & good])
    tracks = pickle.load(open(run / "rotation" / "tracks.pkl", "rb")) if (run / "rotation" / "tracks.pkl").exists() else []
    return vs, tracks, float(good.mean())


def _heading_on(tracks, t: np.ndarray) -> np.ndarray:
    """track heading (reference units) at times t, NaN outside a track; each track starts at 0 (only increments inside a track are meaningful)"""
    out = np.full(len(t), np.nan)
    seg = np.full(len(t), -1)
    for i, tr in enumerate(tracks):
        m = (t >= tr["t"][0]) & (t <= tr["t"][-1])
        out[m] = np.interp(t[m], tr["t"], tr["th"])
        seg[m] = i
    return out, seg


def score(c: dict) -> dict:
    d = CLIPS / c["id"]
    run = d / "run"
    vs, tracks, usable_pairs = _per_second(run, c["dur"])
    t = np.arange(0.0, c["dur"] + 1e-9, 1.0)[:len(vs)]
    hv, seg = _heading_on(tracks, t)
    row = dict(clip=c["id"], cat=c["cat"], usable=float(np.isfinite(vs).mean()), rot_cover=float(np.isfinite(hv).mean()), v_nom_p50=float(np.nanmedian(vs)) if np.isfinite(vs).any() else None)
    med = np.nanmedian(vs) if np.isfinite(vs).any() else np.nan
    low = np.isfinite(vs) & (vs < 0.25 * med)
    run_len, best = 0, 0
    for x in low:
        run_len = run_len + 1 if x else 0
        best = max(best, run_len)
    row["stall_s"] = int(best)                       # longest run of seconds far below the clip's median speed (a vms failure like Gotthard 4:22-5:36)
    ref = reference(c)
    row["class"] = ref["class"]
    if ref.get("why"):
        row["why"] = ref["why"][:80]
    if ref["class"] == "secured":
        vr = np.asarray(ref["speed"])[:len(vs)]
        ok = np.isfinite(vs) & (vr > V_MIN) & (vs > 0)
        sc = float(np.median(vr[ok] / vs[ok])) if ok.sum() >= 5 else np.nan
        e = np.abs(np.log(sc * vs / vr))
        cons = vr > V_MIN
        fail = cons & (~np.isfinite(vs) | ~(e <= FAIL_LOG))
        row.update(v_scale=sc, v_err_med=float(np.nanmedian(e[ok])) if ok.any() else None, v_fail=float(fail.sum() / max(cons.sum(), 1)))
        hr = np.asarray(ref["heading"])[:len(vs)]
        dv, dr = [], []
        for i in range(len(t) - 2):
            if seg[i] >= 0 and seg[i] == seg[i + 2]:
                dv.append(hv[i + 2] - hv[i]); dr.append(hr[i + 2] - hr[i])
        dv, dr = np.array(dv), np.array(dr)
        if len(dv) >= 5 and np.sum(dv * dv) > 0:
            a = float(np.sum(dv * dr) / np.sum(dv * dv))
            res = dr - a * dv
            big = np.abs(dr) > np.radians(5.0)
            row.update(rot_gain=a, f_eff_implied=float(449.0 / a) if a > 0 else None, rot_rms_deg=float(np.degrees(np.sqrt(np.mean(res ** 2)))),
                       turn_err=float(np.median(np.abs(res[big]) / np.abs(dr[big]))) if big.sum() >= 3 else None, ref_turn_deg=float(np.degrees(np.sum(np.abs(dr)) / 2)))
        row["lag_s"] = ref.get("lag_s")
    s = {x["id"]: x for x in sources()}[c["source"]]
    full = _p(s.get("full"))
    if full and (full / "motion" / "motion.csv").exists():
        meta = json.loads((d / "meta.json").read_text())
        vf, trf, _ = _per_second_window(full, meta["t0_exact"], c["dur"])
        ok = np.isfinite(vs) & np.isfinite(vf[:len(vs)])
        if ok.sum() >= 10:
            row["vs_full_v_corr"] = float(np.corrcoef(vs[ok], vf[:len(vs)][ok])[0, 1])
            row["vs_full_v_ratio"] = float(np.median(vs[ok] / np.maximum(vf[:len(vs)][ok], 1e-6)))
        hf, segf = _heading_on(trf, meta["t0_exact"] + t)
        a1, b1 = [], []
        for i in range(len(t) - 2):
            if seg[i] >= 0 and seg[i] == seg[i + 2] and segf[i] >= 0 and segf[i] == segf[i + 2]:
                a1.append(hv[i + 2] - hv[i]); b1.append(hf[i + 2] - hf[i])
        if len(a1) >= 10:
            row["vs_full_yaw_corr"] = float(np.corrcoef(a1, b1)[0, 1])
    return row


def _per_second_window(full: Path, t0: float, dur: float):
    """the full run's nominal speed per second in [t0, t0 + dur) (clip seconds) and its tracks"""
    from rsm.odometry import gating
    from rsm.odometry.calib import CAMERA_HEIGHT_M
    from rsm.odometry.vms_csv import load_pairs
    from rsm.pipeline import config as C
    p = load_pairs(str(full / "motion" / "motion.csv"))
    good = gating.pair_flags(p) == 0
    v = C.F360 * CAMERA_HEIGHT_M * np.nan_to_num(p.s) / p.dt
    n = int(np.ceil(dur))
    vs = np.full(n, np.nan)
    m0 = (p.time >= t0) & (p.time < t0 + n)
    sec = np.floor(p.time[m0] - t0).astype(int)
    vv, gg = v[m0], good[m0]
    for i in range(n):
        m = sec == i
        if m.any() and gg[m].mean() >= 0.5:
            vs[i] = np.median(vv[m & gg])
    tracks = pickle.load(open(full / "rotation" / "tracks.pkl", "rb")) if (full / "rotation" / "tracks.pkl").exists() else []
    return vs, tracks, None


# ------------------------------------------------------------------ table
SEC_COLS = ["clip", "cat", "usable", "v_fail", "v_err_med", "v_scale", "stall_s", "rot_cover", "rot_rms_deg", "turn_err", "f_eff_implied", "ref_turn_deg", "vs_full_v_corr", "vs_full_yaw_corr", "lag_s"]
OPEN_COLS = ["clip", "cat", "usable", "v_nom_p50", "stall_s", "rot_cover", "vs_full_v_corr", "vs_full_v_ratio", "vs_full_yaw_corr", "why"]


def _f(v):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return ""
    if isinstance(v, float):
        return f"{v:.3g}"
    return str(v)


def fmt(rows: list[dict], base: dict | None = None) -> str:
    out = []
    for cls, cols, title in (("secured", SEC_COLS, "Secured speed and rotation (GPS)"), ("open", OPEN_COLS, "Open: reference still to be determined")):
        rs = [r for r in rows if r.get("class") == cls]
        if not rs:
            continue
        out += [f"## {title} ({len(rs)} clips)", "", "| " + " | ".join(cols) + " |", "|---" * len(cols) + "|"]
        for r in rs:
            b = (base or {}).get(r["clip"], {})
            out.append("| " + " | ".join(_f(r.get(k)) if k not in b or _f(b[k]) == _f(r.get(k)) else f"{_f(r.get(k))} ({_f(b[k])})" for k in cols) + " |")
        if cls == "secured":
            for k in ("v_fail", "v_err_med", "rot_rms_deg", "turn_err"):
                x = [r[k] for r in rs if isinstance(r.get(k), float) and np.isfinite(r[k])]
                if x:
                    out.append(f"\nmedian {k}: {np.median(x):.3g} over {len(x)} clips" + (f" (baseline {np.median([b[k] for b in base.values() if isinstance(b.get(k), float)]):.3g})" if base else ""))
        out.append("")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rsm.bench.clips")
    ap.add_argument("cmd", choices=["select", "make", "run", "score", "list"])
    ap.add_argument("--only", default=None, help="clip ids or source ids, comma-separated")
    ap.add_argument("--class", dest="cls", default=None, choices=["secured", "open"])
    ap.add_argument("--save", default=None)
    ap.add_argument("--baseline", default=None)
    a = ap.parse_args(argv)
    log = lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)
    if a.cmd == "select":
        cl = select()
        for c in cl:
            print(c["id"], c["truth"], c["t0"], c["dur"])
        print(len(cl), "clips")
        return 0
    only = a.only.split(",") if a.only else None
    cl = load_clips(only, a.cls)
    if a.cmd == "list":
        for c in cl:
            print(c["id"], _class_of(c))
        return 0
    if a.cmd == "make":
        make(cl, log)
        return 0
    rows = []
    for c in cl:
        if not (CLIPS / c["id"] / "clip.mkv").exists():
            log(f"{c['id']}: no clip (run make)")
            continue
        try:
            if a.cmd == "run":
                log(f"clip {c['id']}")
                run_clip(c, log)
            rows.append(score(c))
        except Exception as e:                  # one clip must not stop the bench
            log(f"  {c['id']} FAILED: {type(e).__name__}: {e}")
            rows.append(dict(clip=c["id"], cat=c["cat"], **{"class": _class_of(c)}, why=f"{type(e).__name__}: {e}"))
    base = None
    if a.baseline:
        f = CLIPS / "results" / f"{a.baseline}.json"
        base = {r["clip"]: r for r in json.loads(f.read_text())} if f.exists() else None
    txt = fmt(rows, base)
    print(txt)
    (CLIPS / "results").mkdir(parents=True, exist_ok=True)
    (CLIPS / "results" / "last.md").write_text(txt)
    (CLIPS / "results" / "last.json").write_text(json.dumps(rows, indent=1, default=float))
    if a.save:
        (CLIPS / "results" / f"{a.save}.json").write_text(json.dumps(rows, indent=1, default=float))
        (CLIPS / "results" / f"{a.save}.md").write_text(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
