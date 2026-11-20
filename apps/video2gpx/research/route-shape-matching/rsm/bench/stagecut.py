# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY (not frozen, not in the sidecar): a time window [t0, t1) of a frozen stage as the image side of a short route case
(docs/CONCEPT_test_strategy.md C, step 4), without the video.

`window(stage, t0, t1, out)` writes motion/ and rotation/ under `out` as the route side reads them, with the times shifted so that the window starts
at 0 (the route of a window counts video seconds from t0; the scores of rsm.bench.regress add t0 back):
  motion/motion.csv            the frame pairs inside the window, `time` - t0, `frame` from 1
  motion/motion.json, cuts.json, summary.json   duration, pairs, the cut candidates inside; the summary recomputed from the cut pairs (as the motion step)
  rotation/far_heading.npz, win_video_base.npz  the far-feature windows that lie wholly inside
  rotation/tracks.pkl          every track cut to the window, its distance and heading starting at 0; tracks of fewer than 2 samples dropped
  rotation/cuts.json, standstill.json           the confirmed cuts, rejected candidates, inserted shots and standstills inside the window
  rotation/vehicle.json, summary.json           as in the stage (the vehicle vote and the far-feature calibration of the whole video)
A window is not a run of the pipeline on a video cut to the window: the horizon calibration, the vehicle vote and the traffic picks are those of the
whole video. That is the point (the route side is tested on the image results it gets in the whole run), and the T3 videos test the cut end to end."""
from __future__ import annotations

import csv
import json
import pickle
import shutil
from pathlib import Path

import numpy as np

FILES = dict(motion=["motion.csv", "motion.json", "cuts.json", "summary.json"],
             rotation=["far_heading.npz", "win_video_base.npz", "tracks.pkl", "cuts.json", "standstill.json", "vehicle.json", "summary.json"])


def _in(t, t0, t1) -> bool:
    return t0 <= float(t) < t1


def _motion(src: Path, dst: Path, t0: float, t1: float) -> None:
    with open(src / "motion.csv", newline="") as fh:
        rd = csv.reader(fh)
        head = next(rd)
        it, ifr = head.index("time"), head.index("frame")
        rows = [r for r in rd if _in(r[it], t0, t1)]
    f0 = int(rows[0][ifr]) - 1 if rows else 0
    for r in rows:
        r[it] = f"{float(r[it]) - t0:.4f}"
        r[ifr] = str(int(r[ifr]) - f0)
    with open(dst / "motion.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(head)
        w.writerows(rows)
    mj = json.loads((src / "motion.json").read_text())
    mj.update(start=float(mj.get("start", 0.0)) + t0, duration=t1 - t0, pairs=len(rows), window=[t0, t1])
    (dst / "motion.json").write_text(json.dumps(mj, indent=1, default=float))
    cj = json.loads((src / "cuts.json").read_text())
    cj["candidates"] = [dict(c, t=c["t"] - t0, i=c["i"] - f0) for c in cj["candidates"] if _in(c["t"], t0, t1)]
    (dst / "cuts.json").write_text(json.dumps(cj, indent=1))
    (dst / "summary.json").write_text(json.dumps(_summary(dst / "motion.csv", json.loads((src / "summary.json").read_text()), t1 - t0), indent=1))


def _summary(csv_path: Path, full: dict, dur: float) -> dict:
    """the motion summary of the cut pairs, computed as the motion step does (rsm.pipeline.steps_a.motion)"""
    from scipy.ndimage import median_filter
    from rsm.odometry import gating, heading
    from rsm.odometry.vms_csv import load_pairs
    from rsm.pipeline import config as C
    p = load_pairs(str(csv_path))
    fl = gating.pair_flags(p)
    segs = gating.build_segments(p, fl, gating.GateParams())
    usable = float(sum(s.t1 - s.t0 for s in segs if s.usable))
    L, speeds = 0.0, []
    for s in segs:
        if not s.usable:
            continue
        tr = heading.integrate(p, s, fl, C.F360)
        L += float(tr.s[-1])
        v = np.diff(tr.s) / np.maximum(np.diff(tr.t), 1e-3)
        speeds.append(median_filter(v, size=31, mode="nearest"))
    v = np.concatenate(speeds) if speeds else np.zeros(1)
    return dict(full, duration_s=dur, usable_s=usable, usable_share=usable / dur, n_segments=int(sum(s.usable for s in segs)), nominal_km=L / 1000,
                v_nom_p50=float(np.percentile(v, 50)), v_nom_p90=float(np.percentile(v, 90)))


def _npz(src: Path, dst: Path, t0: float, t1: float) -> None:
    z = np.load(src, allow_pickle=False)
    m = (z["ta"] >= t0) & (z["tb"] <= t1)
    out = {}
    for k in z.files:
        a = z[k]
        if a.ndim >= 1 and len(a) == len(m) and k != "fields":
            a = a[m]
            if k in ("ta", "tb"):
                a = a - t0
            elif k == "idx":
                a = a - (a[0] if len(a) else 0)
        elif k == "meta":
            meta = json.loads(str(a))
            meta.update(n_windows=int(m.sum()), window=[t0, t1])
            a = np.array(json.dumps(meta))
        out[k] = a
    np.savez_compressed(dst, **out)


def _tracks(src: Path, dst: Path, t0: float, t1: float) -> None:
    out = []
    for tr in pickle.load(open(src, "rb")):
        m = (tr["t"] >= t0) & (tr["t"] < t1)
        if m.sum() < 2:
            continue
        nt = {k: (np.asarray(v)[m] if isinstance(v, np.ndarray) and len(v) == len(m) else v) for k, v in tr.items()}
        nt["t"] = nt["t"] - t0
        for k in ("s", "th"):
            if k in nt:
                nt[k] = nt[k] - nt[k][0]
        out.append(nt)
    pickle.dump(out, open(dst, "wb"))


def _rotation_json(src: Path, dst: Path, t0: float, t1: float) -> None:
    cj = json.loads((src / "cuts.json").read_text())
    for k in ("cuts", "rejected", "candidates"):
        cj[k] = [dict(c, **{f: c[f] - t0 for f in ("t", "t_first", "t_last") if f in c}) for c in cj.get(k, []) if _in(c["t"], t0, t1)]
    cj["cut_times"] = [t - t0 for t in cj.get("cut_times", []) if _in(t, t0, t1)]
    cj["n_cuts"] = len(cj["cuts"])
    cj["inserted"] = [dict(x, t0=max(x["t0"], t0) - t0, t1=min(x["t1"], t1) - t0) for x in cj.get("inserted", []) if x["t1"] > t0 and x["t0"] < t1]
    ie = cj.get("intro_end")
    if ie is not None:
        cj["intro_end"] = ie - t0 if ie > t0 else None
        if cj["intro_end"] is None:
            cj["intro_source"] = None
    (dst / "cuts.json").write_text(json.dumps(cj, indent=1))
    sj = json.loads((src / "standstill.json").read_text())
    sj["spans"] = [[max(a, t0) - t0, min(b, t1) - t0] for a, b in sj.get("spans", []) if b > t0 and a < t1]
    sj["windows"] = [dict(w, t=w["t"] - t0) for w in sj.get("windows", []) if _in(w["t"], t0, t1)]
    (dst / "standstill.json").write_text(json.dumps(sj, indent=1))
    for f in ("vehicle.json", "summary.json"):
        shutil.copy2(src / f, dst / f)


def window(stage: Path, t0: float, t1: float, out: Path) -> Path:
    """motion/ and rotation/ of the window [t0, t1) of `stage` under `out` (replaced) -> out"""
    stage, out = Path(stage), Path(out)
    dur = json.loads((stage / "stage.json").read_text())["source"]["duration_s"]
    if not (0 <= t0 < t1 <= dur + 1e-6):
        raise ValueError(f"window [{t0}, {t1}) outside the stage (0 to {dur:.1f} s)")
    for sub in FILES:
        if (out / sub).exists():
            shutil.rmtree(out / sub)
        (out / sub).mkdir(parents=True)
    _motion(stage / "motion", out / "motion", t0, t1)
    for f in ("far_heading.npz", "win_video_base.npz"):
        _npz(stage / "rotation" / f, out / "rotation" / f, t0, t1)
    _tracks(stage / "rotation" / "tracks.pkl", out / "rotation" / "tracks.pkl", t0, t1)
    _rotation_json(stage / "rotation", out / "rotation", t0, t1)
    return out
