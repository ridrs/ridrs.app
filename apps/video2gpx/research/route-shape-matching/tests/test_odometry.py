# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.odometry on synthetic vms CSVs: yaw integration and sign, gating, segments (no bridging across cuts), turns, json round trip."""
from __future__ import annotations

import ast
import csv
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from rsm.io import trajectory_json
from rsm.odometry import GateParams, TurnParams, build_segments, dead_reckon, detect_turns, integrate, load_pairs, pair_flags
from rsm.odometry import pipeline

F = 400.0  # px at 360 rows
FPS = 25.0
DT = 1 / FPS
COLS = ["frame", "time", "corners", "tracked", "inliers", "rms_px", "s", "c", "yaw", "pitch", "roll", "diff", "rel_speed"]


def write_csv(path, n, yaw=None, s=3e-4, mutate=None, diff=2.0, seed=0):
    """A synthetic vms CSV: n pairs, yaw (px per pair, array or scalar), constant s, small noise-free fit quality."""
    yaw = np.broadcast_to(np.asarray(0.0 if yaw is None else yaw, float), (n,))
    rows = []
    for i in range(n):
        rows.append({"frame": i + 1, "time": (i + 0.5) * DT, "corners": 300, "tracked": 250, "inliers": 150, "rms_px": 0.2, "s": s, "c": 0.0,
                     "yaw": yaw[i], "pitch": 0.0, "roll": 0.0, "diff": diff, "rel_speed": s / DT})
    if mutate:
        mutate(rows)
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, COLS)
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if v is None else v) for k, v in r.items()})
    return path


def blank(row):  # a pair without a fit
    row.update({"inliers": 0, "rms_px": None, "s": None, "c": None, "yaw": None, "pitch": None, "roll": None, "rel_speed": None})


def test_yaw_integration_heading_distance_and_left_positive_path(tmp_path):
    n = 500
    # a constant yaw flow of +2 px per pair at f = 400 px: omega = 0.005 rad/pair; 500 pairs = 2.5 rad
    p = load_pairs(write_csv(tmp_path / "a.csv", n, yaw=2.0))
    fl = pair_flags(p, GateParams())
    assert not fl.any()
    segs = build_segments(p, fl)
    assert len(segs) == 1 and segs[0].usable and segs[0].i0 == 0 and segs[0].i1 == n
    tr = integrate(p, segs[0], fl, F, height_m=1.1)
    assert tr.theta[-1] == pytest.approx(2.0 * n / F)
    assert tr.s[-1] == pytest.approx(F * 1.1 * 3e-4 * n)  # k * s per pair
    assert tr.t[0] == pytest.approx(0.0) and tr.t[-1] == pytest.approx(n * DT)
    x, y = dead_reckon(tr.theta[:100], tr.s[:100])
    assert x[-1] < 0 and y[-1] > 0  # positive yaw = left turn: the path bends to -x
    # the radius of the dead-reckoned circle: ds / dtheta = k s / (yaw / f)
    r = (F * 1.1 * 3e-4) / (2.0 / F)
    xs, ys = dead_reckon(tr.theta, tr.s)
    assert np.hypot(xs[-1] - (-r), ys[-1]) == pytest.approx(r, rel=0.02)  # still on the circle of radius r around (-r, 0)


def test_negative_yaw_is_a_right_turn(tmp_path):
    p = load_pairs(write_csv(tmp_path / "a.csv", 200, yaw=-1.0))
    fl = pair_flags(p)
    tr = integrate(p, build_segments(p, fl)[0], fl, F)
    x, _ = dead_reckon(tr.theta, tr.s)
    assert tr.theta[-1] < 0 and x[-1] > 0


