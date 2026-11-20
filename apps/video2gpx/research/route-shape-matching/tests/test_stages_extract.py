# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stages that hold the extraction (docs/CONCEPT_extraction.md phase 4): a frozen stage keeps extract/ next to motion/ and rotation/; an
interpretation change leaves the stage re-interpretable in minutes (status "reinterpret", `rsm.bench.stages reinterp`), only an extraction change
asks for T4."""
import json
import shutil
from pathlib import Path

import pytest

from rsm.bench import regress as RG, stages as ST, stepcache as SC
from rsm.pipeline import config as C, steps_a as SA
from tests.test_stages import P, _copy_code, _run_dir, _source


def _with_extract(d: Path, key: str = "k-run") -> Path:
    e = d / "extract"
    e.mkdir()
    (e / "chunk_00000000.npz").write_bytes(b"npz")
    (e / "extract.json").write_text(json.dumps(dict(version="extract1", key=key, chunks=[[0, 10, "chunk_00000000.npz"]])))
    return d


def _frozen(tmp_path, extract=True):
    code = _copy_code(tmp_path)
    src = _source(tmp_path)
    work = _run_dir(tmp_path)
    if extract:
        _with_extract(work)
    out = ST.freeze("x", work, src, tmp_path / "sources", dict(P, video=str(src)), tmp_path / "stages", root=code)
    return code, src, out


def _edit(code: Path, rel: str):
    f = code / "rsm" / "pipeline" / rel
    f.write_text(f.read_text() + "\n# edit\n")


def test_freeze_keeps_the_extraction_and_names_it_in_stage_json(tmp_path):
    code, src, out = _frozen(tmp_path)
    assert sorted(p.name for p in out.iterdir()) == ["extract", "motion", "rotation", "stage.json"]
    assert (out / "extract" / "chunk_00000000.npz").read_bytes() == b"npz"
    s = json.loads((out / "stage.json").read_text())
    assert s["extract"] == ST.extract_identity(s["source"]["sha256"], root=code)
    assert {"version", "params", "height", "opencv", "code", "sha256"} <= set(s["extract"])


def test_an_interpretation_change_leaves_the_stage_reinterpretable(tmp_path):
    code, _, out = _frozen(tmp_path)
    assert ST.status(out, root=code) == "fresh"
    _edit(code, "vmsx/interpret.py")
    assert ST.status(out, root=code) == "reinterpret"
    _edit(code, "standstill.py")                                   # a pixel probe or any other image-side code: the same
    assert ST.status(out, root=code) == "reinterpret"


def test_an_extraction_change_makes_the_stage_stale(tmp_path):
    code, _, out = _frozen(tmp_path)
    _edit(code, "vmsx/extract.py")
    assert ST.status(out, root=code) == "stale"


def test_a_stage_without_extraction_stays_stale_on_any_image_side_change(tmp_path):
    code, _, out = _frozen(tmp_path, extract=False)
    _edit(code, "vmsx/interpret.py")
    assert ST.status(out, root=code) == "stale"


def test_reinterp_runs_the_image_side_from_the_stored_extraction_and_freezes_again(tmp_path, monkeypatch):
    code, src, out = _frozen(tmp_path)
    _edit(code, "vmsx/interpret.py")
    seen = {}

    def run_case(c, tag, root, from_step, seed, log, d, P, until, cache):
        m = json.loads((d / "extract" / "extract.json").read_text())
        seen.update(key=m["key"], until=until, files=sorted(p.name for p in (d / "extract").iterdir()))
        fake = _run_dir(tmp_path / "fake")
        for sub in ("motion", "rotation", "steps"):
            shutil.copytree(fake / sub, d / sub)
        return d

    monkeypatch.setattr(RG, "run_case", run_case)
    monkeypatch.setattr(ST, "case", lambda sid: dict(id=sid, video=str(src), bbox=[0, 0, 1, 1]))
    monkeypatch.setattr(ST, "SOURCES", tmp_path / "sources")
    monkeypatch.setattr(ST, "WORK", tmp_path / "work_stages")
    ST.reinterp("x", root=code, out_root=tmp_path / "stages", log=lambda *a: None)
    assert seen["key"] == SA.extract_key(str(src.resolve()), C.VMS["height"])           # the motion step finds the stored extraction its own
    assert seen["until"] == "rotation" and seen["files"] == ["chunk_00000000.npz", "extract.json"]
    assert ST.status(out, root=code) == "fresh" and (out / "extract" / "chunk_00000000.npz").exists()
    assert json.loads((out / "stage.json").read_text())["made"].get("reinterpreted")


def test_reinterp_refuses_a_stale_extraction(tmp_path, monkeypatch):
    code, src, out = _frozen(tmp_path)
    _edit(code, "vmsx/extract.py")
    monkeypatch.setattr(ST, "case", lambda sid: dict(id=sid, video=str(src), bbox=[0, 0, 1, 1]))
    monkeypatch.setattr(ST, "SOURCES", tmp_path / "sources")
    with pytest.raises(RuntimeError, match="T4"):
        ST.reinterp("x", root=code, out_root=tmp_path / "stages", log=lambda *a: None)


def test_the_route_tests_name_the_fast_way_for_a_reinterpretable_stage(tmp_path, monkeypatch):
    monkeypatch.setattr(ST, "status", lambda d, root=None: "reinterpret")
    monkeypatch.setattr(ST, "STAGES", tmp_path)
    with pytest.raises(RuntimeError, match="rsm.bench.stages reinterp"):
        RG.stage_in(dict(stage="x"), tmp_path / "d", dict(P), RG.ROOT)


# ------------------------------------------------------------------ the bench keeps the extraction with the motion step
def _motion_run(d: Path) -> Path:
    (d / "motion").mkdir(parents=True)
    (d / "motion" / "motion.json").write_text("{}")
    (d / "steps").mkdir()
    (d / "steps" / "motion.done.json").write_text(json.dumps(dict(id="motion")))
    return _with_extract(d)


def test_the_step_cache_stores_and_fetches_the_extraction_with_the_motion_step(tmp_path):
    """a cached motion step without its extract/ would send the rotation step back to the video (other band fits for the same keys)"""
    a = _motion_run(tmp_path / "a")
    SC.store(tmp_path / "cache", "case", "motion", "key1", a)
    b = tmp_path / "b"
    b.mkdir()
    assert SC.fetch(tmp_path / "cache", "case", "motion", "key1", b)
    assert (b / "extract" / "extract.json").read_text() == (a / "extract" / "extract.json").read_text()
    assert (b / "extract" / "chunk_00000000.npz").exists()


def test_copy_step_of_the_motion_step_takes_the_extraction(tmp_path):
    a = _motion_run(tmp_path / "a")
    b = tmp_path / "b"
    b.mkdir()
    assert RG.copy_step(a, b, "motion")
    assert (b / "extract" / "extract.json").exists() and (b / "motion" / "motion.json").exists()
