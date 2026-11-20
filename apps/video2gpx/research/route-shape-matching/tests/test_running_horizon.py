# SPDX-License-Identifier: AGPL-3.0-or-later
"""The running horizon of the road-flow fit (vmsx.motion.HZ_*): the focus of expansion, sampled along the whole video and averaged over a centred
minute, is the horizon each frame pair is fitted with. On a pass road the camera holds level while the road tilts, so the road's horizon wanders with
the grade (Gotthard: about 21 rows at 7 %) and a fixed horizon reads the distance uphill too long and downhill too short."""
import json

import numpy as np
import pytest

from rsm.pipeline.vmsx import motion as vm
from tests.test_motion_parallel import CAL, CHUNK_S, N_FRAMES, video  # noqa: F401  (the module fixture)


def _track(t, row):
    return dict(t=[float(x) for x in t], row=[float(x) for x in row])


def test_a_constant_track_gives_its_row():
    tr = _track(np.arange(2.5, 600, vm.HZ_EVERY), np.full(120, 160.0))
    assert np.allclose(vm.running_horizon(tr, np.array([0.0, 100.0, 599.0]), 150.0), 160.0)


def test_the_average_is_centred_over_one_minute():
    t = np.arange(2.5, 600, vm.HZ_EVERY)
    tr = _track(t, np.where(t < 300, 140.0, 180.0))
    got = vm.running_horizon(tr, np.array([200.0, 300.0, 400.0]), 150.0)
    assert got[0] == pytest.approx(140.0) and got[2] == pytest.approx(180.0)
    inside = np.abs(t - 300.0) <= vm.HZ_SPAN / 2
    assert got[1] == pytest.approx(np.where(t < 300, 140.0, 180.0)[inside].mean())
    assert 150.0 < got[1] < 170.0


def test_no_sample_within_half_a_minute_falls_back_to_the_calibrated_row():
    tr = _track([10.0, 20.0], [170.0, 170.0])
    got = vm.running_horizon(tr, np.array([15.0, 200.0]), 150.0)
    assert got[0] == pytest.approx(170.0) and got[1] == pytest.approx(150.0)
    assert vm.running_horizon(None, np.array([15.0]), 150.0)[0] == pytest.approx(150.0)


def test_the_track_drops_stretches_with_few_or_wild_foci(monkeypatch):
    """a stretch with fewer than HZ_MIN_FOES foci (standstill, cut) or a median more than HZ_MAX_DEV rows off the calibrated row says nothing"""
    monkeypatch.setattr(vm, "probe", lambda p: type("I", (), dict(duration=30.0, width=640, height=360, fps=30.0))())
    rows = {0: [160.0] * 8, 1: [161.0] * 3, 2: [300.0] * 8, 3: [158.0, 162.0, 159.0, 161.0, 400.0], 4: [155.0] * 6, 5: [150.0] * 6}
    monkeypatch.setattr(vm, "_foe_sample", lambda a: rows[int(round(a[2] / vm.HZ_EVERY))])
    tr = vm.horizon_track("v.mp4", 360, 150.0, hwaccel=False)
    k = [int(round((x - vm.HZ_WINDOW / 2) / vm.HZ_EVERY)) for x in tr["t"]]
    assert k == [0, 3, 4, 5]
    assert tr["row"] == [160.0, 161.0, 155.0, 150.0]


def test_a_clip_samples_the_stretches_of_the_whole_video(monkeypatch):
    """the sample times lie on one grid from time 0: a clip (or a chunk layout) never moves them"""
    monkeypatch.setattr(vm, "probe", lambda p: type("I", (), dict(duration=600.0, width=640, height=360, fps=30.0))())
    seen = []
    monkeypatch.setattr(vm, "_foe_sample", lambda a: seen.append(a[2]) or [150.0] * 8)
    whole = vm.horizon_track("v.mp4", 360, 150.0, hwaccel=False)
    seen.clear()
    clip = vm.horizon_track("v.mp4", 360, 150.0, t0=200.0, t1=230.0, hwaccel=False)
    assert set(clip["t"]) <= set(whole["t"])
    assert min(seen) <= 200.0 - vm.HZ_SPAN / 2 + vm.HZ_EVERY and max(seen) >= 230.0 + vm.HZ_SPAN / 2 - vm.HZ_EVERY


