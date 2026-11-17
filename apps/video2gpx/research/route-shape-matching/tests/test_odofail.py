# SPDX-License-Identifier: AGPL-3.0-or-later
"""Odometry failure handling (rsm.pipeline.odofail, GOTTHARD_DIAGNOSIS section 7): failure stretches from the usable share, track splitting, the failure gap
prior from both sides, systematic gap sd independent of the step length, wide sd at low usable share."""
from types import SimpleNamespace

import numpy as np

from rsm.hmm import seq
from rsm.odometry import gating
from rsm.pipeline import config as C, odofail as OF


def pairs(T=200.0, dt=0.1, fail=(), slow=(), v=1.0):
    """synthetic pairs: speed v (nominal units of p.s per pair), flagged (NO_FIT) inside `fail`, slow but well fitted inside `slow` (a standstill)"""
    t = np.arange(dt / 2, T, dt)
    s = np.full(len(t), v * dt)
    fl = np.zeros(len(t), np.int32)
    rng = np.random.default_rng(0)
    for a, b in fail:
        m = (t >= a) & (t < b)
        fl[m & (rng.random(len(t)) < 0.75)] = gating.NO_FIT      # 25 % usable, as Gotthard 4:22-5:36
        s[m] = 0.01 * v * dt
    for a, b in slow:
        s[(t >= a) & (t < b)] = 0.02 * v * dt
    return SimpleNamespace(time=t, s=s, dt=dt), fl


def track(t0, t1, v=10.0, ds=4.0):
    s = np.arange(0.0, v * (t1 - t0), ds)
    return dict(t=t0 + s / v, s=s, th=np.zeros(len(s)))


def test_fail_spans_low_usable_not_standstill():
    p, fl = pairs(fail=[(60.0, 100.0), (150.0, 154.0)], slow=[(120.0, 140.0)])
    sp = OF.fail_spans(OF.quality(p, fl))
    assert len(sp) == 1                                    # the 4 s dip is too short, the standstill fits well
    a, b = sp[0]
    assert 55.0 <= a <= 65.0 and 95.0 <= b <= 105.0


def test_split_tracks_and_fail_gap_prior():
    tr = [track(0.0, 200.0)]
    sp = [(80.0, 120.0)]
    out = OF.split_tracks(tr, sp)
    assert len(out) == 2 and out[1].get("odo_fail_before") and out[1]["s"][0] == 0.0
    assert out[0]["t"][-1] < 80.0 and out[1]["t"][0] > 120.0
    p, fl = pairs(fail=[(80.0, 120.0)], v=3.0)
    q = OF.quality(p, fl)
    gn = OF.fail_gap_nominal(q, out, sp)
    v_nom = C.F360 * OF.CAMERA_HEIGHT_M * 3.0               # nominal m/s of the good pairs on both sides
    assert gn[0] is None and abs(gn[1] - v_nom * (out[1]["t"][0] - out[0]["t"][-1])) < 0.05 * gn[1]


def _gap_sd(st, kappa=1.0):
    g = st.gap
    return float(np.sqrt(np.sum((st.rel[g] * kappa * st.mu[g]) ** 2))), float(st.mu[g].sum()), int(g.sum())


def test_gap_sd_systematic_same_for_any_step():
    tr = [track(0.0, 60.0), track(120.0, 180.0)]           # a 60 s gap of about 600 m: 20 sub-steps at 30 m, 40 at 15 m
    sds = []
    for d0 in (30.0, 15.0):
        st = OF.shape_steps(seq.make_steps(tr, d0=d0), [], d0)
        sd, gnom, n = _gap_sd(st)
        assert n > 11                                       # the old cap (rel <= 1 per sub-step) would apply here
        assert abs(sd - C.GAP_SYS_REL * gnom) < 1e-6 * gnom
        sds.append(sd / gnom)
    old = seq.make_steps(tr, d0=15.0)
    assert _gap_sd(old)[0] < 0.9 * sds[1] * _gap_sd(old)[1]  # before: the finer step had less slack


def test_fail_gap_more_substeps_wide_sd():
    tr = [track(0.0, 60.0), track(120.0, 180.0)]
    d0 = 15.0
    st0 = seq.make_steps(tr, d0=d0)
    st = OF.shape_steps(st0, [(60.0, 120.0)], d0)
    sd, gnom, n = _gap_sd(st)
    assert abs(gnom - st0.mu[st0.gap].sum()) < 1e-6
    assert n >= round(C.ODO_GAP_UPPER * gnom / d0)
    assert abs(sd - C.ODO_GAP_REL * gnom) < 1e-6 * gnom
    assert np.all(np.diff(st.t) >= 0) and st.T == st0.T - int(st0.gap.sum()) + n


def test_low_usable_widens_emitting_steps():
    tr = [track(0.0, 200.0)]
    p, fl = pairs(fail=[(90.0, 110.0)])
    q = OF.quality(p, fl)
    st = OF.shape_steps(seq.make_steps(tr, d0=30.0), [], 30.0, q["usable"])
    wide = st.rel >= C.ODO_LOW_REL
    assert wide.any() and not wide[st.t < 70].any() and not wide[st.t > 130].any()
    assert np.all(wide[(st.t > 95) & (st.t < 105)])


def test_truncated_video_status():
    from rsm.pipeline import steps_a
    tr = steps_a.truncation(964.3, 964.3, 2486.5)           # Gotthard: the stream stops at 16:04, the container says 41:26
    assert tr == dict(decoded_s=964.3, container_s=2486.5)
    assert steps_a.truncation(2486.0, 2486.5, 2486.5) is None
    assert steps_a.truncation(100.0, None, None) is None
    assert steps_a.truncation(595.0, 600.0, None) is None    # the last pair ends a few seconds early: normal


def test_ext_classes():
    from rsm.pipeline import local as L
    c = L.ext_classes_for("car")
    assert set(L.classes_for("car")) <= set(c) and "service" in c and "pedestrian" in c and "track" not in c
    assert "track" in L.ext_classes_for("bike")
