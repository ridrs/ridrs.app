# SPDX-License-Identifier: AGPL-3.0-or-later
"""The motion step as interpretation (vmsx.interpret, docs/CONCEPT_extraction.md phase 2): horizon calibration, noise, running horizon, road
fits, traffic candidates and pick from the stored points of `extract/`, without the video; motion.csv keeps its format."""
import csv
import json
import os

import numpy as np
import pytest

from rsm.pipeline.vmsx import extract as EX, interpret as VI, motion as vm
from tests.test_insight import _encode, _world

N_FRAMES = 400                                 # 13.3 s at 30 fps
FPS = 30.0
CAL = {"horizon": 150.0, "iqr": 0.0, "frames": 0, "height": 360, "horizon_free": 140.0, "iqr_free": 0.0, "frames_free": 0,
       "track": {"t": [], "row": []}}                # no track: every pair at the calibrated row, in both the video pass and the interpretation


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    os.environ["RSM_HWACCEL"] = "0"
    p = tmp_path_factory.mktemp("vi") / "road.mp4"
    _encode(p, _world(N_FRAMES))
    return p


@pytest.fixture(scope="module")
def ex(video, tmp_path_factory):
    d = tmp_path_factory.mktemp("vi_ex") / "extract"
    EX.extract(str(video), d, workers=1, hwaccel=False)
    return d


@pytest.fixture(scope="module")
def straight(tmp_path_factory):
    """the synthetic road without turning: its focus of expansion lies on the horizon row 150 (a constant yaw rate moves it off the horizon,
    for the video pass of today too: 92 rows on the turning road)"""
    p = tmp_path_factory.mktemp("vi_st") / "straight.mp4"
    _encode(p, _world(N_FRAMES, yaw_rate=0.0))
    d = p.parent / "extract"
    EX.extract(str(p), d, workers=1, hwaccel=False)
    return d


@pytest.fixture(scope="module")
def interpreted(ex, tmp_path_factory):
    out = tmp_path_factory.mktemp("vi_out") / "motion.csv"
    st = VI.analyse(ex, str(out), calibration=dict(CAL))
    return out, st


def _rows(p):
    with open(p, newline="") as fh:
        rd = csv.reader(fh)
        return next(rd), list(rd)


# ------------------------------------------------------------------ the csv of today
def test_one_row_per_stored_pair_in_the_columns_of_today(ex, interpreted):
    out, st = interpreted
    head, rows = _rows(out)
    z = EX.load(ex)
    assert head == vm.COLUMNS
    assert [int(r[0]) for r in rows] == list(z["idx"]) and st["pairs"] == len(rows) == N_FRAMES - 1
    assert [float(r[1]) for r in rows] == pytest.approx([(j - 0.5) / FPS for j in z["idx"]], abs=1e-4)
    assert [float(r[11]) for r in rows] == pytest.approx(list(z["diff"]), abs=1e-3)


def test_the_stats_carry_what_the_later_steps_read(interpreted):
    _, st = interpreted
    assert {"video", "height", "width", "step", "fps", "start", "duration", "horizon", "horizon_vms", "destatic_tau", "road_width", "horizon_calibration",
            "roi", "alt_thr", "track_t0", "pairs", "traffic", "seconds", "calibration_seconds", "seconds_per_video_hour", "extract", "interpret"} <= set(st)
    assert st["horizon"] == CAL["horizon_free"] and st["horizon_vms"] == CAL["horizon"]
    assert st["duration"] == pytest.approx(N_FRAMES / FPS, abs=0.05) and st["fps"] == FPS
    assert st["interpret"] == VI.params()
    json.dumps(st)


def test_the_speed_follows_todays_analysis_of_the_video(video, interpreted, tmp_path):
    out, _ = interpreted
    vm.analyse(str(video), str(tmp_path / "m.csv"), hwaccel=False, progress=False, calibration=dict(CAL))
    ref = np.genfromtxt(tmp_path / "m.csv", delimiter=",", names=True)["s"]
    got = np.genfromtxt(out, delimiter=",", names=True)["s"]
    ok = np.isfinite(got) & np.isfinite(ref)
    assert ok.mean() > 0.95
    assert np.median(got[ok] / ref[ok]) == pytest.approx(1.0, abs=0.03)
    assert np.corrcoef(got[ok], ref[ok])[0, 1] > 0.9