def test_road_points_above_the_running_horizon_are_left_out():
    mid = np.array([[100.0, 150.0], [100.0, 170.0], [100.0, 200.0]])
    flow = np.ones((3, 2))
    m, f = vm.below_horizon(mid, flow, 160.0, 360)
    assert m[:, 1].tolist() == [170.0, 200.0] and len(f) == 2


def test_every_pair_is_fitted_with_the_running_horizon_at_its_time(video, tmp_path, monkeypatch):  # noqa: F811
    t = np.arange(vm.HZ_WINDOW / 2, 14.0, vm.HZ_EVERY)
    track = _track(t, 148.0 + 2.0 * t)                       # a steep track, so every pair gets its own row
    seen = []
    real = vm.pair_row
    monkeypatch.setattr(vm, "pair_row", lambda tracker, a, b, idx, tt, horizon, *r, **k: seen.append((tt, horizon)) or real(tracker, a, b, idx, tt, horizon, *r, **k))
    st = vm.analyse(str(video), str(tmp_path / "m.csv"), hwaccel=False, progress=False, calibration=dict(CAL, rms_median=0.5, track=track))
    assert len(seen) == N_FRAMES - 1
    ts = np.array([s[0] for s in seen])
    assert np.allclose([s[1] for s in seen], vm.running_horizon(track, ts, CAL["horizon"]))
    assert st["horizon_calibration"]["track"] == track and st["horizon_vms"] == CAL["horizon"]


def test_a_fixed_horizon_is_not_replaced(video, tmp_path, monkeypatch):  # noqa: F811
    """`horizon` given (clip tests, the overlay's synthetic run): no track, every pair at that row"""
    seen = []
    real = vm.pair_row
    monkeypatch.setattr(vm, "pair_row", lambda tracker, a, b, idx, tt, horizon, *r, **k: seen.append(horizon) or real(tracker, a, b, idx, tt, horizon, *r, **k))
    monkeypatch.setattr(vm, "horizon_track", lambda *a, **k: pytest.fail("no track for a fixed horizon"))
    vm.analyse(str(video), str(tmp_path / "m.csv"), hwaccel=False, progress=False, horizon=150.0, duration=2.0)
    assert set(seen) == {150.0}