def test_gating_reasons(tmp_path):
    def mut(rows):
        blank(rows[10])
        rows[20]["inliers"] = 5
        rows[30]["rms_px"] = 3.5
        rows[40]["rel_speed"] = rows[40]["s"] * 3 / DT  # spike
        rows[50]["rel_speed"] = -1e-3
    p = load_pairs(write_csv(tmp_path / "a.csv", 100, mutate=mut))
    fl = pair_flags(p)
    from rsm.odometry.gating import HIGH_RMS, NEG_SPEED, NO_FIT, SPIKE
    assert fl[10] == NO_FIT and fl[20] == NO_FIT and fl[30] == HIGH_RMS and fl[40] == SPIKE and fl[50] & NEG_SPEED
    assert (fl != 0).sum() == 5


def test_cut_is_flagged_with_halfwidth_and_never_bridged(tmp_path):
    def mut(rows):
        rows[300]["diff"] = 60.0  # a scene cut

    p = load_pairs(write_csv(tmp_path / "a.csv", 600, mutate=mut, yaw=1.0))
    gp = GateParams(max_gap_s=100.0)  # even a gap limit of 100 s must not bridge a cut
    fl = pair_flags(p, gp)
    assert (fl != 0).sum() == 15  # +-7 pairs around the cut
    segs = build_segments(p, fl, gp)
    assert len(segs) == 2 and segs[0].i1 == 293 and segs[1].i0 == 308 and all(s.n_bridged == 0 for s in segs)
    assert segs[0].t1 < segs[1].t0


def test_gap_threshold_splits_or_bridges_and_strict_mode(tmp_path):
    def mut(rows):
        for i in range(100, 110):  # 10 pairs = 0.4 s unusable
            blank(rows[i])
        for i in range(200, 220):  # 20 pairs = 0.8 s
            blank(rows[i])
        blank(rows[300])  # one pair

    p = load_pairs(write_csv(tmp_path / "a.csv", 500, mutate=mut, yaw=1.0))
    fl = pair_flags(p)
    segs = build_segments(p, fl, GateParams(max_gap_s=0.5, min_segment_s=2.0))
    assert [(s.i0, s.i1) for s in segs] == [(0, 200), (220, 500)]  # 0.8 s run splits; 0.4 s and 1-pair runs are bridged
    assert segs[0].n_bridged == 10 and segs[1].n_bridged == 1
    strict = build_segments(p, fl, GateParams(max_gap_s=0.0, min_segment_s=0.0))
    assert [(s.i0, s.i1) for s in strict] == [(0, 100), (110, 200), (220, 300), (301, 500)]
    loose = build_segments(p, fl, GateParams(max_gap_s=1.0, min_segment_s=2.0))
    assert [(s.i0, s.i1) for s in loose] == [(0, 500)]
    # bridged pairs are interpolated: heading integrates the interpolated yaw, not zeros
    tr = integrate(p, loose[0], fl, F)
    assert tr.theta[-1] == pytest.approx(500 * 1.0 / F) and tr.bridged.sum() == 31


def test_short_segments_are_not_usable_and_exclusion(tmp_path):
    def mut(rows):
        for i in range(100, 130):
            blank(rows[i])  # 1.2 s: splits
    p = load_pairs(write_csv(tmp_path / "a.csv", 400, mutate=mut))
    fl = pair_flags(p, GateParams(exclude_before_s=1.0))
    segs = build_segments(p, fl, GateParams(min_segment_s=5.0))
    assert [(s.usable, s.reason) for s in segs] == [(False, "too_short"), (True, "")]  # 0.. 100 pairs = 4 s, but starts after the exclusion
    assert segs[0].i0 >= 25 - 1


def test_time_jump_in_the_csv_splits(tmp_path):
    def mut(rows):
        for r in rows[200:]:
            r["time"] += 5.0
    p = load_pairs(write_csv(tmp_path / "a.csv", 400, mutate=mut))
    segs = build_segments(p, pair_flags(p), GateParams(max_gap_s=100.0))
    assert [(s.i0, s.i1) for s in segs] == [(0, 200), (200, 400)]


