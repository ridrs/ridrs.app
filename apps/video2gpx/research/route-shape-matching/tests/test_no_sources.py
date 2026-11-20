# SPDX-License-Identifier: AGPL-3.0-or-later
"""T0 guard of docs/CONCEPT_test_strategy.md (step 6): the tests T1 to T3 read test-data/clips/, long/, stages/, truth/, osm/ and dem/, never the full
videos of test-data/sources/ (those are read only by T4, rsm.bench.stages make). The checks are on the paths the tests use, so they run without data."""
import json
import re
from pathlib import Path

from rsm.bench import clips as CL, gps_truth as GT, long as LG, regress as RG, stages as ST

SOURCES = ST.SOURCES.resolve()
APP = ST.APP


def _outside(p) -> bool:
    return SOURCES not in Path(p).resolve().parents and Path(p).resolve() != SOURCES


def test_the_data_folders_of_the_tests_lie_outside_the_sources():
    for p in (CL.CLIPS, LG.LONG, ST.STAGES, ST.TRUTH, GT.ROOT, Path(RG._x("$RSM_OSM_DIR"))):
        assert _outside(p), p


def test_the_clip_and_long_lists_name_no_files():
    for f in ("clip_set.json", "long_set.json"):
        txt = (Path(CL.HERE) / f).read_text()
        assert "sources/" not in txt and "$RSM_VIDEOS" not in txt and ".mp4" not in txt, f


def test_the_route_cases_on_stages_and_long_videos_read_no_source():
    for c in RG.cases():
        if c.get("stage"):
            P = RG.params(c, stage=True)
            assert _outside(P["pbf"]), c["name"]                  # the video path of a stage case is a name only: stage_in reads no video
    for c in LG.long_set():
        base = [x for x in RG.cases() if x["name"] == c["case"]][0]
        assert _outside(RG._x(base["pbf"])), c["id"]
        assert c["t0"] == 0 and (LG.LONG / c["id"]).resolve().parent == LG.LONG.resolve()


def test_the_app_e2e_defaults_read_no_source():
    rs = (APP / "src-tauri" / "tests" / "e2e.rs").read_text()
    defaults = re.findall(r'concat!\(env!\("CARGO_MANIFEST_DIR"\), "([^"]+)"\)', rs)
    assert defaults and all("/sources/" not in d for d in defaults), defaults


def test_the_truth_is_read_from_the_truth_folder():
    for f in (CL, RG):
        src = Path(f.__file__).read_text()
        assert '$V2G_TEST_DATA/sources") / s["verified"]' not in src and '"sources" / src["verified"]' not in src, f.__name__
    for c in json.loads((Path(CL.HERE) / "clip_sources.json").read_text())["sources"]:
        if c.get("verified"):
            assert not Path(c["verified"]).is_absolute()               # relative to truth/ (copied there by rsm.bench.stages truth)
