# SPDX-License-Identifier: AGPL-3.0-or-later
"""Elevation profile corrections (rsm.pipeline.dem): noise-adaptive smoothing, drift-free grade clamp. Synthetic data only."""
import numpy as np
import pytest

from rsm.pipeline import dem as D

DS = 5.0


def _climb(n=2000, rise=120.0, start=400, length=800):
    """flat, then a steady climb of `rise` metres over `length` samples, then flat (5 m grid)"""
    z = np.zeros(n)
    z[start:start + length] = np.linspace(0, rise, length)
    z[start + length:] = rise
    return z + 50.0


def test_running_quantile_per_sample_matches_numpy():
    rng = np.random.default_rng(1)
    z = rng.normal(0, 5, 300).cumsum()
    for q in (0.0, 25.0, 50.0, 100.0):
        assert np.allclose(D.running_quantile(z, 41, np.full(300, q)), D.running_quantile(z, 41, q))
    q = np.linspace(25, 50, 300)
    v = D.running_quantile(z, 41, q)
    win = np.lib.stride_tricks.sliding_window_view(np.pad(z, 20, mode="edge"), 41)
    assert v[123] == pytest.approx(np.percentile(win[123], q[123]))


def test_robust_local_linear_keeps_lines_and_ignores_outliers():
    s = np.arange(400) * DS
    line = 100 + 0.06 * s
    assert np.allclose(D.robust_local_linear(line, 30.0), line, atol=1e-6)        # a constant grade is kept exactly, ends included
    z = line.copy()
    z[200:204] -= 60                                                             # a gorge under the road (no bridge tag)
    assert np.abs(D.robust_local_linear(z, 30.0) - line).max() < 0.5


def test_grade_clamp_does_not_drift():
    z = np.full(2000, 100.0)
    z[600:606] = 40.0                                                            # a 60 m deep, 30 m wide notch
    zc, clipped = D.clamp_grade(z, DS)
    assert clipped > 0 and np.abs(np.diff(zc) / DS).max() <= D.GRADE_MAX + 1e-9
    assert np.abs(zc[:400] - 100).max() < 0.01 and np.abs(zc[900:] - 100).max() < 0.01   # only the neighbourhood changes
    assert zc.mean() == pytest.approx(z.mean(), abs=0.01)                                # height is moved, not created or lost


def test_clean_dem_keeps_lower_quantile_and_real_climbs():
    rng = np.random.default_rng(2)
    z = _climb() + rng.normal(0, 0.7, 2000)
    z[1500:1510] += 15                                                           # trees beside the road: DSM too high
    zf, st = D.profile(None, z, np.zeros(2000, bool), np.zeros(2000, bool))
    assert st["noisy_share"] < 0.05
    assert D.ascent_descent(zf)[0] == pytest.approx(120, rel=0.05)
    assert np.abs(zf[1480:1530] - 170).max() < 1.0


def test_noisy_cliff_dem_is_smoothed_without_bias_or_extra_climb():
    """a road cut into a cliff: the DSM pixels mix the rock above and the sea / gorge below, errors of +-30 m both ways"""
    rng = np.random.default_rng(3)
    true = _climb(rise=200.0)
    z = true.copy()
    sec = slice(300, 1700)
    z[sec] += rng.normal(0, 6, 1400) + np.where(rng.random(1400) < 0.15, rng.choice([-1, 1], 1400) * rng.uniform(15, 35, 1400), 0)
    zf, st = D.profile(None, z, np.zeros(2000, bool), np.zeros(2000, bool))
    assert st["noisy_share"] > 0.5
    up = D.ascent_descent(zf)[0]
    assert up == pytest.approx(200, rel=0.10)
    e = (zf - true)[sec]
    assert abs(e.mean()) < 2.0 and np.sqrt(np.mean(e ** 2)) < 5.0
    # the lower-quantile filter alone would follow the gorges down and add climbs
    z_old = D.gauss(D.running_quantile(z, 41, D.LOWQ), D.GAUSS_SIGMA_M / DS)
    assert (z_old - true)[sec].mean() < -3.0 and D.ascent_descent(z_old)[0] > up


def test_profile_stats_report_the_filter():
    z = _climb()
    _, st = D.profile(None, z, np.zeros(2000, bool), np.zeros(2000, bool))
    for k in ("noise_median_m", "noisy_share", "noise_lo_m", "noise_hi_m", "high_quantile", "rloess_sigma_m", "grade_clamped_m"):
        assert k in st
    assert D.profile(None, np.array([5.0, 5.5]), np.zeros(2, bool), np.zeros(2, bool))[0].tolist() == [5.0, 5.5]   # too short to filter