def heading_curve(spec, ds=0.5):
    """theta(s) from (length, total angle in deg) pieces, left positive."""
    s, th, s0, t0 = [0.0], [0.0], 0.0, 0.0
    for length, ang in spec:
        n = int(round(length / ds))
        for i in range(1, n + 1):
            s.append(s0 + length * i / n)
            th.append(t0 + np.radians(ang) * i / n)
        s0 += length
        t0 += np.radians(ang)
    return np.array(s), np.array(th)


def test_turn_detector_known_turns():
    s, th = heading_curve([(100, 0), (40, 90), (80, 0), (30, -150), (100, 0), (60, 45), (10, 0), (60, 45), (100, 0), (20, 10), (100, 0)])
    turns = detect_turns(s, th, t=s / 5.0)
    assert [t.sign for t in turns] == [1, -1, 1]  # the two 45-degree pieces 10 m apart merge into one 90-degree left turn; 10 degrees is ignored
    assert [t.angle_deg for t in turns] == pytest.approx([90, -150, 90], abs=6)
    assert turns[0].s_start == pytest.approx(100 - 3, abs=12) and turns[0].length_m == pytest.approx(40 + 12, abs=15)
    assert turns[0].t_start == pytest.approx(turns[0].s_start / 5.0)
    assert not any(t.clipped for t in turns)


def test_turn_detector_mirror_noise_and_gap():
    s, th = heading_curve([(100, 0), (50, 60), (100, 0), (50, -60), (100, 0)])
    a = detect_turns(s, th)
    b = detect_turns(s, -th)
    assert [t.angle_deg for t in a] == pytest.approx([-t.angle_deg for t in b])
    rng = np.random.default_rng(1)
    noisy = th + np.cumsum(rng.normal(0, np.radians(0.04), len(th)))  # random walk, 0.04 deg per 0.5 m step
    c = detect_turns(s, noisy)
    assert [t.sign for t in c] == [1, -1] and [t.angle_deg for t in c] == pytest.approx([60, -60], abs=8)
    # same-sign turns separated by more than the merge gap stay two turns
    s2, th2 = heading_curve([(50, 0), (40, 60), (60, 0), (40, 60), (50, 0)])
    assert len(detect_turns(s2, th2)) == 2
    assert len(detect_turns(s2, th2, params=TurnParams(merge_gap_m=70.0))) == 1
    # the angle does not depend on the distance scale, the length does
    d = detect_turns(s2 * 1.4, th2)
    assert [t.angle_deg for t in d] == pytest.approx([t.angle_deg for t in detect_turns(s2, th2)], abs=3)


def test_pipeline_writes_roundtrippable_trajectories(tmp_path):
    n = 1500
    # 30 s straight, 90 degrees left over 150 pairs, straight again; yaw in px per pair
    yaw = np.zeros(n)
    yaw[500:650] = np.radians(90) / 150 * 370.513  # the nominal Cayolle focal length
    csvp = write_csv(tmp_path / "v.csv", n, yaw=yaw)
    res = pipeline.run(csvp, "cayolle", tmp_path / "out", video_name="synthetic.mp4")
    assert res["segments_usable"] == 1 and res["coverage"]["coverage"] == pytest.approx(1.0)
    seg = res["segments"][0]
    assert len(seg["turns"]) == 1 and seg["turns"][0]["angle_deg"] == pytest.approx(90, abs=5)
    traj = trajectory_json.read(tmp_path / "out" / seg["file"])  # strict reader
    assert traj.metadata["source"] == "vms-odometry" and traj.metadata["video"] == "synthetic.mp4" and traj.metadata["gpx_free"] is True
    assert traj.metadata["f360_px"] == pytest.approx(370.513) and traj.metadata["camera_height_m"] == 1.1 and traj.metadata["segment"] == 0
    assert traj.t is not None and traj.t[0] == pytest.approx(0.0, abs=1e-6) and traj.t[-1] == pytest.approx(n * DT)
    assert not traj.scale.known and (traj.scale.min, traj.scale.max) == (0.7, 1.4)
    assert 100 <= len(traj) <= 3000
    assert traj.length == pytest.approx(res["segments"][0]["length_nominal_m"], rel=0.01)
    # left turn positive: the path ends heading roughly -x, i.e. the total turn is +90 degrees
    assert np.degrees(traj.total_turn(step=1.0)) == pytest.approx(90, abs=6)
    assert traj.points[-1, 0] < 0
    with pytest.raises(ValueError):
        pipeline.run(csvp, "unknown-video", tmp_path / "out2")


