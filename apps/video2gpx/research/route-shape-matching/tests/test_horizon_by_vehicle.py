# SPDX-License-Identifier: AGPL-3.0-or-later
"""The running horizon (A24) by vehicle (docs/STUDY_curve_distance_balance.md, variant B): a motor vehicle on a pass road needs it (Gotthard), on a
bike the speed follows the horizon's noise and the route lags (Pontaix). The vehicle is known only after route_search (kappa), so the first pass runs
with the running horizon and, when the calibration says bike, motion to route_search run once more with the fixed horizon, from the stored
extraction (no video decode)."""
import json
from pathlib import Path

import numpy as np
import pytest

from rsm.pipeline import calib as CB, config as C, steps_a as SA
from rsm.pipeline.vmsx import interpret as VI, motion as vm
from tests.test_interpret import CAL, FPS, ex, video  # noqa: F401  (module fixtures)


# ------------------------------------------------------------------ the rule
@pytest.mark.parametrize("vehicle, mode", [("bike", "fixed"), ("motorcycle", "running"), ("car", "running")])
def test_the_horizon_follows_the_vehicle(vehicle, mode):
    assert CB.horizon_mode(vehicle) == mode


# ------------------------------------------------------------------ the interpretation with a fixed horizon
def test_a_fixed_horizon_fits_every_pair_with_the_calibrated_row(ex, tmp_path):  # noqa: F811
    t = np.arange(vm.HZ_WINDOW / 2, 400.0, vm.HZ_EVERY)
    cal = dict(CAL, rms_median=0.4, rms_pairs=500, track=dict(t=[float(x) for x in t], row=[140.0 if x < 200 else 180.0 for x in t]))
    seen = []
    real = vm.below_horizon
    VI.vm.below_horizon = lambda mid, flow, yh, h: seen.append(yh) or real(mid, flow, yh, h)
    try:
        st = VI.analyse(ex, str(tmp_path / "m.csv"), calibration=json.loads(json.dumps(cal)), seed0=int(300 * FPS), running=False)
    finally:
        VI.vm.below_horizon = real
    assert set(np.round(seen, 6)) == {float(CAL["horizon"])}
    assert st["horizon_mode"] == "fixed" and st["horizon_calibration"]["track"] is None


def test_the_motion_step_interprets_with_the_horizon_of_the_params(tmp_path, monkeypatch):
    got = []
    monkeypatch.setattr(SA, "extract_key", lambda video, height: "k")
    monkeypatch.setattr(VI, "ensure_extract", lambda *a, **k: (dict(pairs=1, seconds=1.0), True))
    monkeypatch.setattr(VI, "analyse", lambda *a, **k: got.append(k.get("running")) or dict(extract={}, seconds=0.0))
    W = type("W", (), dict(log=lambda *a: None, progress=lambda *a, **k: None))()
    for P in (dict(video="v.mp4"), dict(video="v.mp4", horizon="running"), dict(video="v.mp4", horizon="fixed")):
        SA.motion_from_extract(tmp_path, P, W, None, 0)
    assert got == [True, True, False]


