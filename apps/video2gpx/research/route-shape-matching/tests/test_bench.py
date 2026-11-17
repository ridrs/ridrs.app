# SPDX-License-Identifier: AGPL-3.0-or-later
"""Benchmark harness on synthetic tracks (no files): perturbations, library, calibration maths, a tiny end-to-end run."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

from rsm.bench import benchmark, calibrate, perturb, real_video, tracks as T
from rsm.bench.report import render
from rsm.core.matcher import StatusThresholds
from rsm.core.trajectory import RelativeTrajectory
import synthetic as syn


def synth_track(name: str, role: str, seed: int, length=4500.0) -> T.Track:
    p = syn.wiggly(seed, length, step=5.0)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    g = np.column_stack([s / 6.0, p])  # (t, x, y): 6 m/s
    return T.preprocess(name, role, g)


@pytest.fixture(scope="module")
def tracks():
    return [synth_track("a", "dev", 11), synth_track("b", "dev", 12), synth_track("c", "test", 13)]


MODEL = perturb.ErrorModel(0.83, 0.05, (0.72, 1.35), 3.0, 40.0, 2.0, "calibrated")


def test_preprocess_and_cut(tracks):
    t = tracks[0]
    assert t.length > 4000 and t.t is not None and np.all(np.diff(t.s)[:-1] > 1.9)
    c = t.cut(100.0, 400.0)
    assert np.hypot(*np.diff(c, axis=0).T).sum() == pytest.approx(300.0, rel=0.01)
    assert t.arc_at_time(100.0) == pytest.approx(600.0, rel=0.02)  # 6 m/s


def test_library_overlapping_windows_and_params(tracks):
    lib = T.build_library(tracks, 500)
    lc, stride = T.library_params(500)
    assert lc == 850.0 and stride == 250.0
    first = [c for c in lib if c.origin_id == "a"]
    assert [c.origin_offset_m for c in first[:3]] == [0.0, 250.0, 500.0]
    assert first[-1].origin_offset_m + lc == pytest.approx(tracks[0].length, abs=2.1)  # a last window ends at the track end
    c = first[1]
    assert np.hypot(*np.diff(c.points, axis=0).T).sum() == pytest.approx(lc, rel=0.01)


def test_overlap_with_truth_definition():
    truth = ("a", 1000.0, 1400.0)
    assert T.overlap_with_truth("a", 1000.0, 1400.0, truth) == 1.0
    assert T.overlap_with_truth("a", 1200.0, 1600.0, truth) == pytest.approx(0.5)
    assert T.overlap_with_truth("b", 1000.0, 1400.0, truth) == 0.0  # same interval, other track
    assert T.overlap_with_truth("a", 0.0, 100.0, truth) == 0.0


def test_perturbation_is_deterministic_and_levels_share_draws(tracks):
    path = tracks[0].cut(1000.0, 1500.0)
    a, ia = perturb.make_query(path, np.random.default_rng(5), MODEL, 1.0)
    b, ib = perturb.make_query(path, np.random.default_rng(5), MODEL, 1.0)
    assert np.array_equal(a.points, b.points) and ia == ib
    c, ic = perturb.make_query(path, np.random.default_rng(5), MODEL, 2.0)
    assert ic["scale_true"] == ia["scale_true"] and ic["rotation_rad"] == ia["rotation_rad"] and ic["mean_spacing_m"] == ia["mean_spacing_m"]
    m, im = perturb.make_query(path, np.random.default_rng(5), MODEL, 1.0, mirror=True)
    assert im["scale_true"] == ia["scale_true"]
    assert len(a) != len(c) or not np.allclose(a.points, c.points)


def test_perturbation_amplitudes_match_the_model(tracks):
    path = tracks[0].cut(1000.0, 2000.0)
    zero = perturb.ErrorModel(0.83, 0.0, (0.72, 1.35), 0.0, 40.0, 0.0, "assumed")
    q0, i0 = perturb.make_query(path, np.random.default_rng(1), zero, 1.0)
    assert q0.length == pytest.approx(1000.0 / 0.83, rel=0.01) and i0["scale_true"] == pytest.approx(0.83)
    # lateral noise: RMS distance of the perturbed path (after undoing the exact similarity) from the true one
    lat_only = perturb.ErrorModel(0.83, 0.0, (0.72, 1.35), 3.0, 40.0, 0.0, "assumed")
    q, info = perturb.make_query(path, np.random.default_rng(1), lat_only, 1.0)
    th = info["rotation_rad"]
    undo = (q.points - np.array(info["translation"])) @ np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]]) * info["scale_true"]
    from scipy.spatial import cKDTree
    dense = tracks[0].cut(1000.0, 2000.0, 0.5)
    d, _ = cKDTree(dense).query(undo)
    assert 2.0 < float(np.sqrt(np.mean(d ** 2))) < 3.6  # ~ the requested RMS (nearest-point distance slightly under-counts along-path parts)
    # drift grows with the path: displacement of the end from the drift-free end
    drift = perturb.ErrorModel(0.83, 0.0, (0.72, 1.35), 0.0, 40.0, 3.0, "assumed")
    ends = []
    for seed in range(20):
        qd, idn = perturb.make_query(path, np.random.default_rng(seed), drift, 1.0)
        q0, i0 = perturb.make_query(path, np.random.default_rng(seed), zero, 1.0)
        ends.append(np.hypot(*(qd.points[-1] - q0.points[-1])) * 0.83)
    assert 10 < np.median(ends) < 200  # tens of metres at 1 km for 3 deg/100 m random-walk drift
    # the harder level scales both
    qd2, _ = perturb.make_query(path, np.random.default_rng(3), drift, 2.0)
    qd1, _ = perturb.make_query(path, np.random.default_rng(3), drift, 1.0)
    q0, _ = perturb.make_query(path, np.random.default_rng(3), zero, 1.0)
    n = min(len(qd1), len(qd2), len(q0))
    assert np.hypot(*(qd2.points[-1] - q0.points[-1])) > 1.5 * np.hypot(*(qd1.points[-1] - q0.points[-1]))


def test_error_model_loading(tmp_path):
    assert perturb.load_error_model(None).source == "assumed"
    assert perturb.load_error_model(tmp_path / "missing.json").source == "assumed"
    p = tmp_path / "em.json"
    p.write_text(json.dumps({"recommended": {"scale_bias": 0.8, "scale_sigma": 0.1, "scale_clip": [0.7, 1.3], "lateral_rms_m": 5.0,
                                              "lateral_corr_len_m": 30.0, "drift_deg_per_100m": 1.0, "notes": ["x"]}}))
    m = perturb.load_error_model(p)
    assert m.source == "calibrated" and m.lateral_rms_m == 5.0


# -- calibration maths on a pair with known parameters --------------------------------------------------------


def calib_pair(drift_deg_per_100m=0.0, lateral=0.0, seed=0, length=450.0):
    gpx_path = syn.wiggly(21, 900.0, 1.0)
    gpx_ext = RelativeTrajectory(gpx_path[::3])
    a, b = 225.0, 225.0 + length  # the "video" covers this part
    s = np.arange(a, b, 1.0)
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(gpx_path, axis=0).T))])
    pts = np.column_stack([np.interp(s, cum, gpx_path[:, 0]), np.interp(s, cum, gpx_path[:, 1])])
    d = np.diff(pts, axis=0)
    dh = np.radians(drift_deg_per_100m) * np.arange(len(d)) / 100.0
    d = np.column_stack([d[:, 0] * np.cos(dh) - d[:, 1] * np.sin(dh), d[:, 0] * np.sin(dh) + d[:, 1] * np.cos(dh)])
    p = np.vstack([pts[0], pts[0] + np.cumsum(d, axis=0)])
    if lateral:
        rng = np.random.default_rng(seed)
        from scipy.ndimage import gaussian_filter1d
        f = gaussian_filter1d(rng.standard_normal(len(p)), 15)
        f = (f - f.mean()) / f.std() * lateral
        tg = np.gradient(p, axis=0)
        tg /= np.hypot(*tg.T)[:, None]
        p = p + f[:, None] * np.column_stack([-tg[:, 1], tg[:, 0]])
    video = syn.irregular_resample(syn.move(p, 1 / 0.83, 1.1, (40, -30)), 1.0, 3)
    return RelativeTrajectory(video), gpx_ext


def test_calibration_recovers_scale_and_residual_of_a_noise_free_pair():
    video, gpx = calib_pair()
    m = calibrate.measure_pair(video, gpx)
    assert m["fit"]["scale"] == pytest.approx(0.83, rel=0.01) and not m["fit"]["scale_clamped"]
    assert m["fit"]["inverse_scale"] == pytest.approx(1.2, rel=0.02)
    assert m["residual"]["crosstrack_rms_m"] < 0.3  # nothing but the 3 m subsampling of the source GPX polyline
    assert abs(m["heading_drift"]["slope_deg_per_100m"]) < 0.5
    assert m["matched_window_start_m"] == pytest.approx(225.0, abs=15.0)


def test_calibration_recovers_known_heading_drift_and_lateral_noise():
    video, gpx = calib_pair(drift_deg_per_100m=3.0)
    m = calibrate.measure_pair(video, gpx)
    # the similarity fit absorbs part of a linear drift (rotation), the slope is what remains and must still be recovered
    assert m["heading_drift"]["slope_deg_per_100m"] == pytest.approx(3.0, abs=0.9)
    video, gpx = calib_pair(lateral=3.0, seed=2)
    m = calibrate.measure_pair(video, gpx)
    assert 1.5 < m["residual"]["crosstrack_rms_m"] < 4.5
    assert m["smoothness"]["corr_length_m"] > 10 and m["smoothness"]["variance_fractions_by_wavelength"]["lt_30m"] < 0.5
    assert abs(m["heading_drift"]["slope_deg_per_100m"]) < 1.5
    rec = calibrate.recommend({"x": m, "y": m})
    assert rec["lateral_rms_m"] == m["residual"]["crosstrack_rms_m"] and rec["scale_sigma"] >= 0.08 and 15 <= rec["lateral_corr_len_m"] <= 120


def test_calibrate_main_reports_missing_inputs(tmp_path, capsys, monkeypatch):
    monkeypatch.setitem(calibrate.GPX_FILES, "pennes", tmp_path / "nope.gpx")
    assert calibrate.main(str(tmp_path / "em.json"), routes_dir=tmp_path) == 2
    assert not (tmp_path / "em.json").exists() and "cannot calibrate" in capsys.readouterr().err


# -- benchmark end to end -----------------------------------------------------------------------------------


def test_status_and_tune_logic():
    th = StatusThresholds(1.5, 0.1)
    e = lambda scores, n=5: {"scores": scores, "n_distinct": n}
    assert benchmark.status_of(e([0.01, 0.02]), th) == "confident"
    assert benchmark.status_of(e([0.01, 0.012]), th) == "ambiguous"
    assert benchmark.status_of(e([0.2, 0.9]), th) == "no_match"
    assert benchmark.status_of(e([0.01], 1), th) == "confident"
    assert benchmark.status_of(e([0.0, 0.0]), th) == "ambiguous"


def test_benchmark_smoke_on_synthetic_tracks(tracks, tmp_path, monkeypatch):
    cfg = benchmark.BenchConfig(lengths=(300,), n_main=2, n_mirror=1, n_straight=1, n_excluded=1, n_dup=1, n_prefilter=1, workers=1, n_timing=1, error_model=None)
    res = benchmark.run(cfg, tmp_path, tracks=tracks, log=lambda *_: None)
    assert res["chosen"] in benchmark.KEYS and res["n_runs"] > 20
    recs = json.loads((tmp_path / "bench_records.json").read_text())
    kinds = {r["spec"]["kind"] for r in recs}
    assert {"main", "mirror", "excluded", "dup"} <= kinds
    assert res["error_model"]["source"] == "assumed"
    for key in benchmark.KEYS:
        cells = res["tables"][key]["cells"]
        assert set(c.split("|")[0] for c in cells) == {"dev", "test"} and all(0 <= v["top1"] <= 1 for v in cells.values())
    # an easy case on synthetic roads: the truth is usually found at the calibrated level
    assert res["tables"]["rmse_rel"]["cells"]["dev|300|1"]["top20"] >= 0.5
    # determinism: the same specification gives the same record (specs are seeded, independent of worker order)
    specs = benchmark.make_specs(tracks, cfg)
    assert specs == benchmark.make_specs(tracks, cfg)
    benchmark._init_worker(benchmark._payload(tracks), perturb.ASSUMED.to_dict())
    again = benchmark.run_task(specs[1])
    first = next(r for r in recs if r["spec"] == {k: v for k, v in specs[1].items() if k != "library"})
    assert again["keys"]["rmse_rel"]["scores"] == first["keys"]["rmse_rel"]["scores"] and again["info"] == first["info"]
    md = render(res, tmp_path, run_real=False)
    assert "WARNING: error model is ASSUMED" in md and "Hard negatives" in md and "top1 %" in md


def test_duplicate_injection_gives_ambiguous(tracks, tmp_path):
    cfg = benchmark.BenchConfig(lengths=(500,), n_main=2, n_mirror=0, n_straight=0, n_excluded=0, n_dup=2, n_prefilter=0, workers=1, n_timing=1, error_model=None)
    res = benchmark.run(cfg, tmp_path, tracks=tracks, log=lambda *_: None)
    recs = [r for r in json.loads((tmp_path / "bench_records.json").read_text()) if r["spec"]["kind"] == "dup"]
    assert recs
    for r in recs:
        e = r["keys"]["rmse_rel"]
        hit = [i for i, c in enumerate(e["correct"]) if c]
        assert len(hit) >= 2  # the original and its copy both count as the truth
        assert e["scores"][hit[1]] == pytest.approx(e["scores"][hit[0]], rel=1e-2)  # identical shape: a tie (up to which coarse windows get refined), whatever its rank
        assert hit[1] == hit[0] + 1


def test_real_video_runner_with_a_stubbed_reconstruction(tracks, monkeypatch, tmp_path):
    tr = tracks[2]
    a, b = 2000.0, 2400.0
    q, _ = perturb.make_query(tr.cut(a, b), np.random.default_rng(1), MODEL, 1.0)
    ta, tb = float(np.interp(a, tr.s, tr.t)), float(np.interp(b, tr.s, tr.t))
    video = RelativeTrajectory(q.points, t=np.linspace(ta, tb, len(q)), scale=q.scale)
    monkeypatch.setattr(real_video.road_reconstruction, "load", lambda p: video)
    monkeypatch.setattr(real_video, "PAIRS", {"stub": "c"})
    th = {k: StatusThresholds(1.2, 1.0) for k in benchmark.KEYS}
    out = real_video.run(tracks, benchmark.KEYS, th, "rmse_rel")
    qq = out["queries"][0]
    assert qq["truth"]["start_m"] == pytest.approx(a, abs=3.0) and qq["truth"]["length_m"] == pytest.approx(400.0, abs=4.0)
    assert qq["per_key"]["rmse_rel"]["truth_rank"] == 1 and qq["per_key"]["rmse_rel"]["best_overlap_with_truth"] > 0.8
    assert out["circular"]


def test_real_video_runner_reports_missing_inputs(tracks, tmp_path):
    out = real_video.run(tracks, benchmark.KEYS, {k: StatusThresholds(1.2, 1.0) for k in benchmark.KEYS}, "rmse_rel", routes_dir=tmp_path)
    assert out["queries"] == [] and out["not_run"]