def test_odometry_imports_only_numpy_scipy_and_stdlib():
    pkg = Path(__file__).resolve().parents[1] / "rsm" / "odometry"
    allowed = {"numpy", "scipy"}
    stdlib = set(sys.stdlib_module_names) | {"rsm"}
    seen = set()
    for f in pkg.glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module else []
            seen |= {m.split(".")[0] for m in mods}
    assert seen - stdlib <= allowed, seen - stdlib - allowed
    assert "vms" not in seen and "cv2" not in seen and "matplotlib" not in seen
    code = ("import sys, rsm.odometry, rsm.odometry.pipeline; "
            "bad = [m for m in ('cv2', 'matplotlib', 'vms', 'shapely', 'pandas', 'gpxpy', 'pycolmap') if m in sys.modules]; assert not bad, bad")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=pkg.parents[1])
    assert r.returncode == 0, r.stderr


def test_calibration_scales_distance_and_horizon_correction_and_default_unchanged(tmp_path):
    from rsm.odometry import Calibration, load_calibration
    n = 400
    path = write_csv(tmp_path / "cal.csv", n, yaw=1.0, s=3e-4)
    p = load_pairs(path)
    # c column: constant 0.01 per pair
    import dataclasses
    p = dataclasses.replace(p, c=np.full(n, 0.01))
    fl = pair_flags(p, GateParams())
    seg = build_segments(p, fl)[0]
    base = integrate(p, seg, fl, F)
    same = integrate(p, seg, fl, F, dist_scale=1.0, c_delta_px=0.0)
    assert np.array_equal(base.theta, same.theta) and np.array_equal(base.s, same.s)  # defaults reproduce the original
    cal = integrate(p, seg, fl, F, dist_scale=1.25, c_delta_px=16.0)
    assert cal.s[-1] == pytest.approx(1.25 * base.s[-1])
    assert cal.theta[-1] == pytest.approx(n * (1.0 + 16.0 * 0.01) / F)  # yaw + c * delta
    with pytest.raises(ValueError):
        integrate(dataclasses.replace(p, c=None), seg, fl, F, c_delta_px=1.0)
    # JSON round trip of the calibration and the pipeline using it
    import json
    cj = tmp_path / "calibration.json"
    cj.write_text(json.dumps({"constants": {"f360": {"value": 450.0}, "dist_scale": {"value": 1.2}, "turn": {"sigma_m": {"value": 8.0}}}}))
    c = load_calibration(cj)
    assert c == Calibration(f360=450.0, dist_scale=1.2, turn={"sigma_m": 8.0}, meta={})
    res = pipeline.run(path, "x", tmp_path / "out", calibration=c)
    assert res["f360_px"] == 450.0 and res["turn_params"]["sigma_m"] == 8.0
    assert res["k"] == pytest.approx(450.0 * 1.1 * 1.2)


def _traffic(rows, a, b, rms=1.8, factor=0.4):
    """pairs a..b: a passing vehicle blended into the fit (high rms, wrong speed)"""
    for i in range(a, b):
        rows[i]["rms_px"] = rms
        rows[i]["rel_speed"] = rows[i]["s"] * factor / DT


