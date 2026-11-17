# SPDX-License-Identifier: AGPL-3.0-or-later
"""vms motion CSV -> gated segments -> heading over distance -> turns -> trajectory.json per usable segment."""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

from ..core.trajectory import RelativeTrajectory, ScalePrior
from ..io import trajectory_json
from .calib import CAMERA_HEIGHT_M, NOMINAL, YAW_SIGN, Calibration
from .gating import REASONS, GateParams, Segment, build_segments, pair_flags
from .heading import SegmentTrack, dead_reckon, integrate
from .turns import TurnParams, detect_turns
from .vms_csv import Pairs, load_pairs

SOURCE = "vms-odometry"
MAX_POINTS = 3000
MIN_STEP_M, MAX_STEP_M, TARGET_POINTS = 1.0, 5.0, 500  # spacing = length / 500, clipped to 1..5 m (and at most MAX_POINTS points)


def segment_track(p: Pairs, seg: Segment, flags: np.ndarray, f360: float, height_m: float = CAMERA_HEIGHT_M,
                  dist_scale: float = 1.0, c_delta_px: float = 0.0) -> SegmentTrack:
    return integrate(p, seg, flags, f360, height_m, dist_scale=dist_scale, c_delta_px=c_delta_px)


def to_trajectory(tr: SegmentTrack, meta: dict, max_points: int = MAX_POINTS) -> RelativeTrajectory:
    """Dead-reckoned path resampled by distance: spacing length / 500 clipped to 1..5 m, so 190 m -> 190 points, 1.4 km -> 560, 10 km -> 2000."""
    x, y = dead_reckon(tr.theta, tr.s)
    length = float(tr.s[-1])
    step = max(min(max(MIN_STEP_M, length / TARGET_POINTS), MAX_STEP_M), length / max_points)
    su, iu = np.unique(tr.s, return_index=True)
    sg = np.append(np.arange(0.0, su[-1], step), su[-1])
    if sg[-1] - sg[-2] < step / 4 and len(sg) > 2:
        sg = np.delete(sg, -2)
    pts = np.column_stack([np.interp(sg, su, x[iu]), np.interp(sg, su, y[iu])])
    t = np.maximum.accumulate(np.interp(sg, su, tr.t[iu]))
    return RelativeTrajectory(pts, t=t, scale=ScalePrior(known=False, min=0.7, max=1.4), direction_known=True, metadata=meta)


def coverage(p: Pairs, flags: np.ndarray, segs: list[Segment]) -> dict:
    """Seconds of the analysed stream by outcome; every pair is counted once."""
    n, dt = len(p), p.dt
    lab = np.full(n, "gap", dtype=object)
    for sg in segs:
        sl = slice(sg.i0, sg.i1)
        ok = flags[sl] == 0
        lab[sl] = np.where(ok, "ok_in_segment" if sg.usable else "ok_in_too_short_section",
                           "bridged_in_segment" if sg.usable else "bridged_in_too_short_section")
    out = {"analysed_s": round(n * dt, 3), "pair_dt_s": dt}
    for name in ("ok_in_segment", "bridged_in_segment", "ok_in_too_short_section", "bridged_in_too_short_section"):
        out[name + "_s"] = round(float((lab == name).sum() * dt), 3)
    gap = lab == "gap"
    out["unusable_outside_segments_s"] = round(float(gap.sum() * dt), 3)
    taken = np.zeros(n, bool)
    by = {}
    for name, bit in REASONS.items():  # priority order of REASONS
        sel = gap & (flags & bit != 0)
        by[name] = round(float((sel & ~taken).sum() * dt), 3)
        taken |= sel
    by["other_(time jump or trimmed edge)"] = round(float((gap & ~taken).sum() * dt), 3)
    out["unusable_outside_segments_by_primary_reason_s"] = by
    flag_any = {name: round(float(((flags & bit) != 0).sum() * dt), 3) for name, bit in REASONS.items()}
    out["pairs_flagged_any_reason_s"] = flag_any
    usable = out["ok_in_segment_s"] + out["bridged_in_segment_s"]
    out["usable_s"] = round(usable, 3)
    excluded = float(((flags & REASONS["excluded"]) != 0).sum() * dt)
    out["excluded_s"] = round(excluded, 3)
    out["coverage"] = round(usable / (n * dt - excluded), 4)  # usable / (analysed - excluded)
    out["coverage_of_analysed"] = round(usable / (n * dt), 4)
    return out


