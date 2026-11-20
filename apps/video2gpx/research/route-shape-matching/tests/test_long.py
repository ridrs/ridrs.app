# SPDX-License-Identifier: AGPL-3.0-or-later
"""T3 tooling (rsm.bench.long, docs/CONCEPT_test_strategy.md D): the regress case of a long video and the parity with its frozen stage"""
import json
import shutil

import pytest

from rsm.bench import long as LG, stages as ST
from tests.test_stagecut import _stage


def test_a_long_video_must_start_at_the_source_start():
    with pytest.raises(ValueError, match="second 0"):
        LG.cut(dict(id="x", source="pontaix", t0=5, dur=60))


def test_the_long_case_takes_the_route_case_with_the_long_video(tmp_path, monkeypatch):
    monkeypatch.setattr(LG, "LONG", tmp_path)
    (tmp_path / "g").mkdir()
    (tmp_path / "g" / "case.json").write_text(json.dumps(dict(file="video.mp4", duration=588.0)))
    c = LG.case(dict(id="g", stage="gotthard", dur=588, case="gotthard-start", landmarks="gotthard-start"))
    assert c["name"] == "g" and c["video"] == str(tmp_path / "g" / "video.mp4") and c["window"] == [0.0, 588.0] and c["landmarks"] == "gotthard-start"
    assert c["score"] == "checkpoints" and "start_bbox" not in c and "known" not in c


def test_a_run_equal_to_its_stage_has_full_parity(tmp_path, monkeypatch):
    st = _stage(tmp_path)
    monkeypatch.setattr(ST, "STAGES", tmp_path / "stages")
    monkeypatch.setattr(LG, "LONG", tmp_path / "long")
    (tmp_path / "long" / "x").mkdir(parents=True)
    (tmp_path / "long" / "x" / "case.json").write_text(json.dumps(dict(file="video.mp4", duration=100.0)))
    run = tmp_path / "run"
    shutil.copytree(st, run)
    p = LG.parity(dict(id="x", stage="x", dur=100), run)
    assert p["par_cuts_unmatched"] == 0 and p["par_still_s"] == p["par_still_s_stage"] == 5.0
    assert p["par_v_ratio"] == pytest.approx(1.0) and p["par_yaw_corr"] in (None, pytest.approx(1.0))
