# SPDX-License-Identifier: AGPL-3.0-or-later
"""Passing traffic in the vms road fit (2026-11-17): candidate road fits for a pair a vehicle took over, and the pick of the road candidate over time."""
from __future__ import annotations

import csv

import numpy as np

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


def test_pick_leaves_an_old_csv_alone(tmp_path):
    f = tmp_path / "motion.csv"
    _write(f, [_row(i, 3e-4) for i in range(1, 50)], with_alts=False)
    before = f.read_bytes()
    assert M.pick_alternatives(str(f)) == dict(candidates=0)
    assert f.read_bytes() == before
