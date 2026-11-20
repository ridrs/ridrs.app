# SPDX-License-Identifier: AGPL-3.0-or-later
"""Passing traffic in the vms road fit (2026-11-17): candidate road fits for a pair a vehicle took over, and the pick of the road candidate over time."""
from __future__ import annotations

import csv

import numpy as np
import pytest

from rsm.pipeline.vmsx import motion as M

W, H, HZ = 640, 360, 174.0
DT = 1 / 60


def road_flow(mid: np.ndarray, p: np.ndarray) -> np.ndarray:
    """flow of road points under the model parameters p (fixed point: the design depends on the flow through the start / end rows)"""
    flow = np.zeros_like(mid)
    for _ in range(20):
        a, n = M._flow_design(mid, flow, W / 2, H / 2, HZ)
        f = a @ p
        flow = np.column_stack([f[:n], f[n:]])
    return flow


def scene(seed: int = 0, s_true: float = 3.0e-4, n_road: int = 40, n_car: int = 90):
    """road points over the trapezoid, and a compact vehicle cluster on the left that moves towards the horizon (an overtake)"""
    rng = np.random.default_rng(seed)
    p = np.array([s_true, 0.0, 0.3, 0.0, 0.0])
    u = rng.uniform(15, 175, n_road)
    road = np.column_stack([W / 2 + rng.uniform(-1, 1, n_road) * 1.6 * u, HZ + u])
    car = np.column_stack([rng.uniform(120, 260, n_car), rng.uniform(240, 340, n_car)])
    fr = road_flow(road, p) + rng.normal(0, 0.08, (n_road, 2))
    fc = np.array([-2.5, -1.5]) + rng.normal(0, 0.08, (n_car, 2))
    return np.vstack([road, car]), np.vstack([fr, fc]), s_true


def test_vehicle_wins_the_plain_fit_but_a_candidate_is_the_road():
    mid, flow, s_true = scene()
    fit = M.fit_fixed_horizon(mid, flow, W / 2, H / 2, HZ, M.MIN_RESIDUAL)
    assert fit is not None and abs(fit.params[0] / s_true - 1) > 0.3            # the plain fit is not the road
    cands = M.candidates(mid, flow, W / 2, H / 2, HZ, 1.0, seed=7)
    assert 1 <= len(cands) <= M.ALT_KEEP
    assert min(abs(c[0][0] / s_true - 1) for c in cands) < 0.05                 # one candidate is
    assert all(c[1] >= M.MIN_INLIERS for c in cands)


def test_candidates_are_deterministic_per_frame():
    mid, flow, _ = scene()
    a = M.candidates(mid, flow, W / 2, H / 2, HZ, 1.0, seed=11)
    b = M.candidates(mid, flow, W / 2, H / 2, HZ, 1.0, seed=11)
    assert [(c[0].tolist(), c[1], c[2]) for c in a] == [(c[0].tolist(), c[1], c[2]) for c in b]


def _write(path, rows, with_alts=True):
    cols = M.COLUMNS if with_alts else M.COLUMNS[:-2]
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in rows:
            w.writerow(r if with_alts else r[:-2])


def _row(i, s, rms=0.2, alts=""):
    return [i, f"{i * DT:.4f}", 300, 200, 150, f"{rms:.4f}", f"{s:.4e}", "0.0000e+00", "0.1000", "0.0000", "0.000e+00", "2.000", f"{s / DT:.6e}", alts, ""]


def test_pick_takes_the_candidate_that_continues_the_road_speed(tmp_path):
    s = 3.0e-4
    rows = [_row(i, s) for i in range(1, 121)]
    for i in range(50, 70):                                   # a passing vehicle: plain fit reads 30 %, candidates: the vehicle and the road
        alts = ";".join([M._alt_text([0.3 * s, 0, 0.1, 0, 0], 120, 2.1), M._alt_text([0.32 * s, 0, 0.1, 0, 0], 80, 0.3),
                         M._alt_text([1.02 * s, 0, 0.2, 0, 0], 30, 0.25)])
        rows[i] = _row(i + 1, 0.3 * s, rms=2.1, alts=alts)
    rows[100] = _row(101, 0.3 * s, rms=2.0, alts=M._alt_text([0.3 * s, 0, 0.1, 0, 0], 120, 2.0) + ";" + M._alt_text([2.0 * s, 0, 0, 0, 0], 20, 0.3))
    f = tmp_path / "motion.csv"
    _write(f, rows)
    st = M.pick_alternatives(str(f))
    assert st == dict(candidates=21, replaced=20, kept=0, none=1)
    with open(f, newline="") as fh:
        out = list(csv.DictReader(fh))
    for r in out[50:70]:
        assert r["pick"] == "2" and abs(float(r["rel_speed"]) * DT / s - 1.02) < 1e-3 and float(r["rms_px"]) < 0.3 and r["yaw"] == "0.2000"
    assert out[100]["pick"] == "-1" and out[100]["rms_px"] == "2.0000"          # nothing near the road speed: the row stays (gating rejects it)
    assert all(r["pick"] == "" for r in out[:50])


