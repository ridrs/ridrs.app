# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rotation improvements of work/rotation-exp: far bands hung from the FOE horizon of vms (horizon_vms, ROT_BAND_OFF_VMS) with a fallback for old projects,
and heading across vms speed gaps from the far features alone (ROT_BRIDGE_ON): gap sub-steps emit, cut jumps never, the gap distance prior is unchanged."""
from types import SimpleNamespace

import numpy as np

from rsm.angle import farfeat
from rsm.hmm import seq
from rsm.pipeline import config as C, odofail as OF, steps_a, tracks as T


# ------------------------------------------------------------------ band rows
def test_band_ends_from_horizon_vms():
    row, off = farfeat.band_horizon(dict(horizon=150.0, horizon_vms=180.0), C.ROT_BAND_OFF_VMS)
    assert (row, off) == (180.0, C.ROT_BAND_OFF_VMS)
    p = farfeat.Params(band_off=off)
    e = steps_a.band_ends(row, 360, p, 35.0, 3)
    assert e == [180.0 + C.ROT_BAND_OFF_VMS, 180.0 + C.ROT_BAND_OFF_VMS + 35.0, min(180.0 + C.ROT_BAND_OFF_VMS + 70.0, 0.62 * 360)]


def test_band_ends_fall_back_to_old_horizon_and_keep_the_cap():
    for mj in (dict(horizon=150.0), dict(horizon=150.0, horizon_vms=None), dict(horizon=150.0, horizon_vms=float("nan"))):
        assert farfeat.band_horizon(mj, C.ROT_BAND_OFF_VMS) == (150.0, -5.0)
    row, off = farfeat.band_horizon(dict(horizon=150.0, horizon_vms=260.0), C.ROT_BAND_OFF_VMS)   # marburg: FOE row low in the frame
    assert steps_a.band_ends(row, 360, farfeat.Params(band_off=off), 35.0, 3) == [235.0 if 235.0 < 0.62 * 360 else 0.62 * 360] + [0.62 * 360] * 2


def test_rotation_reads_horizon_vms(tmp_path, monkeypatch):
    """the rotation step's band rows: from horizon_vms (meta records it)"""
    import json
    captured = {}

    class Stop(Exception):
        pass

    def fake_probe(_):
        return SimpleNamespace(fps=30.0, duration=10.0, width=640, height=360)

    def fake_ctx(_):
        captured.update(steps_a._G)
        raise Stop
    (tmp_path / "motion").mkdir()
    (tmp_path / "motion" / "motion.json").write_text(json.dumps(dict(horizon=150.0, horizon_vms=190.0)))
    monkeypatch.setattr(steps_a, "probe", fake_probe)
    monkeypatch.setattr(steps_a.mp, "get_context", fake_ctx)
    try:
        steps_a.rotation(tmp_path, dict(video="v.mp4"), None)
    except Stop:
        pass
    assert captured["horizon"] == 190.0 and captured["p"].band_off == C.ROT_BAND_OFF_VMS


# ------------------------------------------------------------------ heading across vms gaps
def track(t0, t1, v=10.0, ds=4.0, th0=0.0, rate=0.0):
    s = np.arange(0.0, v * (t1 - t0), ds)
    t = t0 + s / v
    return dict(t=t, s=s, th=th0 + rate * (t - t0))


def far(T_end=200.0, w=0.25, rate=0.01, invalid=()):
    """far-only heading per window, constant turn rate (track units per s), NaN inside `invalid`"""
    ta = np.arange(0.0, T_end, w)
    tb = ta + w
    d = np.full(len(ta), rate * w)
    for a, b in invalid:
        d[(tb > a) & (ta < b)] = np.nan
    return ta, tb, d


def test_far_heading_increment_and_validity():
    fh = T.FarHeading(*far(rate=0.02, invalid=[(50.0, 51.0)]))
    assert abs(fh(10.0, 13.0) - 0.06) < 1e-9
    assert abs(fh(10.1, 10.6) - 0.01) < 1e-9                          # partial windows by overlap
    assert abs(fh(49.0, 54.0) - 0.10) < 1e-9                          # 1 s of 5 invalid: scaled up (0.8 valid share)
    assert np.isnan(fh(50.0, 51.5))                                    # mostly invalid
    assert np.isnan(fh(250.0, 260.0)) and np.isnan(fh(5.0, 5.0))


def test_gap_substeps_get_far_heading_distance_prior_unchanged():
    tr = [track(0.0, 60.0), track(80.0, 140.0)]                       # a 20 s vms speed gap
    fh = T.FarHeading(*far(rate=0.01))
    st0 = T.steps_of(tr)
    st1 = T.steps_of(tr, gap_dth=fh)
    g = st1.gap
    assert g.sum() > 3 and np.all(np.isnan(st0.dth[st0.gap]))
    assert np.all(np.isfinite(st1.dth[g]))
    dt = st1.t[np.flatnonzero(g)] - st1.t[np.flatnonzero(g) - 1]
    assert np.allclose(st1.dth[g], 0.01 * dt)
    for f in ("t", "mu", "rel", "v", "gap", "seg"):                     # only the emission changes
        assert np.array_equal(getattr(st0, f), getattr(st1, f)), f
    assert np.array_equal(st0.dth[~g], st1.dth[~g], equal_nan=True)


