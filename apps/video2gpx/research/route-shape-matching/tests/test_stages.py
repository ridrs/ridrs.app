# SPDX-License-Identifier: AGPL-3.0-or-later
"""frozen image-analysis results (rsm.bench.stages, docs/CONCEPT_test_strategy.md A and step 2): stage.json, keys by source hash, fresh / stale"""
import json
import shutil
from pathlib import Path

from rsm.bench import stages as ST, stepcache as SC

ROOT = Path(__file__).resolve().parents[1]
P = dict(video="", bbox=dict(south=0, west=0, north=1, east=1), pbf=None, vehicle="auto")


def _copy_code(tmp: Path) -> Path:
    shutil.copytree(ROOT / "rsm", tmp / "code" / "rsm", ignore=shutil.ignore_patterns("__pycache__"))
    return tmp / "code"


def _run_dir(tmp: Path) -> Path:
    """a finished image side as the pipeline leaves it (contents are placeholders)"""
    d = tmp / "work"
    for sub, files in (("motion", ("motion.csv", "motion.json", "cuts.json")), ("rotation", ("win_video_base.npz", "tracks.pkl", "far_heading.npz", "cuts.json", "vehicle.json",
                                                                                           "summary.json", "standstill.json"))):
        (d / sub).mkdir(parents=True)
        for f in files:
            (d / sub / f).write_text("{}")
    (d / "motion" / "summary.json").write_text(json.dumps(dict(horizon=171.5, fps=30.0, duration_s=600.0)))
    (d / "steps").mkdir()
    for sid, sec in (("motion", 12.5), ("rotation", 4.0)):
        (d / "steps" / f"{sid}.done.json").write_text(json.dumps(dict(id=sid, seconds=sec)))
    (d / "map").mkdir()                                   # not part of a stage
    return d


def _source(tmp: Path, body: bytes = b"video bytes") -> Path:
    s = tmp / "sources" / "x" / "video.mp4"
    s.parent.mkdir(parents=True)
    s.write_bytes(body)
    return s


def test_keys_follow_the_source_hash_not_its_path(tmp_path):
    code = _copy_code(tmp_path)
    a = SC.step_keys(code, dict(P, video="/old/place.mp4"), ["motion", "rotation"], video_sig="sha-1")
    b = SC.step_keys(code, dict(P, video="/new/place.mp4"), ["motion", "rotation"], video_sig="sha-1")
    c = SC.step_keys(code, dict(P, video="/new/place.mp4"), ["motion", "rotation"], video_sig="sha-2")
    assert a == b and a["motion"] != c["motion"] and a["rotation"] != c["rotation"]


def test_freeze_writes_the_contract_and_stage_json(tmp_path):
    code = _copy_code(tmp_path)
    src = _source(tmp_path)
    out = ST.freeze("x", _run_dir(tmp_path), src, tmp_path / "sources", dict(P, video=str(src)), tmp_path / "stages", root=code,
                    gps_align=dict(span_s=20.0, used=[[150.0, 1.2]]))
    assert sorted(p.name for p in out.iterdir()) == ["motion", "rotation", "stage.json"]
    assert (out / "rotation" / "standstill.json").exists() and (out / "motion" / "motion.csv").exists()
    s = json.loads((out / "stage.json").read_text())
    assert s["version"] == 1 and s["case"] == "x"
    assert s["source"]["path"] == "x/video.mp4" and s["source"]["sha256"] == ST.sha256(src) and s["source"]["fps"] == 30.0
    assert s["window"] == [0.0, 600.0] and s["horizon"] == 171.5
    assert s["params"]["vehicle"] == "auto" and s["params"]["bbox"] == P["bbox"]
    assert s["code"] == SC.step_keys(code, dict(P, video=str(src)), ["motion", "rotation"], video_sig=s["source"]["sha256"])
    assert s["gps_align"]["used"] == [[150.0, 1.2]] and s["made"]["seconds"] == dict(motion=12.5, rotation=4.0)


def test_a_stage_is_fresh_until_the_image_side_code_changes(tmp_path):
    code = _copy_code(tmp_path)
    src = _source(tmp_path)
    out = ST.freeze("x", _run_dir(tmp_path), src, tmp_path / "sources", dict(P, video=str(src)), tmp_path / "stages", root=code,
                    fixed=_run_dir(tmp_path / "fixed"))
    assert ST.status(out, root=code) == "fresh"
    f = code / "rsm" / "pipeline" / "local.py"                    # route side only: the stage stays fresh
    f.write_text(f.read_text() + "\n# edit\n")
    assert ST.status(out, root=code) == "fresh"
    f = code / "rsm" / "pipeline" / "standstill.py"               # image side: stale
    f.write_text(f.read_text() + "\n# edit\n")
    assert ST.status(out, root=code) == "stale"
    assert ST.status(tmp_path / "stages" / "nothing", root=code) == "missing"


def test_the_stage_list_names_existing_sources():
    for sid in ST.STAGE_IDS:
        c = ST.case(sid)
        assert c["video"].startswith("$V2G_TEST_DATA/sources/") or c["video"].startswith("$RSM_VIDEOS/"), c
        assert len(c["bbox"]) == 4


def test_rekey_gives_a_stale_stage_the_current_keys_and_keeps_the_old(tmp_path):
    code = _copy_code(tmp_path)
    src = _source(tmp_path)
    out = ST.freeze("x", _run_dir(tmp_path), src, tmp_path / "sources", dict(P, video=str(src)), tmp_path / "stages", root=code,
                    fixed=_run_dir(tmp_path / "fixed"))
    old = json.loads((out / "stage.json").read_text())["code"]
    f = code / "rsm" / "pipeline" / "standstill.py"
    f.write_text(f.read_text() + "\n# a comment\n")
    assert ST.status(out, root=code) == "stale"
    s = ST.rekey("x", "a comment only", root=code, out_root=tmp_path / "stages")
    assert ST.status(out, root=code) == "fresh"
    assert s["rekeyed"][0]["old"] == old and s["rekeyed"][0]["reason"] == "a comment only"
    assert s["code_fixed"] == SC.step_keys(code, dict(P, video=str(ST.SOURCES / s["source"]["path"]), horizon="fixed"), ["motion", "rotation"],
                                           video_sig=s["source"]["sha256"]) and s["rekeyed"][0]["old_fixed"] != s["code_fixed"]
    assert len(ST.rekey("x", "again", root=code, out_root=tmp_path / "stages")["rekeyed"]) == 1     # nothing to do: no second entry
