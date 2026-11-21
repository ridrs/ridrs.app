# SPDX-License-Identifier: AGPL-3.0-or-later
"""Source-free cases (docs/CONCEPT_test_strategy.md, "a rolling set of verified videos"): a stage adopted from an app run's extraction whose source
is discarded afterwards, a verified track from an atlas result (scenic.json), and inexact ranges of a verified track that are not scored."""
import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from rsm.bench import gps_truth as GT, regress as RG, stages as ST
from tests.test_stages import P, _copy_code, _run_dir, _source
from tests.test_stages_extract import _edit, _with_extract


# ------------------------------------------------------------------ the verified track of an atlas result
def test_a_scenic_result_becomes_a_verified_gpx_whose_time_is_the_video_time(tmp_path):
    sc = dict(video_id="abc", t=[63, 64, 65], c=[[2.8161, 39.832197], [2.8162, 39.8322], [2.8163, 39.83221]], e=[663.1, 663.0, 662.9])
    out = tmp_path / "verified.gpx"
    GT.write_scenic_gpx(sc, out)
    lat, lon, tt = GT.read_gpx(out)
    assert list(tt - RG.EPOCH_2000) == [63.0, 64.0, 65.0]
    assert lat[0] == pytest.approx(39.832197) and lon[2] == pytest.approx(2.8163)


# ------------------------------------------------------------------ inexact ranges are not scored
def test_inexact_seconds_are_the_seconds_inside_the_ranges():
    t = np.arange(0.0, 20.0)
    m = RG.inexact_mask(t, [[5, 8, "a cut"], [15, 16, "b"]])
    assert list(np.flatnonzero(m)) == [5, 6, 7, 8, 15, 16]
    assert not RG.inexact_mask(t, None).any()


def _verified_case(tmp_path, monkeypatch, inexact):
    """a straight 1 km road along x, the route at 10 m/s; the verified track agrees except 40 m ahead in 30-40 s"""
    from pyproj import Transformer
    crs = "EPSG:32631"
    t = np.arange(0.0, 90.0)
    s = 10.0 * t
    sg = np.arange(0.0, 1001.0)
    xy = np.column_stack([500000.0 + sg, np.full_like(sg, 4400000.0)])
    d = tmp_path / "run"
    (d / "refine").mkdir(parents=True)
    np.savez(d / "refine" / "result.npz", crs=np.array(crs), t=t, s=s, extrap=np.zeros(len(t), bool), sg=sg, xy=xy)
    (d / "route_points.json").write_text(json.dumps(dict(points=[dict(offset_m=0.0) for _ in t])))
    st = s + np.where((t >= 30) & (t <= 40), 40.0, 0.0)
    lon, lat = Transformer.from_crs(crs, 4326, always_xy=True).transform(500000.0 + st, np.full_like(st, 4400000.0))
    truth = tmp_path / "truth" / "x" / "verified.gpx"
    truth.parent.mkdir(parents=True)
    GT.write_scenic_gpx(dict(t=list(t), c=[[a, b] for a, b in zip(lon, lat)]), truth)
    monkeypatch.setattr(RG, "truth_source", lambda c: dict(gps="x", gps_quality="verified", verified="x/verified.gpx", inexact=inexact))
    monkeypatch.setenv("V2G_TEST_DATA", str(tmp_path))
    return dict(name="x", gps="x", score="gps"), d


def test_the_verified_score_leaves_out_the_inexact_ranges(tmp_path, monkeypatch):
    c, d = _verified_case(tmp_path, monkeypatch, [[29, 41, "the track is unsure around a cut"]])
    r = RG.score_gps(c, d)
    monkeypatch.setattr(RG, "truth_source", lambda c: dict(gps="x", gps_quality="verified", verified="x/verified.gpx"))
    full = RG.score_gps(c, d)
    assert r["along_p90"] < 2.0 and r["n_inexact"] == 13 and r["n_scored"] == full["n_scored"] - 13


def test_the_verified_score_takes_the_offsets_by_time_when_the_route_points_start_after_an_intro(tmp_path, monkeypatch):
    """route_points.json starts at the end of the intro (Sa Calobra: 63 s), the refine result at 0 s"""
    c, d = _verified_case(tmp_path, monkeypatch, None)
    rp = [dict(t=float(t), offset_m=1.5) for t in range(10, 90)]
    (d / "route_points.json").write_text(json.dumps(dict(points=rp)))
    R = dict(np.load(d / "refine" / "result.npz"))
    R["extrap"] = np.arange(90) < 10
    np.savez(d / "refine" / "result.npz", **R)
    r = RG.score_gps(c, d)
    assert r["n_scored"] <= 80 and r["cross_line_median"] == pytest.approx(1.5, abs=0.2)


def test_without_inexact_ranges_the_same_track_scores_the_error(tmp_path, monkeypatch):
    c, d = _verified_case(tmp_path, monkeypatch, None)
    r = RG.score_gps(c, d)
    assert r["along_p90"] > 20.0 and r["n_inexact"] == 0


