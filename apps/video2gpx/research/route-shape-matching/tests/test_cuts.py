# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scene cuts (rsm.pipeline.cuts, F4): detection on synthetic frames and pair series, the plan (jumps, inserted shots, start rule), the jump in the HMM steps,
the smoother and the GPX. Real-video checks (Bavaria, bench) are in the work notes, not here (no video data in tests)."""
import numpy as np
import pytest
from scipy.ndimage import gaussian_filter, gaussian_filter1d

from rsm.hmm import grid, seq
from rsm.hmm_cal import dp
from rsm.fusion import rts
from rsm.pipeline import config as C, cuts as K, steps_c, steps_d, tracks as T
from rsm.pipeline.vmsx import motion as vm
from tests.test_track2 import make_graph


# ------------------------------------------------------------------ detection
def _texture(seed, mean, h=360, w=640):
    rng = np.random.default_rng(seed)
    x = gaussian_filter(rng.normal(0, 1, (h + 40, w + 40)), 2.5)
    return np.clip(mean + 45 * x / x.std(), 0, 255)


def _frames(n_before=8, n_after=8):
    """a camera panning 1 px per frame over one texture, then a cut to another texture panning the same way"""
    a, b = _texture(1, 128), _texture(2, 100)
    out = [a[20:380, 20 + i:660 + i] for i in range(n_before)] + [b[20:380, 20 + i:660 + i] for i in range(n_after)]
    return [f.astype(np.uint8) for f in out]


def test_synthetic_frames_give_a_diff_impulse_and_a_failed_fit_at_the_cut():
    fr = _frames()
    tr = vm.Tracker(360, 640, 180, 349, None, None)
    rows = [vm.pair_row(tr, p, q, i + 1, (i + 0.5) / 25, 150.0, vm.MIN_RESIDUAL, 0.04, 640, 360) for i, (p, q) in enumerate(zip(fr[:-1], fr[1:]))]
    diff = np.array([float(r[11]) for r in rows])
    inl = np.array([float(r[4]) for r in rows])
    i_cut = 7
    assert diff[i_cut] > 4 * np.median(np.delete(diff, i_cut)) and diff[i_cut] > 25
    assert inl[i_cut] < vm.MIN_INLIERS and np.median(np.delete(inl, i_cut)) > 100
    # a long enough series around it: same frames repeated as a steady ride before and after
    reps = 20
    D = np.concatenate([np.tile(np.delete(diff, i_cut), reps)[:200], [diff[i_cut]], np.tile(np.delete(diff, i_cut), reps)[:200]])
    I = np.concatenate([np.tile(np.delete(inl, i_cut), reps)[:200], [inl[i_cut]], np.tile(np.delete(inl, i_cut), reps)[:200]])
    TT = np.arange(len(D)) * 0.04
    c = K.candidates(TT, D, I)
    assert [x["i"] for x in c] == [200] and c[0]["vms"]
    assert [round(x["t"], 2) for x in K.decide(c)] == [round(TT[200], 2)]


def _series(n=3000, seed=0):
    rng = np.random.default_rng(seed)
    return np.arange(n) * 0.02, rng.normal(10, 1, n).clip(5), rng.normal(300, 20, n)


def test_a_bump_or_flash_is_no_cut_and_a_spike_needs_a_model_cue():
    t, d, inl = _series()
    d[500:506] = 70; inl[500:506] = 0          # bump: several pairs in a row -> no impulse
    d[1000] = 70; d[1001] = 70; inl[1000:1002] = 5   # flash: one bright frame raises two pairs
    d[1500] = 70                               # one pair, but road flow fits (exposure jump)
    d[2000] = 70; inl[2000] = 0                # cut
    c = K.candidates(t, d, inl)
    assert [x["i"] for x in c] == [1500, 2000]
    assert [x["vms"] for x in c] == [False, True]
    assert [round(x["t"], 2) for x in K.decide(c)] == [40.0]
    # the far-feature cue alone confirms a spike too: the window across pair 1500 has no fit
    ta = np.arange(0, 60, 0.26); tb = ta + 0.26
    ok = np.ones((len(ta), 3), bool); ninl = np.full((len(ta), 3), 200.0)
    w = int(np.searchsorted(ta, t[1500], side="right") - 1)
    ok[w] = False
    c2 = K.far_cue(c, ta, tb, ok, ninl)
    assert [x["far"] for x in c2] == [True, False]
    assert [round(x["t"], 2) for x in K.decide(c2)] == [30.0, 40.0]


def test_a_strong_impulse_with_a_dead_road_flow_fit_is_a_spike_below_the_main_gate():
    """Cayolle 0:41.67 / 0:49.25, Clue du Pérouré 0:50.33 (real values): a hard cut whose frame difference stays under the main gate (4 x median, 25) is
    still a candidate when the jump is an impulse (CUT_STRONG_IMPULSE) and the road-flow fit collapses at that one pair; the same pair with a fitting road
    flow is not, nor one whose neighbours lose their fit too (a flash, Gotthard 40:00)"""
    t, d, inl = _series()
    d[:] = 6.0; d[1000:] = 8.6
    d[600] = 24.8; inl[600] = 0           # 49.25: ratio 4.1, under the 25 floor
    d[1600] = 29.9; inl[1600] = 0         # 41.67: ratio 3.5, under 4 x median
    d[2200] = 24.8                        # same impulse, road flow fits: no candidate
    d[2600] = 20.0; d[2599] = 9.0; inl[2600] = 0   # impulse 2.2 only: no candidate
    d[2800] = 26.2; d[2797:2800] = 10.9; inl[2800] = 0   # Clue 50.33: ratio 2.6 (base 8.6 here: 3.0), impulse 2.4
    d[2400] = 25.0; inl[2400] = 0; inl[2401] = 30  # Gotthard 40:00: a neighbour keeps 30 of about 300 inliers (10 %): no candidate
    c = K.candidates(t, d, inl)
    assert [x["i"] for x in c] == [600, 1600, 2800] and all(x["vms"] and x["strong"] for x in c)
    assert [round(x["t"], 2) for x in K.decide(c)] == [12.0, 32.0, 56.0]


def test_the_strong_gate_leaves_bumps_and_flashes_alone():
    t, d, inl = _series()
    d[500:506] = 40; inl[500:506] = 0     # bump
    d[1000:1002] = 40; inl[1000:1002] = 0  # flash: two pairs
    assert K.candidates(t, d, inl) == []


def test_cut_pairs_close_together_are_one_cut():
    c = [dict(t=10.0, vms=True), dict(t=10.3, vms=True), dict(t=11.0, vms=True)]
    cu = K.decide(c)
    assert [(x["t"], x["n_pairs"]) for x in cu] == [(10.0, 2), (11.0, 1)]


# ------------------------------------------------------------------ plan
def _track(t0, t1, v=6.0):
    t = np.arange(t0, t1, 4.0 / v)
    return dict(t=t, s=(t - t0) * v, th=np.zeros(len(t)))


def test_plan_jumps_inserted_shots_and_the_start_rule():
    tr = [_track(1, 10), _track(15, 37), _track(41, 590), _track(601, 607), _track(611, 890), _track(901, 1200)]
    cuts = [dict(t=x) for x in (12.0, 39.0, 600.0, 610.0, 900.0)]
    out, info = K.plan(tr, cuts)
    assert info["intro_end"] == 39.0
    assert info["inserted"] == [dict(t0=600.0, t1=610.0)]
    assert info["dropped_tracks"] == 3                       # two intro tracks, the inserted shot
    assert [float(x["t"][0]) for x in out] == [41.0, 611.0, 901.0]
    assert [x.get("cut_before") for x in out] == [None, 610.0, 900.0]


def test_plan_without_cuts_or_without_early_cuts_changes_nothing():
    tr = [_track(1, 300), _track(301, 600)]
    out, info = K.plan(tr, [])
    assert out is tr and info["n_cuts"] == 0
    out, info = K.plan(tr, [dict(t=300.5)])
    assert info["intro_end"] is None and len(out) == 2 and out[0] is tr[0] and out[1]["cut_before"] == 300.5


def test_start_rule_never_removes_the_whole_route():
    tr = [_track(1, 50), _track(61, 110)]
    out, info = K.plan(tr, [dict(t=115.0)])
    assert len(out) == 2 and info["intro_end"] is None and info["intro_rule_skipped"]


def test_plan_splits_a_track_that_spans_a_cut():
    """the cut detector can confirm a cut that gating did not split at (strong-impulse gate): the track is split there, the piece before an intro cut
    is dropped and the piece after it starts the route (Cayolle: one track 31.5-1002 s across the cut at 49.25 s)"""
    tr = [_track(31.5, 1002.0)]
    out, info = K.plan(tr, [dict(t=31.37), dict(t=49.25)])
    assert info["intro_end"] == 49.25 and info["split_tracks"] == 1 and info["dropped_tracks"] == 1
    assert len(out) == 1 and float(out[0]["t"][0]) > 49.25 and float(out[0]["t"][-1]) == float(tr[0]["t"][-1])
    assert out[0]["s"][0] == 0.0 and out[0]["th"][0] == 0.0
    # a cut in the middle of the ride: two pieces, the second with cut_before
    out, info = K.plan([_track(200.0, 900.0)], [dict(t=500.0)])
    assert [float(x["t"][0]) < 500.0 for x in out] == [True, False] and [x.get("cut_before") for x in out] == [None, 500.0]
    assert float(out[0]["t"][-1]) <= 500.0 < float(out[1]["t"][0])


def test_a_user_intro_end_replaces_the_detected_one():
    """"Intro-Ende hier setzen" (app, --intro-end): the user's time is the intro end, before or after the detected one, also without any cut; a track
    across it is split there (Cayolle: detected 0:31, real 0:49)"""
    tr = [_track(31.5, 1002.0)]
    out, info = K.plan(tr, [dict(t=31.37)], intro_user=49.25)
    assert info["intro_end"] == 49.25 and info["intro_source"] == "user" and float(out[0]["t"][0]) > 49.25
    out, info = K.plan([_track(1, 30), _track(41, 600)], [dict(t=40.0)], intro_user=20.0)     # earlier than the detected cut: the cut stays a jump
    assert info["intro_end"] == 20.0 and [float(x["t"][0]) > 20.0 for x in out] == [True, True] and out[1]["cut_before"] == 40.0
    out, info = K.plan([_track(1, 600)], [], intro_user=50.0)                                # no cut at all
    assert info["intro_end"] == 50.0 and info["n_cuts"] == 0 and float(out[0]["t"][0]) > 50.0 and "cut_before" not in out[0]
    out, info = K.plan([_track(1, 600)], [dict(t=31.0)])
    assert info["intro_source"] == "cuts"


def test_the_gpx_skips_a_user_intro_without_cuts(tmp_path):
    import json
    (tmp_path / "rotation").mkdir()
    (tmp_path / "rotation" / "cuts.json").write_text(json.dumps(dict(cut_times=[], intro_end=50.0, intro_source="user")))
    c = steps_d.cut_plan(tmp_path)
    assert c == dict(times=[], intro_end=50.0, breaks=[], intro_source="user")
    assert [p["t"] for p in steps_d.apply_cut_plan([dict(t=t) for t in (49.0, 50.0, 51.0)], c)] == [51.0]


# ------------------------------------------------------------------ steps: the jump
def test_steps_without_cuts_are_make_steps_exactly():
    tr = [_track(0, 200), _track(203, 500)]
    a, b = T.steps_of(tr), seq.make_steps(tr, d0=C.D0)
    for f in ("t", "dth", "mu", "rel", "v", "gap", "seg"):
        np.testing.assert_array_equal(getattr(a, f), getattr(b, f))


SDS = [None, C.CUT_PRIOR_SD_SOFT_M]     # None = the shipped default (flat jump, maintainer 2026-11-13); the soft stay prior stays a tested option (DECISIONS A13)


@pytest.mark.parametrize("sd", SDS)
def test_a_cut_gap_is_a_run_of_flat_jump_substeps(sd):
    tr = [_track(0, 200), dict(_track(201, 500), cut_before=200.5)]
    st = T.steps_of(tr, prior_sd=sd)
    jump = st.mu == T.CUT_SUB_MU
    if sd is None and C.CUT_FREE_JUMP:
        assert st.jump is not None and st.jump.sum() == 1 and np.array_equal(jump, st.jump)
        assert np.all(st.gap[jump]) and np.all(np.isnan(st.dth[jump]))
    else:
        n = T.jump_substeps(C.D0)
        assert st.jump is None and n <= jump.sum() <= n + 1 and np.all(st.gap[jump]) and np.all(np.isnan(st.dth[jump]))
        want = C.CUT_PRIOR_SD_M if sd is None else sd
        assert st.rel[jump][0] * np.sqrt(jump.sum()) * T.CUT_SUB_MU == pytest.approx(want, rel=0.05) and st.mu[jump].sum() < 30
    (ta, tb, tc, v), = K.spans(st, tr)
    assert tc == pytest.approx(200.5) and v == pytest.approx(6.0, rel=0.1)
    assert ta < 200.0 and tb == pytest.approx(201.0)
    # the gap substeps of a normal gap keep their rel and have no jump flag
    st0 = T.steps_of([tr[0], _track(201, 500)])
    assert not np.any(st0.mu == T.CUT_SUB_MU) and st0.jump is None


def test_the_default_cut_jump_is_flat_and_the_soft_prior_is_the_option():
    assert C.CUT_PRIOR_SD_M >= 50 * C.CUT_JUMP_M and C.CUT_PRIOR_SD_SOFT_M == 400.0
    cost = lambda d, sd: d ** 2 / (2 * sd ** 2)
    assert cost(C.CUT_JUMP_M, C.CUT_PRIOR_SD_M) < 1e-3                     # flat: a start 1.5 km on costs nothing extra
    assert cost(C.CUT_JUMP_M, C.CUT_PRIOR_SD_SOFT_M) == pytest.approx(7.03, abs=0.01)   # soft: 7 nats


def _zigzag(n=24, seg=100.0, seed=5):
    rng = np.random.default_rng(seed)
    h = np.cumsum(rng.choice([-1, 1], n) * rng.uniform(0.4, 1.1, n))
    p = np.vstack([[0, 0], np.cumsum(seg * np.column_stack([np.cos(h), np.sin(h)]), axis=0)])
    return make_graph([[tuple(a), tuple(b)] for a, b in zip(p[:-1], p[1:])]), p


def _track_on(p, s0, s1, t0, v=8.0):
    d = np.hypot(*np.diff(p, axis=0).T)
    c = np.concatenate([[0], np.cumsum(d)])
    s = np.arange(s0, s1, 4.0)
    x = gaussian_filter1d(np.interp(s, c, p[:, 0]), 3); y = gaussian_filter1d(np.interp(s, c, p[:, 1]), 3)
    th = np.unwrap(np.arctan2(np.gradient(y), np.gradient(x)))
    return dict(t=t0 + (s - s0) / v, s=s - s0, th=th - th[0])


def test_the_decoder_jumps_across_a_cut_and_rides_through_without_one():
    g, p = _zigzag()
    c = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    A = _track_on(p, 0.0, 700.0, 0.0)
    B = _track_on(p, 1500.0, 2300.0, float(A["t"][-1]) + 0.6)
    G = grid.build(g, None, h=30.0)
    pre = dp.prepare(G, dp.Par())

    def err(tracks):
        st = T.steps_of(tracks)
        r = dp.viterbi(pre, st, backptr=True)
        xy = G.xy[r["cell_path"]]
        # arc position of every decoded cell on the zigzag (nearest of 1 m samples)
        ss = np.arange(0, c[-1], 1.0)
        q = np.column_stack([np.interp(ss, c, p[:, 0]), np.interp(ss, c, p[:, 1])])
        arc = ss[np.argmin(((xy[:, None, :] - q[None]) ** 2).sum(-1), axis=1)]
        e = []
        for X, s0 in ((A, 0.0), (B, 1500.0)):
            m = (~st.gap) & (st.t > X["t"][0] + 5) & (st.t <= X["t"][-1])
            e.append(float(np.median(np.abs(arc[m] - (s0 + (st.t[m] - X["t"][0]) * 8.0)))))
        return e

    assert max(err([A, dict(B, cut_before=float(A["t"][-1]) + 0.3)])) < 40.0     # both pieces in place
    assert max(err([A, B])) > 300.0                                                # ridden through: one piece is forced to the wrong place


# ------------------------------------------------------------------ smoother and GPX
def test_smoother_holds_the_position_up_to_a_cut_and_jumps_without_a_prior():
    nodes = np.arange(0.0, 21.0)
    dm = np.full(len(nodes), 8.0); dm[0] = 0
    dm[10:12] = 600.0                                         # the decoder's walk through a 1.2 km jump between t 9 and 11
    dg = np.zeros(len(nodes)); dg[10:12] = 600.0
    meas = [rts.Meas(float(t), 8.0 * t if t <= 9 else 8.0 * t + 300.0, 25.0, "posterior") for t in nodes if t != 10]
    meas.append(rts.Meas(10.0, 700.0, 25.0, "posterior"))      # inside the jump: dropped
    kept = steps_c.cut_process(nodes, dm, dg, meas, [(9.0, 11.0)], rts.FuseParams().gap_rel)
    assert len(kept) == len(meas) - 1 and dm[10] == dm[11] == 0.0
    xs = rts.fuse(nodes, dm, dg, kept, 0.0)["xs"][:, 0]
    assert abs(xs[9] - 72.0) < 5 and abs(xs[10] - xs[9]) < 1.0      # held up to the cut
    assert abs(xs[11] - 388.0) < 5 and abs(xs[20] - 460.0) < 5      # the jump is the measured one (300 m), not the walked 1200 m
    assert np.allclose(np.diff(xs[:10]), 8.0, atol=0.5)               # no smoothing of the riding before the cut
    # with the cut time and the speed: riding goes on up to the cut (t 10), then the hold and the jump
    dm2 = np.full(len(nodes), 8.0); dm2[0] = 0; dm2[10:12] = 600.0
    dg2 = np.zeros(len(nodes)); dg2[10:12] = 600.0
    kept = steps_c.cut_process(nodes, dm2, dg2, [m for m in meas if m.t != 10.0], [(9.0, 11.0, 10.0, 4.0)], rts.FuseParams().gap_rel, kappa=2.0)
    assert dm2[10] == 8.0 and dm2[11] == 0.0
    xs = rts.fuse(nodes, dm2, dg2, kept, 0.0)["xs"][:, 0]
    assert abs(xs[10] - xs[9] - 8.0) < 1.0 and abs(xs[11] - 388.0) < 5


def _pts(n=10):
    return [dict(t=float(t), lat=45.0 + t * 1e-5, lon=5.0, confidence=0.9, in_gap=False, extrapolated=False) for t in range(n)]


def _meta(**kw):
    return dict(name="v", rule="r", verdict="confident", basis="b", offset_m=1.5, side="right", vehicle="bike", **kw)


def test_gpx_without_cuts_has_one_segment_and_no_cut_metadata(tmp_path):
    f = tmp_path / "a.gpx"
    steps_d.write_gpx(f, _pts(), steps_d.parse_time(None), _meta())
    x = f.read_text()
    assert x.count("<trkseg>") == 1 and "rsm:cuts" not in x
    steps_d.write_gpx(tmp_path / "b.gpx", _pts(), steps_d.parse_time(None), _meta(cuts=None))
    assert (tmp_path / "b.gpx").read_text() == x


def test_gpx_splits_at_cuts_and_skips_the_intro(tmp_path):
    cp = dict(times=[2.5, 6.2], intro_end=2.5, breaks=[6.5])
    pts = steps_d.apply_cut_plan(_pts(), cp)
    assert [p["t"] for p in pts] == [3, 4, 5, 6, 7, 8, 9]
    f = tmp_path / "c.gpx"
    steps_d.write_gpx(f, pts, steps_d.parse_time(None), _meta(cuts=cp))
    x = f.read_text()
    assert x.count("<trkseg>") == 2 and '<rsm:cuts n="2" intro_skipped_s="2.50">2.50 6.20</rsm:cuts>' in x
    import xml.etree.ElementTree as ET
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    segs = ET.parse(f).getroot().findall(".//g:trkseg", ns)
    assert [len(s.findall("g:trkpt", ns)) for s in segs] == [4, 3]
    assert steps_d.apply_cut_plan(_pts(), dict(times=[300.0], intro_end=None, breaks=[])) == _pts()


def test_cut_constants_are_set():
    assert C.CUT_ON and C.CUT_INTRO_S == 120.0 and C.CUT_MIN_PIECE_S > 10.0 and T.jump_substeps(30.0) == 25
    assert K.mmss(38.67) == "0:39" and K.mmss(615.3) == "10:15"


@pytest.mark.parametrize("sd", SDS)
def test_the_jump_prefers_the_end_of_the_previous_piece_but_can_move_on(sd):
    """a heading-free (straight) road: the next piece starts where the last ended (prior); a strongly curved piece far away still pulls the decoder there"""
    g, p = _zigzag(n=40, seg=120.0, seed=11)
    G = grid.build(g, None, h=30.0)
    pre = dp.prepare(G, dp.Par())
    c = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    A = _track_on(p, 0.0, 600.0, 0.0)
    B_far = _track_on(p, 1400.0, 2200.0, float(A["t"][-1]) + 0.6)
    st = T.steps_of([A, dict(B_far, cut_before=float(A["t"][-1]) + 0.3)], prior_sd=sd)
    r = dp.viterbi(pre, st, backptr=True)
    jump = st.mu == T.CUT_SUB_MU
    cost = lambda d: d ** 2 / (2 * (C.CUT_PRIOR_SD_M if sd is None else sd) ** 2)
    assert cost(1500.0) < 10 and cost(0.0) == 0.0 and np.isfinite(r["score"])
    ss = np.arange(0, c[-1], 1.0)
    q = np.column_stack([np.interp(ss, c, p[:, 0]), np.interp(ss, c, p[:, 1])])
    arc = ss[np.argmin(((G.xy[r["cell_path"]][:, None, :] - q[None]) ** 2).sum(-1), axis=1)]
    m = (~st.gap) & (st.t > B_far["t"][0] + 5)
    assert np.median(np.abs(arc[m] - (1400.0 + (st.t[m] - B_far["t"][0]) * 8.0))) < 40.0     # 800 m on: the prior did not force the same place


# ------------------------------------------------------------------ same-scene veto (sun flash / exposure jump is no cut)
def _flash(f: np.ndarray, gain: float, lift: float, shift: int = 2) -> np.ndarray:
    """the same scene a frame later (moved by `shift` px), washed out by a flash: contrast x gain, plus a bright haze"""
    g = np.roll(f.astype(float), shift, axis=1) * gain + lift
    yy, xx = np.mgrid[:f.shape[0], :f.shape[1]]
    g += 60.0 * np.exp(-((yy - 20.0) ** 2 + (xx - f.shape[1] * 0.6) ** 2) / (2 * 120.0 ** 2))      # sun glare blob near the top
    return np.clip(g, 0, 255).astype(np.uint8)


def test_a_flash_keeps_the_scene_and_a_cut_does_not():
    a = _texture(1, 128)[20:290, 20:500].astype(np.uint8)
    other = _texture(2, 128)[20:290, 20:500].astype(np.uint8)
    same = K.same_scene(a, _flash(a, 0.55, 90.0))
    cut = K.same_scene(a, other)
    assert same["share"] >= 2 * C.CUT_SAME_SHARE, same
    assert cut["share"] < C.CUT_SAME_SHARE / 2, cut


def test_the_veto_is_off_without_decoding(monkeypatch):
    monkeypatch.setattr(C, "CUT_SAME_ON", False)
    cuts = [dict(t=5.0, t_first=5.0, t_last=5.0, n_pairs=1, cues=["diff", "vms"])]
    assert K.veto_same_scene("/nonexistent.mp4", cuts) == (cuts, [])


def test_undecodable_frames_keep_the_cut(monkeypatch):
    monkeypatch.setattr(K, "grey_frames", lambda *a, **k: (np.zeros((0, 270, 480), np.uint8), 50.0))
    cuts = [dict(t=5.0, t_first=5.0, t_last=5.0, n_pairs=1, cues=["diff", "vms"])]
    kept, rej = K.veto_same_scene("/x.mp4", cuts)
    assert [c["t"] for c in kept] == [5.0] and rej == [] and kept[0]["same"] is None


def test_cut_same_constants_are_set():
    assert C.CUT_SAME_ON and 0.1 <= C.CUT_SAME_SHARE <= 0.3 and C.CUT_SAME_WIN_S > 0.04


# ------------------------------------------------------------------ cuts4: multi-type transitions (low-inlier hard, dissolve, fade, negatives)
def _color_scene(seed: int, h: int = 135, w: int = 240, pad: int = 180) -> np.ndarray:
    """Richly textured 3-channel synthetic BGR canvas with distinct spatial color regions and fine texture."""
    rng = np.random.default_rng(seed)
    H, W = h + pad, w + pad
    base = np.zeros((H, W, 3), np.float32)
    for ch in range(3):
        coarse = gaussian_filter(rng.normal(0, 1, (H, W)), 18.0)
        fine = gaussian_filter(rng.normal(0, 1, (H, W)), 2.2)
        mean = float(rng.uniform(75, 175))
        base[:, :, ch] = np.clip(mean + 42.0 * coarse / (coarse.std() + 1e-6) + 32.0 * fine / (fine.std() + 1e-6), 0, 255)
    return base.astype(np.uint8)


def test_transition_candidates_catch_low_inlier_hard_cuts_dissolves_and_blackouts():
    t = np.arange(3000) * 0.033
    d = np.full(3000, 14.0)
    inl = np.full(3000, 31.0)                 # busy rocky descent like Sa Calobra 2:45 (below CUT_STRONG_AROUND=100)
    d[1500] = 42.9; inl[1500] = 0.0           # low-inlier hard cut
    # road blackout (1.0 s fade)
    inl[2400:2435] = 0.0
    # far-feature windows (0.26 s step)
    ta = np.arange(0.0, 99.0, 0.26); tb = ta + 0.26
    m = len(ta)
    ok = np.ones((m, 3), bool)
    n_pts = np.full((m, 3), 220.0)
    n_inl = np.full((m, 3), 160.0)
    # 1.2 s dissolve: n_pts collapses around t=20 s
    w_diss = int(round(20.0 / 0.26))
    n_pts[w_diss - 1:w_diss + 2] = 0.0; n_inl[w_diss - 1:w_diss + 2] = 0.0; ok[w_diss - 1:w_diss + 2] = False
    # 2.5 s slow dissolve: n_pts stays 70 (>25% of 220) while ~ok and n_inl collapses to 6 around t=35 s
    w_slow = int(round(35.0 / 0.26))
    n_pts[w_slow - 2:w_slow + 3] = 70.0; n_inl[w_slow - 2:w_slow + 3] = 6.0; ok[w_slow - 2:w_slow + 3] = False

    cands = K.transition_candidates(t, d, inl, ta, tb, ok, n_pts, n_inl)
    ts_found = [c["t"] for c in cands]
    assert any(abs(x - t[1500]) < 0.2 and c["hint"] == "hard" for x, c in zip(ts_found, cands)), cands
    assert any(abs(x - 20.0) < 0.6 for x in ts_found), cands
    assert any(abs(x - 35.0) < 0.8 for x in ts_found), cands
    assert any(abs(x - 0.5 * (t[2400] + t[2434])) < 0.6 for x in ts_found), cands


def test_verify_hard_frames_detects_real_cut_and_rejects_flash_and_occlusion():
    a = _texture(11, 128, h=135, w=240)
    b = _texture(22, 110, h=135, w=240)
    fps = 30.0
    n = 48
    # 1. Real hard cut at frame 24 (t = 10.0 + 24/30 = 10.80)
    F_cut = np.array([a[20:155, i // 2:240 + i // 2] if i < 24 else b[20:155, (i - 24) // 2:240 + (i - 24) // 2] for i in range(n)], np.uint8)
    hit = K.verify_hard_frames(F_cut, fps, t0=10.0, tc=10.8)
    assert hit is not None and hit["kind"] == "hard" and abs(hit["t"] - (10.0 + 23.5 / fps)) < 0.05

    # 2. Sun flash on same scene: brightness/contrast jump at frame 24, same underlying scene -> rejected
    F_flash = np.array([a[20:155, i // 2:240 + i // 2] for i in range(n)], np.uint8)
    F_flash[24:] = np.clip(F_flash[24:].astype(float) * 0.55 + 90.0, 0, 255).astype(np.uint8)
    assert K.verify_hard_frames(F_flash, fps, t0=10.0, tc=10.8) is None

    # 3. Brief foreground occlusion (dark object covers frame for 4 frames, then same scene returns) -> rejected by wide bracket
    F_occ = np.array([a[20:155, i // 2:240 + i // 2] for i in range(n)], np.uint8)
    F_occ[24:28] = 10
    assert K.verify_hard_frames(F_occ, fps, t0=10.0, tc=10.8) is None


@pytest.mark.parametrize("dur", [0.4, 1.2, 2.5])
def test_verify_transition_frames_detects_moving_dissolves(dur):
    sa, sb = _color_scene(101), _color_scene(202)
    fps = 5.0
    n = 25
    ts = 100.0 + np.arange(n) / fps
    tc = ts[n // 2]
    # Gentle forward-camera drift (~0.3 px/step) during the crossfade
    A = np.array([sa[60:195, 40 + i // 3:280 + i // 3] for i in range(n)], np.float32)
    B = np.array([sb[60:195, 40 + i // 3:280 + i // 3] for i in range(n)], np.float32)
    al = np.clip((ts - (tc - dur / 2.0)) / dur, 0.0, 1.0)
    mix = ((1.0 - al[:, None, None, None]) * A + al[:, None, None, None] * B).astype(np.uint8)
    hit = K.verify_transition_frames(mix, ts, tc)
    assert hit is not None and hit["kind"] == "dissolve", (dur, hit)
    assert abs(hit["t"] - tc) <= 0.35 and hit["t_first"] < hit["t"] < hit["t_last"]


@pytest.mark.parametrize("level", [0.0, 255.0])
def test_verify_transition_frames_detects_fade_through_black_and_dip_to_white(level):
    sa, sb = _color_scene(303), _color_scene(404)
    fps = 5.0
    n = 25
    ts = 50.0 + np.arange(n) / fps
    tc = ts[12]
    frames = []
    for i in range(n):
        if i <= 8:
            frames.append(sa[60:195, 40 + i:280 + i])
        elif i < 12:
            w = (i - 8) / 4.0
            frames.append(((1 - w) * sa[60:195, 40 + i:280 + i] + w * level).astype(np.uint8))
        elif i == 12:
            frames.append(np.full((135, 240, 3), int(level), np.uint8))
        elif i < 16:
            w = (i - 12) / 4.0
            frames.append(((1 - w) * level + w * sb[60:195, 40 + i:280 + i]).astype(np.uint8))
        else:
            frames.append(sb[60:195, 40 + i:280 + i])
    hit = K.verify_transition_frames(np.array(frames, np.uint8), ts, tc)
    assert hit is not None and hit["kind"] == "fade" and abs(hit["t"] - tc) <= 0.25


def test_verify_transition_frames_rejects_pan_tunnel_blur_pulse_and_sweeping_shadow():
    import cv2
    sc = _color_scene(505, h=135, w=240, pad=360)
    fps = 5.0
    n = 25
    ts = 200.0 + np.arange(n) / fps
    tc = ts[12]

    # 1. Fast continuous horizontal pan (hairpin turn): 14 px per 0.2 s step
    pan = np.array([sc[60:195, i * 14:240 + i * 14] for i in range(n)], np.uint8)
    assert K.verify_transition_frames(pan, ts, tc) is None

    # 2. Entering a dark tunnel (one-way dimming to pitch dark, stays dark)
    base = np.array([sc[60:195, 40 + i:280 + i] for i in range(n)], np.float32)
    gain = np.clip(1.0 - (ts - (tc - 0.6)) / 1.2, 0.03, 1.0)
    tunnel = (base * gain[:, None, None, None]).astype(np.uint8)
    assert K.verify_transition_frames(tunnel, ts, tc) is None

    # 3. Focus blur-and-refocus pulse on the SAME scene (like Amalfi 55:19)
    still = sc[60:195, 80:320]
    blur_seq = []
    for i in range(n):
        dist = abs(i - 12)
        if dist <= 3:
            k = 2 * (4 - dist) * 4 + 1
            blur_seq.append(cv2.GaussianBlur(still, (k, k), 0))
        else:
            blur_seq.append(still.copy())
    assert K.verify_transition_frames(np.array(blur_seq, np.uint8), ts, tc) is None

    # 4. Sweeping shadow / bridge overhead (dark curtain moving top-to-bottom across the same road)
    sa = sc[60:195, 80:320].astype(np.float32)
    sweep = []
    for i in range(n):
        row_cut = int(np.clip((i - 8) / 8.0, 0.0, 1.0) * 135)
        f = sa.copy()
        f[:row_cut] *= 0.25
        sweep.append(f.astype(np.uint8))
    assert K.verify_transition_frames(np.array(sweep, np.uint8), ts, tc) is None


def test_plan_excises_samples_inside_multi_frame_dissolve_span():
    tr = [_track(200.0, 900.0)]
    out, info = K.plan(tr, [dict(t=500.0, t_first=498.5, t_last=501.5, kind="dissolve")])
    assert info["split_tracks"] == 1 and len(out) == 2
    assert float(out[0]["t"][-1]) <= 498.5
    assert float(out[1]["t"][0]) >= 501.5 and out[1]["cut_before"] == 500.0
    assert out[1]["s"][0] == 0.0 and out[1]["th"][0] == 0.0


def test_free_cut_jump_handles_arbitrary_distance_and_matches_numpy_and_native(monkeypatch):
    from rsm.hmm_cal import _native
    from rsm.refine import post as P
    g, p = _zigzag(n=65, seg=100.0, seed=11)
    c = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    A = _track_on(p, 0.0, 900.0, 0.0)
    B = _track_on(p, 5200.0, 6200.0, float(A["t"][-1]) + 1.0)
    tracks = [A, dict(B, cut_before=float(A["t"][-1]) + 0.5)]
    G = grid.build(g, None, h=30.0)
    par = dp.Par()
    pre = dp.prepare(G, par)
    st = T.steps_of(tracks)
    assert st.jump is not None and int(st.jump.sum()) == 1

    def arc_err(cell_path):
        xy = G.xy[cell_path]
        ss = np.arange(0, c[-1], 1.0)
        q = np.column_stack([np.interp(ss, c, p[:, 0]), np.interp(ss, c, p[:, 1])])
        arc = ss[np.argmin(((xy[:, None, :] - q[None]) ** 2).sum(-1), axis=1)]
        out = []
        for X, s0 in ((A, 0.0), (B, 5200.0)):
            m = (~st.gap) & (st.t > X["t"][0] + 5) & (st.t <= X["t"][-1])
            out.append(float(np.median(np.abs(arc[m] - (s0 + (st.t[m] - X["t"][0]) * 8.0)))))
        return out

    # Native C path (when available) + NumPy path must agree identically and place both pieces across the 4.3 km jump
    r_nat = dp.viterbi(pre, st, backptr=True)
    sc_nat = dp.viterbi_scan(G, par, st, [par.a_ang, par.a_ang * 1.1])
    fb_nat = dp.forward_backward(pre, st, r_nat["cell_path"])
    assert max(arc_err(r_nat["cell_path"])) < 40.0
    if sc_nat is not None:
        assert sc_nat[0] == pytest.approx(r_nat["score"], abs=1e-3)
    assert float(np.nanmean(fb_nat["p_vit"])) > 0.7

    monkeypatch.setattr(_native, "available", lambda: False)
    r_np = dp.viterbi(pre, st, backptr=True)
    fb_np = dp.forward_backward(pre, st, r_np["cell_path"])
    assert r_np["score"] == pytest.approx(r_nat["score"], abs=1e-3)
    np.testing.assert_array_equal(r_np["cell_path"], r_nat["cell_path"])
    if sc_nat is not None:
        r_np2 = dp.viterbi(dp.prepare(G, dp.Par(a_ang=par.a_ang * 1.1)), st, backptr=False)
        assert sc_nat[1] == pytest.approx(r_np2["score"], abs=1e-3)
    np.testing.assert_allclose(fb_np["p_vit"], fb_nat["p_vit"], atol=1e-4)

    # refine.post.forward_backward_cb handles st.jump without crashing or losing mass
    seen = []
    P.forward_backward_cb(dp, pre, st, lambda j, p_: seen.append((j, float(p_.sum()))))
    assert len(seen) == st.T and all(abs(s - 1.0) < 1e-2 for _, s in seen)

    # Legacy fixed-budget walk cannot reach across 4.3 km (> CUT_JUMP_M = 1500 m)
    st_leg = T.steps_of(tracks, prior_sd=C.CUT_PRIOR_SD_SOFT_M)
    assert st_leg.jump is None
    r_leg = dp.viterbi(pre, st_leg, backptr=True)
    # Use st_leg's own non-gap mask
    xy_l = G.xy[r_leg["cell_path"]]
    ss = np.arange(0, c[-1], 1.0)
    q = np.column_stack([np.interp(ss, c, p[:, 0]), np.interp(ss, c, p[:, 1])])
    arc_l = ss[np.argmin(((xy_l[:, None, :] - q[None]) ** 2).sum(-1), axis=1)]
    err_leg = []
    for X, s0 in ((A, 0.0), (B, 5200.0)):
        m = (~st_leg.gap) & (st_leg.t > X["t"][0] + 5) & (st_leg.t <= X["t"][-1])
        err_leg.append(float(np.median(np.abs(arc_l[m] - (s0 + (st_leg.t[m] - X["t"][0]) * 8.0)))))
    assert max(err_leg) > 1000.0


def test_disconnected_path_after_free_jump_breaks_cleanly_through_pathctx_offset_and_align():
    from rsm.pipeline import align as AL, offset as OF
    from rsm.refine import pathctx
    # Two disconnected straight roads 8 km apart
    segs = [((0.0, 0.0), (100.0, 0.0)), ((100.0, 0.0), (200.0, 0.0)),
            ((8000.0, 500.0), (8100.0, 500.0)), ((8100.0, 500.0), (8200.0, 500.0))]
    g = make_graph(segs)
    # Find forward edges along piece 0 and piece 1
    def edge_from(x0, x1):
        for e in range(g.n_edges):
            gm = g.geom(e)
            if abs(gm[0, 0] - x0) < 1 and abs(gm[-1, 0] - x1) < 1:
                return e
        raise AssertionError((x0, x1))

    e0, e1 = edge_from(0.0, 100.0), edge_from(100.0, 200.0)
    e2, e3 = edge_from(8000.0, 8100.0), edge_from(8100.0, 8200.0)
    path, s_steps = pathctx.build_path(g, np.array([e0, e1, e2, e3]), np.array([20.0, 50.0, 30.0, 70.0]))
    assert len(path.breaks) == 1 and path.breaks[0] == pytest.approx(200.0, abs=1.0)
    assert path.start[-1] == pytest.approx(path.sg[-1], abs=1.0)
    assert s_steps[0] < s_steps[1] < path.breaks[0] < s_steps[2] < s_steps[3]
    # Within each piece consecutive samples are 1 m apart; only the break jumps ~8 km
    ds = np.hypot(*np.diff(path.xy, axis=0).T)
    jumps = np.flatnonzero(ds > 5.0)
    assert len(jumps) == 1 and ds[jumps[0]] > 7000.0
    # offset & align stay clean across the 8 km seam
    dl, _, _ = OF.driving_line(path.xy, delta_m=1.6, step=1.0)
    assert not OF.has_loops(dl, path.xy)
    assert np.all(np.isfinite(dl)) and dl.shape == path.xy.shape
    assert np.allclose(dl[:180, 1], -1.6, atol=0.1) and np.allclose(dl[220:, 1], 498.4, atol=0.1)
    phi = AL.path_heading(path.xy, smooth_m=8.0)
    assert np.all(np.isfinite(phi)) and np.allclose(phi, 0.0, atol=1e-2)


def test_scan_kappa_excludes_free_jumps_from_log_kappa_scale():
    from rsm.pipeline import steps_b
    g, p = _zigzag(n=30, seg=100.0, seed=7)
    A = _track_on(p, 0.0, 600.0, 0.0)
    B = _track_on(p, 1800.0, 2500.0, float(A["t"][-1]) + 1.0)
    st = T.steps_of([A, dict(B, cut_before=float(A["t"][-1]) + 0.5)])
    assert st.jump is not None and int(st.jump.sum()) == 1
    k = 1.4
    G = grid.build(g, None, h=30.0 * k)
    pre = dp.prepare(G, dp.Par(kappa=k))
    f = C.F_REF
    sc = steps_b.scan_kappa(pre, st, k, [f], lambda: None)
    raw = dp.viterbi(pre, st, backptr=False)["score"]
    n_trans = st.T - 1 - int(st.jump.sum())
    assert sc[0] == pytest.approx(raw + n_trans * np.log(k), abs=1e-4)


def test_odofail_shape_steps_and_islands_slice_preserve_jump_alignment():
    from rsm.pipeline import islands as ISL, odofail as OF
    # Track 0 -> odometry-failure gap (100..130s) -> Track 1 -> scene cut (250.5s) -> Track 2
    tr = [_track(0.0, 100.0), _track(130.0, 250.0), dict(_track(251.0, 400.0), cut_before=250.5)]
    st = T.steps_of(tr)
    assert st.jump is not None and int(st.jump.sum()) == 1
    t_jump = float(st.t[st.jump][0])
    # Expand the odometry-failure gap before the cut so st.T grows and shifts the jump index
    st2 = OF.shape_steps(st, spans=[(100.0, 130.0)], d0=C.D0)
    assert st2.T > st.T and st2.jump is not None and len(st2.jump) == st2.T
    assert int(st2.jump.sum()) == 1 and float(st2.t[st2.jump][0]) == pytest.approx(t_jump)
    # Slice containing the cut keeps jump aligned; slice starting AT the cut clears jump[0]
    j_idx = int(np.flatnonzero(st2.jump)[0])
    sl_with = ISL.slice_steps(st2, j_idx - 3, j_idx + 3)
    assert sl_with.jump is not None and len(sl_with.jump) == sl_with.T and int(np.flatnonzero(sl_with.jump)[0]) == 3
    sl_at = ISL.slice_steps(st2, j_idx, j_idx + 3)
    assert sl_at.jump is None
