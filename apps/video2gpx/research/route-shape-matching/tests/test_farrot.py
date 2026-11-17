# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.farrot: fixed-f rotation fit with parallax outliers, focal-point leak estimate, lean decomposition, block comparison."""
import numpy as np

from rsm.angle import rotflow
from rsm.farrot import model, series, validate


def _scene(n=300, f=450.0, A=20.0, B=1.5, C=-3.0, e=4.0, n_near=80, seed=0):
    rng = np.random.default_rng(seed)
    x = rng.uniform(-300, 300, n); y = rng.uniform(-170, -20, n)
    fl = rotflow.synth_flow(x, y, f, 0.0, A, B, C, e) + rng.normal(0, 0.15, (n, 2))
    fl[:n_near] += rng.uniform(5, 30, (n_near, 2))       # near features: parallax
    return x, y, fl, f


def test_fit_window_recovers_rotation_and_rejects_near_features():
    x, y, fl, f = _scene()
    w = model.fit_window(x, y, fl, f, rng=np.random.default_rng(1), min_xspread=0.0)
    assert w.ok
    assert abs(w.A - 20.0) < 0.3 and abs(w.B - 1.5) < 0.5 and abs(w.C + 3.0) < 0.5
    assert w.sA < 1.0 and w.n_inl > 150


def test_fit_window_refuses_few_points():
    x, y, fl, f = _scene(n=20, n_near=0)
    assert not model.fit_window(x, y, fl, f).ok


def test_x0_estimate_from_straight_windows():
    rng = np.random.default_rng(2)
    eps = rng.uniform(0.02, 0.1, 3000)
    A = -eps * 25.0 + rng.normal(0, 0.1, 3000)           # no turning: A_fit = -eps x0
    x0, n = series.estimate_x0(A, eps, np.zeros(3000), series.SeriesParams())
    assert abs(x0 - 25.0) < 1.0 and n > 100


def test_block_compare_gain_and_correlation():
    rng = np.random.default_rng(3)
    ref = rng.normal(0, 0.1, 200)
    r = validate.block_compare(ref, 0.8 * ref + rng.normal(0, 0.005, 200))
    assert abs(r["slope"] - 0.8) < 0.03 and r["r"] > 0.99 and r["ratio_cv"] < 0.2