# ------------------------------------------------------------------ calibration from the stored points
def test_the_horizon_is_calibrated_from_the_stored_points(straight):
    """the synthetic road's horizon is row 150 (tests.test_insight._world)"""
    cal = VI.calibrate_horizon(VI.Points(straight))
    assert cal["horizon"] == pytest.approx(150.0, abs=2.0) and cal["frames"] >= 20
    assert np.isfinite(cal["horizon_free"]) and cal["frames_free"] >= 20 and cal["height"] == 360


def test_the_noise_is_the_median_rms_of_the_plain_road_fits(ex):
    n = VI.calibrate_noise(VI.Points(ex), 150.0, 166, 349)
    assert n["rms_pairs"] > 100 and 0.0 < n["rms_median"] < 0.6


def test_the_running_track_lies_on_the_grid_of_today(straight):
    tr = VI.horizon_track(VI.Points(straight), 150.0)
    assert len(tr["t"]) == len(tr["row"]) >= 2
    k = (np.array(tr["t"]) - vm.HZ_WINDOW / 2) / vm.HZ_EVERY
    assert np.allclose(k, np.round(k)) and np.all(np.abs(np.array(tr["row"]) - 150.0) < 3.0)


def test_without_a_calibration_the_interpretation_calibrates_itself(straight, tmp_path):
    st = VI.analyse(straight, str(tmp_path / "m.csv"))
    cal = st["horizon_calibration"]
    assert cal["horizon"] == pytest.approx(150.0, abs=2.0) and {"rms_median", "rms_pairs", "track"} <= set(cal)
    assert st["horizon_vms"] == cal["horizon"] and st["horizon"] == cal["horizon_free"] and st["track_t0"] == 0.0


def test_a_given_calibration_is_used_as_is_and_the_track_in_source_seconds(ex, tmp_path):
    """a clip (P["calibration"], P["frame0"]): the stage's calibration with its track, read at t + frame0 / fps"""
    t = np.arange(vm.HZ_WINDOW / 2, 400.0, vm.HZ_EVERY)
    cal = dict(CAL, rms_median=0.4, rms_pairs=500, track=dict(t=[float(x) for x in t], row=[140.0 if x < 200 else 180.0 for x in t]))
    seen = []
    real = vm.below_horizon
    VI.vm.below_horizon = lambda mid, flow, yh, h: seen.append(yh) or real(mid, flow, yh, h)
    try:
        st = VI.analyse(ex, str(tmp_path / "m.csv"), calibration=json.loads(json.dumps(cal)), seed0=int(300 * FPS))
    finally:
        VI.vm.below_horizon = real
    assert st["horizon_calibration"] == cal and st["track_t0"] == 300.0
    assert set(np.round(seen, 6)) == {180.0}                                  # clip time 0..13 s = source 300..313 s


def test_the_candidates_are_seeded_by_the_source_frame(ex, tmp_path, monkeypatch):
    seeds = []
    real = vm.candidates
    monkeypatch.setattr(vm, "ALT_TRIGGER", 1e-6)
    monkeypatch.setattr(vm, "candidates", lambda *a, seed, **k: seeds.append(seed) or real(*a, seed=seed, **k))
    VI.analyse(ex, str(tmp_path / "m.csv"), calibration=dict(CAL, rms_median=0.4), seed0=1000)
    z = EX.load(ex)
    assert len(seeds) > 0.9 * len(z["idx"]) and set(seeds) <= set(int(j) + 1000 for j in z["idx"])


# ------------------------------------------------------------------ which stored points
def test_one_point_per_cell_the_strongest_with_a_usable_track(monkeypatch):
    """E4: two points per cell are stored, strongest first; USE_NPTS of them are used, after the forward-backward limit of the fit"""
    x = np.array([3, 9, 20, 30, 40, 44], float)            # cells (16 px): 0, 0, 1, 1, 2, 2
    y = np.full(6, 5.0)
    fb = np.array([0.1, 0.1, 0.7, 0.2, 0.1, 0.1])            # cell 1: the strongest point tracked badly, the second one stands in
    monkeypatch.setattr(VI, "USE_NPTS", 1)
    assert list(VI.select(x, y, fb, vm.MAX_FB_ERROR)) == [0, 3, 4]
    monkeypatch.setattr(VI, "USE_NPTS", 2)
    assert list(VI.select(x, y, fb, vm.MAX_FB_ERROR)) == [0, 1, 3, 4, 5]