def test_pick_ignores_candidates_at_the_videos_own_fit_level(tmp_path):
    """a soft video fits plain road at ~0.85 px: every pair is above ALT_TRIGGER and has candidates, but only pairs above ALT_TRIGGER_REL x the
    video's median plain rms may be traffic; the others keep their plain fit and are the reference of the road speed"""
    s = 3.0e-4
    rng = np.random.default_rng(3)
    rows = []
    for i in range(1, 301):
        e = float(rng.uniform(0.78, 0.92))
        alts = ";".join([M._alt_text([s, 0, 0.1, 0, 0], 150, e), M._alt_text([0.97 * s, 0, 0.1, 0, 0], 50, 0.3)])
        rows.append(_row(i, s, rms=e, alts=alts))
    for i in range(150, 170):                                 # a real vehicle: plain fit reads 30 % at 2.1 px, one candidate is the road
        alts = ";".join([M._alt_text([0.3 * s, 0, 0.1, 0, 0], 120, 2.1), M._alt_text([1.02 * s, 0, 0.2, 0, 0], 30, 0.25)])
        rows[i] = _row(i + 1, 0.3 * s, rms=2.1, alts=alts)
    f = tmp_path / "motion.csv"
    _write(f, rows)
    st = M.pick_alternatives(str(f))
    assert st["candidates"] == 300 and st["replaced"] == 20 and st["kept"] == 280 and st["none"] == 0
    assert abs(st["trigger"] - M.ALT_TRIGGER_REL * 0.85) < 0.02
    with open(f, newline="") as fh:
        out = list(csv.DictReader(fh))
    for r in out[150:170]:
        assert r["pick"] == "1" and abs(float(r["rel_speed"]) * DT / s - 1.02) < 1e-3
    for r in out[:150] + out[170:]:                           # plain road: the plain fit stays, no candidate replaces it
        assert r["pick"] == "0" and abs(float(r["rel_speed"]) * DT / s - 1) < 1e-3


def test_pick_trigger_stays_absolute_on_a_clean_video(tmp_path):
    rows = [_row(i, 3e-4, rms=0.25) for i in range(1, 200)]
    alts = M._alt_text([1.5e-4, 0, 0.1, 0, 0], 150, 0.65) + ";" + M._alt_text([2.95e-4, 0, 0.1, 0, 0], 60, 0.3)
    rows[100] = _row(101, 1.5e-4, rms=0.65, alts=alts)        # just above ALT_TRIGGER: a candidate may replace it
    f = tmp_path / "motion.csv"
    _write(f, rows)
    st = M.pick_alternatives(str(f))
    assert "trigger" not in st and st["replaced"] == 1


def test_pick_leaves_an_old_csv_alone(tmp_path):
    f = tmp_path / "motion.csv"
    _write(f, [_row(i, 3e-4) for i in range(1, 50)], with_alts=False)
    before = f.read_bytes()
    assert M.pick_alternatives(str(f)) == dict(candidates=0)
    assert f.read_bytes() == before


def _stored(fit, cands, pick, rms):
    alts = ";".join([M._alt_text(fit.params, int(fit.inliers.sum()), fit.rms)] + [M._alt_text(p, k, e) for p, k, e in cands])
    return dict(alts=alts, pick=str(pick), rms_px=f"{rms:.4f}")


def test_overlay_marks_the_vehicle_as_ignored_traffic_when_a_candidate_replaced_the_fit():
    from rsm.pipeline.insight import TRAFFIC, traffic_points
    mid, flow, s_true = scene()
    fit = M.fit_fixed_horizon(mid, flow, W / 2, H / 2, HZ, M.MIN_RESIDUAL)
    cands = M.candidates(mid, flow, W / 2, H / 2, HZ, 1.0, seed=7)
    k = 1 + min(range(len(cands)), key=lambda j: abs(cands[j][0][0] / s_true - 1))
    codes, info = traffic_points(mid, flow, W / 2, H / 2, HZ, 1.0, fit.inliers, _stored(fit, cands, k, cands[k - 1][2]), 0.8)
    assert info["state"] == "replaced" and info["pick"] == k and info["n_traffic"] == int((codes == TRAFFIC).sum())
    road, car = codes[:40], codes[40:]
    assert (road == 1).mean() > 0.9                       # the road carries the speed
    assert (car == TRAFFIC).mean() > 0.9                  # the vehicle is marked as ignored traffic, not as road and not as a plain outlier


