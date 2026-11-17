# SPDX-License-Identifier: AGPL-3.0-or-later
"""development tools of the bench (docs/CONCEPT_fast_testing.md): step cache keys, scan memo, clip window choice"""
import shutil
from pathlib import Path

import numpy as np

from rsm.bench import clips as CL, stepcache as SC

ROOT = Path(__file__).resolve().parents[1]
P = dict(video=__file__, bbox=dict(south=0, west=0, north=1, east=1), pbf="", vehicle="auto")
STEPS = ["motion", "rotation", "map", "route_search", "plausibility", "refine", "gpx"]


def _copy_code(tmp: Path) -> Path:
    shutil.copytree(ROOT / "rsm", tmp / "rsm", ignore=shutil.ignore_patterns("__pycache__"))
    return tmp


def test_a_change_in_local_py_changes_only_refine_and_gpx(tmp_path):
    code = _copy_code(tmp_path)
    k0 = SC.step_keys(code, P, STEPS)
    f = code / "rsm" / "pipeline" / "local.py"
    f.write_text(f.read_text() + "\n# edit\n")
    k1 = SC.step_keys(code, P, STEPS)
    assert [s for s in STEPS if k0[s] != k1[s]] == ["refine", "gpx"]


def test_a_config_value_reaches_only_the_steps_that_read_it(tmp_path):
    code = _copy_code(tmp_path)
    k0 = SC.step_keys(code, P, STEPS)
    f = code / "rsm" / "pipeline" / "config.py"
    f.write_text(f.read_text().replace("LOCAL_ACCEPT_NATS = 5.0", "LOCAL_ACCEPT_NATS = 6.0"))
    k1 = SC.step_keys(code, P, STEPS)
    assert [s for s in STEPS if k0[s] != k1[s]] == ["refine", "gpx"]
    f.write_text(f.read_text().replace("LOCAL_ACCEPT_NATS = 6.0", "LOCAL_ACCEPT_NATS = 5.0").replace('VMS = dict(', 'VMS = dict(_x=1, ', 1))
    k2 = SC.step_keys(code, P, STEPS)
    assert all(k0[s] != k2[s] for s in STEPS)          # the vms config changes everything


def test_motion_does_not_depend_on_the_map_code(tmp_path):
    code = _copy_code(tmp_path)
    k0 = SC.step_keys(code, P, STEPS)
    f = code / "rsm" / "pipeline" / "osm.py"
    f.write_text(f.read_text() + "\n# edit\n")
    k1 = SC.step_keys(code, P, STEPS)
    assert k0["motion"] == k1["motion"] and k0["rotation"] == k1["rotation"] and k0["map"] != k1["map"]


def test_store_and_fetch_round_trip(tmp_path):
    d = tmp_path / "case"
    (d / "refine").mkdir(parents=True); (d / "steps").mkdir()
    (d / "refine" / "x.txt").write_text("1"); (d / "steps" / "refine.done.json").write_text("{}")
    SC.store(tmp_path / "cache", "c", "refine", "k", d)
    e = tmp_path / "other"
    assert SC.fetch(tmp_path / "cache", "c", "refine", "k", e) and (e / "refine" / "x.txt").read_text() == "1"
    assert not SC.fetch(tmp_path / "cache", "c", "refine", "other-key", e)


def test_clip_windows_are_apart_and_cover_the_categories():
    rows = [dict(t0=float(t), usable=1.0 if t != 300 else 0.4, speed=5.0 + (t == 900) * 5, turn=1.0 + (t == 600) * 9) for t in range(60, 1500, 15)]
    picks = CL._pick(rows)
    cats = dict(picks)
    assert cats["turns"] == 600 and cats["fast"] == 900 and cats["weak"] == 300 and "typical" in cats
    t = sorted(t for _, t in picks)
    assert np.all(np.diff(t) >= CL.DUR)


def test_checkpoint_score_measures_the_distance_at_the_checkpoint_second(tmp_path):
    from pyproj import Transformer

    from rsm.bench import regress as RG
    crs = "EPSG:32632"
    xy = np.column_stack([np.linspace(0, 1000, 101) + 450000.0, np.full(101, 5160000.0)])   # a straight path, 1000 m east
    sg = np.linspace(0, 1000, 101)
    t = np.arange(0, 101, dtype=float)
    (tmp_path / "refine").mkdir()
    np.savez(tmp_path / "refine" / "result.npz", crs=crs, xy=xy, sg=sg, t=t, s=10.0 * t, extrap=np.zeros(101, bool))   # 10 m/s
    inv = Transformer.from_crs(crs, 4326, always_xy=True)
    lon0, lat0 = inv.transform(450300.0, 5160000.0)       # the route is here at 30 s
    lon1, lat1 = inv.transform(450500.0, 5160000.0)       # at 80 s the route is 300 m past this point
    L = [dict(name="a", t=30, lat=lat0, lon=lon0, tol_m=50), dict(name="b", t=80, lat=lat1, lon=lon1, tol_m=100)]
    r = RG.score_checkpoints(dict(name="x"), tmp_path, L)
    assert r["cp_ok"] == "1/2"
    assert abs(r["checkpoints"][0]["dist_m"]) < 0.5 and r["checkpoints"][0]["ok"]
    assert abs(r["checkpoints"][1]["dist_m"] - 300) < 0.5 and not r["checkpoints"][1]["ok"]
    assert abs(r["cp_max_m"] - 300) < 0.5
    assert "80: 300!" in RG.fmt_table([dict(case="x", **r)])
