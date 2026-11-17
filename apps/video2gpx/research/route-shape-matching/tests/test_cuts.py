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
    n = T.jump_substeps(C.D0)
    jump = st.mu == T.CUT_SUB_MU
    assert n <= jump.sum() <= n + 1 and np.all(st.gap[jump]) and np.all(np.isnan(st.dth[jump]))
    (ta, tb, tc, v), = K.spans(st, tr)
    assert tc == pytest.approx(200.5) and v == pytest.approx(6.0, rel=0.1)
    assert ta < 200.0 and tb == pytest.approx(201.0)
    # the gap substeps of a normal gap keep their rel
    st0 = T.steps_of([tr[0], _track(201, 500)])
    assert not np.any(st0.mu == T.CUT_SUB_MU)
    # distance prior: total sd of the walk through the jump = the chosen sd, sub-steps carry ~0 nominal distance
    want = C.CUT_PRIOR_SD_M if sd is None else sd
    assert st.rel[jump][0] * np.sqrt(jump.sum()) * T.CUT_SUB_MU == pytest.approx(want, rel=0.05) and st.mu[jump].sum() < 30


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


# ------------------------------------------------------------------ real video (skipped when absent)
import os  # noqa: E402
from pathlib import Path  # noqa: E402

VIDEOS = Path(os.path.expanduser(os.environ.get("RSM_VIDEOS", "~/rsm-data/videos")))
GOTTHARD = VIDEOS / "gotthard.mp4"
CLUE = VIDEOS / "clue.mp4"
CAYOLLE = VIDEOS / "cayolle-1080p.mp4"


def _detect(video: Path, start: float, dur: float, tmp_path) -> tuple[list, list, list]:
    """the cut detection of the pipeline (vms pairs -> candidates -> decide -> same-scene veto) on one stretch of a real video; the far-feature cue
    is not computed (it can only add cuts, so a stretch that must have no cut is tested harder) -> (candidates, cuts, rejected), times in video seconds"""
    from rsm.odometry.vms_csv import load_pairs
    csv = tmp_path / "m.csv"
    vm.analyse(str(video), str(csv), height=C.VMS["height"], step=C.VMS["step"], start=start, duration=dur, progress=False)
    p = load_pairs(str(csv))
    t = p.time + (start if p.time[0] < start - 1 else 0.0)
    cands = K.candidates(t, p.diff, p.inliers)
    kept, rej = K.veto_same_scene(str(video), K.decide(cands))
    return cands, kept, rej


@pytest.mark.realdata
def test_gotthard_sun_flashes_3m00_3m20_are_no_cut(tmp_path):
    """Gotthard HDR 3:00-3:20, Andermatt old town: the sun flashes at 3:12 (and 3:14) spike the frame difference and break the road-flow fit, but the street
    stays (same roadwork sign and flag before and after). A cut there let the route jump onto the bypass (docs/GOTTHARD_DIAGNOSIS.md section 8)."""
    if not GOTTHARD.exists():
        pytest.skip(f"{GOTTHARD} missing")
    cands, kept, rej = _detect(GOTTHARD, 180.0, 20.0, tmp_path)
    assert any(191.5 < c["t"] < 193.0 for c in cands), cands          # the flash is a candidate: the veto is what decides
    assert kept == [], kept
    assert rej and all(r["same"]["share"] >= C.CUT_SAME_SHARE for r in rej)


@pytest.mark.realdata
def test_gotthard_intro_cut_at_0m20_stays_a_cut(tmp_path):
    """the counter-case on the same video: the cut from the Google Earth intro to the car park at 0:20 is a real cut and must survive the veto"""
    if not GOTTHARD.exists():
        pytest.skip(f"{GOTTHARD} missing")
    _, kept, _ = _detect(GOTTHARD, 10.0, 20.0, tmp_path)
    assert any(19.5 < c["t"] < 20.5 for c in kept), kept


@pytest.mark.realdata
def test_cayolle_intro_cut_at_0m49_is_a_cut(tmp_path):
    """Cayolle HDR 0:49.25: the hard cut from the last teaser shot (larch forest track) to the ride start in the village of Guillaumes. The road-flow fit
    keeps 0 inliers and the jump is an impulse (about 4x the pairs around it), but the frame difference (about 24.8) stayed under CUT_MIN_DIFF 25, so it was
    no candidate and the intro ended at the earlier cut at 0:31 (2026-11-16 run). It must be detected and survive the veto."""
    if not CAYOLLE.exists():
        pytest.skip(f"{CAYOLLE} missing")
    _, kept, _ = _detect(CAYOLLE, 44.0, 12.0, tmp_path)
    assert any(49.0 < c["t"] < 49.5 for c in kept), kept


@pytest.mark.realdata
def test_clue_du_peroure_intro_cut_at_0m50_is_a_cut(tmp_path):
    """Clue du Pérouré HDR 0:50.33: the hard cut from a narrow road along a stream to an open valley road with a car ahead (the ride start). The shot
    before it is busy (stream, branches): the frame difference is 26.2 against a median of 10.0 (ratio 2.6, impulse 2.4), under both the main gate and the
    first strong-impulse gate; the clear signal is the road-flow fit falling from about 238 inliers to 0 at exactly one pair. The intro ended at the cut at
    0:12 (2026-11-16 run). It must be detected and survive the veto."""
    if not CLUE.exists():
        pytest.skip(f"{CLUE} missing")
    _, kept, _ = _detect(CLUE, 45.0, 11.0, tmp_path)
    assert any(50.1 < c["t"] < 50.6 for c in kept), kept