def test_the_fit_falls_back_to_the_plain_pair():
    """vm.fit_row is shared by pair_row (video) and the interpretation: a destatic pair without a fit takes the plain pair"""
    rng = np.random.default_rng(0)
    p0 = np.column_stack([rng.uniform(100, 540, 200), rng.uniform(170, 340, 200)])
    u0 = p0[:, 1] - 150.0
    s = 2e-4
    u1 = u0 / (1 - s * u0)
    p1 = np.column_stack([320 + (p0[:, 0] - 320) * u1 / u0, 150.0 + u1])
    fl = p1 - p0
    plain = lambda: (200, p0 + fl / 2, fl)
    empty = lambda: (3, np.zeros((0, 2)), np.zeros((0, 2)))
    r = vm.fit_row(7, 0.2, 1.5, empty, plain, 150.0, vm.MIN_RESIDUAL, 1 / 30, 640, 360, 1.0)
    assert r[0] == 7 and r[2] == 200 and float(r[6]) == pytest.approx(s, rel=0.02)
    r = vm.fit_row(7, 0.2, 1.5, empty, None, 150.0, vm.MIN_RESIDUAL, 1 / 30, 640, 360, 1.0)
    assert r[4] == 0 and r[6] == ""


# ------------------------------------------------------------------ reuse of the extraction
def test_the_extraction_is_reused_while_its_key_holds(video, tmp_path, monkeypatch):
    d = tmp_path / "extract"
    calls = []
    real = EX.extract
    monkeypatch.setattr(EX, "extract", lambda *a, **k: calls.append(1) or real(*a, **k))
    m1, reused = VI.ensure_extract(str(video), d, key="k1", workers=1, hwaccel=False)
    assert not reused and m1["key"] == "k1" and len(calls) == 1
    _, reused = VI.ensure_extract(str(video), d, key="k1", workers=1, hwaccel=False)
    assert reused and len(calls) == 1
    m3, reused = VI.ensure_extract(str(video), d, key="k2", workers=1, hwaccel=False)
    assert not reused and m3["key"] == "k2" and len(calls) == 2


def test_the_interpretation_reads_no_video():
    """guard (docs/CONCEPT_extraction.md §7): the interpretation never decodes; only ensure_extract hands the video to the extraction"""
    import tokenize
    names = [t.string for t in tokenize.generate_tokens(open(VI.__file__).readline) if t.type == tokenize.NAME]
    for word in ("frames", "frames_from", "probe", "decode", "VideoCapture", "subprocess", "calcOpticalFlowPyrLK", "goodFeaturesToTrack"):
        assert word not in names, word


# ------------------------------------------------------------------ the analysis overlay
def test_the_overlay_shows_the_stored_points_the_step_fitted(video, ex, interpreted, tmp_path, monkeypatch):
    """a run from the extraction: the overlay (insight.frame) takes the pair's points from extract/ instead of tracking the frames again, and
    reproduces the stored csv row exactly"""
    import shutil
    from rsm.pipeline import insight as I
    from rsm.pipeline.vmsx import decode
    out, st = interpreted
    d = tmp_path / "run"
    (d / "motion").mkdir(parents=True)
    shutil.copytree(ex, d / "extract")
    shutil.copy(out, d / "motion" / "motion.csv")
    (d / "motion" / "motion.json").write_text(json.dumps(st))
    monkeypatch.setattr(decode, "frames_from", lambda *a, **k: pytest.fail("the overlay of an extracted run decodes no frames"))
    for t in (0.9, 6.0, 12.5):
        r = I.frame(d, t, str(video), ("motion",))["motion"]
        assert "error" not in r, r.get("error")
        assert r["agree"], r.get("diff")
        assert r["points_from"] == "extract" and r["decoded"] == 0
        assert len(r["points"]) == r["tracked"] and sum(p[4] == 1 for p in r["points"]) == r["fit"]["inliers"]