def test_gap_substeps_without_far_windows_stay_silent():
    tr = [track(0.0, 60.0), track(80.0, 140.0)]
    st = T.steps_of(tr, gap_dth=T.FarHeading(*far(invalid=[(58.0, 82.0)])))
    assert np.all(np.isnan(st.dth[st.gap]))


def test_cut_jumps_are_never_bridged():
    tr = [track(0.0, 60.0), dict(track(80.0, 140.0), cut_before=70.0)]
    st = T.steps_of(tr, gap_dth=T.FarHeading(*far()))
    assert st.gap.sum() > 0 and np.all(np.isnan(st.dth[st.gap]))
    assert np.all(st.mu[st.gap] == T.CUT_SUB_MU)


def test_far_heading_masks_cut_windows():
    S = SimpleNamespace(ta=np.arange(0.0, 20.0, 0.25), tb=np.arange(0.25, 20.25, 0.25), dth_far=np.full(80, 0.001), f=450.0)
    fh = T.far_heading(S, [(10.0, 10.0)])
    bad = np.isnan(fh["dth"])
    assert bad.any() and np.all((fh["tb"][bad] > 9.4) & (fh["ta"][bad] < 10.6))
    assert np.allclose(fh["dth"][~bad], 0.001 / (C.F_REF / 450.0))


def test_failure_gaps_get_heading_too(tmp_path):
    """odofail: failure gap sub-steps (rebuilt with more sub-steps and a wide sd) emit far heading; their distance treatment is unchanged"""
    tr = [track(0.0, 60.0), track(120.0, 180.0)]
    d0 = 15.0
    fh = T.FarHeading(*far(rate=0.01))
    a = OF.shape_steps(seq.make_steps(tr, d0=d0), [(60.0, 120.0)], d0)
    b = OF.shape_steps(seq.make_steps(tr, d0=d0, gap_dth=fh), [(60.0, 120.0)], d0, gap_dth=fh)
    for f in ("t", "mu", "rel", "v", "gap", "seg"):
        assert np.array_equal(getattr(a, f), getattr(b, f)), f
    assert np.all(np.isnan(a.dth[a.gap])) and np.all(np.isfinite(b.dth[b.gap]))


def test_build_loads_far_heading_of_the_project(tmp_path, monkeypatch):
    (tmp_path / "motion").mkdir(); (tmp_path / "rotation").mkdir()
    csv = tmp_path / "motion" / "motion.csv"
    csv.write_text("x")
    t = np.arange(0.05, 200.0, 0.1)
    p, fl = SimpleNamespace(time=t, s=np.full(len(t), 0.3), dt=0.1), np.zeros(len(t), np.int32)
    monkeypatch.setattr(OF, "load_pairs", lambda _: p)
    monkeypatch.setattr(OF.gating, "pair_flags", lambda _: fl)
    tr = [track(0.0, 60.0), track(80.0, 140.0)]
    st0, _ = OF.build(tr, str(csv))
    assert np.all(np.isnan(st0.dth[st0.gap]))                          # old project: no far_heading.npz
    ta, tb, d = far()
    T.save_far_heading(tmp_path / "rotation" / "far_heading.npz", dict(ta=ta, tb=tb, dth=d))
    st1, info = OF.build(tr, str(csv))
    assert info["gap_steps_heading"] == info["gap_steps"] > 0
    assert np.array_equal(st0.mu, st1.mu) and np.array_equal(st0.rel, st1.rel)
    monkeypatch.setattr(C, "ROT_BRIDGE_ON", False)
    st2, _ = OF.build(tr, str(csv))
    assert np.array_equal(st0.dth, st2.dth, equal_nan=True)


# ------------------------------------------------------------------ resume hashes
def test_rotation_config_changes_only_the_hashes_that_read_it(tmp_path, monkeypatch):
    from rsm.pipeline.cli import Run, parse_args
    vid, pbf = tmp_path / "v.mp4", tmp_path / "p.pbf"
    vid.write_bytes(b"x"); pbf.write_bytes(b"y")
    run = Run(parse_args(["run", "--video", str(vid), "--bbox", "1,2,3,4", "--pbf", str(pbf), "--out", str(tmp_path / "o")]))
    base = dict(video=str(vid), bbox=dict(south=1, west=2, north=3, east=4), pbf=str(pbf), vehicle="auto", offset_m=None, start_time=None, traffic_side="auto", decoys=0,
                start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    steps = list(C.STEPS)
    for first, nm, new in (("rotation", "ROT_BAND_OFF_VMS", -36.5), ("route_search", "ROT_BRIDGE_ON", False), ("route_search", "ROT_BRIDGE_MIN_VALID", 0.5)):
        ref = run.hashes(base)
        with monkeypatch.context() as m:
            m.setattr(C, nm, new)
            h1 = run.hashes(base)
        for s_ in steps:
            assert (h1[s_] == ref[s_]) == (steps.index(s_) < steps.index(first)), (nm, s_)
