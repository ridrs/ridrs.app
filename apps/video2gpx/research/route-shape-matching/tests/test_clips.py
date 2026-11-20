# SPDX-License-Identifier: AGPL-3.0-or-later
"""the clip bench of T1 (rsm.bench.clips, docs/CONCEPT_test_strategy.md B): the clip list, the stream-copy cut, the horizon calibration of the stage,
the event scores and the checks"""
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np

from rsm.bench import clips as CL, stages as ST, stepcache as SC

ROOT = Path(__file__).resolve().parents[1]


def test_the_clip_list_is_well_formed():
    cl = CL.clip_set()
    ids = [c["id"] for c in cl]
    assert len(ids) == len(set(ids)) and 15 <= len(cl) <= 25
    assert sum(bool(c.get("calibrate")) for c in cl) == 1
    for c in cl:
        assert c["source"] in ST.STAGE_IDS, c
        assert 20 <= c["dur"] <= 75, c
        for t in c.get("cut_at", []):
            assert c["t0"] < t < c["t0"] + c["dur"], c
        for a, b in c.get("still", []):
            assert c["t0"] <= a < b <= c["t0"] + c["dur"], c
        assert c.get("known") or c.get("checks"), f"{c['id']}: no checks"
    assert any(CL.sources()[c["source"]].get("gps_quality") == "verified" for c in cl)


def test_keyframe_at_or_before():
    assert CL.keyframe_at_or_before([0.0, 2.0, 4.0], 3.9) == 2.0
    assert CL.keyframe_at_or_before([0.0, 2.0, 4.0], 4.0) == 4.0
    assert CL.keyframe_at_or_before([2.0, 4.0], 1.0) == 2.0


def test_cut_copies_from_the_keyframe_with_the_source_pixels(tmp_path, monkeypatch):
    src = tmp_path / "sources" / "x" / "video.mp4"
    src.parent.mkdir(parents=True)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=8", "-c:v", "libx264", "-g", "25", "-keyint_min", "25",
                    "-sc_threshold", "0", "-pix_fmt", "yuv420p", str(src)], check=True)
    monkeypatch.setenv("V2G_TEST_DATA", str(tmp_path))
    monkeypatch.setattr(CL, "CLIPS", tmp_path / "clips")
    monkeypatch.setattr(CL, "sources", lambda: {"x": dict(id="x", video="$V2G_TEST_DATA/sources/x/video.mp4")})
    d = CL.cut(dict(id="x-a", source="x", t0=3.5, dur=2.0, kind="test"), log=lambda m: None)
    m = json.loads((d / "clip.json").read_text())
    assert m["t0_exact"] == 3.0 and m["frame0"] == 75 and m["first_frame_equal"] is True
    assert m["source_path"] == "x/video.mp4" and (d / "clip.mp4").exists()
    assert 2.4 <= m["duration"] <= 2.7                       # from the keyframe to the end of the wanted window


def test_a_clip_takes_the_horizon_calibration_of_its_stage(tmp_path, monkeypatch):
    monkeypatch.setattr(CL, "meta", lambda c: dict(file="clip.mp4", frame0=300))
    c = dict(id="pontaix-x", source="pontaix", t0=10, dur=30, kind="t")
    assert CL.params(c)["calibration"] == str(CL.STAGES / "pontaix" / "motion" / "motion.json")
    assert "calibration" not in CL.params(dict(c, calibrate=True))
    assert CL.params(c)["frame0"] == 300                     # seeds the traffic candidate fits as in the whole source


def test_the_calibration_and_the_first_frame_are_part_of_the_image_side_keys(tmp_path):
    shutil.copytree(ROOT / "rsm", tmp_path / "code" / "rsm", ignore=shutil.ignore_patterns("__pycache__"))
    code = tmp_path / "code"
    P = dict(video="", bbox=dict(south=0, west=0, north=1, east=1), pbf=None, vehicle="auto")
    m1, m2 = tmp_path / "m1.json", tmp_path / "m2.json"
    m1.write_text(json.dumps(dict(horizon_calibration=dict(horizon=190.0))))
    m2.write_text(json.dumps(dict(horizon_calibration=dict(horizon=170.0))))
    k0 = SC.step_keys(code, P, ["motion", "rotation"], video_sig="v")
    k1 = SC.step_keys(code, dict(P, calibration=str(m1)), ["motion", "rotation"], video_sig="v")
    k2 = SC.step_keys(code, dict(P, calibration=str(m2)), ["motion", "rotation"], video_sig="v")
    assert len({k0["motion"], k1["motion"], k2["motion"]}) == 3 and len({k0["rotation"], k1["rotation"], k2["rotation"]}) == 3
    k3 = SC.step_keys(code, dict(P, frame0=300), ["motion", "rotation"], video_sig="v")
    assert k3["motion"] != k0["motion"] and SC.step_keys(code, dict(P, frame0=0), ["motion", "rotation"], video_sig="v") == k0


def test_event_scores_count_missed_and_false_events():
    c = dict(cut_at=[20.0, 30.0], still=[[6.5, 12.5], [15.0, 20.0]])
    ev = dict(cuts=[20.1, 25.0], still=[[6.0, 12.5], [16.0, 17.0], [28.0, 29.0]])
    assert CL.event_scores(c, ev) == dict(cuts_missed=1, cuts_false=1, still_missed=1, still_false=1)
    assert CL.event_scores(dict(cut_at=[]), dict(cuts=[], still=[[1.0, 2.0]])) == dict(cuts_missed=0, cuts_false=0)
    assert CL.event_scores(dict(), ev) == {}


def test_check_holds_the_events_and_the_bounds():
    c = dict(checks=dict(min=dict(vs_full_v_corr=0.9), max=dict(v_fail=0.2)))
    assert CL.check(dict(vs_full_v_corr=0.95, v_fail=0.1, cuts_missed=0), c) == []
    bad = CL.check(dict(vs_full_v_corr=0.8, v_fail=None, cuts_false=1, first_frame_equal=False), c)
    assert len(bad) == 4 and any("first frame" in b for b in bad)
    assert CL.check(dict(v_fail=float("nan")), dict(checks=dict(max=dict(v_fail=0.2)))) != []


def test_the_verified_reference_reads_video_time(tmp_path, monkeypatch):
    pts = "".join(f'<trkpt lat="44.7" lon="{5.0 + 1e-4 * i:.6f}"><time>2000-01-01T00:00:{i:02d}Z</time></trkpt>' for i in range(60))
    (tmp_path / "v.gpx").write_text(f'<gpx><trk><trkseg>{pts}</trkseg></trk></gpx>')
    monkeypatch.setenv("V2G_TEST_DATA", str(tmp_path.parent))
    s = dict(gps_quality="verified", verified=f"{tmp_path.name}/v.gpx")
    monkeypatch.setattr(CL, "_x", lambda p: tmp_path.parent if p == "$V2G_TEST_DATA/sources" else Path(p))
    ref = CL.verified_reference(s, 10.0, 20)
    assert ref["inside"] and len(ref["speed"]) == 20
    assert np.allclose(ref["speed"][3:-3], 7.9, atol=0.3)  # 1e-4 deg of longitude at 44.7 N is about 7.9 m, one per second
    assert CL.verified_reference(dict(gps_quality="coarse"), 0.0, 10) is None