# ------------------------------------------------------------------ the step keys
def _run(tmp_path):
    from rsm.pipeline.cli import Run, parse_args
    vid, pbf = tmp_path / "v.mp4", tmp_path / "p.pbf"
    vid.write_bytes(b"x")
    pbf.write_bytes(b"y")
    base = dict(video=str(vid), bbox=dict(south=1, west=2, north=3, east=4), pbf=str(pbf), vehicle="auto", offset_m=None, start_time=None, traffic_side="auto",
                decoys=0, start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    return Run(parse_args(["run", "--video", str(vid), "--bbox", "1,2,3,4", "--pbf", str(pbf), "--out", str(tmp_path / "o")])), base


def test_a_fixed_horizon_reruns_motion_and_every_later_step_and_the_running_one_keeps_the_old_keys(tmp_path):
    run, base = _run(tmp_path)
    h0 = run.hashes(base)
    assert run.hashes(dict(base, horizon="running")) == h0
    hf = run.hashes(dict(base, horizon="fixed"))
    assert all(hf[s] != h0[s] for s in C.STEPS)


def test_the_bench_keys_of_the_motion_step_name_a_fixed_horizon(tmp_path):
    from rsm.bench import stepcache as SC
    root = Path(SC.__file__).resolve().parents[2]
    P = dict(video=None, bbox=[0, 0, 1, 1], pbf=None, vehicle="auto")
    k0 = SC.step_keys(root, P, ["motion", "rotation"], video_sig="abc")
    assert SC.step_keys(root, dict(P, horizon="running"), ["motion", "rotation"], video_sig="abc") == k0
    kf = SC.step_keys(root, dict(P, horizon="fixed"), ["motion", "rotation"], video_sig="abc")
    assert kf["motion"] != k0["motion"] and kf["rotation"] != k0["rotation"]


# ------------------------------------------------------------------ the second pass of a run
def _fake_run(tmp_path, monkeypatch, argv_extra, vehicles, iqr=None):
    """a run whose workers only write what the parent reads; route_search says the vehicles in turn -> [(step, horizon)] in order;
    with iqr the motion step writes a motion.json whose horizon calibration spreads iqr rows"""
    from rsm.pipeline import cli, memguard
    run, _ = _run(tmp_path)
    a = cli.parse_args(["run", "--video", str(tmp_path / "v.mp4"), "--bbox", "1,2,3,4", "--pbf", str(tmp_path / "p.pbf"), "--out", str(tmp_path / "o"), *argv_extra])
    run = cli.Run(a)
    monkeypatch.setattr(memguard, "free_percent", lambda: 90.0)
    monkeypatch.setattr(cli, "emit", lambda e: None)
    calls, said = [], list(vehicles)

    def worker(sid, i):
        P = json.loads((run.d / "project.params.json").read_text())
        calls.append((sid, P.get("horizon")))
        if sid == "motion" and iqr is not None:
            (run.d / "motion").mkdir(exist_ok=True)
            (run.d / "motion" / "motion.json").write_text(json.dumps(dict(horizon_calibration=dict(CAL, iqr=iqr))))
        summ = dict(f_eff=500.0, kappa=1.0, conf_mean=0.9, path_km=1.0)
        if sid == "route_search":
            (run.d / "route_search" / "vehicle_final.json").write_text(json.dumps(dict(vehicle=said.pop(0), from_kappa=True)))
        if sid == "gpx":
            (run.d / "project.json").write_text(json.dumps(dict(verdict_detail=dict(verdict="confident", basis="x", reasons=[], signals={}),
                                                                effective=dict(vehicle="bike", offset_m=1.5, traffic_side="right"))))
        return 0, dict(seconds=1.0, peak_gb=0.1, summary=summ), []

    monkeypatch.setattr(run, "run_worker", worker)
    assert run.run() == 0
    return calls, run


def test_an_estimated_bike_gets_a_second_pass_with_the_fixed_horizon(tmp_path, monkeypatch):
    calls, run = _fake_run(tmp_path, monkeypatch, [], ["bike", "bike"])
    first = [("motion", "running"), ("rotation", "running"), ("map", "running"), ("route_search", "running")]
    second = [("motion", "fixed"), ("rotation", "fixed"), ("map", "fixed"), ("route_search", "fixed"), ("refine", "fixed"), ("gpx", "fixed")]
    assert calls == first + second
    assert json.loads((run.d / "project.params.json").read_text())["horizon"] == "fixed"


def test_a_motor_vehicle_runs_once_with_the_running_horizon(tmp_path, monkeypatch):
    calls, _ = _fake_run(tmp_path, monkeypatch, [], ["motorcycle"])
    assert [s for s, _ in calls] == ["motion", "rotation", "map", "route_search", "refine", "gpx"] and {h for _, h in calls} == {"running"}


def test_the_second_pass_runs_at_most_once(tmp_path, monkeypatch):
    calls, _ = _fake_run(tmp_path, monkeypatch, [], ["bike", "motorcycle"])
    assert [s for s, _ in calls].count("route_search") == 2 and calls[-1] == ("gpx", "fixed")


@pytest.mark.parametrize("vehicle, mode", [("bike", "fixed"), ("car", "running")])
def test_a_chosen_vehicle_runs_once_with_its_horizon(tmp_path, monkeypatch, vehicle, mode):
    calls, _ = _fake_run(tmp_path, monkeypatch, ["--vehicle", vehicle], ["motorcycle" if vehicle == "bike" else "bike"])
    assert [s for s, _ in calls].count("route_search") == 1 and {h for _, h in calls} == {mode}


# ------------------------------------------------------------------ the test bench: stages hold both image sides
from rsm.bench import regress as RG, stages as ST  # noqa: E402
from tests.test_source_free import _adopted  # noqa: E402


def test_a_stage_holds_the_image_side_of_the_fixed_horizon_too(tmp_path, monkeypatch):
    code, src, out, seen = _adopted(tmp_path, monkeypatch)
    assert seen["horizon"] == "fixed"                                     # the last run of the adoption: the fixed horizon
    assert (out / "fixed" / "motion").is_dir() and (out / "fixed" / "rotation").is_dir() and not (out / "fixed" / "extract").exists()
    s = json.loads((out / "stage.json").read_text())
    assert s["code_fixed"] and s["code_fixed"] != s["code"]
    assert ST.status(out, root=code) == "fresh"


def test_a_stage_without_the_fixed_image_side_is_not_fresh(tmp_path, monkeypatch):
    import shutil
    code, src, out, _ = _adopted(tmp_path, monkeypatch)
    shutil.rmtree(out / "fixed")
    assert ST.status(out, root=code) == "frozen"                          # source-free: kept as frozen, a source-backed stage would be reinterpret


def _staged(tmp_path, monkeypatch, vehicles, vehicle="auto"):
    """_run_cached on a stage with fake steps; route_search says the vehicles in turn -> [(step, horizon)] run, horizons staged in"""
    d = tmp_path / "d"
    (d / "steps").mkdir(parents=True)
    staged, ran, said = [], [], list(vehicles)

    def stage_in(c, d, P, code, log=print):
        staged.append(P.get("horizon", "running"))
        return {s: f"{s}-{P.get('horizon', 'running')}" for s in RG.STEPS}

    def run_step(code, d, sid, log):
        P = json.loads((d / "project.params.json").read_text())
        ran.append((sid, P.get("horizon", "running")))
        if sid == "route_search":
            (d / "route_search" / "vehicle_final.json").write_text(json.dumps(dict(vehicle=said.pop(0))))
        return dict(seconds=1.0)

    monkeypatch.setattr(RG, "stage_in", stage_in)
    monkeypatch.setattr(RG, "run_step", run_step)
    monkeypatch.setattr(RG.SC, "fetch", lambda *a, **k: False)
    monkeypatch.setattr(RG.SC, "store", lambda *a, **k: None)
    P = dict(vehicle=vehicle, video="discarded:v.mp4", pbf="/x.pbf")
    (d / "project.params.json").write_text(json.dumps(P))
    RG._run_cached(dict(name="x", stage="x"), d, P, Path("."), lambda *a: None, "gpx", keys=stage_in(None, d, P, None))
    return staged, ran


def test_the_route_tests_give_an_estimated_bike_the_second_pass_on_the_stages_fixed_image_side(tmp_path, monkeypatch):
    staged, ran = _staged(tmp_path, monkeypatch, ["bike", "bike"])
    assert staged == ["running", "fixed"]
    assert ran == [("map", "running"), ("route_search", "running"), ("map", "fixed"), ("route_search", "fixed"), ("refine", "fixed"), ("gpx", "fixed")]


def test_the_route_tests_run_a_motor_vehicle_once(tmp_path, monkeypatch):
    staged, ran = _staged(tmp_path, monkeypatch, ["motorcycle"])
    assert staged == ["running"] and [s for s, _ in ran] == ["map", "route_search", "refine", "gpx"]


def test_the_stage_in_takes_the_fixed_image_side_from_its_subdirectory(tmp_path, monkeypatch):
    sd = tmp_path / "x"
    for side in (sd, sd / "fixed"):
        for sub in ("motion", "rotation"):
            (side / sub).mkdir(parents=True)
            (side / sub / "summary.json").write_text(json.dumps(dict(side=side.name)))
    (sd / "stage.json").write_text(json.dumps(dict(source=dict(sha256="abc"), made=dict(seconds={}))))
    monkeypatch.setattr(ST, "STAGES", tmp_path)
    monkeypatch.setattr(ST, "status", lambda d, root=None: "fresh")
    d = tmp_path / "d"
    (d / "steps").mkdir(parents=True)
    RG.stage_in(dict(stage="x"), d, dict(P_BENCH, horizon="fixed"), RG.ROOT, log=lambda *a: None)
    assert json.loads((d / "motion" / "summary.json").read_text())["side"] == "fixed"


P_BENCH = dict(video="discarded:v.mp4", bbox=[0, 0, 1, 1], pbf="/x.pbf", vehicle="auto")


# ------------------------------------------------------------------ a scattered horizon calibration: the running horizon for a bike too (A27)
# Lahntal (Van Gestel, bike, 2026-11-21): the focus of expansion of the calibration stretches spread 67 rows (others <= 39, Pontaix / Roanne 8-9).
# No fixed row fits it (249: distance right, yaw at half gain; 194: yaw right, 60 % of the distance) and the route stayed at the start (no_route);
# with the running horizon it followed the route (along median 24 m against the coarse GPS).
@pytest.mark.parametrize("vehicle, iqr, mode", [("bike", None, "fixed"), ("bike", 9.0, "fixed"), ("bike", C.HZ_SPREAD_IQR, "fixed"),
                                                ("bike", C.HZ_SPREAD_IQR + 0.1, "running"), ("bike", 67.0, "running"), ("car", 9.0, "running")])
def test_a_scattered_calibration_gives_a_bike_the_running_horizon(vehicle, iqr, mode):
    assert CB.horizon_mode(vehicle, iqr) == mode


@pytest.mark.parametrize("iqr, running", [(9.0, False), (67.0, True)])
def test_a_fixed_horizon_turns_running_when_the_calibration_is_scattered(ex, tmp_path, iqr, running):  # noqa: F811
    t = np.arange(vm.HZ_WINDOW / 2, 400.0, vm.HZ_EVERY)
    cal = dict(CAL, iqr=iqr, rms_median=0.4, rms_pairs=500, track=dict(t=[float(x) for x in t], row=[140.0 if x < 200 else 180.0 for x in t]))
    seen = []
    real = vm.below_horizon
    VI.vm.below_horizon = lambda mid, flow, yh, h: seen.append(yh) or real(mid, flow, yh, h)
    try:
        st = VI.analyse(ex, str(tmp_path / "m.csv"), calibration=json.loads(json.dumps(cal)), seed0=int(300 * FPS), running=False, spread_iqr=C.HZ_SPREAD_IQR)
    finally:
        VI.vm.below_horizon = real
    assert st["horizon_mode"] == ("running" if running else "fixed")
    assert set(np.round(seen, 6)) == ({180.0} if running else {float(CAL["horizon"])})   # the clip lies after 300 s: the track says 180 there
    assert st["horizon_spread"] == dict(iqr=iqr, limit=C.HZ_SPREAD_IQR, running=running)


def test_the_motion_step_passes_the_spread_limit(tmp_path, monkeypatch):
    got = []
    monkeypatch.setattr(SA, "extract_key", lambda video, height: "k")
    monkeypatch.setattr(VI, "ensure_extract", lambda *a, **k: (dict(pairs=1, seconds=1.0), True))
    monkeypatch.setattr(VI, "analyse", lambda *a, **k: got.append(k.get("spread_iqr")) or dict(extract={}, seconds=0.0))
    W = type("W", (), dict(log=lambda *a: None, progress=lambda *a, **k: None))()
    SA.motion_from_extract(tmp_path, dict(video="v.mp4", horizon="fixed"), W, None, 0)
    assert got == [C.HZ_SPREAD_IQR]


def test_the_spread_limit_is_part_of_the_key_of_a_fixed_horizon(tmp_path, monkeypatch):
    run, base = _run(tmp_path)
    h0, hf = run.hashes(dict(base, horizon="running")), run.hashes(dict(base, horizon="fixed"))
    monkeypatch.setattr(C, "HZ_SPREAD_IQR", C.HZ_SPREAD_IQR + 1)
    assert run.hashes(dict(base, horizon="running")) == h0 and run.hashes(dict(base, horizon="fixed"))["motion"] != hf["motion"]




def test_an_estimated_bike_with_a_scattered_calibration_keeps_the_running_horizon(tmp_path, monkeypatch):
    seen = []
    real_mode = CB.horizon_mode
    monkeypatch.setattr(CB, "horizon_mode", lambda v, iqr=None: seen.append(iqr) or real_mode(v, iqr))
    calls, run = _fake_run(tmp_path, monkeypatch, [], ["bike", "bike"], iqr=67.0)
    assert [s for s, _ in calls] == ["motion", "rotation", "map", "route_search", "refine", "gpx"] and {h for _, h in calls} == {"running"}
    assert 67.0 in seen


def test_the_route_tests_keep_the_running_horizon_of_a_scattered_bike(tmp_path, monkeypatch):
    d = tmp_path / "d"
    (d / "motion").mkdir(parents=True)
    (d / "motion" / "motion.json").write_text(json.dumps(dict(horizon_calibration=dict(CAL, iqr=67.0))))
    staged, ran = _staged(tmp_path, monkeypatch, ["bike"])
    assert staged == ["running"] and [s for s, _ in ran] == ["map", "route_search", "refine", "gpx"]
