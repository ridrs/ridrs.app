# SPDX-License-Identifier: AGPL-3.0-or-later
"""Angle scale from far features: rotation-flow model and fit, stretch selection, pooling, references. Synthetic data only (no video, no cv2)."""
import numpy as np

from rsm.angle import analyse, farfeat, refs, rotflow


def _points(rng, n=300):
    return rng.uniform(-300, 300, n), rng.uniform(-170, -60, n)


def test_flow_model_matches_pinhole_rotation():
    # a point at depth Z, camera yawing by w: compare the model with the exact projection difference
    f, w = 450.0, 0.01
    X, Y, Z = np.array([30.0, -80.0]), np.array([-20.0, -5.0]), np.array([2000.0, 3000.0])
    x0, y0 = f * X / Z, f * Y / Z
    c, s = np.cos(w), np.sin(w)
    Xr, Zr = c * X - s * Z, s * X + c * Z  # scene rotates by -w about the vertical axis = camera yaw
    flow = np.column_stack([f * Xr / Zr - x0, f * Y / Zr - y0])
    A = flow[:, 0].mean()
    A = -w * f  # yaw constant
    m = rotflow.synth_flow(x0, y0, f, 0.0, A=A)
    assert np.allclose(m, flow, atol=0.1)


def test_fit_pair_recovers_f_with_outliers():
    rng = np.random.default_rng(3)
    x, y = _points(rng)
    f_true = 380.0
    fl = rotflow.synth_flow(x, y, f_true, 0.0, A=28.0, B=-4.0, C=0.01, e=4e-4) + rng.normal(0, 0.25, (len(x), 2))
    bad = rng.random(len(x)) < 0.3
    fl[bad] += rng.normal(0, 5, (bad.sum(), 2))  # parallax points
    fg = np.exp(np.linspace(np.log(200), np.log(1000), 49))
    kg = np.array([0.0])
    r = rotflow.fit_pair(x, y, fl, fg, kg, 449.0, rng=rng)
    assert r is not None and r.n_inl > 150
    f, _, _, _ = rotflow.pooled_argmin(r.chi2, fg, kg)
    assert abs(f / f_true - 1) < 0.12
    i = int(np.argmin(np.abs(fg - f_true)))
    assert abs(r.A[i, 0] - 28.0) < 1.0  # the yaw constant is almost independent of f


def test_pooling_many_pairs_tightens_f():
    rng = np.random.default_rng(4)
    fg = np.exp(np.linspace(np.log(200), np.log(1000), 49))
    kg = np.array([0.0])
    tot = np.zeros((len(fg), 1))
    for _ in range(25):
        x, y = _points(rng)
        fl = rotflow.synth_flow(x, y, 520.0, 0.0, A=rng.uniform(-30, 30)) + rng.normal(0, 0.3, (len(x), 2))
        r = rotflow.fit_pair(x, y, fl, fg, kg, 449.0, rng=rng)
        tot += r.chi2
    f = rotflow.pooled_argmin(tot, fg, kg)[0]
    assert abs(f / 520.0 - 1) < 0.04


def test_distortion_is_inverted_consistently():
    xn = np.array([0.3, -0.5, 0.0]); yn = np.array([-0.2, 0.1, 0.4])
    xu, yu = rotflow._undistort(xn, yn, 0.08)
    s = 1 + 0.08 * (xu**2 + yu**2)
    assert np.allclose(xu * s, xn, atol=1e-6) and np.allclose(yu * s, yn, atol=1e-6)


def test_pick_stretches_takes_turns_not_straights(tmp_path):
    t = np.arange(0, 400, 0.05)
    yaw = np.zeros_like(t)
    yaw[(t > 100) & (t < 106)] = 1.0  # 20 pairs per s: about 100 px over 5 s
    yaw[(t > 300) & (t < 306)] = -1.0
    csv = tmp_path / "v.csv"
    with open(csv, "w") as fh:
        fh.write("frame,time,corners,tracked,inliers,rms_px,s,c,yaw,pitch,roll,diff,rel_speed\n")
        for i, (a, b) in enumerate(zip(t, yaw)):
            fh.write(f"{i},{a:.3f},300,300,250,0.2,1e-4,0,{b},0,0,5,1e-3\n")
    st = farfeat.pick_stretches(str(csv), farfeat.Params(n_stretch=5, min_net_px=60, stretch_s=5.0))
    assert len(st) >= 2
    assert all(abs(s["t0"] - 100) < 7 or abs(s["t0"] - 300) < 7 for s in st)
    assert min(s["net_px"] for s in st) < 0 < max(s["net_px"] for s in st)


def test_transfer_ratio_recovers_gain():
    p = farfeat.Params()
    fg = farfeat.f_grid(p)
    rng = np.random.default_rng(1)
    strs = []
    for s in range(6):
        pairs = []
        for q in range(5):
            a = rng.uniform(10, 30)
            A = np.full((len(fg), 1), a, np.float32)
            pairs.append(dict(ta=float(q), tb=float(q + 1), sigma=0.3, A=A, chi2=np.zeros((len(fg), 1), np.float32), vms_yaw=0.8 * a))
        chi = (np.log(fg / 450.0) ** 2)[:, None] * 100
        strs.append(dict(t0=0.0, t1=5.0, net_px=100.0, k=8, band_end=100.0, n_try=5, pairs=pairs, chi2=chi))
    from dataclasses import asdict
    res = dict(params=asdict(p), stretches=strs)
    pool = farfeat.pool_f(res)
    assert abs(pool["f"] / 450 - 1) < 0.02
    tr = farfeat.transfer_ratio(res, pool["f"], 0.0, n_boot=20)
    assert abs(tr["g"] - 0.8) < 1e-6
    s = analyse.summarize(res, n_boot=20)
    assert abs(s["f_eff_A"] / (0.8 * 450) - 1) < 0.02


def test_robust_slope_ignores_outliers():
    rng = np.random.default_rng(0)
    x = rng.normal(size=200)
    y = 400 * x + rng.normal(0, 5, 200)
    y[:10] += 3000
    assert abs(refs.robust_slope(x, y) / 400 - 1) < 0.03