def test_sa_calobra_is_a_verified_source_free_case_with_its_cut_at_the_turn_inexact():
    src = RG.truth_source(dict(gps="sacalobra"))
    assert src["video"] is None and src["gps_quality"] == "verified" and not Path(src["verified"]).is_absolute()
    assert [r[:2] for r in src["inexact"]] == [[1010, 1040]]
    c = [c for c in RG.cases() if c["name"] == "sacalobra"][0]
    assert c["stage"] == "sacalobra" and c["score"] == "gps" and "video" not in c
    assert "sacalobra" in ST.SOURCE_FREE_IDS and "sacalobra" not in ST.STAGE_IDS


# ------------------------------------------------------------------ a stage adopted from an app run, then without its source
def _adopted(tmp_path, monkeypatch):
    code = _copy_code(tmp_path)
    src = _source(tmp_path)
    run = _with_extract(_run_dir(tmp_path / "app"))                     # an app project's out/: its extraction and its image side
    seen = {}

    def run_case(c, tag, root, from_step, seed, log, d, P, until, cache):
        seen.update(files=sorted(p.name for p in (d / "extract").iterdir()), until=until, video=P["video"], horizon=P.get("horizon", "running"))
        seen["n"] = seen.get("n", 0) + 1                                 # once per image side (running, then fixed)
        fake = _run_dir(tmp_path / f"fake{seen['n']}")
        for sub in ("motion", "rotation", "steps"):
            shutil.copytree(fake / sub, d / sub)
        return d

    monkeypatch.setattr(RG, "run_case", run_case)
    monkeypatch.setattr(ST, "case", lambda sid: dict(id=sid, video=None, bbox=[0, 0, 1, 1]))
    monkeypatch.setattr(ST, "WORK", tmp_path / "work_stages")
    out = ST.adopt(sid="y", run=run, video=src, root=code, out_root=tmp_path / "stages", log=lambda *a: None)
    return code, src, out, seen


def test_adopt_reinterprets_the_runs_extraction_with_the_current_code_and_freezes_without_a_source(tmp_path, monkeypatch):
    code, src, out, seen = _adopted(tmp_path, monkeypatch)
    assert seen["until"] == "rotation" and seen["files"] == ["chunk_00000000.npz", "extract.json"] and seen["video"] == str(src.resolve())
    s = json.loads((out / "stage.json").read_text())
    assert s["source"]["discarded"] is True and s["source"]["path"] is None and s["source"]["name"] == "video.mp4" and s["source"]["sha256"] == ST.sha256(src)
    assert sorted(p.name for p in out.iterdir()) == ["extract", "fixed", "motion", "rotation", "stage.json"]
    assert ST.status(out, root=code) == "fresh"


def test_a_source_free_stage_is_frozen_after_an_interpretation_change_and_retired_after_an_extraction_change(tmp_path, monkeypatch):
    code, src, out, _ = _adopted(tmp_path, monkeypatch)
    src.unlink()                                                        # the source is discarded: the status needs no video
    _edit(code, "vmsx/interpret.py")
    assert ST.status(out, root=code) == "frozen"
    _edit(code, "vmsx/extract.py")
    assert ST.status(out, root=code) == "retire"


def test_the_route_tests_run_a_frozen_stage_and_stop_at_a_retired_one(tmp_path, monkeypatch):
    sd = tmp_path / "x"
    _run_dir(tmp_path)
    shutil.copytree(tmp_path / "work", sd)
    (sd / "stage.json").write_text(json.dumps(dict(source=dict(sha256="abc", discarded=True, path=None), made=dict(seconds={}))))
    monkeypatch.setattr(ST, "STAGES", tmp_path)
    monkeypatch.setattr(ST, "status", lambda d, root=None: "frozen")
    d = tmp_path / "d"
    (d / "steps").mkdir(parents=True)
    logs = []
    RG.stage_in(dict(stage="x"), d, dict(P), RG.ROOT, log=logs.append)
    assert (d / "motion").is_dir() and any("frozen" in m for m in logs)
    monkeypatch.setattr(ST, "status", lambda d, root=None: "retire")
    with pytest.raises(RuntimeError, match="retire"):
        RG.stage_in(dict(stage="x"), tmp_path / "d2", dict(P), RG.ROOT)


def test_the_route_params_of_a_source_free_stage_name_no_source_path(tmp_path, monkeypatch):
    sd = tmp_path / "sacalobra"
    sd.mkdir()
    (sd / "stage.json").write_text(json.dumps(dict(source=dict(sha256="abc", discarded=True, path=None, name="v.mp4"))))
    monkeypatch.setattr(ST, "STAGES", tmp_path)
    c = dict(name="sacalobra", stage="sacalobra", pbf="/x.pbf", bbox=[0, 0, 1, 1])
    assert RG.params(c, stage=True)["video"] == "discarded:v.mp4"