def test_passing_traffic_is_rejected_and_bridged_while_moving(tmp_path):
    """a 2 s overtake (rms 1.8 px, speed read 40 %) while moving: rejected (high_rms, also below the old 2.0 px gate) and bridged, not split"""
    from rsm.odometry.gating import HIGH_RMS
    p = load_pairs(write_csv(tmp_path / "a.csv", 1000, mutate=lambda r: _traffic(r, 400, 450), yaw=0.5))
    fl = pair_flags(p)
    assert np.all(fl[400:450] & HIGH_RMS)
    segs = build_segments(p, fl, GateParams(min_segment_s=2.0))
    assert [(s.i0, s.i1) for s in segs] == [(0, 1000)] and segs[0].n_bridged == 50
    old = GateParams(max_rms_px=2.0, traffic_bridge_s=0.0, min_segment_s=2.0)
    assert not (pair_flags(p, old)[400:450] & HIGH_RMS).any()     # the old gate let the blended speed through


def test_traffic_bridge_limits(tmp_path):
    """no bridge when the run is too long, when it is not mostly high rms, or when the camera is (nearly) standing on one side"""
    gp = GateParams(min_segment_s=2.0)

    def segs(mut):
        p = load_pairs(write_csv(tmp_path / "a.csv", 1000, mutate=mut))
        return [(s.i0, s.i1) for s in build_segments(p, pair_flags(p, gp), gp)]
    assert segs(lambda r: _traffic(r, 300, 420)) == [(0, 300), (420, 1000)]          # 4.8 s: longer than traffic_bridge_s

    def dark(rows):
        for i in range(300, 340):
            blank(rows[i])
        _traffic(rows, 340, 345)
    assert segs(dark) == [(0, 300), (345, 1000)]                                    # mostly no fit (darkness), not traffic

    def stop(rows):
        for i in range(250, 300):
            rows[i]["s"] = 1e-6
            rows[i]["rel_speed"] = 1e-6 / DT
        _traffic(rows, 300, 350)
    assert (300, 350) not in [(a, b) for a, b in segs(stop)] and segs(stop)[0][1] <= 300   # standing before it: left to the standstill test


def test_rms_gate_follows_the_videos_own_fit_quality(tmp_path):
    """a soft / low-resolution video fits plain road at ~0.9 px (PCI25WijGrE 480p: median 0.80 px, half of all pairs above 0.8 px, tracks split for 104 s):
    the rms limit is max(max_rms_px, max_rms_rel x the video's median rms), so plain road stays usable and passing traffic (well above the level) is still rejected"""
    from rsm.odometry.gating import HIGH_RMS, rms_limit
    rng = np.random.default_rng(1)
    noisy = 0.9 + 0.1 * rng.standard_normal(1000)

    def mut(rows):
        for i, r in enumerate(rows):
            r["rms_px"] = round(float(max(noisy[i], 0.3)), 4)
        _traffic(rows, 400, 450, rms=3.5)
    p = load_pairs(write_csv(tmp_path / "a.csv", 1000, mutate=mut, yaw=0.5))
    gp = GateParams(min_segment_s=2.0)
    assert rms_limit(p.rms_px, p.inliers, gp) == pytest.approx(1.5 * np.median(p.rms_px), rel=0.02)
    fl = pair_flags(p, gp)
    assert not (np.delete(fl, np.s_[400:450]) & HIGH_RMS).any()
    assert np.all(fl[400:450] & HIGH_RMS)
    segs = build_segments(p, fl, gp)
    assert [(s.i0, s.i1) for s in segs] == [(0, 1000)] and segs[0].n_bridged == 50
    clean = load_pairs(write_csv(tmp_path / "b.csv", 1000))
    assert rms_limit(clean.rms_px, clean.inliers, gp) == gp.max_rms_px            # a clean video (0.2 px) keeps the absolute 0.8 px gate (A17)