def test_overlay_marks_every_fit_point_ignored_but_not_as_traffic_when_the_pair_is_rejected():
    """a rejected pair gives no speed, so every point that carried the fit is ignored; it is not located traffic (often only a soft frame), so the
    points get their own code IGNORED, not TRAFFIC"""
    from rsm.pipeline.insight import IGNORED, TRAFFIC, traffic_points
    mid, flow, _ = scene()
    fit = M.fit_fixed_horizon(mid, flow, W / 2, H / 2, HZ, M.MIN_RESIDUAL)
    cands = M.candidates(mid, flow, W / 2, H / 2, HZ, 1.0, seed=7)
    codes, info = traffic_points(mid, flow, W / 2, H / 2, HZ, 1.0, fit.inliers, _stored(fit, cands, -1, fit.rms), 0.8)
    assert info["state"] == "rejected" and set(codes.tolist()) <= {0, IGNORED}
    assert (codes == IGNORED).sum() == int(fit.inliers.sum()) == info["n_ignored"] and (codes == TRAFFIC).sum() == 0


def test_overlay_leaves_a_plain_road_pair_alone():
    from rsm.pipeline.insight import traffic_points
    mid, flow, _ = scene(n_car=0)
    fit = M.fit_fixed_horizon(mid, flow, W / 2, H / 2, HZ, M.MIN_RESIDUAL)
    codes, info = traffic_points(mid, flow, W / 2, H / 2, HZ, 1.0, fit.inliers, dict(alts="", pick="", rms_px=f"{fit.rms:.4f}"), 0.8)
    assert info is None and codes.tolist() == fit.inliers.astype(int).tolist()
    assert traffic_points(mid, flow, W / 2, H / 2, HZ, 1.0, fit.inliers, None, 0.8)[1] is None


def _noisy_road(seed: int, noise: float = 0.5, n: int = 150):
    rng = np.random.default_rng(seed)
    p = np.array([3.0e-4, 0.0, 0.3, 0.0, 0.0])
    u = rng.uniform(15, 175, n)
    mid = np.column_stack([W / 2 + rng.uniform(-1, 1, n) * 1.6 * u, HZ + u])
    return mid, road_flow(mid, p) + rng.normal(0, noise, (n, 2))


def test_candidate_tolerance_follows_the_videos_noise():
    """a soft video scatters plain road at ~0.85 px (PCI25WijGrE): with the fixed 0.6 px tolerance the road splits into several candidate sets (the
    rest is drawn as traffic); with the tolerance of `alt_threshold` one candidate holds the road"""
    fixed, rel = [], []
    for seed in range(8):
        mid, flow = _noisy_road(seed, noise=0.6)
        fit = M.fit_fixed_horizon(mid, flow, W / 2, H / 2, HZ, M.MIN_RESIDUAL)
        assert fit.rms > 0.6
        thr = M.alt_threshold(fit.rms, 1.0)
        fixed.append(M.candidates(mid, flow, W / 2, H / 2, HZ, 1.0, seed=seed)[0][1] / len(mid))
        rel.append(M.candidates(mid, flow, W / 2, H / 2, HZ, 1.0, seed=seed, thr=thr)[0][1] / len(mid))
    assert np.mean(fixed) < 0.7 and np.mean(rel) > 0.9


def test_alt_threshold_stays_absolute_on_a_clean_video():
    assert M.alt_threshold(0.3, 1.0) == M.ALT_THR
    assert M.alt_threshold(0.8 / 1.5, 1.0) == pytest.approx(M.ALT_THR)
    assert M.alt_threshold(0.85, 1.0) == pytest.approx(M.ALT_THR + M.ALT_THR_SLOPE * (0.85 - 0.8 / 1.5))
    assert M.alt_threshold(0.54, 1.0) == pytest.approx(M.ALT_THR, abs=0.02)        # continuous where it turns relative
    assert M.alt_threshold(0.6, 2.0) == pytest.approx(2 * M.ALT_THR)            # rms in px of a 720-row analysis: 0.3 px at 360 rows
    assert M.alt_threshold(float("nan"), 1.0) == M.ALT_THR