def test_the_track_is_computed_once_and_the_parallel_csv_stays_identical(video, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr(vm, "calibrate_horizon", lambda *a, **k: dict(CAL))
    seq = vm.analyse(str(video), str(tmp_path / "s.csv"), hwaccel=False, progress=False, calibration=dict(CAL))
    tr = seq["horizon_calibration"]["track"]
    assert len(tr["t"]) >= 1 and len(tr["t"]) == len(tr["row"])
    par = vm.analyse_parallel(str(video), str(tmp_path / "p.csv"), workers=3, chunk_s=CHUNK_S, hwaccel=False)
    assert par["horizon_calibration"]["track"] == tr
    assert (tmp_path / "s.csv").read_bytes() == (tmp_path / "p.csv").read_bytes()


def test_the_overlay_refits_with_the_horizon_the_step_used():
    t = np.arange(vm.HZ_WINDOW / 2, 600, vm.HZ_EVERY)
    track = _track(t, np.where(t < 300, 140.0, 180.0))
    mj = dict(horizon=120.0, horizon_vms=150.0, horizon_calibration=dict(horizon=150.0, track=track))
    assert vm.horizon_at(mj, 100.0) == pytest.approx(140.0) and vm.horizon_at(mj, 500.0) == pytest.approx(180.0)
    assert vm.horizon_at(json.loads(json.dumps(dict(horizon=120.0, horizon_vms=150.0))), 100.0) == pytest.approx(150.0)
    assert vm.horizon_at(dict(horizon=120.0), 100.0) == pytest.approx(120.0)


def test_a_clip_reads_the_stage_track_at_its_source_time(video, tmp_path, monkeypatch):  # noqa: F811
    """T1 clips take the horizon calibration of their source's stage (P["calibration"]) and the index of their first source frame (P["frame0"]):
    the track is in source seconds, so a clip pair at clip time t is fitted with the row at t + frame0 / fps (docs/CONCEPT_test_strategy.md B)"""
    t = np.arange(vm.HZ_WINDOW / 2, 400.0, vm.HZ_EVERY)
    track = _track(t, np.where(t < 200, 140.0, 180.0))
    frame0 = 300 * 30                                          # the clip starts at 300 s of its source
    seen = []
    real = vm.pair_row
    monkeypatch.setattr(vm, "pair_row", lambda tracker, a, b, idx, tt, horizon, *r, **k: seen.append((tt, horizon)) or real(tracker, a, b, idx, tt, horizon, *r, **k))
    st = vm.analyse(str(video), str(tmp_path / "m.csv"), hwaccel=False, progress=False, calibration=dict(CAL, rms_median=0.5, track=track), seed0=frame0)
    assert all(h == pytest.approx(180.0) for _, h in seen)    # 140 at clip time, 180 at source time
    assert st["track_t0"] == pytest.approx(300.0)
    assert vm.horizon_at(st, 1.0) == pytest.approx(180.0)


def test_a_clip_without_a_stage_keeps_its_own_track_in_source_time(video, tmp_path, monkeypatch):  # noqa: F811
    """a clip that calibrates itself (clip.json `calibrate`) samples its own frames; the track it stores is shifted to source seconds as well"""
    monkeypatch.setattr(vm, "_foe_sample", lambda a: [150.0 + a[2]] * 8)
    st = vm.analyse(str(video), str(tmp_path / "m.csv"), hwaccel=False, progress=False, calibration=dict(CAL, rms_median=0.5), seed0=300 * 30)
    tr = st["horizon_calibration"]["track"]
    assert tr["t"][0] == pytest.approx(300.0 + vm.HZ_WINDOW / 2) and tr["row"][0] == pytest.approx(150.0)
    assert vm.horizon_at(st, 0.0) == pytest.approx(float(np.mean([r for x, r in zip(tr["t"], tr["row"]) if abs(x - 300.0) <= vm.HZ_SPAN / 2])))


def test_the_running_horizon_parameters_key_the_motion_step(tmp_path, monkeypatch):
    """a changed HZ_* parameter reruns motion and everything after it on resume"""
    from rsm.pipeline import config as C
    from rsm.pipeline.cli import Run, parse_args
    vid, pbf = tmp_path / "v.mp4", tmp_path / "p.pbf"
    vid.write_bytes(b"x"); pbf.write_bytes(b"y")
    run = Run(parse_args(["run", "--video", str(vid), "--bbox", "1,2,3,4", "--pbf", str(pbf), "--out", str(tmp_path / "o")]))
    base = dict(video=str(vid), bbox=dict(south=1, west=2, north=3, east=4), pbf=str(pbf), vehicle="auto", offset_m=None, start_time=None, traffic_side="auto", decoys=0,
                start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    ref = run.hashes(base)
    for nm in ("HZ_EVERY", "HZ_WINDOW", "HZ_SPAN", "HZ_MIN_FOES", "HZ_MAX_DEV"):
        with monkeypatch.context() as m:
            m.setattr(vm, nm, getattr(vm, nm) + 1)
            h1 = run.hashes(base)
        assert all(h1[s] != ref[s] for s in C.STEPS), nm
