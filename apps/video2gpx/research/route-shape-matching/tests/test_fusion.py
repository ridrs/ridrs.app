# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.fusion: RTS smoother (state s, k), robust measurement updates, kind-blind anchor sigma, gate mapping."""
from types import SimpleNamespace

import numpy as np

from rsm.fusion import core, gate, rts
from rsm.refine import anchors as A


def _setup(n=400, k_true=1.3, jump=None):
    t = np.arange(n, dtype=float)
    dm = np.full(n, 10.0); dm[0] = 0.0                         # 10 map-metres nominal per second at rho = 1
    rho = np.full(n, k_true)
    if jump is not None:
        rho[jump:] = jump_val(jump)
    s = np.cumsum(dm * rho)
    return t, dm, s


def jump_val(j):
    return 1.1


def test_smoother_learns_a_constant_factor_from_sparse_anchors():
    t, dm, s = _setup()
    meas = [rts.Meas(float(t[i]), float(s[i]), 25.0, "x") for i in range(0, 400, 100)]
    r = rts.fuse(t, dm, np.zeros_like(dm), meas, float(s[0]))
    assert np.abs(r["xs"][:, 0] - s).max() < 6.0
    assert abs(r["xs"][-1, 1] - 1.3) < 0.03


def test_follows_a_changing_factor_with_posterior_like_measurements():
    t, dm, s = _setup(jump=200)
    meas = [rts.Meas(float(t[i]), float(s[i]), 100.0, "posterior") for i in range(0, 400, 5)]
    r = rts.fuse(t, dm, np.zeros_like(dm), meas, float(s[0]))
    assert np.abs(r["xs"][:, 0] - s).max() < 12.0
    assert 1.05 < r["xs"][380, 1] < 1.2


def test_huber_stops_one_wrong_anchor_from_pulling_the_segment():
    t, dm, s = _setup()
    post = [rts.Meas(float(t[i]), float(s[i]), 400.0, "posterior") for i in range(0, 400, 4)]
    good = [rts.Meas(float(t[i]), float(s[i]), 16.0, "curve") for i in range(20, 400, 40)]
    bad = rts.Meas(200.0, float(s[200] + 100.0), 16.0, "curve")
    good = [m for m in good if m.t != 180.0 and m.t != 220.0]
    with_bad = good + [bad]
    nofix = rts.fuse(t, dm, np.zeros_like(dm), post + with_bad, float(s[0]), rts.FuseParams(huber_c=1e9, n_irls=0))
    rob = rts.fuse(t, dm, np.zeros_like(dm), post + with_bad, float(s[0]))
    e0 = np.abs(nofix["xs"][:, 0] - s)[150:250].max(); e1 = np.abs(rob["xs"][:, 0] - s)[150:250].max()
    assert e0 > 40.0 and e1 < 0.5 * e0
    assert rob["w"][len(post) + good.__len__()] < 0.3            # the wrong anchor was down-weighted


def test_standstill_holds_the_position():
    t = np.arange(100, dtype=float)
    dm = np.where(np.arange(100) < 50, 10.0, 0.0); dm[0] = 0.0
    meas = [rts.Meas(0.0, 0.0, 4.0, "x"), rts.Meas(99.0, 490.0, 4.0, "x")]
    r = rts.fuse(t, dm, np.zeros(100), meas, 0.0)
    assert abs(r["xs"][60, 0] - r["xs"][99, 0]) < 3.0


def test_anchor_sigma_is_kind_blind_and_uses_quality_and_time_sigma():
    ctx = SimpleNamespace(kappa=1.0, D=lambda t: 10.0 * np.asarray(t, float))
    a = A.Anchor(10, 100, "curve", 1.0, 0.0, 5.0)
    b = A.Anchor(10, 100, "tunnel_portal", 1.0, 0.0, 5.0)
    assert core.anchor_sigma(a, ctx) == core.anchor_sigma(b, ctx) == 5.0
    assert core.anchor_sigma(A.Anchor(10, 100, "x", 0.25, 0.0, 5.0), ctx) == 10.0
    assert np.isclose(core.anchor_sigma(A.Anchor(10, 100, "x", 1.0, 1.0, 5.0), ctx), np.hypot(5.0, 10.0))


def test_gate_mapping_is_monotone_and_rejects():
    g = gate.GateParams()
    good = dict(inlier_share=1.0, margin=60.0, ang_dev=0.1, yaw_noise=0.004)
    s0, why = gate.sigma(good, g)
    assert why == "" and s0 == g.sig_base
    for k, v in (("inlier_share", 0.8), ("margin", 15.0), ("ang_dev", 0.8), ("yaw_noise", 0.02)):
        s1, why = gate.sigma(dict(good, **{k: v}), g)
        assert why == "" and s1 > s0
    assert gate.sigma(dict(good, margin=3.0), g)[1] == "margin"
    assert gate.sigma(dict(good, inlier_share=0.2), g)[1] == "inlier"
    assert gate.sigma(dict(good, yaw_noise=0.1), g)[1] == "sigma"


def test_gate_passes_other_kinds_unchanged():
    feat = SimpleNamespace(of=lambda a: {})
    p = A.Anchor(5, 50, "tunnel_portal", 0.95, 0.7, 5.0)
    keep, rej, _ = gate.gate([p], feat)
    assert keep == [p] and rej == []