def coverage_vs_gap(p: Pairs, flags: np.ndarray, gp: GateParams, gaps=(0.0, 0.25, 0.5, 1.0, 2.0)) -> list[dict]:
    rows = []
    for g in gaps:
        gq = GateParams(**{**asdict(gp), "max_gap_s": g})
        segs = build_segments(p, flags, gq)
        use = [s for s in segs if s.usable]
        d = np.array([s.duration for s in use]) if use else np.zeros(0)
        exc = float(((flags & REASONS["excluded"]) != 0).sum() * p.dt)
        rows.append({"max_gap_s": g, "segments": len(use), "usable_s": round(float(d.sum()), 2), "coverage": round(float(d.sum() / (len(p) * p.dt - exc)), 4),
                     "median_len_s": round(float(np.median(d)), 1) if len(d) else None, "max_len_s": round(float(d.max()), 1) if len(d) else None})
    return rows


def run(csv_path: str | Path, video_id: str, out_dir: str | Path, f360: float | None = None, gate: GateParams = GateParams(),
        turn: TurnParams = TurnParams(), height_m: float = CAMERA_HEIGHT_M, video_name: str | None = None,
        calibration: Calibration | None = None) -> dict:
    """`calibration` (optional, default None = the original behaviour): f360, distance factor, post-hoc horizon correction and detector
    parameters from a Calibration; explicit f360 / gate / turn arguments are overridden by the calibration's values where it sets them."""
    p = load_pairs(csv_path)
    dist_scale, c_delta = 1.0, 0.0
    if calibration is not None:
        f360 = calibration.f360
        dist_scale, c_delta = calibration.dist_scale, calibration.c_delta_px
        turn = TurnParams(**{**turn.to_dict(), **calibration.turn})
        gate = GateParams(**{**gate.to_dict(), **calibration.gate})
    if f360 is None:
        if video_id not in NOMINAL:
            raise ValueError(f"no nominal focal length for video id {video_id!r}; pass f360 (known: {sorted(NOMINAL)})")
        f360 = NOMINAL[video_id].f360
    flags = pair_flags(p, gate)
    segs = build_segments(p, flags, gate)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    k = f360 * height_m * dist_scale
    rows, n_usable = [], 0
    for i, sg in enumerate(segs):
        row = {"id": i, "t0": round(sg.t0, 3), "t1": round(sg.t1, 3), "duration_s": round(sg.duration, 3), "n_bridged_pairs": sg.n_bridged,
               "usable": sg.usable, "reason": sg.reason}
        if sg.usable:
            tr = segment_track(p, sg, flags, f360, height_m, dist_scale, c_delta)
            turns = detect_turns(tr.s, tr.theta, tr.t, turn)
            meta = {"source": SOURCE, "video": video_name or video_id, "video_id": video_id, "segment": i, "t0": sg.t0, "t1": sg.t1,
                    "f360_px": f360, "camera_height_m": height_m, "dist_scale": dist_scale, "c_delta_px": c_delta, "k_nominal_m_per_s_unit": k, "yaw_sign": YAW_SIGN,
                    "distance": "nominal metres: k * s with k = f360 * h (h assumed); true metres = nominal * scale, scale in [0.7, 1.4] unknown",
                    "gate": gate.to_dict(), "turn_params": turn.to_dict(), "gpx_free": True,
                    "warnings": ["distances are nominal (assumed camera height 1.1 m and the nominal focal length)"]
                    + ([f"{sg.n_bridged} unusable pairs inside the segment were bridged by interpolation"] if sg.n_bridged else [])}
            traj = to_trajectory(tr, meta)
            name = f"seg_{i:03d}.trajectory.json"
            trajectory_json.write(traj, out / name)
            assert trajectory_json.read(out / name).equals(traj)
            n_usable += 1
            row.update({"file": name, "length_nominal_m": round(float(tr.s[-1]), 2), "net_turn_deg": round(float(np.degrees(tr.theta[-1])), 2),
                        "abs_turn_deg": round(float(np.degrees(np.abs(np.diff(tr.theta)).sum())), 1), "points": len(traj),
                        "turns": [t.to_dict() for t in turns]})
        rows.append(row)
    usable = [r for r in rows if r["usable"]]
    d = np.array([r["duration_s"] for r in usable]) if usable else np.zeros(0)
    res = {"csv": str(csv_path), "video_id": video_id, "f360_px": f360, "camera_height_m": height_m, "k": k, "yaw_sign": YAW_SIGN,
           "gate": gate.to_dict(), "turn_params": turn.to_dict(), "coverage": coverage(p, flags, segs),
           "coverage_vs_max_gap": coverage_vs_gap(p, flags, gate),
           "segments_usable": len(usable), "segments_too_short": sum(1 for r in rows if not r["usable"]),
           "length_s": {q: round(float(np.percentile(d, q)), 1) for q in (0, 25, 50, 75, 100)} if len(d) else {},
           "total_length_nominal_m": round(sum(r["length_nominal_m"] for r in usable), 1), "segments": rows}
    (out / "segments.json").write_text(json.dumps(res, indent=1) + "\n")
    return res
