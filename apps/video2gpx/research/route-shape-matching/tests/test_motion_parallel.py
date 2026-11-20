# SPDX-License-Identifier: AGPL-3.0-or-later
"""Parallel motion analysis (vmsx.motion.analyse_parallel): byte-identical to the sequential analyse, and it falls back to it when a chunk seek is off."""
import filecmp
import os

import pytest

from rsm.pipeline.vmsx import motion as vm
from tests.test_insight import _encode, _world

N_FRAMES = 400              # 13.3 s at 30 fps
CHUNK_S = 4 * vm.WARM_FRAMES / 30.0     # the shortest chunk: 128 frames -> 3 chunks
CAL = {"horizon": 150.0, "iqr": 0.0, "frames": 0, "height": 360, "horizon_free": 140.0, "iqr_free": 0.0, "frames_free": 0}


@pytest.fixture(scope="module")
def video(tmp_path_factory):
    os.environ["RSM_HWACCEL"] = "0"
    p = tmp_path_factory.mktemp("par") / "road.mp4"
    _encode(p, _world(N_FRAMES))
    return p


@pytest.fixture
def fixed_horizon(monkeypatch):
    """the synthetic road is too short for the 16-stretch calibration: both paths get the same fixed one"""
    monkeypatch.setattr(vm, "calibrate_horizon", lambda *a, **k: dict(CAL))


@pytest.fixture(scope="module")
def sequential(video, tmp_path_factory):
    out = tmp_path_factory.mktemp("seq") / "motion.csv"
    st = vm.analyse(str(video), str(out), hwaccel=False, progress=False, calibration=dict(CAL))
    assert st["pairs"] == N_FRAMES - 1
    return out


def test_parallel_csv_is_byte_identical_to_the_sequential_one(video, sequential, fixed_horizon, tmp_path):
    out = tmp_path / "motion.csv"
    st = vm.analyse_parallel(str(video), str(out), workers=3, chunk_s=CHUNK_S, hwaccel=False)
    assert st["parallel"] == dict(workers=3, chunks=3, chunk_s=CHUNK_S, warm_frames=vm.WARM_FRAMES)
    assert st["pairs"] == N_FRAMES - 1
    assert st["horizon"] == CAL["horizon_free"] and st["horizon_vms"] == CAL["horizon"]
    assert filecmp.cmp(sequential, out, shallow=False)
    assert not (tmp_path / "motion.csv.part").exists()


def test_a_seek_that_lands_one_frame_late_falls_back_to_the_sequential_analysis(video, sequential, fixed_horizon, tmp_path, monkeypatch):
    real = vm.frames_from
    monkeypatch.setattr(vm, "frames_from", lambda path, info, height, first, n=None, **k: real(path, info, height, first + 1, n, **k))
    logs = []
    out = tmp_path / "motion.csv"
    st = vm.analyse_parallel(str(video), str(out), workers=3, chunk_s=CHUNK_S, hwaccel=False, log=lambda lv, m: logs.append((lv, m)))
    assert "seek did not land" in st["parallel"]["fallback"]
    assert logs and logs[0][0] == "warn"
    assert filecmp.cmp(sequential, out, shallow=False)


def test_irregular_stream_timing_runs_sequentially(video, sequential, fixed_horizon, tmp_path, monkeypatch):
    monkeypatch.setattr(vm, "timing_problem", lambda path, fps: "packet times off the constant-rate grid by up to 1.00 frames")
    out = tmp_path / "motion.csv"
    st = vm.analyse_parallel(str(video), str(out), workers=3, chunk_s=CHUNK_S, hwaccel=False)
    assert st["parallel"]["fallback"].startswith("packet times")
    assert filecmp.cmp(sequential, out, shallow=False)


def test_the_synthetic_stream_passes_the_timing_gate(video):
    assert vm.timing_problem(str(video), 30.0) is None


def test_calibration_stretches_in_a_pool_give_the_same_horizon(video):
    import multiprocessing as mp
    jobs = [(str(video), 360, s, 3.0, False) for s in (1.0, 5.0, 9.0)]
    seq = [vm._horizon_sample(j) for j in jobs]
    with mp.get_context("fork").Pool(3, initializer=vm._worker_init) as pool:
        par = pool.map(vm._horizon_sample, jobs, chunksize=1)
    assert par == seq and sum(len(e) for e, _ in seq) > 0


def test_the_candidate_tolerance_comes_from_the_noise_calibration(video, tmp_path):
    """the tolerance of the road candidates follows the plain-road rms of the calibration stretches (fixed samples: the same for every chunk layout);
    a calibration that already carries `rms_median` is used as it is"""
    st = vm.analyse(str(video), str(tmp_path / "a.csv"), hwaccel=False, progress=False, calibration=dict(CAL, rms_median=0.85))
    assert st["alt_thr"] == pytest.approx(vm.alt_threshold(0.85, 1.0))
    st = vm.analyse(str(video), str(tmp_path / "b.csv"), hwaccel=False, progress=False, calibration=dict(CAL))
    med = st["horizon_calibration"]["rms_median"]
    assert med > 0 and st["alt_thr"] == pytest.approx(vm.alt_threshold(med, 1.0))
    par = vm.analyse_parallel(str(video), str(tmp_path / "c.csv"), workers=3, chunk_s=CHUNK_S, hwaccel=False, calibration=dict(CAL))
    assert par["horizon_calibration"]["rms_median"] == med and par["alt_thr"] == st["alt_thr"]
