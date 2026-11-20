# SPDX-License-Identifier: AGPL-3.0-or-later
"""T2 on frozen stages (docs/CONCEPT_test_strategy.md C, step 4): the window of a stage (rsm.bench.stagecut), the stage mode of rsm.bench.regress
(motion and rotation from the stage, no video) and the scores by truth quality (verified: timed, coarse: place only)"""
import csv
import json
import pickle
from pathlib import Path

import numpy as np
import pytest

from rsm.bench import regress as RG, stagecut as SK, stages as ST

FPS = 25.0


def _stage(tmp: Path, dur: float = 100.0) -> Path:
    """a synthetic stage: straight ride at 10 m/s, one cut at 60 s, one standstill 30-35 s, windows of 0.28 s, two tracks"""
    d = tmp / "stages" / "x"
    (d / "motion").mkdir(parents=True)
    (d / "rotation").mkdir()
    n = int(dur * FPS)
    head = ["frame", "time", "corners", "tracked", "inliers", "rms_px", "s", "c", "yaw", "pitch", "roll", "diff", "rel_speed", "alts", "pick"]
    with open(d / "motion" / "motion.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(head)
        for i in range(1, n):
            t = i / FPS
            w.writerow([i, f"{t:.4f}", 300, 290, 280, "0.3", "4.0e-04", "0", "0.01", "0", "0", "10.0", f"{4e-4 * FPS:.6e}", "", ""])
    (d / "motion" / "motion.json").write_text(json.dumps(dict(fps=FPS, start=0.0, duration=dur, pairs=n - 1, horizon=150.0)))
    (d / "motion" / "cuts.json").write_text(json.dumps(dict(version="cuts3", candidates=[dict(i=1500, t=60.0, diff=40.0), dict(i=250, t=10.0, diff=30.0)])))
    (d / "motion" / "summary.json").write_text(json.dumps(dict(duration_s=dur, fps=FPS, horizon=150.0, usable_s=dur, usable_share=1.0, n_segments=1, nominal_km=1.0,
                                                              v_nom_p50=10.0, v_nom_p90=10.0)))
    ta = np.arange(0, dur - 0.28, 0.28)
    np.savez_compressed(d / "rotation" / "far_heading.npz", ta=ta, tb=ta + 0.28, dth=np.full(len(ta), 0.001))
    np.savez_compressed(d / "rotation" / "win_video_base.npz", idx=np.arange(len(ta)), ta=ta, tb=ta + 0.28, fields=np.array(["a"] * 10), data=np.zeros((len(ta), 3, 10)),
                        ok=np.ones((len(ta), 3), bool), n_pts=np.ones((len(ta), 3)), n_inl=np.ones((len(ta), 3)), why=np.zeros((len(ta), 3)),
                        meta=np.array(json.dumps(dict(fps=FPS, n_windows=len(ta)))))
    tt = np.arange(0, dur, 1.0)
    pickle.dump([dict(t=tt[tt < 60], s=10 * tt[tt < 60], th=0.01 * tt[tt < 60]), dict(t=tt[tt >= 60] , s=10 * (tt[tt >= 60] - 60), th=np.zeros((tt >= 60).sum()))],
                open(d / "rotation" / "tracks.pkl", "wb"))
    (d / "rotation" / "cuts.json").write_text(json.dumps(dict(version="cuts3", cuts=[dict(t=60.0, t_first=60.0, t_last=60.0)], rejected=[dict(t=10.0)], candidates=[],
                                                              n_cuts=1, cut_times=[60.0], intro_end=None, intro_source=None, inserted=[])))
    (d / "rotation" / "standstill.json").write_text(json.dumps(dict(version=2, spans=[[30.0, 35.0]], windows=[dict(t=32.0, still=True)])))
    (d / "rotation" / "vehicle.json").write_text(json.dumps(dict(vehicle="auto")))
    (d / "rotation" / "summary.json").write_text(json.dumps(dict(features={})))
    (d / "stage.json").write_text(json.dumps(dict(version=1, case="x", source=dict(path="x/video.mp4", sha256="abc", duration_s=dur, fps=FPS),
                                                  made=dict(seconds=dict(motion=1.0, rotation=2.0)), params=dict(vehicle="auto", bbox=dict(south=0, west=0, north=1, east=1)))))
    return d


def test_a_window_shifts_every_series_to_start_at_zero(tmp_path):
    out = SK.window(_stage(tmp_path), 25.0, 75.0, tmp_path / "w")
    rows = list(csv.DictReader(open(out / "motion" / "motion.csv")))
    assert float(rows[0]["time"]) == 0.0 and float(rows[-1]["time"]) < 50.0 and rows[0]["frame"] == "1"
    assert json.loads((out / "motion" / "motion.json").read_text())["duration"] == 50.0
    assert [c["t"] for c in json.loads((out / "motion" / "cuts.json").read_text())["candidates"]] == [35.0]
    s = json.loads((out / "motion" / "summary.json").read_text())
    assert s["duration_s"] == 50.0 and 0.9 <= s["usable_share"] <= 1.0
    z = np.load(out / "rotation" / "far_heading.npz")
    assert z["ta"][0] >= 0.0 and z["tb"][-1] <= 50.0
    w = np.load(out / "rotation" / "win_video_base.npz")
    assert w["idx"][0] == 0 and len(w["idx"]) == len(z["ta"]) and json.loads(str(w["meta"]))["n_windows"] == len(z["ta"])
    tr = pickle.load(open(out / "rotation" / "tracks.pkl", "rb"))
    assert len(tr) == 2 and tr[0]["t"][0] == 0.0 and tr[0]["s"][0] == 0.0 and tr[0]["th"][0] == 0.0 and tr[1]["t"][0] == 35.0
    cj = json.loads((out / "rotation" / "cuts.json").read_text())
    assert cj["cut_times"] == [35.0] and cj["n_cuts"] == 1 and cj["rejected"] == []
    assert json.loads((out / "rotation" / "standstill.json").read_text())["spans"] == [[5.0, 10.0]]


def test_a_window_outside_the_stage_is_refused(tmp_path):
    with pytest.raises(ValueError):
        SK.window(_stage(tmp_path), 50.0, 150.0, tmp_path / "w")


def test_the_stage_mode_reads_no_video(tmp_path, monkeypatch):
    d0 = _stage(tmp_path)
    monkeypatch.setattr(ST, "STAGES", tmp_path / "stages")
    monkeypatch.setattr(ST, "status", lambda d, root=None: "fresh")
    c = dict(name="x", stage="x", window=[25.0, 75.0], video="/nowhere/video.mp4", pbf="/nowhere/x.pbf", bbox=[0, 0, 1, 1])
    P = RG.params(c, stage=True)
    assert P["video"] == str(ST.SOURCES / "x" / "video.mp4")
    d = tmp_path / "run"
    (d / "steps").mkdir(parents=True)
    keys = RG.stage_in(c, d, P, RG.ROOT, log=lambda m: None)
    assert json.loads((d / "steps" / "rotation.done.json").read_text())["window"] == [25.0, 75.0]
    assert (d / "rotation" / "tracks.pkl").exists() and (d / "motion" / "motion.csv").exists()
    d2 = tmp_path / "run2"
    (d2 / "steps").mkdir(parents=True)
    full = RG.stage_in(dict(c, window=None), d2, P, RG.ROOT, log=lambda m: None)
    assert keys["map"] != full["map"] and set(keys) == set(RG.STEPS)
    monkeypatch.setattr(ST, "status", lambda d, root=None: "stale")
    with pytest.raises(RuntimeError, match="stale"):
        RG.stage_in(c, d, P, RG.ROOT, log=lambda m: None)
    assert d0.exists()


def test_landmarks_move_to_route_seconds_and_outside_ones_are_dropped(monkeypatch, tmp_path):
    L = {"m": [dict(name="a", t=100.0), dict(name="b", t=300.0), dict(name="c", t=500.0)]}
    f = tmp_path / "regress_landmarks.json"
    f.write_text(json.dumps(L))
    monkeypatch.setattr(RG, "HERE", tmp_path)
    assert [x["t"] for x in RG._landmarks(dict(name="m"))] == [100.0, 300.0, 500.0]
    assert [(x["name"], x["t"]) for x in RG._landmarks(dict(name="w", landmarks="m", window=[200, 400]))] == [("b", 100.0)]


def test_truth_quality_decides_timed_or_place_scores():
    assert RG.gps_quality(dict(gps="pontaix-chamaloc")) == "verified"
    assert RG.gps_quality(dict(gps="col-de-rousset")) == "coarse"
    assert RG.gps_quality(dict(gps="unknown")) == "coarse"


def test_the_place_score_needs_no_time(tmp_path, monkeypatch):
    from rsm.bench import gps_truth as GT
    x = np.linspace(0, 1000, 1001)
    monkeypatch.setattr(GT, "gps_base", lambda name, crs: dict(x=x + 450000.0, y=np.full_like(x, 5160000.0)))
    d = tmp_path / "run"
    (d / "refine").mkdir(parents=True)
    sg = np.arange(0, 1000.0)
    xy = np.column_stack([sg + 450000.0, np.full_like(sg, 5160005.0)])                  # 5 m beside the track
    xy[600:] += [0, 40.0]                                                                # the last 400 m on another road, 45 m away
    t = np.arange(0, 100.0)
    np.savez(d / "refine" / "result.npz", crs="EPSG:32632", sg=sg, xy=xy, t=t, s=t * 9.0, extrap=np.zeros(len(t), bool))
    r = RG.score_gps(dict(gps="col-de-rousset", window=[1000, 1100]), d)
    assert r["truth"] == "coarse" and abs(r["place_road"] - 67 / 100) < 0.02 and 4.0 <= r["place_median_m"] <= 6.0
    assert r["off_place_seconds"][0][0] >= 1066.0                                        # in video seconds: the window start added back


def test_a_window_keeps_the_running_horizon_of_its_pairs(tmp_path):
    """the running horizon track is in source seconds (vmsx.motion.HZ_*): a window shifts `track_t0` by its start, so a pair keeps its row"""
    from rsm.pipeline.vmsx import motion as vm
    st = _stage(tmp_path)
    mj = json.loads((st / "motion" / "motion.json").read_text())
    mj.update(horizon_vms=150.0, track_t0=0.0, horizon_calibration=dict(horizon=150.0, track=dict(t=[2.5 + 5 * k for k in range(20)], row=[140.0] * 8 + [180.0] * 12)))
    (st / "motion" / "motion.json").write_text(json.dumps(mj))
    out = SK.window(st, 50.0, 90.0, tmp_path / "w")
    wj = json.loads((out / "motion" / "motion.json").read_text())
    assert wj["track_t0"] == 50.0
    assert vm.horizon_at(wj, 30.0) == pytest.approx(vm.horizon_at(mj, 80.0))