def test_false_stop_while_the_picture_moves(tmp_path):
    """a speed collapse to 4 % for 3 s at cruising speed while the frame difference stays normal is a false stop (far valley side below the
    horizon in a curve, Furka 0eEylPLoqMA 25:48); the same collapse with a still picture is a real stop and stays usable"""
    from rsm.odometry.gating import FALSE_STOP
    n = int(60 / DT)
    a, b = int(30 / DT), int(33 / DT)

    def moving(rows):
        for r in rows[a:b]:
            r["rel_speed"] *= 0.04
            r["rms_px"] = 0.1
    p = load_pairs(write_csv(tmp_path / "a.csv", n, mutate=moving))
    fl = pair_flags(p, GateParams())
    hit = (fl & FALSE_STOP) != 0
    assert hit[a - 10:b + 10].all() and not hit[:a - 110].any() and not hit[b + 110:].any()  # widened by 2 s
    segs = build_segments(p, fl)
    assert len(segs) == 1 and segs[0].usable  # bridged, not split: the yaw of the collapse is kept, only its distance is filled
    from rsm.odometry import integrate
    tr = integrate(p, segs[0], fl, F)
    v = np.diff(tr.s) / DT
    assert v[a:b].min() > 0.9 * v[:a - 60].mean()  # the distance through the collapse is the neighbours' speed, not 4 %

    def still(rows):
        moving(rows)
        for r in rows[a - 25:b + 25]:
            r["diff"] = 0.1
    p = load_pairs(write_csv(tmp_path / "b.csv", n, mutate=still))
    assert not (pair_flags(p, GateParams()) & FALSE_STOP).any()


def test_false_stop_needs_cruising_speed(tmp_path):
    """at walking pace (here a fifth of the video median for 20 s) a stop within a second is possible: not flagged"""
    from rsm.odometry.gating import FALSE_STOP
    n = int(120 / DT)
    a, b = int(60 / DT), int(63 / DT)

    def crawl(rows):
        for r in rows[int(45 / DT):int(80 / DT)]:
            r["rel_speed"] *= 0.2
        for r in rows[a:b]:
            r["rel_speed"] *= 0.04
    p = load_pairs(write_csv(tmp_path / "a.csv", n, mutate=crawl))
    assert not (pair_flags(p, GateParams()) & FALSE_STOP).any()


def test_rms_limit_rises_in_curves_on_a_noisy_video(tmp_path):
    """a video whose plain level makes the limit relative (median 0.7 px -> 1.05 px) admits pairs up to 1.5 x that limit at w >= 80 px/s (a
    leaning motorcycle in a hairpin, Griesalp gIGsrHCyZZA 30:38); on straights and on a clean video the limit is unchanged"""
    from rsm.odometry.gating import HIGH_RMS
    n = int(60 / DT)
    a, b = int(30 / DT), int(36 / DT)

    def noisy(rows, yaw_px):
        for r in rows:
            r["rms_px"] = 0.7
        for r in rows[a:b]:
            r["rms_px"] = 1.4      # above 1.05, below 1.05 x 1.5
            r["yaw"] = yaw_px      # px per pair; x 25 = px/s
    p = load_pairs(write_csv(tmp_path / "curve.csv", n, mutate=lambda rr: noisy(rr, 4.0)))      # 100 px/s
    assert not (pair_flags(p, GateParams())[a + 15:b - 15] & HIGH_RMS).any()
    p = load_pairs(write_csv(tmp_path / "straight.csv", n, mutate=lambda rr: noisy(rr, 0.0)))
    assert (pair_flags(p, GateParams())[a:b] & HIGH_RMS).all()

    def clean(rows):           # median 0.2 px: absolute limit 0.8 px, no curve allowance
        for r in rows[a:b]:
            r["rms_px"] = 1.0
            r["yaw"] = 4.0
    p = load_pairs(write_csv(tmp_path / "clean.csv", n, mutate=clean))
    assert (pair_flags(p, GateParams())[a:b] & HIGH_RMS).all()
