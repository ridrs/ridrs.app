# SPDX-License-Identifier: AGPL-3.0-or-later
"""The vms flow model (exact forward step, second-order rotation) and the focus-of-expansion horizon (2026-11-14)."""
import numpy as np

from rsm.pipeline.vmsx import motion as m

W, H = 640, 360
CX, CY = W / 2, H / 2


def _road(yh, n=200, seed=0):
    rng = np.random.default_rng(seed)
    x = rng.uniform(40, W - 40, n)
    y = rng.uniform(yh + 20, H - 12, n)
    return np.column_stack([x, y])


def _step(p0, yh, s):
    """exact image motion of road points for a forward step: 1/U1 = 1/U0 - s, X scales with U"""
    u0 = p0[:, 1] - yh
    u1 = u0 / (1 - s * u0)
    x1 = (p0[:, 0] - CX) * u1 / u0 + CX
    return np.column_stack([x1, u1 + yh])


def test_exact_model_recovers_s_on_a_large_step():
    yh = 200.0
    p0 = _road(yh)
    s = 6e-4                                    # about 20 px flow at the bottom edge: the midpoint model reads it biased
    p1 = _step(p0, yh, s)
    mid, flow = (p0 + p1) / 2, p1 - p0
    fit = m.fit_fixed_horizon(mid, flow, CX, CY, yh, m.MIN_RESIDUAL)
    assert fit is not None and abs(fit.params[0] / s - 1) < 0.01
    assert fit.inliers.sum() == len(p0)


def test_focus_of_expansion_is_the_horizon_point_for_any_depth():
    rng = np.random.default_rng(1)
    foe = np.array([350.0, 240.0])
    pts = np.column_stack([rng.uniform(0, W, 300), rng.uniform(30, H - 10, 300)])
    depth = rng.uniform(0.02, 0.2, 300)          # house fronts and road alike: only the direction counts
    flow = (pts - foe) * depth[:, None] + rng.normal(0, 0.05, (300, 2))
    fo = m.focus_of_expansion(pts, flow, 0.3)
    assert fo is not None and abs(fo[0] - foe[0]) < 3 and abs(fo[1] - foe[1]) < 3


def test_focus_of_expansion_needs_enough_moving_points():
    pts = np.column_stack([np.linspace(0, W, 30), np.full(30, 300.0)])
    assert m.focus_of_expansion(pts, np.zeros_like(pts), 0.3) is None


def test_vehicle_from_calibration_uses_kappa_and_real_speed():
    from rsm.pipeline.steps_b import vehicle_from_calibration as v
    # bench foe1 (2026-11-14): (kappa, nominal p90 m/s, truth)
    cases = [(0.99, 9.61, "bike"), (1.06, 7.84, "bike"), (1.06, 8.65, "bike"), (0.80, 8.69, "bike"), (1.06, 6.98, "bike"), (1.06, 7.55, "bike"),
             (1.73, 6.25, "motorcycle"), (1.06, 10.45, "motorcycle")]
    for k, v90, truth in cases:
        assert v(k, v90, "bike") == truth and v(k, v90, "motorcycle") == truth
    assert v(1.2, 8.5, "motorcycle") == "motorcycle" and v(1.2, 8.5, "bike") == "bike"   # in between: the estimate stays


def test_destatic_cancels_what_stands_still_and_keeps_what_moves():
    rng = np.random.default_rng(2)
    pattern = (rng.random((H, W)) * 255).astype(np.float32)        # a fixed grain pattern (camera denoiser / encoder)
    f = m.Destatic(tau=2.0, gain=3.0)
    for _ in range(10):
        out = f(pattern.astype(np.uint8))
    assert np.abs(out.astype(float) - 128).max() <= 2               # fixed in the image: cancels to mid-grey
    moved = np.roll(pattern, 3, axis=0).astype(np.uint8)
    assert np.abs(f(moved).astype(float) - 128).mean() > 20         # moving texture stays


def test_pair_row_falls_back_to_the_plain_frames_at_a_standstill():
    rng = np.random.default_rng(3)
    img = (rng.random((H, W)) * 255).astype(np.uint8)
    import cv2
    img = cv2.GaussianBlur(img, (5, 5), 0)
    tr = m.Tracker(H, W, 170, H - 11, 160.0)
    f = m.Destatic()
    a, b = f(img), f(img)
    row = m.pair_row(tr, a, b, 1, 0.0, 160.0, m.MIN_RESIDUAL, 1 / 30, W, H, raw=(img, img))
    assert row[4] >= m.MIN_INLIERS and abs(float(row[6])) < 1e-6   # a fit with speed 0, not a failed pair
