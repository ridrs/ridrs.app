# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.pipeline: fixed rules, events, driving line, graph builder, decoy boxes, verdict, retime, packaging hygiene."""
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import pytest

from rsm.pipeline import config as C, offset as O, osm, steps_b, steps_d, tracks as T
from rsm.pipeline.traffic import traffic_side

ROOT = Path(__file__).resolve().parents[1]


def test_scan_grids_are_wide_and_fixed():
    assert C.F_GRID[0] == pytest.approx(250.0) and C.F_GRID[-1] == pytest.approx(600.0) and len(C.F_GRID) == 11
    assert C.K_GRID[0] == pytest.approx(0.8) and C.K_GRID[-1] == pytest.approx(3.5) and len(C.K_GRID) == 8
    r = np.diff(np.log(C.F_GRID)); assert np.allclose(r, r[0])             # log steps
    assert C.MAX_WORKERS == 4 and C.MEMGUARD == dict(max_gb=12.0, min_free=25.0)


def test_traffic_side_offline():
    for lon, lat, side in [(-0.12, 51.5, "left"), (-6.26, 53.35, "left"), (139.7, 35.7, "left"), (151.2, -33.9, "left"), (174.8, -41.3, "left"), (18.4, -33.9, "left"), (77.2, 28.6, "left"),
                           (33.4, 35.1, "left"), (14.5, 35.9, "left"), (14.55, 40.63, "right"), (2.35, 48.85, "right"), (8.5, 47.4, "right"), (-74, 40.7, "right"), (5.2, 44.7, "right")]:
        assert traffic_side(lon, lat)[0] == side, (lon, lat)


def _hairpin(R, turn="right", n_straight=40):
    s = np.arange(0, n_straight, 1.0)
    st = np.column_stack([s, np.zeros_like(s)])
    th = np.arange(0, np.pi, 1.0 / R)
    sg = -1.0 if turn == "right" else 1.0
    arc = np.column_stack([n_straight + R * np.sin(th), sg * R * (1 - np.cos(th))])
    back = np.column_stack([n_straight - np.arange(1, n_straight, 1.0), sg * 2 * R * np.ones(n_straight - 1)])
    return np.vstack([st, arc, back])


@pytest.mark.parametrize("turn,R", [("right", 8.0), ("left", 8.0), ("right", 3.0), ("left", 3.0), ("right", 15.0)])
def test_driving_line_has_no_loops_in_hairpins(turn, R):
    xy = _hairpin(R, turn)
    P, dl, g = O.driving_line(xy, 1.5, "right")
    assert not O.has_loops(P, xy)
    assert g.min() > 0.3
    assert np.abs(dl).max() <= 1.5 + 1e-9
    L = np.hypot(*np.diff(P, axis=0).T).sum() / np.hypot(*np.diff(xy, axis=0).T).sum()
    assert 0.8 < L < 1.2


def test_driving_line_straight_side_and_oneway():
    xy = np.column_stack([np.arange(0, 200.0), np.zeros(200)])            # heading east
    P, dl, _ = O.driving_line(xy, 1.5, "right")
    assert np.allclose(P[50:150, 1], -1.5, atol=1e-6)                        # right of east = south
    P, _, _ = O.driving_line(xy, 1.5, "left")
    assert np.allclose(P[50:150, 1], 1.5, atol=1e-6)
    ow = np.zeros(200, bool); ow[60:140] = True
    P, dl, _ = O.driving_line(xy, 1.5, "right", ow)
    assert abs(dl[100]) < 0.05 and abs(dl[10]) > 1.4                          # 0 m on one-way stretches, ramp in between
    assert np.all(np.abs(np.diff(dl)) < 0.2)


def test_driving_line_vertex_kink_is_smoothed():
    xy = np.vstack([np.column_stack([np.arange(0, 50.0), np.zeros(50)]), np.column_stack([50 + np.zeros(30), np.arange(1, 31.0)])])   # sharp 90 deg vertex (inner side right)
    P, _, g = O.driving_line(xy, 1.5, "right")
    assert not O.has_loops(P, xy) and g.min() > 0.3


def test_default_offsets():
    assert C.OFFSET_M == {"bike": 1.5, "motorcycle": 1.6, "car": 1.6}


def test_graph_builder_oneway_roundabout_and_split():
    nodes = {1: (45.0, 5.0), 2: (45.0, 5.001), 3: (45.0, 5.002), 4: (45.001, 5.001), 5: (45.001, 5.002), 6: (45.002, 5.0), 7: (45.002, 5.001)}
    ways = [(10, {"highway": "tertiary", "name": "A"}, [1, 2, 3]),                  # split at 2 (shared with way 11)
            (11, {"highway": "unclassified", "oneway": "yes"}, [2, 4]),
            (12, {"highway": "residential", "junction": "roundabout"}, [4, 5, 7, 4]),
            (13, {"highway": "tertiary", "oneway": "-1"}, [6, 7])]
    g = osm.build_graph(ways, nodes)
    e = list(zip(g.edge_way.tolist(), g.edge_oneway.tolist()))
    assert e.count((10, False)) == 4                                                  # 1-2, 2-3 in both directions
    assert e.count((11, True)) == 1 and e.count((13, True)) == 1
    assert (g.edge_way == 12).sum() == 2 and g.edge_oneway[g.edge_way == 12].all()
    i13 = int(np.flatnonzero(g.edge_way == 13)[0])
    assert g.node_osm[g.edge_u[i13]] == 7 and g.node_osm[g.edge_v[i13]] == 6          # oneway=-1 runs against the node order
    assert g.crs.startswith("EPSG:326") and g.edge_len.min() > 50


def test_road_classes_unchanged_and_bike_paths_separate():
    assert C.CLASSES_MOTOR == ("motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified")
    assert C.CLASSES_BIKE == ("trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential", "living_street")
    assert C.CLASSES_BIKE_PATHS[:len(C.CLASSES_BIKE)] == C.CLASSES_BIKE and {"cycleway", "path", "track", "service"} <= set(C.CLASSES_BIKE_PATHS)
    assert not set(C.BIKE_PATH_CLASSES) & set(C.CLASSES_MOTOR) and "steps" not in C.CLASSES_BIKE_PATHS
    assert osm.rules_token(C.CLASSES_MOTOR) == [] and osm.rules_token(C.CLASSES_BIKE) == [] and osm.rules_token(C.CLASSES_BIKE_PATHS) == [C.BIKE_PATH_RULES]


def test_bike_paths_are_off_by_default():
    assert C.BIKE_PATHS_ON is False and C.BIKE_PATHS_FALLBACK is False
    for req in ("bike", "auto", "motorcycle", "car"):
        assert steps_b.bike_paths_mode(dict(requested=req, effective="bike" if req in ("bike", "auto") else req)) == (False, False)


def test_bike_paths_only_for_a_bike_profile_or_as_fallback_for_an_estimated_bike(monkeypatch):
    monkeypatch.setattr(C, "BIKE_PATHS_ON", True)
    monkeypatch.setattr(C, "BIKE_PATHS_FALLBACK", True)
    m = steps_b.bike_paths_mode
    assert m(dict(requested="bike", effective="bike")) == (True, False)
    assert m(dict(requested="auto", effective="bike")) == (False, True)
    for v in ("motorcycle", "car"):
        assert m(dict(requested=v, effective=v)) == (False, False) and m(dict(requested="auto", effective=v)) == (False, False)


def test_subset_of_a_larger_extract_builds_the_same_road_graph():
    nodes = {1: (47.0, 11.0), 2: (47.0, 11.001), 3: (47.0, 11.002), 4: (47.001, 11.001), 5: (47.002, 11.001)}
    roads = [(1, {"highway": "tertiary"}, [1, 2, 3])]
    ways = roads + [(2, {"highway": "track"}, [2, 4, 5])]                              # the track would split the road at node 2
    a = osm.build_graph(roads, {k: nodes[k] for k in (1, 2, 3)})
    b = osm.build_graph(*osm.subset(ways, nodes, C.CLASSES_BIKE))
    assert a.n_edges == b.n_edges == 2 and np.array_equal(a.edge_geom, b.edge_geom) and np.array_equal(a.edge_len, b.edge_len) and a.crs == b.crs
    assert osm.build_graph(ways, nodes).n_edges == 6                                  # with the track: road split in two, both directions


@pytest.mark.parametrize("tags,ok", [
    ({"highway": "primary"}, True), ({"highway": "primary", "access": "private"}, False),
    ({"highway": "residential", "bicycle": "no"}, True),                                  # roads: unchanged rule (only access=private)
    ({"highway": "cycleway"}, True), ({"highway": "cycleway", "access": "no"}, False), ({"highway": "cycleway", "bicycle": "dismount"}, False),
    ({"highway": "path"}, True), ({"highway": "path", "surface": "fine_gravel"}, True),
    ({"highway": "path", "foot": "designated"}, False), ({"highway": "path", "foot": "designated", "bicycle": "designated"}, True),
    ({"highway": "path", "mtb:scale": "3"}, False), ({"highway": "path", "mtb:scale": "3", "bicycle": "yes"}, True), ({"highway": "path", "surface": "rock"}, False),
    ({"highway": "path", "bicycle": "no"}, False),
    ({"highway": "track"}, True), ({"highway": "track", "tracktype": "grade2", "motor_vehicle": "no"}, True), ({"highway": "track", "motor_vehicle": "agricultural"}, True),
    ({"highway": "track", "tracktype": "grade5"}, False), ({"highway": "track", "tracktype": "grade5", "bicycle": "designated"}, True),
    ({"highway": "track", "access": "private"}, False), ({"highway": "track", "access": "private", "bicycle": "yes"}, True), ({"highway": "track", "vehicle": "no"}, False),
    ({"highway": "service"}, False), ({"highway": "service", "bicycle": "yes"}, True), ({"highway": "footway"}, False), ({"highway": "footway", "bicycle": "designated"}, True),
    ({"highway": "pedestrian", "bicycle": "permissive"}, True), ({"highway": "bridleway"}, False),
])
def test_bike_path_access_rule(tags, ok):
    assert osm.way_ok(tags) is ok


def test_bike_path_ways_build_a_graph_with_their_class():
    nodes = {1: (47.0, 11.0), 2: (47.0, 11.001), 3: (47.001, 11.001)}
    g = osm.build_graph([(1, {"highway": "track", "tracktype": "grade2"}, [1, 2]), (2, {"highway": "cycleway", "oneway": "yes"}, [2, 3])], nodes)
    assert sorted(set(g.edge_highway.tolist())) == ["cycleway", "track"] and (g.edge_highway == "track").sum() == 2 and (g.edge_highway == "cycleway").sum() == 1


def test_bike_tier_order():
    assert osm.bike_tier({"highway": "secondary"}) == 0 and osm.bike_tier({"highway": "cycleway"}) == 0 and osm.bike_tier({"highway": "path", "bicycle": "designated"}) == 0
    assert osm.bike_tier({"highway": "track", "bicycle": "yes"}) == 1 and osm.bike_tier({"highway": "track", "tracktype": "grade2"}) == 2
    assert {"highway", "bicycle", "tracktype", "surface"} <= set(osm.TAGS)              # the graph builder keeps only TAGS: edge_tiers reads them
    assert osm.bike_tier({"highway": "path", "surface": "asphalt"}) == 3 and osm.bike_tier({"highway": "path"}) == 4 and osm.bike_tier({"highway": "track", "tracktype": "grade3"}) == 4


def test_fit_tiers_gives_up_the_highest_bike_path_tiers_until_the_hmm_fits():
    nodes = {i: (47.0 + 0.001 * (i // 10), 11.0 + 0.001 * (i % 10)) for i in range(40)}
    ways = [(1, {"highway": "tertiary"}, list(range(0, 10))), (2, {"highway": "track", "tracktype": "grade2"}, list(range(10, 20))),
            (3, {"highway": "path"}, list(range(20, 30))), (4, {"highway": "path"}, list(range(30, 40)))]
    g = osm.build_graph(ways, nodes)
    tiers = osm.edge_tiers(g, ways)
    E = np.arange(g.n_edges)
    assert sorted(set(tiers.tolist())) == [0, 2, 4]
    gb = lambda sel: osm.memory_plan(g, sel, 1000, 1e9)["gb"]
    E, t = steps_b.fit_tiers(g, np.arange(g.n_edges), tiers, 1000, cap_gb=gb(np.arange(g.n_edges)) * 1.01)
    assert t is None and len(E) == g.n_edges                                          # fits: nothing given up
    E, t = steps_b.fit_tiers(g, np.arange(g.n_edges), tiers, 1000, cap_gb=gb(np.flatnonzero(tiers <= 2)) * 1.01)
    assert t in (2, 3) and set(tiers[E].tolist()) == {0, 2}                            # untagged paths given up first
    E, t = steps_b.fit_tiers(g, np.arange(g.n_edges), tiers, 1000, cap_gb=gb(np.flatnonzero(tiers == 0)) * 1.01)
    assert t in (0, 1) and set(tiers[E].tolist()) == {0}
    with pytest.raises(MemoryError):                                                   # roads alone too large: the error stands
        steps_b.fit_tiers(g, np.arange(g.n_edges), tiers, 1000, cap_gb=gb(np.flatnonzero(tiers == 0)) * 0.5)


def test_bbox_parse():
    assert osm.parse_bbox("40.5,14.3,40.7,14.8") == dict(south=40.5, west=14.3, north=40.7, east=14.8)
    for bad in ("1,2,3", "40.7,14.3,40.5,14.8", "a,b,c,d"):
        with pytest.raises(ValueError):
            osm.parse_bbox(bad)


def test_foreign_boxes_rule():
    rng = np.random.default_rng(0)
    km = rng.uniform(5, 15, (600, 800))
    D = dict(lat0=40.0, lon0=5.0, km=km)
    bbox = dict(south=42.0, west=7.0, north=42.3, east=7.4)
    fb = osm.foreign_boxes(D, bbox, None)
    assert len(fb) == 3
    w, h = osm.bbox_km(bbox)
    for f in fb:
        b = f["bbox"]
        assert abs(osm.bbox_km(b)[1] - h) / h < 0.02
        assert 0.7 <= f["ratio"] <= 1.4
        gap = (b["west"] > bbox["east"] + 0.5 * (bbox["east"] - bbox["west"]) or b["east"] < bbox["west"] - 0.5 * (bbox["east"] - bbox["west"])
               or b["south"] > bbox["north"] + 0.5 * (bbox["north"] - bbox["south"]) or b["north"] < bbox["south"] - 0.5 * (bbox["north"] - bbox["south"]))
        assert gap
    assert fb == osm.foreign_boxes(D, bbox, None)                                      # deterministic


def test_memory_plan_aborts_above_4gb():
    class G:
        edge_len = np.full(1000, 30.0 * 0.8)
    with pytest.raises(MemoryError, match="4.0 GB"):
        osm.memory_plan(G, np.arange(1000), T=2_000_000)
    assert osm.memory_plan(G, np.arange(1000), T=600)["gb"] < 0.01


@pytest.mark.parametrize("nf", [3, 2, 0])
def test_decoy_families_are_19(nf):
    from rsm.hmm import seq
    t = np.arange(0, 400.0)
    st = seq.Steps(t, np.r_[np.nan, np.random.default_rng(1).normal(0, .1, 399)], np.full(400, 30.0), np.zeros(400), np.full(400, 5.0), np.zeros(400, bool), np.zeros(400, int), 30.0)
    f = steps_b.families(st, nf)
    assert len(f) == 19
    assert sum(x["fam"] == "mirror" for x in f) == 1 and sum(x["fam"] == "foreign" for x in f) == nf and sum(x["fam"] == "foreign+shuffle" for x in f) == nf
    assert all(len(x["st"].dth) == 400 for x in f)


def test_verdict_rule():
    mk = lambda rank, margin: dict(rank=rank, margin=margin)
    assert steps_b.verdict_of(mk(1, 12.2)) == "confident" and steps_b.verdict_of(mk(1, 14.5)) == "confident"
    assert steps_b.verdict_of(mk(1, 2.5)) == "uncertain"                                # Rousset
    assert steps_b.verdict_of(mk(3, -0.46)) == "no_route"                               # Amalfi with the vms yaw
    done = {"real": dict(per_km=-20.0), **{f"d{i}": dict(per_km=-30.0 - i, fam="shuffle") for i in range(19)}}
    r = steps_b.rank(done)
    assert r["rank"] == 1 and r["n"] == 19 and r["p"] == pytest.approx(0.05) and r["margin"] == pytest.approx(10.0)


def test_vehicle_estimate_on_dev_features():
    bike = dict(yaw_ratio=1.0, frac_vms=0.03, lean_p95_deg=11.0, v_nom_p90=9.6)
    moto = dict(yaw_ratio=4.5, frac_vms=0.29, lean_p95_deg=16.9, v_nom_p90=6.0)
    car = dict(yaw_ratio=1.0, frac_vms=0.02, lean_p95_deg=4.0, v_nom_p90=20.0)
    assert T.estimate_vehicle(bike)["vehicle"] == "bike" and T.estimate_vehicle(moto)["vehicle"] == "motorcycle" and T.estimate_vehicle(car)["vehicle"] == "motorcycle"


def _fake_project(d: Path):
    pts = [dict(t=float(i), lat=45.0 + i * 1e-5, lon=5.0, heading=0.0, confidence=0.9, in_gap=i == 2, extrapolated=i == 0, sd_m=5.0, arc_m=i * 5.0, offset_m=1.5) for i in range(4)]
    (d / "route_points.json").write_text(json.dumps(dict(meta="x", verdict="confident", points=pts)))
    (d / "project.json").write_text(json.dumps(dict(params=dict(video="/x/ride.mp4"), effective=dict(offset_m=1.5, traffic_side="right", vehicle="bike", start_time="2000-01-01T00:00:00Z"),
                                                    driving_line=dict(rule="driving line: approximation"))))


def test_retime_rewrites_only_times(tmp_path):
    _fake_project(tmp_path)
    r = steps_d.retime(tmp_path, "2026-05-01T08:30:00+02:00")
    assert r["start_time"] == "2026-05-01T06:30:00Z"
    ns = {"g": "http://www.topografix.com/GPX/1/1", "rsm": "https://ridrs.org/rsm/1"}
    root = ET.parse(tmp_path / "route.gpx").getroot()
    tp = root.findall(".//g:trkpt", ns)
    assert [t.find("g:time", ns).text for t in tp] == [f"2026-05-01T06:30:0{i}Z" for i in range(4)]
    assert tp[2].find("g:extensions/rsm:in_gap", ns).text == "1" and tp[0].find("g:extensions/rsm:extrapolated", ns).text == "1"
    assert root.find("g:metadata/g:extensions/rsm:verdict", ns).text == "confident"
    assert "OpenStreetMap contributors" in ET.tostring(root, encoding="unicode") and "driving line: approximation" in root.find("g:metadata/g:desc", ns).text
    steps_d.retime(tmp_path, "2000-01-01T00:00:00Z")
    assert ET.parse(tmp_path / "route.gpx").getroot().find(".//g:trkpt/g:time", ns).text == "2000-01-01T00:00:00Z"
    assert json.loads((tmp_path / "project.json").read_text())["effective"]["start_time"] == "2000-01-01T00:00:00Z"


def test_events_are_json_lines(capsys):
    from rsm.pipeline.cli import Run
    import argparse
    r = Run(argparse.Namespace(out="/tmp/x"))
    r.step_event("route_search", 4, "running", 63.24, 240.4)
    from rsm.pipeline.common import Worker
    Worker().status("decoy_margin", "good", np.float64(12.2), "m")
    out = [json.loads(l) for l in capsys.readouterr().out.splitlines()]
    assert out[0] == {"type": "step", "id": "route_search", "index": 4, "of": 7, "state": "running", "pct": 63.2, "eta_s": 240}
    assert out[1] == {"type": "status", "signal": "decoy_margin", "level": "good", "value": 12.2, "message": "m"}


def test_ffmpeg_env(monkeypatch):
    from rsm.pipeline import common
    monkeypatch.delenv("RSM_FFMPEG", raising=False); monkeypatch.delenv("RSM_FFPROBE", raising=False)
    assert common.ffmpeg_bin() == "ffmpeg" and common.ffprobe_bin() == "ffprobe"
    monkeypatch.setenv("RSM_FFMPEG", "/app/bin/ffmpeg")
    assert common.ffmpeg_bin() == "/app/bin/ffmpeg" and common.ffprobe_bin() == "/app/bin/ffprobe"
    monkeypatch.setenv("RSM_FFPROBE", "/x/probe")
    assert common.ffprobe_bin() == "/x/probe"


def test_data_dir_default_is_inside_out(tmp_path, monkeypatch):
    from rsm.pipeline import common
    monkeypatch.delenv("RSM_DATA_DIR", raising=False)
    assert common.data_dir(tmp_path) == tmp_path / "_cache"
    monkeypatch.setenv("RSM_DATA_DIR", str(tmp_path / "appdata"))
    assert common.data_dir(tmp_path) == tmp_path / "appdata"


def test_frozen_json_matches_config():
    f = json.loads((ROOT / "rsm" / "pipeline" / "frozen.json").read_text())
    assert f["config"]["f_grid"] == list(C.F_GRID) and f["config"]["k_grid"] == list(C.K_GRID)
    from rsm.pipeline.common import code_hash
    assert f["code_hash"] == code_hash()[0], "pipeline code changed after the freeze: regenerate with python -m rsm.pipeline.freeze"


def _tight_edges(g, n=12):
    out = []
    for e in range(g.n_edges):
        p = g.geom(e)
        if len(p) < 8:
            continue
        d = np.diff(p, axis=0)
        ph = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
        tot = np.abs(np.diff(ph)).sum()
        if tot > 2.0 and np.hypot(*d.T).sum() < 150:
            out.append((tot / np.hypot(*d.T).sum(), e))
    return [e for _, e in sorted(out, reverse=True)[:n]]


@pytest.mark.parametrize("graph", ["work/track2/cache/graph_col-de-rousset.npz", "work/amalfi_cal/cache/graph_amalfi_cal.npz"])
def test_driving_line_on_real_hairpins(graph):
    f = ROOT / graph
    if not f.exists():
        pytest.skip("research graph not present")
    from rsm.network.graph import NetGraph
    g = NetGraph.load(f)
    es = _tight_edges(g)
    assert len(es) >= 3
    for e in es:
        p = g.geom(e)
        s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
        grid_ = np.arange(0, s[-1], 1.0)
        xy = np.column_stack([np.interp(grid_, s, p[:, 0]), np.interp(grid_, s, p[:, 1])])
        for side in ("right", "left"):
            P, _, gg = O.driving_line(xy, 1.6, side)
            d_ = np.diff(xy, axis=0); turn = abs(np.unwrap(np.arctan2(d_[:, 1], d_[:, 0]))[[0, -1]].dot([-1, 1]))
            if turn < np.radians(300):                                  # a 330 degree cul-de-sac turnaround of R 3.5 m closes on itself whatever the offset; only reversal is checked there
                assert not O.has_loops(P, xy), (graph, e, side)
            else:
                assert (np.einsum("ij,ij->i", np.diff(P, axis=0), np.diff(xy, axis=0)) > 0).all()
            assert gg.min() > 0.3


def test_lean_environment_imports_and_writes_nothing(tmp_path):
    """the packaging check: a read-only copy of the repo imported with ONLY the pipeline requirements (set RSM_LEAN_PYTHON to the interpreter of such a venv)"""
    py = os.environ.get("RSM_LEAN_PYTHON")
    if not py:
        pytest.skip("RSM_LEAN_PYTHON not set")
    import shutil
    dst = tmp_path / "repo"
    shutil.copytree(ROOT / "rsm", dst / "rsm", ignore=shutil.ignore_patterns("__pycache__"))
    for p in [dst, *dst.rglob("*")]:
        os.chmod(p, 0o555 if p.is_dir() else 0o444)
    code = ("import sys; sys.dont_write_bytecode=True; import rsm.pipeline.allmods as a; "
            "bad=[m for m in ('osmnx','networkx','pandas','geopandas','matplotlib','skimage','requests_cache','gpxpy','dtaidistance') if m in sys.modules]; "
            "heavy=[m for m in sys.modules if m.startswith('rsm.') and any(x in m for x in ('rsm.hmm.exp','rsm.refine.load','rsm.track2','rsm.plaus','rsm.quanta','rsm.nogps'))]; "
            "print(bad, heavy)")
    r = subprocess.run([py, "-s", "-c", code], capture_output=True, text=True, env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"}, cwd=str(dst))
    try:
        assert r.returncode == 0, r.stderr
        assert r.stdout.strip() == "[] []", r.stdout
    finally:
        for p in [dst, *dst.rglob("*")]:
            os.chmod(p, 0o755 if p.is_dir() else 0o644)


def _fake_run(d: Path, **kw):
    import pickle
    for sub in ("route_search", "motion", "rotation"):
        (d / sub).mkdir(exist_ok=True)
    sf = dict(interior_f=kw.get("inter", True), interior_kappa=kw.get("inter", True), best_minus_median=kw.get("flat", 20.0))
    pickle.dump(dict(surface=sf, conf_mean=kw.get("conf", 0.97), conf_below_half=kw.get("below", 0.007)), open(d / "route_search" / "route.pkl", "wb"))
    (d / "motion" / "summary.json").write_text(json.dumps(dict(usable_share=kw.get("usable", 0.997))))
    (d / "rotation" / "summary.json").write_text(json.dumps(dict(features=dict(yaw_ratio=kw.get("yaw", 4.5)))))


def test_verdict_without_decoys(tmp_path):
    from rsm.pipeline.verdict import verdict_nodecoy
    _fake_run(tmp_path)                                              # Amalfi with far yaw: interior peak, 0.973 posterior, 0.7 % below .5, motorcycle noise
    v = verdict_nodecoy(tmp_path)
    assert v["verdict"] == "confident" and v["basis"] == "without decoy check" and v["reasons"] == []
    _fake_run(tmp_path, inter=False, flat=0.5)                        # Amalfi with the vms yaw: peak at the lowest f_eff, flat
    assert verdict_nodecoy(tmp_path)["verdict"] == "no_route"
    _fake_run(tmp_path, below=0.12, conf=0.8)                         # Rousset-like: part of the route with posterior near 0
    v = verdict_nodecoy(tmp_path)
    assert v["verdict"] == "uncertain" and len(v["reasons"]) == 2
    _fake_run(tmp_path, usable=0.3)
    assert verdict_nodecoy(tmp_path)["verdict"] == "no_route"
    _fake_run(tmp_path, conf=0.4)
    assert verdict_nodecoy(tmp_path)["verdict"] == "no_route"


def test_select_families_priority():
    from rsm.hmm import seq
    t = np.arange(0, 400.0)
    st = seq.Steps(t, np.r_[np.nan, np.zeros(399)], np.full(400, 30.0), np.zeros(400), np.full(400, 5.0), np.zeros(400, bool), np.zeros(400, int), 30.0)
    f = steps_b.families(st, 3)
    s = steps_b.select_families(f, 7)
    assert len(s) == 7 and sum(x["fam"] == "foreign" for x in s) == 3 and sum(x["fam"] == "mirror" for x in s) == 1 and sum(x["fam"] == "foreign+shuffle" for x in s) == 3
    assert steps_b.select_families(f, 19) is f


def test_decoys_off_by_default():
    from rsm.pipeline.cli import parse_args
    assert parse_args(["run", "--video", "v", "--bbox", "1,2,3,4", "--pbf", "p", "--out", "o"]).decoys == 0


# ------------------------------------------------------------------ area hints (start / end frame, route hint)
def _hmm_case(seed=3, n=16):
    from rsm.hmm import grid, seq
    from rsm.hmm_cal import dp
    from tests.test_hmm import city, heading_series, random_walk
    g = city()
    path = random_walk(g, np.random.default_rng(seed), n)
    st = seq.make_steps(heading_series(g, path), 30.0)
    G = grid.build(g, None, h=30.0)
    return g, path, st, G, dp.prepare(G, dp.Par())


def test_start_frame_forces_the_decoded_start_into_the_frame():
    from rsm.hmm_cal import dp
    g, path, st, G, pre = _hmm_case()
    free = dp.viterbi(pre, st, backptr=True)
    p0 = G.xy[free["cell_path"][0]]
    # a frame around the true start: the free path already starts there, the constrained one too, with the same score
    near = np.hypot(*(G.xy - p0).T) < 80
    c = dp.viterbi(pre, st, backptr=True, start_ok=near)
    assert near[c["cell_path"][0]] and abs(c["score"] - free["score"]) < 1e-3
    # a frame somewhere else forces the start away from the free optimum, at a lower score
    far = np.hypot(*(G.xy - G.xy[np.argmax(np.hypot(*(G.xy - p0).T))]).T) < 80
    c2 = dp.viterbi(pre, st, backptr=True, start_ok=far)
    assert far[c2["cell_path"][0]] and c2["score"] < free["score"] - 1.0
    # end frame
    pe = G.xy[free["cell_path"][-1]]
    endf = np.hypot(*(G.xy - pe).T) < 80
    assert endf[dp.viterbi(pre, st, backptr=True, end_ok=endf)["cell_path"][-1]]
    both = dp.viterbi(pre, st, backptr=True, start_ok=near, end_ok=endf)
    assert near[both["cell_path"][0]] and endf[both["cell_path"][-1]]
    # posterior with the same frames: the mass stays on the path, the start cell is inside the frame
    fb = dp.forward_backward(pre, st, c["cell_path"], start_ok=near, end_ok=None)
    fb0 = dp.forward_backward(pre, st, c["cell_path"])
    assert np.isfinite(fb["p_vit"][0]) and fb["p_vit"][0] >= fb0["p_vit"][0] - 1e-6


def test_infeasible_frame_is_reported_not_crashed():
    from rsm.hmm_cal import dp
    g, path, st, G, pre = _hmm_case()
    nothing = np.zeros(G.N, bool)
    r = dp.viterbi(pre, st, backptr=True, start_ok=nothing)
    assert r["score"] == float("-inf") and r["cell_path"] is None


def test_infeasible_frame_falls_back_with_a_problem_status(tmp_path, monkeypatch):
    """route_search: a start frame that no route can satisfy -> status `start_frame` problem, same search without the frame"""
    from rsm.pipeline import steps_b
    calls = []

    def fake_search(d, P, W, g, E, st, cons, label="scan"):
        calls.append(cons)
        if cons:
            return None
        return dict(step_t=np.arange(3.0), step_cell=np.arange(3), f_eff=400.0, kappa=1.2, a_ang=1.1, score=-1.0, score_per_km=-1.0, km=1.0, surface=dict(interior_f=True, interior_kappa=True, best_minus_median=9.0),
                    conf_mean=0.99, conf_below_half=0.0, edge_share=0.0, _ll=np.array([[5.0, 45.0]] * 3), _xy=np.zeros((3, 2)), post=None)
    monkeypatch.setattr(steps_b, "_search", fake_search)
    monkeypatch.setattr(steps_b.T, "steps_of", lambda tr: type("S", (), {"km": 1.0})())
    monkeypatch.setattr(steps_b, "load_map", lambda d, n: (None, np.arange(3)))
    import pickle
    (tmp_path / "rotation").mkdir(); (tmp_path / "motion").mkdir(); (tmp_path / "map").mkdir()
    pickle.dump([], open(tmp_path / "rotation" / "tracks.pkl", "wb"))
    (tmp_path / "motion" / "summary.json").write_text(json.dumps(dict(usable_share=1.0)))
    (tmp_path / "rotation" / "summary.json").write_text(json.dumps(dict(features=dict(yaw_ratio=1.0))))
    (tmp_path / "rotation" / "vehicle.json").write_text(json.dumps(dict(requested="bike", effective="bike")))

    class W:
        ev = []
        def progress(self, *a, **k): pass
        def log(self, level, msg): self.ev.append(("log", level, msg))
        def status(self, sig, lev, val, msg): self.ev.append(("status", sig, lev))
    P = dict(bbox=dict(south=44.0, west=4.0, north=45.0, east=5.0), start_bbox=dict(south=44.5, west=4.5, north=44.51, east=4.51), start_tol_m=150.0)
    w = W()
    out = steps_b.route_search(tmp_path, P, w)
    assert len(calls) == 2 and calls[0] is not None and calls[1] is None
    assert ("status", "start_frame", "problem") in w.ev
    assert out["hints_used"]["frames_applied"] is False and "frames_infeasible" in out["hints_used"]["notes"]


@pytest.mark.parametrize("road_conf,paths_file,expect", [(0.3, True, "paths"), (0.99, True, "real"), (0.3, False, "real")])
def test_bike_path_fallback_runs_only_when_the_road_result_is_not_confident(tmp_path, monkeypatch, road_conf, paths_file, expect):
    """route_search: with map/edges_paths.npy (estimated bike) a not-confident road result is searched once more on the map with paths; the better one wins"""
    calls = []

    def fake_search(d, P, W, g, E, st, cons, label="scan"):
        calls.append(label)
        conf = road_conf if label == "scan" else 0.99
        return dict(step_t=np.arange(3.0), step_cell=np.arange(3), f_eff=400.0, kappa=1.2, a_ang=1.1, score=-1.0, score_per_km=-1.0 if label == "scan" else -0.5, km=1.0,
                    surface=dict(interior_f=True, interior_kappa=True, best_minus_median=9.0), conf_mean=conf, conf_below_half=0.0 if conf > 0.9 else 0.6, edge_share=0.0,
                    _ll=np.array([[5.0, 45.0]] * 3), _xy=np.zeros((3, 2)), post=None)
    monkeypatch.setattr(steps_b, "_search", fake_search)
    monkeypatch.setattr(steps_b.T, "steps_of", lambda tr: type("S", (), {"km": 1.0})())
    monkeypatch.setattr(steps_b, "load_map", lambda d, n: (n, np.arange(3)))
    import pickle
    for k in ("rotation", "motion", "map"):
        (tmp_path / k).mkdir()
    pickle.dump([], open(tmp_path / "rotation" / "tracks.pkl", "wb"))
    (tmp_path / "motion" / "summary.json").write_text(json.dumps(dict(usable_share=1.0)))
    (tmp_path / "rotation" / "summary.json").write_text(json.dumps(dict(features=dict(yaw_ratio=1.0))))
    (tmp_path / "rotation" / "vehicle.json").write_text(json.dumps(dict(requested="auto", effective="bike")))
    (tmp_path / "map" / "map.json").write_text(json.dumps(dict(bike_paths=dict(mode="fallback", kept=None, path_km=10.0))))
    if paths_file:
        np.save(tmp_path / "map" / "edges_paths.npy", np.arange(3))

    class W:
        ev = []
        def progress(self, *a, **k): pass
        def log(self, level, msg): self.ev.append(("log", level, msg))
        def status(self, sig, lev, val, msg): self.ev.append(("status", sig, lev))
    out = steps_b.route_search(tmp_path, dict(bbox=dict(south=44.0, west=4.0, north=45.0, east=5.0)), W())
    assert out["edge_set"] == expect
    assert calls == (["scan", "paths"] if (paths_file and road_conf < 0.9) else ["scan"])
    if expect == "paths":
        assert out["bike_paths"]["chosen"] == "paths" and out["bike_paths"]["road_verdict"] != "confident"


def test_frame_cell_mask_with_tolerance():
    from rsm.pipeline import hints as H
    nodes = {1: (45.0, 5.0), 2: (45.0, 5.01), 3: (45.0, 5.02)}
    g = osm.build_graph([(1, {"highway": "tertiary"}, [1, 2, 3])], nodes)
    from rsm.hmm import grid
    G = grid.build(g, None, h=30.0)
    frame = dict(south=44.999, north=45.001, west=5.0, east=5.005)
    m0, m1 = H.cell_mask(g, G, frame, 0.0), H.cell_mask(g, G, frame, 500.0)
    assert 0 < m0.sum() < m1.sum() < G.N
    assert H.cell_mask(g, G, None) is None


GPX_TRK = '''<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
<trkpt lat="45.0" lon="5.0"><time>2020-01-01T00:00:00Z</time></trkpt><trkpt lat="45.1" lon="5.1"/><trkpt lat="45.2" lon="5.1"/></trkseg>
<trkseg><trkpt lat="46.0" lon="6.0"/><trkpt lat="46.1" lon="6.0"/></trkseg></trk><wpt lat="1" lon="1"/></gpx>'''
GPX_RTE = '<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><rte><rtept lat="45.0" lon="5.0"/><rtept lat="45.5" lon="5.5"/></rte></gpx>'
KML_LS = '''<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString><coordinates>
5.0,45.0,100 5.1,45.1,110
5.2,45.2,0</coordinates></LineString></Placemark></Document></kml>'''
KML_MULTI = '''<kml xmlns="http://www.opengis.net/kml/2.2"><Folder><Placemark><MultiGeometry><LineString><coordinates>5,45 5.1,45.1</coordinates></LineString>
<Point><coordinates>9,9</coordinates></Point><LineString><coordinates>6,46 6.1,46.1 6.2,46.2</coordinates></LineString></MultiGeometry></Placemark></Folder></kml>'''
KML_GX = '''<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track>
<when>2020-01-01T00:00:00Z</when><when>2020-01-01T00:00:10Z</when><gx:coord>5.0 45.0 0</gx:coord><gx:coord>5.1 45.1 0</gx:coord></gx:Track></Placemark></Document></kml>'''


@pytest.mark.parametrize("name,text,n_lines,n_pts", [("a.gpx", GPX_TRK, 2, 5), ("b.gpx", GPX_RTE, 1, 2), ("c.kml", KML_LS, 1, 3), ("d.kml", KML_MULTI, 2, 5), ("e.kml", KML_GX, 1, 2)])
def test_hint_parsing(tmp_path, name, text, n_lines, n_pts):
    from rsm.pipeline import hints as H
    f = tmp_path / name
    f.write_text(text)
    lines = H.read_hint(f)
    assert len(lines) == n_lines and sum(len(l) for l in lines) == n_pts
    assert lines[0][0] == (5.0, 45.0) or name == "d.kml" or lines[0][0][0] in (5.0, 5)      # (lon, lat) order, timestamps ignored


def test_hint_parsing_errors(tmp_path):
    from rsm.pipeline import hints as H
    for name, text in [("x.gpx", "<gpx><wpt lat='1' lon='1'/></gpx>"), ("y.kml", "<kml><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></kml>"), ("z.gpx", "not xml"), ("w.txt", "<a/>")]:
        f = tmp_path / name
        f.write_text(text)
        with pytest.raises(ValueError):
            H.read_hint(f)


def _grid_graph():
    """streets every ~110 m in a 2 x 2 km block around (45.0, 5.0)"""
    nodes, ways, nid = {}, [], 1
    ids = {}
    for i in range(-9, 10):
        for j in range(-9, 10):
            ids[i, j] = nid
            nodes[nid] = (45.0 + i * 0.001, 5.0 + j * 0.0014)
            nid += 1
    for i in range(-9, 10):
        ways.append((1000 + i, {"highway": "tertiary"}, [ids[i, j] for j in range(-9, 10)]))
        ways.append((2000 + i, {"highway": "tertiary"}, [ids[j, i] for j in range(-9, 10)]))
    return osm.build_graph(ways, nodes)


def test_corridor_filter_keeps_a_connected_road_set():
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from rsm.pipeline import hints as H
    g = _grid_graph()
    E = np.arange(g.n_edges)
    # a hint along the row i=0 (45.0), then a jump to row i=5: the corridor has two pieces that must be joined by roads
    lines = [[(5.0 - 0.012, 45.0), (5.0 + 0.012, 45.0)], [(5.0 + 0.012, 45.005), (5.0 - 0.012, 45.005)]]
    lxy = H.project_lines(lines, g.crs)
    Ec = H.corridor_edges(g, E, lxy, 150.0)
    assert 0 < len(Ec) < len(E)
    u, v = g.edge_u[Ec], g.edge_v[Ec]
    n = g.node_xy.shape[0]
    nc, lab = connected_components(coo_matrix((np.ones(len(Ec)), (u, v)), shape=(n, n)), directed=False)
    assert len(np.unique(lab[np.unique(np.r_[u, v])])) == 1                    # one connected road set
    no_bridge = H.corridor_edges(g, E, lxy, 150.0, bridge_max_m=1.0)
    assert len(no_bridge) < len(Ec)                                            # without bridging the two rows are separate pieces
    # the narrow corridor is a subset of the wide one; a far-away hint selects nothing
    assert set(H.corridor_edges(g, E, lxy, 150.0, 0.0)) <= set(H.corridor_edges(g, E, lxy, 600.0, 0.0))
    far = H.project_lines([[(5.5, 45.5), (5.6, 45.5)]], g.crs)
    assert len(H.corridor_edges(g, E, far, 300.0)) == 0
    # agreement: points on the hint are within, points 1 km away are not
    on = np.column_stack([lxy[0][:, 0], lxy[0][:, 1]])
    assert H.agreement(on, lxy, 50.0) == 1.0 and H.agreement(on + [0, 1000], lxy, 50.0) < 0.5


def test_cli_hint_options_and_hash_compat():
    from rsm.pipeline.cli import Run, parse_args
    a = parse_args(["run", "--video", "v", "--bbox", "1,2,3,4", "--pbf", "p", "--out", "o"])
    assert a.start_bbox is None and a.end_bbox is None and a.hint is None and a.hint_buffer_m == 300.0 and a.hint_fallback == "auto" and a.start_tol_m == 150.0
    b = parse_args(["run", "--video", "v", "--bbox", "1,2,3,4", "--pbf", "p", "--out", "o", "--start-bbox", "1,2,1.1,2.1", "--hint", "h.gpx", "--hint-fallback", "off"])
    assert b.start_bbox and b.hint == "h.gpx" and b.hint_fallback == "off"


def test_checkpoint_hashes_react_to_hints_but_not_without(tmp_path):
    from rsm.pipeline.cli import Run, parse_args
    vid, pbf = tmp_path / "v.mp4", tmp_path / "p.pbf"
    vid.write_bytes(b"x"); pbf.write_bytes(b"y")
    run = Run(parse_args(["run", "--video", str(vid), "--bbox", "1,2,3,4", "--pbf", str(pbf), "--out", str(tmp_path / "o")]))
    base = dict(video=str(vid), bbox=dict(south=1, west=2, north=3, east=4), pbf=str(pbf), vehicle="auto", offset_m=None, start_time=None, traffic_side="auto", decoys=0, start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    h0 = run.hashes(base)
    assert h0 == run.hashes(dict(base))
    hs = run.hashes(dict(base, start_bbox=dict(south=1, west=2, north=1.1, east=2.1)))
    assert hs["map"] == h0["map"] and hs["route_search"] != h0["route_search"] and hs["motion"] == h0["motion"]       # a frame reruns route_search, not map
    hh = run.hashes(dict(base, hint="h.gpx", hint_hash="aa"))
    assert hh["map"] != h0["map"] and hh["rotation"] == h0["rotation"]                                                 # a hint reruns map
    assert run.hashes(dict(base, hint="h.gpx", hint_hash="aa", hint_buffer_m=500.0))["map"] != hh["map"]


def test_a_user_intro_end_reruns_the_rotation_step_but_not_motion(tmp_path):
    """--intro-end ("Intro-Ende hier setzen"): rotation and every later step recompute, motion is reused; without it the hashes are as before"""
    from rsm.pipeline.cli import Run, parse_args
    vid, pbf = tmp_path / "v.mp4", tmp_path / "p.pbf"
    vid.write_bytes(b"x"); pbf.write_bytes(b"y")
    a = parse_args(["run", "--video", str(vid), "--bbox", "1,2,3,4", "--pbf", str(pbf), "--out", str(tmp_path / "o"), "--intro-end", "49.3"])
    assert a.intro_end == 49.3
    run = Run(a)
    base = dict(video=str(vid), bbox=dict(south=1, west=2, north=3, east=4), pbf=str(pbf), vehicle="auto", offset_m=None, start_time=None, traffic_side="auto", decoys=0, start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    h0, h1 = run.hashes(base), run.hashes(dict(base, intro_end=49.3))
    assert h1["motion"] == h0["motion"] and h1["rotation"] != h0["rotation"] and h1["gpx"] != h0["gpx"]
    assert run.hashes(dict(base, intro_end=None)) == h0 and run.hashes(dict(base, intro_end=50.0))["rotation"] != h1["rotation"]


# ------------------------------------------------------------------ adaptive calibration grid
def _synth_scorer(f_star, k_star, calls=None):
    """a smooth best-path score surface (per km 1, km = 1) with its peak at (f_star, k_star) in log-log"""
    def score(fv, kv):
        if calls is not None:
            calls.append((len(fv), len(kv)))
        return np.array([[-(np.log(f / f_star) / 0.25) ** 2 - (np.log(k / k_star) / 0.35) ** 2 for k in kv] for f in fv])
    return score


def test_adaptive_grid_extends_to_an_optimum_outside_the_initial_grid():
    score = _synth_scorer(f_star=190.0, k_star=5.0)                       # the Madone case: f_eff below 250 and kappa above 3.5
    S0 = score(list(C.F_GRID), list(C.K_GRID))
    assert steps_b.surface(S0, 1.0)["interior_f"] is False and steps_b.surface(S0, 1.0)["interior_kappa"] is False
    S, fg, kg, notes = steps_b.extend_scan(S0, C.F_GRID, C.K_GRID, score, 1.0)
    sf = steps_b.surface(S, 1.0, fg, kg)
    assert sf["interior_f"] and sf["interior_kappa"] and notes
    assert abs(np.log(sf["f"] / 190.0)) < 0.12 and abs(np.log(sf["kappa"] / 5.0)) < 0.25
    assert fg == sorted(fg) and kg == sorted(kg) and S.shape == (len(fg), len(kg))
    assert min(fg) >= C.F_EXT[0] * 0.999 and max(kg) <= C.K_EXT[1] * 1.001
    r = np.diff(np.log(fg)); assert np.allclose(r, r[0])                   # log steps of the same ratio on the extended side too
    assert np.allclose(S[[fg.index(f) for f in C.F_GRID]][:, [kg.index(k) for k in C.K_GRID]], S0)   # the original block is untouched


def test_adaptive_grid_stops_at_the_hard_limits_and_does_nothing_when_interior():
    calls = []
    inside = _synth_scorer(420.0, 1.5, calls)
    S0 = inside(list(C.F_GRID), list(C.K_GRID))
    S, fg, kg, notes = steps_b.extend_scan(S0, C.F_GRID, C.K_GRID, inside, 1.0)
    assert notes == [] and fg == list(C.F_GRID) and kg == list(C.K_GRID) and len(calls) == 1
    far = _synth_scorer(30.0, 60.0)                                        # beyond every limit: the peak stays at the edge of the extended grid
    S0 = far(list(C.F_GRID), list(C.K_GRID))
    S, fg, kg, notes = steps_b.extend_scan(S0, C.F_GRID, C.K_GRID, far, 1.0)
    assert len(notes) <= C.EXT_MAX and min(fg) >= C.F_EXT[0] * 0.999 and max(kg) <= C.K_EXT[1] * 1.001
    sf = steps_b.surface(S, 1.0, fg, kg)
    assert not (sf["interior_f"] and sf["interior_kappa"])
    S, fg, kg, notes = steps_b.extend_scan(S0, C.F_GRID, C.K_GRID, far, 1.0, kappa_ok=lambda k: False)   # the memory rule can refuse the new kappa
    assert max(kg) == max(C.K_GRID)


# ------------------------------------------------------------------ local pass (all road classes in a corridor, finer steps)
def _town():
    """irregular blocks (60-160 m) around (45.0, 5.0): every 3rd row / column tertiary, the others residential (a regular grid would be self-similar). -> (ways, nodes, ids)"""
    rng = np.random.default_rng(7)
    lat = 45.0 + np.cumsum(rng.uniform(0.00055, 0.00145, 13)); lon = 5.0 + np.cumsum(rng.uniform(0.00075, 0.002, 17))
    nodes, ways, ids, nid = {}, [], {}, 1
    for i in range(-6, 7):
        for j in range(-8, 9):
            ids[i, j] = nid
            nodes[nid] = (lat[i + 6] + rng.uniform(-0.0001, 0.0001), lon[j + 8] + rng.uniform(-0.0001, 0.0001))
            nid += 1
    for i in range(-6, 7):
        ways.append((1000 + i, {"highway": "tertiary" if i % 3 == 0 else "residential"}, [ids[i, j] for j in range(-8, 9)]))
    for j in range(-8, 9):
        ways.append((2000 + j, {"highway": "tertiary" if j % 3 == 0 else "residential"}, [ids[i, j] for i in range(-6, 7)]))
    return ways, nodes, ids


def _edges_of(g, ids, cells):
    osm_ix = {int(o): k for k, o in enumerate(g.node_osm)}
    out = []
    for a, b in zip(cells[:-1], cells[1:]):
        u, v = osm_ix[ids[a]], osm_ix[ids[b]]
        out.append(int(np.flatnonzero((g.edge_u == u) & (g.edge_v == v))[0]))
    return out


def test_local_pass_follows_residential_streets_the_search_map_lacks(tmp_path, monkeypatch):
    from rsm.hmm import grid
    from rsm.hmm_cal import dp
    from rsm.pipeline import local as L
    from tests.test_hmm import heading_series
    ways, nodes, ids = _town()
    gF = osm.build_graph(ways, nodes)
    gM = osm.build_graph([w for w in ways if w[1]["highway"] == "tertiary"], nodes)
    # true drive: zigzag on residential streets with turns ~110 m apart
    wp = [(1, -7), (1, -4), (2, -4), (2, 0), (-1, 0), (-1, 4), (-4, 4), (-4, 7)]
    walk = [wp[0]]
    for (i1, j1) in wp[1:]:
        while walk[-1] != (i1, j1):
            i0, j0 = walk[-1]
            walk.append((i0 + int(np.sign(i1 - i0)), j0) if i0 != i1 else (i0, j0 + int(np.sign(j1 - j0))))
    true_edges = _edges_of(gF, ids, walk)
    tracks = heading_series(gF, true_edges)
    st = T.steps_of(tracks)
    G = grid.build(gM, None, h=C.H, sm=10.0)
    # the search result: right area, wrong streets (each step snapped to the nearest main-road cell, as when the true street is missing from the search map)
    from scipy.spatial import cKDTree
    tp = L._densify(np.vstack([gF.geom(e) for e in true_edges]), 1.0)
    arc = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(tp, axis=0).T))])
    s_step = np.interp(st.t, tracks[0]["t"], tracks[0]["s"])
    pos = np.column_stack([np.interp(s_step, arc, tp[:, 0]), np.interp(s_step, arc, tp[:, 1])])
    cells = cKDTree(G.xy).query(pos)[1]
    route = dict(step_t=st.t, step_cell=cells, kappa=1.0, a_ang=1.0, cons=None)
    pbf = tmp_path / "x.osm.pbf"; pbf.write_bytes(b"x")
    monkeypatch.setattr(osm, "extract", lambda pbf_, cls, boxes, progress=None: {"local": ([w for w in ways if w[1]["highway"] in cls], nodes)})
    monkeypatch.setattr(L, "data_dir", lambda d: tmp_path)
    monkeypatch.setattr(C, "LOCAL_MINOR_NATS_PER_KM", 0.0)     # this test is about the corridor; the town is mostly residential (prior: own test)

    class W_:
        def log(self, *a): pass
        def status(self, *a): pass
    res, info = L.local_pass(tmp_path, dict(pbf=str(pbf)), W_(), gM, np.arange(gM.n_edges), tracks, route, "motorcycle")
    assert res is not None and info["corridor_edges"] > 0
    loc, gl, Ec, st_l = res
    assert loc["d0"] == C.LOCAL_D0 and st_l.d0 == C.LOCAL_D0 and loc["local"]
    truth = cKDTree(L._densify(np.vstack([gF.geom(e) for e in true_edges]), 2.0))
    d_search = truth.query(G.xy[cells])[0]
    Gl = grid.build(gl, Ec, h=loc["h"], sm=10.0)
    d_local = truth.query(Gl.xy[loc["step_cell"]])[0]
    print("search: median %.0f m, on the true street %.2f; local: median %.1f m, on the true street %.2f" % (np.median(d_search), (d_search < 15).mean(), np.median(d_local), (d_local < 15).mean()))
    assert (d_search < 15).mean() < 0.7       # the search map lacks the residential streets of the drive
    assert np.median(d_local) < 5 and (d_local < 15).mean() > 0.9
    assert info["changed_share"] > 0.2


def test_local_classes_add_residential_for_motor_vehicles():
    from rsm.pipeline import local as L
    c = L.classes_for("motorcycle")
    assert "residential" in c and "living_street" in c and "primary" in c and set(C.CLASSES_MOTOR) <= set(c)
    assert set(C.CLASSES_BIKE) <= set(L.classes_for("bike"))


# ------------------------------------------------------------------ timing: measured standstills, dense heading alignment
def test_make_steps_uses_a_measured_gap_instead_of_the_mean_speed():
    from rsm.hmm import seq
    s = np.arange(0, 400.0, 4.0)
    a = dict(t=s / 8.0, s=s, th=np.zeros_like(s))
    b = dict(t=a["t"][-1] + 10.0 + s / 8.0, s=s, th=np.zeros_like(s))      # 10 s stop between the tracks
    est = seq.make_steps([a, b], 30.0)
    meas = seq.make_steps([a, b], 30.0, gap_nom=[None, 3.0])
    gap_est, gap_meas = est.mu[est.gap].sum(), meas.mu[meas.gap].sum()
    assert gap_est > 60 and gap_meas < 3.0 + 30.0                            # mean speed fills ~80 m; measured: 3 m plus the leftover of the last step


def _corner_path():
    """1 m sampled path: 300 m east, sharp 90 deg left kink (a junction node), 300 m north"""
    a = np.column_stack([np.arange(0, 300.0), np.zeros(300)])
    b = np.column_stack([np.full(300, 300.0), np.arange(0, 300.0)])
    xy = np.vstack([a, b])
    return np.arange(len(xy), dtype=float), xy


def test_alignment_times_a_junction_kink_the_video_spreads_out():
    from scipy.ndimage import gaussian_filter1d
    from rsm.pipeline import align as AL
    sg, xy = _corner_path()
    kappa, v = 2.5, 6.0                                       # map metres per nominal metre; true speed m/s
    s_true = np.arange(0, 590.0, 4.0 * kappa)                 # one sample every 4 nominal m
    t = s_true / v
    heading = np.where(s_true < 300, 0.0, np.pi / 2)
    th = gaussian_filter1d(heading, 12.0 / (4.0 * kappa))     # the video turns over ~25 m, the map turns at one node
    tracks = [dict(t=t, s=s_true / kappa, th=th)]
    prior_s = s_true + 60.0 * np.sin(s_true / 200.0)          # a rough, wrong-in-time HMM route (only the start is used)
    al = AL.align(sg, xy, tracks, kappa, 1.0, t, prior_s)
    t_corner = np.interp(300.0, al["s"] + 1e-6 * np.arange(len(al["s"])), al["t"])
    assert abs(t_corner - 300.0 / v) < 1.0                   # within 1 s of the true time at the kink
    assert np.all(np.diff(al["s"]) >= 0)


def test_window_max_is_exact():
    from rsm.pipeline.align import _window_max
    rng = np.random.default_rng(1)
    a = rng.normal(size=200)
    for W in (0, 1, 5, 17, 64):
        v, d = _window_max(a, W)
        ref = np.array([a[max(0, i - W):i + 1].max() for i in range(len(a))])
        assert np.allclose(v, ref) and np.all(a[np.arange(len(a)) - d] == v) and d.max() <= W


def test_posterior_thinning_on_straights_is_configured():
    # Fable fix 3: thinned (one per 200 m) and inflated (x2) on straights; 0 switches it off. Dev evidence: Madone town lateness 3.5 -> 2.7 s, Roanne along-track
    # median 3.63 -> 3.59 m; 400 m / x4 made Roanne worse (4.6 m)
    assert C.POST_STRAIGHT_EVERY_M == 200.0 and C.POST_STRAIGHT_INFL == 2.0


def test_grid_edge_cost_lowers_the_weight_of_entries_by_cost_times_distance():
    from rsm.hmm import grid
    from tests.test_hmm import city
    g = city()
    G0 = grid.build(g, None, h=30.0)
    G1 = grid.build(g, None, h=30.0, edge_cost=np.full(g.n_edges, 0.01))    # 10 nats per km everywhere
    for gr0, gr1 in zip(G0.groups[1:], G1.groups[1:]):
        assert np.allclose(gr1.w, gr0.w - 0.01 * gr0.D, atol=1e-4)
    assert np.allclose(G1.groups[0].w, G0.groups[0].w)                       # staying in a cell costs nothing


def test_local_minor_road_prior_is_on():
    # Menton: a parallel residential one-way street beat the main road by 7.5 nats over ~1 km; 10-25 nats/km all keep the main road there and the true
    # residential detour at Rond-Point Saint-Roch (FINDINGS "Side street in Menton")
    assert C.LOCAL_MINOR_NATS_PER_KM == 15.0


# ------------------------------------------------------------------ Incyclist export (rsm.pipeline.export, rsm.pipeline.dem)
def _write_geotiff(path, a, west, north, d, tile=16, predictor=3):
    """a small tiled, DEFLATE, float32 GeoTIFF (PixelIsArea) written by hand, with the floating-point predictor"""
    import struct, zlib
    H, W = a.shape
    nty, ntx = -(-H // tile), -(-W // tile)
    blobs = []
    for ty in range(nty):
        for tx in range(ntx):
            t = np.zeros((tile, tile), np.float32)
            blk = a[ty * tile:(ty + 1) * tile, tx * tile:(tx + 1) * tile]
            t[:blk.shape[0], :blk.shape[1]] = blk
            if predictor == 3:
                be = t.astype(">f4").view(np.uint8).reshape(tile, tile, 4)
                rows = np.ascontiguousarray(be.transpose(0, 2, 1)).reshape(tile, 4 * tile).astype(np.int16)
                rows[:, 1:] = (rows[:, 1:] - rows[:, :-1]) % 256
                raw = rows.astype(np.uint8).tobytes()
            else:
                raw = t.astype("<f4").tobytes()
            blobs.append(zlib.compress(raw))
    geokeys = [1, 1, 0, 1, 1025, 0, 1, 1]
    extra = {33550: (12, [d, d, 0.0]), 33922: (12, [0.0, 0.0, 0.0, west, north, 0.0]), 34735: (3, geokeys)}
    tags = {256: (3, [W]), 257: (3, [H]), 258: (3, [32]), 259: (3, [8]), 262: (3, [1]), 277: (3, [1]), 284: (3, [1]), 317: (3, [predictor]),
            322: (3, [tile]), 323: (3, [tile]), 324: (4, [0] * len(blobs)), 325: (4, [len(b) for b in blobs]), 339: (3, [3]), **extra}
    fmtc = {3: ("H", 2), 4: ("I", 4), 12: ("d", 8)}
    n = len(tags)
    ifd_off = 8
    data_off = ifd_off + 2 + 12 * n + 4
    entries, payload = [], b""
    blob_start = None
    # first pass: lay out out-of-line values, then the tiles
    vals = {}
    for tag in sorted(tags):
        typ, v = tags[tag]
        ch, sz = fmtc[typ]
        if sz * len(v) > 4:
            vals[tag] = data_off + len(payload)
            payload += b"\0" * (sz * len(v))
    blob_start = data_off + len(payload)
    offs, o = [], blob_start
    for b in blobs:
        offs.append(o); o += len(b)
    tags[324] = (4, offs)
    payload = b""
    for tag in sorted(tags):
        typ, v = tags[tag]
        ch, sz = fmtc[typ]
        packed = struct.pack("<" + ch * len(v), *v)
        if len(packed) > 4:
            entries.append(struct.pack("<HHI", tag, typ, len(v)) + struct.pack("<I", data_off + len(payload)))
            payload += packed
        else:
            entries.append(struct.pack("<HHI", tag, typ, len(v)) + packed.ljust(4, b"\0"))
    out = b"II" + struct.pack("<HI", 42, ifd_off) + struct.pack("<H", n) + b"".join(entries) + b"\0\0\0\0" + payload + b"".join(blobs)
    Path(path).write_bytes(out)


def test_cog_reader_undoes_predictor_3_and_samples_bilinear(tmp_path):
    from rsm.pipeline import dem as D
    rng = np.random.default_rng(3)
    a = (rng.normal(500, 300, (40, 37))).astype(np.float32)                 # partial tiles on both axes
    p = tmp_path / "t.tif"
    _write_geotiff(p, a, 5.0, 45.0, 0.025)
    c = D.Cog(p)
    rr, cc = np.meshgrid(np.arange(40), np.arange(37), indexing="ij")
    assert np.array_equal(c.pixel(rr.ravel(), cc.ravel()), a.ravel())
    # pixel centres (PixelIsArea: tie point at the corner) and bilinear interpolation between them
    lon0, lat0 = 5.0 + 0.5 * 0.025, 45.0 - 0.5 * 0.025
    assert c.sample([lon0 + 3 * 0.025], [lat0 - 7 * 0.025])[0] == pytest.approx(a[7, 3], abs=1e-3)
    v = c.sample([lon0 + 3.25 * 0.025], [lat0 - 7.5 * 0.025])[0]
    ref = 0.75 * 0.5 * (a[7, 3] + a[8, 3]) + 0.25 * 0.5 * (a[7, 4] + a[8, 4])
    assert v == pytest.approx(ref, abs=1e-3)
    _write_geotiff(tmp_path / "u.tif", a, 5.0, 45.0, 0.025, predictor=1)
    assert np.array_equal(D.Cog(tmp_path / "u.tif").pixel(rr.ravel(), cc.ravel()), a.ravel())
    (tmp_path / "bad.tif").write_bytes(b"II+\0" + b"\0" * 20)                  # BigTIFF: refused, not guessed
    with pytest.raises(D.UnsupportedTiff):
        D.Cog(tmp_path / "bad.tif")


def test_dem_tile_names_and_sea_marker(tmp_path):
    from rsm.pipeline import dem as D
    assert D.tile_name(43, 7) == "Copernicus_DSM_COG_10_N43_00_E007_00_DEM"
    assert D.tile_name(-1, -2) == "Copernicus_DSM_COG_10_S01_00_W002_00_DEM"
    assert D.tiles_for_bbox(43.7, 6.9, 43.9, 7.5) == ["Copernicus_DSM_COG_10_N43_00_E006_00_DEM", "Copernicus_DSM_COG_10_N43_00_E007_00_DEM"]
    dm = D.Dem(tmp_path)
    assert dm.missing(["Copernicus_DSM_COG_10_N43_00_E007_00_DEM"])
    (tmp_path / "Copernicus_DSM_COG_10_N43_00_E007_00_DEM.none").write_text("")
    assert not dm.missing(["Copernicus_DSM_COG_10_N43_00_E007_00_DEM"]) and dm.sample([43.5], [7.5])[0] == 0.0


def test_tunnel_and_bridge_runs_are_interpolated_between_portals():
    from rsm.pipeline import dem as D
    z = np.linspace(100, 200, 101)
    z2 = z.copy(); z2[40:60] += 300                                          # the mountain above a tunnel
    m = np.zeros(101, bool); m[40:60] = True
    out, n = D.interp_runs(z2, m)
    assert n == 20 and np.allclose(out, z)
    v = z.copy(); v[10:20] -= 80                                             # the valley floor below a bridge
    m2 = np.zeros(101, bool); m2[10:20] = True
    assert np.allclose(D.interp_runs(v, m2)[0], z)
    e = np.zeros(101, bool); e[:5] = True                                    # a run at the start stays flat at the first good value
    assert np.allclose(D.interp_runs(z, e)[0][:5], z[5])


def test_grade_clamp_and_ascent_hysteresis():
    from rsm.pipeline import dem as D
    s = np.arange(0, 2000, 5.0)
    z = 0.05 * s
    z[200:204] += 30                                                         # a 30 m DSM spike (a building)
    zc, clipped = D.clamp_grade(z, 5.0)
    assert np.abs(np.diff(zc) / 5.0).max() <= D.GRADE_MAX + 1e-9 and clipped > 0
    assert abs(zc[-1] - z[-1]) < 5                                           # the end level is kept (the clipped height is put back slowly)
    assert D.clamp_grade(0.05 * s, 5.0)[1] == 0.0
    up, down = D.ascent_descent(np.array([0, 2, 0, 2, 0, 10, 8, 9, 3, 3]))
    assert up == 10 and down == 7                                            # wiggles below 3 m do not count
    # the lower-quantile filter ignores trees beside the road (DSM only ever too high)
    flat = np.full(400, 100.0); flat[100:110] += 15
    zf, st = D.profile(np.arange(400) * 5.0, flat, np.zeros(400, bool), np.zeros(400, bool))
    assert np.abs(zf - 100).max() < 0.5 and D.ascent_descent(zf)[0] == 0


def test_trim_start_frame_speed_guard_and_standstills():
    from rsm.pipeline import export as X
    ex = np.array([1, 1, 0, 0, 0, 0, 1], bool)
    assert X.trim_span(ex) == (2, 5) and X.trim_span(ex, "off") == (0, 6)
    assert X.start_frame(0.0, 50.0) == 1 and X.start_frame(21.0, 50.0) == 1051 and X.start_frame(12.0, 29.97) == 361
    # one 200 m jump in a 10 m/s series, bike limit 25 m/s: spread over the neighbours, start / end / total kept
    s = np.cumsum(np.r_[0, np.full(20, 10.0)]); s[11:] += 190
    g, n = X.speed_guard(s, 1.0, 25.0)
    assert n == 1 and np.diff(g).max() <= 25.0 + 1e-6 and g[0] == s[0] and g[-1] == pytest.approx(s[-1]) and np.all(np.diff(g) >= 0)
    assert np.allclose(X.speed_guard(np.arange(10.0) * 5, 1.0, 25.0)[0], np.arange(10.0) * 5)
    # a 6 s standstill: its first and last second are kept, the seconds between are dropped, no duplicates
    s2 = np.r_[0, 5, 10, 10, 10.1, 10.1, 10.2, 10.2, 15, 20]
    k, sn = X.thin_standstills(s2)
    assert list(k) == [0, 1, 2, 7, 8, 9] and np.all(np.diff(sn[k]) >= X.MIN_STEP_M - 1e-9)


def _fake_export_run(d: Path, n=120, v=8.0):
    """a finished run on a straight road (UTM 31N near 44.5 N, 5.5 E): standstill 40-49 s, extrapolated first 3 / last 2 s, a tunnel"""
    from pyproj import Transformer
    x0, y0 = Transformer.from_crs(4326, 32631, always_xy=True).transform(5.5, 44.5)
    L = 2000
    sg = np.arange(0.0, L, 1.0)
    xy = np.column_stack([x0 + sg, np.full_like(sg, y0)])
    t = np.arange(float(n))
    s = np.cumsum(np.r_[0, np.where((t[1:] > 40) & (t[1:] < 50), 0.0, v)])
    ex = (t < 3) | (t > n - 3)
    s[t < 3] = s[3]; s[t > n - 3] = s[n - 3]
    tun = (sg > 300) & (sg < 400)
    (d / "refine").mkdir(parents=True)
    np.savez_compressed(d / "refine" / "result.npz", t=t, s=s, s_sd=np.ones(n), conf=np.where(ex, 0, 0.95), extrap=ex, in_gap=np.zeros(n, bool), sg=sg, xy=xy,
                        oneway=np.zeros(len(sg), bool), tunnel=tun, bridge=np.zeros(len(sg), bool), crs=np.array("EPSG:32631"))
    (d / "project.json").write_text(json.dumps(dict(params=dict(video="/x/Test Ride.mp4"), effective=dict(vehicle="bike", offset_m=1.5, traffic_side="right"),
                                                    verdict="confident", verdict_basis="without decoy check", driving_line=dict(rule="driving line: approximation."))))


def test_export_gpx_schema_and_elevation(tmp_path):
    from rsm.pipeline import export as X, dem as D
    d = tmp_path / "run"
    _fake_export_run(d)
    dd = tmp_path / "dem"; dd.mkdir()
    lon = 5.0 + (np.arange(40) + 0.5) * 0.025
    a = np.tile((200.0 + 100.0 * (lon - 5.0)).astype(np.float32), (40, 1))     # rises 1 m per 0.01 deg of longitude, eastwards
    _write_geotiff(dd / (D.tile_name(44, 5) + ".tif"), a, 5.0, 45.0, 0.025)
    summ = X.export(d, tmp_path / "o.gpx", tmp_path / "o.json", dd, fps=29.97, title="Ride & <Test> \"ä\"")
    root = ET.parse(tmp_path / "o.gpx").getroot()
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    pts = root.findall(".//g:trkpt", ns)
    times = [np.datetime64(p.find("g:time", ns).text.rstrip("Z")) for p in pts]
    sec = np.diff(times).astype("timedelta64[s]").astype(int)
    assert np.all(sec >= 1)                                                    # strictly increasing
    assert (sec == 1).mean() > 0.9 and summ["points_thinned"] == 8             # one point per second, the standstill thinned to its first and last second
    assert str(times[0]) == "2000-01-01T00:00:00" and summ["t_first"] == 3.0 and summ["start_frame"] == 91 and summ["trimmed_head_s"] == 3 and summ["trimmed_tail_s"] == 2
    ele = np.array([float(p.find("g:ele", ns).text) for p in pts])
    assert ele[-1] > ele[0] and summ["elevation"]["tunnels"] == 1 and summ["ascent_m"] >= 0
    assert root.find("g:metadata/g:name", ns).text == "Ride & <Test> \"ä\""
    assert pts[5].find("g:extensions", ns)[0].get("speed") == "28.8"           # gte:gps speed in km/h
    # without the tiles: no <ele>, a note in the summary
    s2 = X.export(d, tmp_path / "n.gpx", tmp_path / "n.json", tmp_path / "empty")
    assert "<ele>" not in (tmp_path / "n.gpx").read_text() and s2["elevation"]["missing"] and s2["start_frame"] is None


def _fake_dem(tmp_path):
    from rsm.pipeline import dem as D
    dd = tmp_path / "dem"; dd.mkdir()
    lon = 5.0 + (np.arange(40) + 0.5) * 0.025
    a = np.tile((200.0 + 100.0 * (lon - 5.0)).astype(np.float32), (40, 1))
    _write_geotiff(dd / (D.tile_name(44, 5) + ".tif"), a, 5.0, 45.0, 0.025)
    return dd


def test_profile_writes_the_diag_file_and_the_profile_z_is_the_plain_elevation(tmp_path):
    import json
    from rsm.pipeline import export as X, dem as D
    d = tmp_path / "run"
    _fake_export_run(d)
    dd = _fake_dem(tmp_path)
    r = X.elevation_profile(d, d / "elevation_profile.json", dd)
    p = json.loads((d / "elevation_profile.json").read_text())
    g = json.loads((d / "elevation_diag.json").read_text())
    assert p["diag"] == "elevation_diag.json" and p["pipeline_hash"] and isinstance(p["blocks"], dict) and p["version"] == 1
    assert g["version"] == 2 and g["n"] == len(p["z"]) and g["pipeline_hash"] == p["pipeline_hash"]
    assert all(len(g[k]) == g["n"] for k in ("z_p13", "rug", "filled", "gap", "w_dtm"))
    assert g["z_p13"] == p["z"] and g["strategy_share"]["p13"] == 1.0              # no extra source cached: the profile is P13
    assert [x["name"] for x in g["sources"]] == ["copernicus"] and sum(g["gap"]) > 0     # the tunnel
    # the diagnostics do not change z: the same call without them gives the same heights
    R = np.load(d / "refine" / "result.npz")
    grid = np.arange(0.0, float(R["sg"][-1]) + D.SAMPLE_M, D.SAMPLE_M)
    glat, glon = X.path_lonlat(d)
    gi = np.clip(np.rint(grid).astype(int), 0, len(R["sg"]) - 1)
    z, _, _ = X.corrected_elevation(dd, glat, glon, grid, np.asarray(R["tunnel"], bool)[gi], np.zeros(len(gi), bool))
    assert p["z"] == [round(float(v), 1) for v in z] and r["points"] == len(z)


def test_export_reuses_a_current_profile_and_not_a_stale_one(tmp_path):
    import json
    from pyproj import Transformer
    from rsm.pipeline import export as X
    d = tmp_path / "run"
    _fake_export_run(d)
    dd = _fake_dem(tmp_path)
    X.elevation_profile(d, d / "elevation_profile.json", dd)
    pf = d / "elevation_profile.json"
    p = json.loads(pf.read_text())
    assert X.current_profile(d, dd) is not None
    summ = X.export(d, tmp_path / "r.gpx", tmp_path / "r.json", dd, fps=30.0)
    assert summ["elevation"]["profile_reused"] is True and summ["elevation"]["source"] == p["source"] and summ["elevation"]["sources"] == p["sources"]
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    pts = ET.parse(tmp_path / "r.gpx").getroot().findall(".//g:trkpt", ns)
    x0 = Transformer.from_crs(4326, 32631, always_xy=True).transform(5.5, 44.5)[0]
    xs = Transformer.from_crs(4326, 32631, always_xy=True).transform([float(q.get("lon")) for q in pts], [float(q.get("lat")) for q in pts])[0]
    ele = np.array([float(q.find("g:ele", ns).text) for q in pts])
    want = np.interp(np.asarray(xs) - x0, np.arange(len(p["z"])) * p["ds"], p["z"])
    assert np.abs(ele - want).max() <= 0.051                                         # the GPX heights are the profile's, at each point's arc
    assert summ["ascent_m"] is not None
    # stale: another pipeline hash, a different set of cached blocks, a result newer than the profile -> computed again
    for mutate in (lambda q: q.update(pipeline_hash="0" * 16), lambda q: q.update(blocks={"nasadem": 3}), lambda q: q.pop("blocks")):
        q = json.loads(pf.read_text()); mutate(q); pf.write_text(json.dumps(q))
        assert X.current_profile(d, dd) is None
        assert "profile_reused" not in X.export(d, tmp_path / "s.gpx", tmp_path / "s.json", dd)["elevation"]
        pf.write_text(json.dumps(p))
    assert X.current_profile(d, dd) is not None
    os.utime(d / "refine" / "result.npz", (pf.stat().st_mtime + 10,) * 2)
    assert X.current_profile(d, dd) is None
    assert "profile_reused" not in X.export(d, tmp_path / "u.gpx", tmp_path / "u.json", dd, use_profile=False)["elevation"]


def test_cli_has_the_profile_subcommand():
    from rsm.pipeline.cli import parse_args
    a = parse_args(["profile", "--out", "o", "--dest", "p.json", "--dem-dir", "d"])
    assert a.cmd == "profile" and a.dest == "p.json" and a.dem_dir == "d"


# ------------------------------------------------------------------ calibration candidates (rsm.pipeline.calib): physical mask, peaks, choice
def _circle_track(v=10.0, radius=50.0, n=400):
    """a track at the reference calibration: constant speed v (m/s) on a circle of `radius` m -> lateral acceleration v^2 / radius"""
    s = np.arange(n) * 4.0
    return dict(t=s / v, s=s, th=s / radius)


def test_motion_stats_and_plausibility_scale_with_the_calibration():
    from rsm.pipeline import calib as CB
    st = CB.motion_stats([_circle_track(10.0, 50.0)])
    assert st["v99"] == pytest.approx(10.0, rel=1e-6) and st["alat95"] == pytest.approx(2.0, rel=1e-6)          # v^2 / r = 100 / 50
    m = CB.at(st, C.F_REF / 2.0, 3.0)                                       # half the focal length doubles the yaw rate, kappa 3 triples the speed
    assert m["v99"] == pytest.approx(30.0) and m["alat95"] == pytest.approx(2.0 * 3.0 * 2.0)
    assert CB.plausible(st, C.F_REF, 1.0) and CB.plausible(st, C.F_REF, 2.4) and not CB.plausible(st, C.F_REF, 2.6)   # limit 5 m/s2
    assert not CB.plausible(st, 4 * C.F_REF, 4.6)                           # 46 m/s: the speed limit, although the lateral acceleration is small
    assert CB.plausible(None, 100.0, 9.0) and CB.plausible(CB.motion_stats([]), 100.0, 9.0)                    # no statistics: nothing is excluded
    M = CB.plausible_mask(st, [C.F_REF], [1.0, 9.0])
    assert M.tolist() == [[True, False]]
    assert CB.plausible_mask(dict(v99=1e3, alat95=1e3, n=5), [300.0], [1.0, 2.0]).all()                       # nothing plausible: mask off


def _two_peak_surface():
    """a corner maximum (low f_eff, high kappa: the runaway) and a lower interior maximum"""
    fg, kg = list(C.F_GRID), list(C.K_GRID)
    S = np.array([[-80.0 + 14.0 * np.exp(-(np.log(f / 430.0) / 0.12) ** 2 - (np.log(k / 1.6) / 0.2) ** 2) + 12.0 * (np.log(k / kg[0]) - np.log(f / fg[-1])) for k in kg] for f in fg])
    return S, fg, kg


def test_candidates_are_the_best_plausible_cell_and_the_interior_peaks():
    from rsm.pipeline import calib as CB
    S, fg, kg = _two_peak_surface()
    assert CB.best_cell(S) == (0, len(kg) - 1)                              # the corner wins on the score alone
    c = CB.candidates(S)
    assert c[0] == (0, len(kg) - 1) and len(c) == 2
    fi, ki = c[1]
    assert abs(np.log(fg[fi] / 430.0)) < 0.1 and abs(np.log(kg[ki] / 1.6)) < 0.25
    sf = CB.surface_at(S, 1.0, fg, kg, fi, ki)
    assert sf["interior_f"] and sf["interior_kappa"]
    mask = np.ones(S.shape, bool)
    mask[0, -1] = False                                                      # the corner cell is physically implausible
    cm = CB.candidates(S, mask)
    assert mask[cm[0]] and cm[0] != (0, len(kg) - 1) and (fi, ki) in cm
    sfm = CB.surface_at(S, 1.0, fg, kg, *cm[0])                               # the best plausible cell sits next to a higher implausible one: not a peak
    assert not (sfm["interior_f"] and sfm["interior_kappa"])
    # the description of the global maximum is exactly steps_b.surface (today's result when there is one candidate)
    one = np.array([[-(np.log(f / 420.0) / 0.25) ** 2 - (np.log(k / 1.5) / 0.35) ** 2 for k in kg] for f in fg])
    assert CB.candidates(one) == [CB.best_cell(one)]
    assert CB.surface_at(one, 2.0, fg, kg, *CB.best_cell(one)) == steps_b.surface(one, 2.0, fg, kg)


def test_choice_prefers_verdict_then_plausibility_then_an_interior_peak_never_the_score_alone():
    from rsm.pipeline import calib as CB
    c = lambda rank, interior, score, plausible=True: dict(rank=rank, interior=interior, score_per_km=score, plausible=plausible)
    assert CB.choose([c(0, False, -58.0), c(2, True, -74.0)]) == 1          # Madone: interior and confident beats the higher corner with a posterior of 0.3
    assert CB.choose([c(1, False, -60.0), c(1, True, -70.0)]) == 1          # same verdict: the interior peak
    assert CB.choose([c(1, True, -60.0), c(1, True, -50.0)]) == 0           # same quality: the primary stays, a higher score alone is not a reason
    assert CB.choose([c(2, True, -60.0), c(1, True, -50.0)]) == 0
    assert CB.choose([c(1, True, -60.0, plausible=False), c(1, False, -70.0)]) == 1
    assert CB.choose([c(0, False, -58.0), c(1, True, -74.0), c(1, True, -72.0)]) == 2   # among the better ones the higher score


def test_extension_follows_the_best_plausible_cell_and_skips_implausible_rows():
    calls = []
    far = _synth_scorer(30.0, 60.0, calls)                                  # the likelihood rises towards low f_eff / high kappa without end
    S0 = far(list(C.F_GRID), list(C.K_GRID))
    ok = lambda f, k: k / f <= 2.0 / 250.0                                   # lateral acceleration ~ kappa / f_eff
    S, fg, kg, notes = steps_b.extend_scan(S0, C.F_GRID, C.K_GRID, far, 1.0, cell_ok=ok)
    S2, fg2, kg2, _ = steps_b.extend_scan(S0, C.F_GRID, C.K_GRID, far, 1.0)
    assert len(fg) * len(kg) < len(fg2) * len(kg2)                           # fewer scans than without the mask
    assert max(kg) < max(kg2)                                                # the kappa columns beyond the plausible region are not scanned
    inside = _synth_scorer(420.0, 1.5)
    S0 = inside(list(C.F_GRID), list(C.K_GRID))
    assert steps_b.extend_scan(S0, C.F_GRID, C.K_GRID, inside, 1.0, cell_ok=lambda f, k: True)[3] == []


def test_verdict_names_a_confident_rival_and_an_implausible_calibration():
    from rsm.pipeline import verdict as V
    rs = dict(surface=dict(interior_f=True, interior_kappa=True, best_minus_median=9.0), conf_mean=0.97, conf_below_half=0.01)
    ms, rot = dict(usable_share=0.99), dict(yaw_ratio=1.0)
    assert V.verdict_from(rs, ms, rot)["verdict"] == "confident"
    v = V.verdict_from(dict(rs, rival_confident=True, candidates=[{}, {}]), ms, rot)
    assert v["verdict"] == "uncertain" and v["signals"]["n_candidates"] == 2 and any("different routes" in r for r in v["reasons"])
    assert V.verdict_from(dict(rs, calibration_implausible=True), ms, rot)["verdict"] == "uncertain"


# ------------------------------------------------------------------ accuracy work 2026-11-12: prior-decided stretches (A3), local start anchoring
def _two_streets():
    """Main (tertiary) and Side (residential): two parallel streets 45 m apart over 500 m between the junctions B and C"""
    m = lambda x, y: (45.0 + y / 111195.0, 5.0 + x / (111195.0 * np.cos(np.radians(45.0))))
    nodes = {1: m(0, 0), 2: m(150, 0), 3: m(650, 0), 4: m(800, 0), 5: m(170, 45), 6: m(630, 45)}
    ways = [(1, {"highway": "tertiary", "name": "Main"}, [1, 2, 3, 4]), (2, {"highway": "residential", "name": "Side"}, [2, 5, 6, 3])]
    return osm.build_graph(ways, nodes)


def test_prior_decided_reports_the_stretch_where_the_two_decodes_differ():
    from rsm.hmm import grid
    from rsm.pipeline import local as L
    from rsm.refine import pathctx
    g = _two_streets()
    E = np.arange(g.n_edges)
    G = grid.build(g, E, h=15.0, sm=10.0)
    ce, _ = pathctx.cell_layout(g, E, 15.0)
    fwd = np.asarray(g.to_wgs84(G.xy))[:, 0]
    east = np.array([np.diff(g.geom(e)[[0, -1], 0])[0] > 0 for e in ce])     # cells of the eastbound edges
    name = np.asarray(g.edge_name)[ce]
    main = np.flatnonzero(east & (name == "Main")); main = main[np.argsort(fwd[main])]
    side = np.flatnonzero(east & (name == "Side")); side = side[np.argsort(fwd[side])]
    x = G.xy[main, 0] - G.xy[main, 0].min()
    pre, post = main[x < 140], main[x > 660]
    mid = main[(x >= 140) & (x <= 660)]
    with_prior = np.concatenate([pre, mid, post])                            # stays on Main
    n = len(mid)
    without = np.concatenate([pre, side[np.rint(np.linspace(0, len(side) - 1, n)).astype(int)], post])   # takes Side between the junctions
    t = 2.0 * np.arange(len(with_prior))
    out = L.prior_decided(g, G, E, t, with_prior, without)
    assert len(out) == 1
    r = out[0]
    assert r["name_with"] == "Main" and r["name_without"] == "Side"
    assert t[len(pre)] - 2 <= r["t0"] <= t[len(pre)] + 8 and t[len(pre) + n - 1] - 8 <= r["t1"] <= t[len(pre) + n - 1] + 2
    assert 350 < r["length_m"] < 520
    assert len(L.prior_decided(g, G, E, t, with_prior, without, same_m=C.PRIOR_DECIDED_SAME_M)) == 1   # the pipeline's threshold finds it too
    assert L.prior_decided(g, G, E, t, with_prior, with_prior) == []         # same route with and without the prior: nothing to report
    assert L.prior_decided(g, G, E, t, with_prior, without, min_s=1e6) == []


def test_local_end_masks_keep_the_ends_of_the_search_route():
    from rsm.hmm import grid
    from rsm.pipeline import local as L
    g = _two_streets()
    G = grid.build(g, None, h=15.0, sm=10.0)
    lxy = np.array([G.xy[:, 0].min(), G.xy[G.xy[:, 0].argmin(), 1]])[None, :] + np.array([[0.0, 0.0], [800.0, 0.0]])
    sa, ea = L.end_masks(G, lxy, 100.0)
    assert sa.any() and ea.any() and not (sa & ea).any()
    assert (G.xy[sa, 0] - lxy[0, 0]).max() <= 100.0 and (lxy[1, 0] - G.xy[ea, 0]).max() <= 100.0
    assert C.LOCAL_END_TOL_M == 300.0 and C.PRIOR_DECIDED_CONF == 0.5 and C.PRIOR_DECIDED_SAME_M < 15.0   # parallel streets are 15 to 40 m apart


# ------------------------------------------------------------------ driving line 2026-11-13: OSM cross-section (graph2), lane model L1, line solver L2
def test_osm_cross_section_tags_are_parsed_per_edge_direction():
    assert osm._width({"width": "6.5 m"}) == 6.5 and osm._width({"width": "6,5"}) == 6.5 and osm._width({"est_width": "4"}) == 4.0
    assert np.isnan(osm._width({"width": "wide"})) and np.isnan(osm._width({"width": "55"})) and np.isnan(osm._width({}))
    m = lambda x: (45.0, 5.0 + x / 78600.0)
    nodes = {1: m(0), 2: m(100), 3: m(200)}
    ways = [(1, {"highway": "primary", "lanes": "3", "lanes:forward": "2", "lanes:backward": "1", "width": "10", "cycleway:right": "lane"}, [1, 2]),
            (2, {"highway": "tertiary", "junction": "roundabout", "lane_markings": "no"}, [2, 3])]
    g = osm.build_graph(ways, nodes)
    fwd = [e for e in range(g.n_edges) if g.edge_way[e] == 1 and g.edge_u[e] == 0]
    bwd = [e for e in range(g.n_edges) if g.edge_way[e] == 1 and g.edge_u[e] == 1]
    assert g.edge_lanes_fwd[fwd[0]] == 2 and g.edge_lanes_fwd[bwd[0]] == 1 and g.edge_lanes[fwd[0]] == 3 and g.edge_width[fwd[0]] == 10.0
    assert g.edge_cycle[fwd[0]] == 1 and g.edge_cycle[bwd[0]] == 0
    rb = [e for e in range(g.n_edges) if g.edge_way[e] == 2]
    assert len(rb) == 1 and g.edge_roundabout[rb[0]] and g.edge_marked[rb[0]] == 0 and np.isnan(g.edge_width[rb[0]])


def test_netgraph_load_accepts_graphs_without_the_cross_section(tmp_path):
    from rsm.network.graph import NetGraph
    m = lambda x: (45.0, 5.0 + x / 78600.0)
    g = osm.build_graph([(1, {"highway": "residential"}, [1, 2])], {1: m(0), 2: m(50)})
    g.save(tmp_path / "new.npz")
    assert NetGraph.load(tmp_path / "new.npz").edge_lanes is not None
    z = dict(np.load(tmp_path / "new.npz"))
    old = {k: v for k, v in z.items() if k in ("crs", "node_xy", "node_osm", "edge_u", "edge_v", "edge_len", "edge_way", "edge_off", "edge_geom", "edge_name", "edge_ref",
                                                "edge_highway", "edge_tunnel", "edge_bridge", "edge_oneway")}
    np.savez(tmp_path / "old.npz", **old)                                      # a graph1 file of an old project
    g1 = NetGraph.load(tmp_path / "old.npz")
    assert g1.edge_width is None and g1.n_edges == g.n_edges
    g1.save(tmp_path / "again.npz")                                            # None arrays are not written
    assert "edge_width" not in np.load(tmp_path / "again.npz").files


def _lane_R(n, **kw):
    R = dict(xy=np.column_stack([np.arange(n, dtype=float), np.zeros(n)]), highway=np.full(n, "tertiary"), width=np.full(n, np.nan), lanes=np.zeros(n, int),
             lanes_fwd=np.zeros(n, int), oneway=np.zeros(n, bool), roundabout=np.zeros(n, bool), marked=np.full(n, -1), cycle=np.zeros(n, int))
    R.update({k: (np.full(n, v) if np.isscalar(v) else v) for k, v in kw.items()})
    return R


def test_lane_model_positions_per_vehicle_and_road():
    from rsm.pipeline import lane as LN
    W = C.LANE_WIDTH_DEFAULT["tertiary"]
    bike, car, moto = (LN.model(_lane_R(200), v)["d"][100] for v in ("bike", "car", "motorcycle"))
    assert bike == pytest.approx(W / 2 - C.LANE_BIKE_EDGE_M[0])                # near the own edge
    assert car == pytest.approx(W / 4)                                         # centre of the own lane of a two-lane road
    assert moto == pytest.approx(W / 4 - C.LANE_MOTO_SHIFT_M)
    assert LN.model(_lane_R(200, width=8.0), "car")["d"][100] == pytest.approx(2.0)   # tagged width wins
    assert LN.model(_lane_R(200, width=8.0), "car")["sd"][100] == C.LANE_SD_M[0]
    assert LN.model(_lane_R(200, oneway=True), "car")["d"][100] == pytest.approx(0.0)  # one lane one-way: on the OSM line
    m2 = LN.model(_lane_R(200, oneway=True, highway="motorway", lanes=2), "car")
    assert m2["d"][100] == pytest.approx(3.75 / 2)                             # right lane of a two-lane carriageway
    nar = LN.model(_lane_R(200, highway="unclassified"), "car")
    assert nar["lo"][100] < 0 < nar["d"][100] <= 0.5                           # narrow road without own half: near the middle
    assert LN.model(_lane_R(200, highway="unclassified"), "bike")["lo"][100] == 0.0   # a bike keeps its half
    rb = LN.model(_lane_R(200, roundabout=True), "car")
    assert rb["lo"][100] == pytest.approx(-C.LANE_WIDTH_DEFAULT["roundabout"] / 2 + C.LANE_MARGIN_M["car"])
    # step between two edges: a ramp over LANE_RAMP_M, no jump
    hw = np.array(["tertiary"] * 100 + ["primary"] * 100)
    d = LN.model(_lane_R(200, highway=hw), "car")["d"]
    assert np.abs(np.diff(d)).max() < 0.2 and d[10] == pytest.approx(W / 4) and d[190] == pytest.approx(C.LANE_WIDTH_DEFAULT["primary"] / 4)


def _bend(sign=1.0, R=40.0):
    a = np.column_stack([np.arange(0, 300.0), np.zeros(300)])
    th = np.linspace(0, np.pi / 2, int(np.pi / 2 * R))[1:]
    b = np.column_stack([300 + R * np.sin(th), R - R * np.cos(th)])
    c = np.column_stack([np.full(300, b[-1, 0]), b[-1, 1] + np.arange(1, 301.0)])
    return np.vstack([a, b, c]) * np.array([1.0, sign]), 300 + len(th) // 2


def test_line_solver_flattens_bends_to_the_inside_when_fast_and_keeps_the_lane_when_slow():
    for sign, inside in ((1.0, -1), (-1.0, +1)):                                # left bend: inside = smaller d (left); right bend: larger d
        xy, apex = _bend(sign)
        n = len(xy)
        lo, hi, dp = np.zeros(n), np.full(n, 1.8), np.full(n, 0.9)
        slow = O.solve_line(xy, dp, lo, hi, np.full(n, 4.0))
        fast = O.solve_line(xy, dp, lo, hi, np.full(n, 15.0))
        assert np.abs(slow - 0.9).max() < 0.1                                   # a slow rider keeps the lane position
        assert inside * (fast[apex] - 0.9) > 0.3                                # a fast one cuts towards the inside ...
        assert (fast >= lo - 1e-6).all() and (fast <= hi + 1e-6).all()          # ... inside the corridor
        assert abs(fast[100] - 0.9) < 0.05 and abs(fast[-100] - 0.9) < 0.05     # back in the lane on the straights
    xy, apex = _bend(1.0)
    n = len(xy)
    left = O.solve_line(xy, np.full(n, 0.9), np.zeros(n), np.full(n, 1.8), np.full(n, 15.0), side="left")
    assert left[apex] > 0.9 + 0.3                                               # left-hand traffic: a left bend is on the driving side, the inside is larger d


def test_gpx_line_layer_rule():
    assert steps_d.line_layer({"offset_m": 1.5}) == "fixed" and steps_d.line_layer({"offset_m": 1.5, "line": "model"}) == "fixed"
    assert steps_d.line_layer({}) == C.LINE_DEFAULT and steps_d.line_layer({"line": "fixed"}) == "fixed" and steps_d.line_layer({"line": "model"}) == "model"


# ------------------------------------------------------------------ Bavaria fixes F1 / F2 / F3 / F5 (docs/BAVARIA_DIAGNOSIS.md "Fixes")
def test_bike_paths_run_option_overrides_the_config_for_a_bike_only():
    m = steps_b.bike_paths_mode
    for req in ("bike", "auto"):
        vj = dict(requested=req, effective="bike")
        assert m(vj, "on") == (True, False) and m(vj, "fallback") == (False, True) and m(vj, "off") == (False, False)
        assert m(vj, None) == m(vj)                                                        # no option: the config flags decide, as before
    for v in ("motorcycle", "car"):
        for mode in ("on", "fallback", "off", None):
            assert m(dict(requested="auto", effective=v), mode) == (False, False) and m(dict(requested=v, effective=v), mode) == (False, False)
    with pytest.raises(ValueError):
        m(dict(requested="bike", effective="bike"), "always")


def test_cli_bike_paths_option_and_map_hash(tmp_path):
    from rsm.pipeline.cli import Run, parse_args
    assert parse_args(["run", "--video", "v", "--bbox", "1,2,3,4", "--pbf", "p", "--out", "o"]).bike_paths is None
    assert parse_args(["run", "--video", "v", "--bbox", "1,2,3,4", "--pbf", "p", "--out", "o", "--bike-paths", "fallback"]).bike_paths == "fallback"
    with pytest.raises(SystemExit):
        parse_args(["run", "--video", "v", "--bbox", "1,2,3,4", "--pbf", "p", "--out", "o", "--bike-paths", "yes"])
    vid, pbf = tmp_path / "v.mp4", tmp_path / "p.pbf"
    vid.write_bytes(b"x"); pbf.write_bytes(b"y")
    run = Run(parse_args(["run", "--video", str(vid), "--bbox", "1,2,3,4", "--pbf", str(pbf), "--out", str(tmp_path / "o")]))
    base = dict(video=str(vid), bbox=dict(south=1, west=2, north=3, east=4), pbf=str(pbf), vehicle="auto", offset_m=None, start_time=None, traffic_side="auto", decoys=0, start_tol_m=150.0, hint_buffer_m=300.0, hint_fallback="auto")
    h0 = run.hashes(base)
    assert run.hashes(dict(base, bike_paths="off")) == h0                                  # off = the default while the config flags are off: old checkpoints stay
    hon, hfb = run.hashes(dict(base, bike_paths="on")), run.hashes(dict(base, bike_paths="fallback"))
    assert hon["map"] != h0["map"] and hfb["map"] != h0["map"] and hon["map"] != hfb["map"] and hon["rotation"] == h0["rotation"]


def test_bike_speed_limit_of_the_calibration_check(monkeypatch):
    from rsm.pipeline import calib as CB
    assert C.CAL_VMAX_BIKE == C.CAL_VMAX                                                  # F2 shipped off
    monkeypatch.setattr(C, "CAL_VMAX_BIKE", C.CAL_VMAX_BIKE_ON)
    st = CB.motion_stats([_circle_track(10.0, 500.0)])                                   # v99 10 m/s, tiny lateral acceleration
    assert CB.vmax_for("bike") == C.CAL_VMAX_BIKE < C.CAL_VMAX and CB.vmax_for("motorcycle") == CB.vmax_for("car") == CB.vmax_for(None) == C.CAL_VMAX
    k = 0.5 * (C.CAL_VMAX_BIKE + C.CAL_VMAX) / 10.0                                       # between the two limits (e.g. 32 m/s)
    assert CB.plausible(st, C.F_REF, k) and not CB.plausible(st, C.F_REF, k, vmax=CB.vmax_for("bike"))
    assert CB.plausible(st, C.F_REF, 1.4, vmax=CB.vmax_for("bike"))                       # 14 m/s: the dev bikes' true calibrations stay plausible
    assert CB.plausible_mask(st, [C.F_REF], [1.0, k], CB.vmax_for("bike")).tolist() == [[True, False]]
    assert CB.plausible_mask(st, [C.F_REF], [1.0, k]).tolist() == [[True, True]]


def test_bike_base_kappa_grid_reaches_below_the_old_edge_within_the_memory_cap(monkeypatch):
    assert C.K_GRID_BIKE == C.K_GRID                                                      # F5 shipped off
    monkeypatch.setattr(C, "K_GRID_BIKE", C.K_GRID_BIKE_ON)
    assert steps_b.base_k_grid("bike")[1:] == C.K_GRID and steps_b.base_k_grid("bike")[0] < C.K_LO
    assert steps_b.base_k_grid("bike")[0] == pytest.approx(C.K_GRID[0] ** 2 / C.K_GRID[1]) and steps_b.base_k_grid("motorcycle") == C.K_GRID == steps_b.base_k_grid(None)
    seen = {}

    def fake_scan_full(pres, st, on_done=None, g=None, cons=None, kg=None):
        seen["kg"] = list(kg)
        return np.zeros((len(C.F_GRID), len(kg)))

    monkeypatch.setattr(steps_b, "scan_full", fake_scan_full)
    monkeypatch.setattr(steps_b, "prepared_gen", lambda g, E, kg=None: iter(()))
    monkeypatch.setattr(steps_b, "extend_scan", lambda S, fg, kg, *a, **k: (S, list(fg), list(kg), []))
    st = type("St", (), dict(T=100, km=1.0))()
    tick = type("Tick", (), dict(total=0))()
    for cells, expect in ((1000, list(C.K_GRID_BIKE)), (10 ** 9, list(C.K_GRID))):        # the low column only when its HMM arrays fit HMM_CAP_GB
        monkeypatch.setattr(osm, "n_cells", lambda g, E, h, n=cells: n)
        S, fg, kg, _ = steps_b._scan(None, None, st, None, tick, None, C.K_GRID_BIKE)
        assert seen["kg"] == expect and kg == expect and S.shape == (len(C.F_GRID), len(expect))
    steps_b._scan(None, None, st, None, tick, None)                                        # default: the old grid
    assert seen["kg"] == list(C.K_GRID)


@pytest.mark.parametrize("tags,ok", [
    ({"highway": "service", "motor_vehicle": "agricultural;forestry"}, True), ({"highway": "service", "access": "private"}, False),
    ({"highway": "service", "vehicle": "no"}, False), ({"highway": "service", "service": "parking_aisle"}, False), ({"highway": "service", "service": "driveway"}, False),
    ({"highway": "service", "service": "driveway", "bicycle": "yes"}, True), ({"highway": "service", "bicycle": "no"}, False),
    ({"highway": "footway"}, False), ({"highway": "bridleway"}, False),                    # unchanged: only with a permission
])
def test_service_ways_without_bicycle_tag_enter_path_maps(tags, ok, monkeypatch):
    monkeypatch.setattr(C, "BIKE_SERVICE_UNTAGGED", True)                                  # F3 is shipped off; the rule itself is tested switched on
    assert osm.way_ok(tags) is ok


def test_service_rule_switch_and_cache_token(monkeypatch):
    assert C.BIKE_SERVICE_UNTAGGED is False and C.BIKE_PATH_RULES == "bikepath2"            # shipped off: the old rule and cache token
    assert osm.rules_token(C.CLASSES_BIKE_PATHS) == ["bikepath2"] and osm.rules_token(C.CLASSES_BIKE) == []
    assert "service" not in C.CLASSES_BIKE and "service" not in C.CLASSES_MOTOR and "service" not in C.LOCAL_EXTRA     # the road sets never read service ways
    assert osm.way_ok({"highway": "service"}) is False and osm.way_ok({"highway": "service", "bicycle": "yes"}) is True


def test_fit_search_keeps_the_roads_when_no_path_tier_fits():
    nodes = {i: (47.0 + 0.001 * (i // 10), 11.0 + 0.001 * (i % 10)) for i in range(30)}
    ways = [(1, {"highway": "tertiary"}, list(range(0, 10))), (2, {"highway": "cycleway"}, list(range(10, 20))), (3, {"highway": "path"}, list(range(20, 30)))]
    g = osm.build_graph(ways, nodes)
    tiers = osm.edge_tiers(g, ways)
    E = np.arange(g.n_edges)
    road = np.flatnonzero(g.edge_highway == "tertiary")
    gb = lambda sel: osm.memory_plan(g, sel, 1000, 1e9)["gb"]
    Ef, t = steps_b.fit_search(g, E, tiers, 1000, cap_gb=gb(E) * 1.01)
    assert t is None and len(Ef) == len(E)
    Ef, t = steps_b.fit_search(g, E, tiers, 1000, cap_gb=gb(road) * 1.01)               # tier 0 (road + cycleway) too large: the roads alone
    assert t == -1 and sorted(Ef.tolist()) == sorted(road.tolist())
    assert sorted(steps_b.keep_tiers(g, E, tiers, -1).tolist()) == sorted(road.tolist()) and len(steps_b.keep_tiers(g, E, tiers, None)) == len(E)
    with pytest.raises(MemoryError):
        steps_b.fit_search(g, E, tiers, 1000, cap_gb=gb(road) * 0.5)
    with pytest.raises(MemoryError):                                                       # a road-only map: the old error, no silent change
        steps_b.fit_search(g, road, np.zeros(g.n_edges, np.int8), 1000, cap_gb=gb(road) * 0.5)


def test_retime_keeps_the_track_segments_of_scene_cuts(tmp_path):
    _fake_project(tmp_path)
    rp = json.loads((tmp_path / "route_points.json").read_text())
    rp["cuts"] = dict(times=[1.5], intro_end=None, breaks=[2.0])
    (tmp_path / "route_points.json").write_text(json.dumps(rp))
    steps_d.retime(tmp_path, "2026-05-01T08:30:00+02:00")
    ns = {"g": "http://www.topografix.com/GPX/1/1", "rsm": "https://ridrs.org/rsm/1"}
    root = ET.parse(tmp_path / "route.gpx").getroot()
    assert [len(s.findall("g:trkpt", ns)) for s in root.findall(".//g:trkseg", ns)] == [2, 2]
    assert root.find("g:metadata/g:extensions/rsm:cuts", ns).text == "1.50"


def test_rotation_cut_decision_writes_cuts_and_status_only_for_an_edited_video(tmp_path, capsys):
    from rsm.pipeline import steps_a
    from rsm.pipeline.common import Worker
    (tmp_path / "motion").mkdir(); (tmp_path / "rotation").mkdir()
    tr = [dict(t=np.arange(a, b, 0.5), s=np.arange(a, b, 0.5) * 8.0 - a * 8.0, th=np.zeros(len(np.arange(a, b, 0.5)))) for a, b in ((1, 30), (41, 600), (601, 900))]
    ta = np.arange(0, 1000, 0.26); tb = ta + 0.26; ok = np.ones((len(ta), 3), bool); ninl = np.full((len(ta), 3), 200.0)
    (tmp_path / "motion" / "cuts.json").write_text(json.dumps(dict(candidates=[])))
    assert steps_a.scene_cuts(tmp_path, tmp_path / "rotation", tr, ta, tb, ok, ninl, Worker()) is tr
    assert capsys.readouterr().out == "" and json.loads((tmp_path / "rotation" / "cuts.json").read_text())["n_cuts"] == 0
    cands = [dict(i=1, t=40.0, vms=True), dict(i=2, t=600.5, vms=False), dict(i=3, t=950.0, vms=False)]   # 950: spike without a model cue
    (tmp_path / "motion" / "cuts.json").write_text(json.dumps(dict(candidates=cands)))
    ok[int(np.searchsorted(ta, 600.5, side="right") - 1)] = False                                          # 600.5: confirmed by the far-feature fit
    out = steps_a.scene_cuts(tmp_path, tmp_path / "rotation", tr, ta, tb, ok, ninl, Worker())
    ev = [json.loads(l) for l in capsys.readouterr().out.splitlines()]
    st = {e["signal"]: e for e in ev if e["type"] == "status"}
    assert st["scene_cuts"]["value"] == 2 and st["intro_skipped"]["value"] == 40.0 and "intro up to 0:40 skipped" in st["intro_skipped"]["message"]
    assert [float(x["t"][0]) for x in out] == [41.0, 601.0] and out[1]["cut_before"] == 600.5
    assert json.loads((tmp_path / "rotation" / "cuts.json").read_text())["cut_times"] == [40.0, 600.5]


# ------------------------------------------------------------------ local pass acceptance test 2026-11-13 (docs/GOTTHARD_DIAGNOSIS.md)
def test_step_masks_force_the_path_through_a_cell_at_a_step():
    from rsm.hmm import grid
    from rsm.hmm_cal import dp
    from rsm.hmm import seq
    g = _two_streets()
    G = grid.build(g, None, h=15.0, sm=10.0)
    tr = [dict(t=np.linspace(0, 80, 201), s=np.linspace(0, 800, 201), th=np.zeros(201))]
    st = seq.make_steps(tr, 15.0)
    pre = dp.prepare(G, dp.Par())
    free = dp.viterbi(pre, st, backptr=True)
    side = np.array([e in set(np.nonzero(np.asarray(g.edge_name) == "Side")[0]) for e in G.edges[G.cell_ei]])
    j = st.T // 2
    forced = dp.viterbi(pre, st, backptr=True, step_ok={j: side})
    assert side[forced["cell_path"][j]] and not side[free["cell_path"][j]]
    assert forced["score"] <= free["score"]
    fb = dp.forward_backward(pre, st, forced["cell_path"], step_ok={j: side})
    assert np.asarray(g.edge_name)[fb["e_max"][j]] == "Side"     # the posterior at the masked step is on the side street


def test_turn_landmarks_find_a_right_angle_turn_and_explains_checks_the_road():
    from types import SimpleNamespace
    from rsm.pipeline import local as L
    s = np.arange(0, 400, 4.0)
    th = np.where(s < 200, 0.0, np.radians(-90.0))           # a right turn of 90 degrees at 200 m (left +)
    tr = [dict(t=s / 10.0, s=s, th=th)]
    lms = L.turn_landmarks(tr, 1.0, 1.0)
    assert len(lms) == 1 and abs(np.degrees(lms[0]["dth"]) + 90) < 1 and lms[0]["t0"] < 20.0 <= lms[0]["t1"]
    sg = np.arange(0, 400, 1.0)
    turning = SimpleNamespace(sg=sg, phi=np.where(sg < 200, 0.0, np.radians(-90.0)))
    straight = SimpleNamespace(sg=sg, phi=np.zeros_like(sg))
    t = np.arange(0, 40, 1.0)
    assert L.explains((turning, t * 10.0, t), lms[0]) and not L.explains((straight, t * 10.0, t), lms[0])
    assert C.LOCAL_ACCEPT_ON and C.LOCAL_ACCEPT_NATS == 5.0 and C.LOCAL_ACCEPT_MIN_S == 30.0


def test_alignment_posterior_is_narrow_in_the_turn_and_wide_on_the_straight():
    from scipy.ndimage import gaussian_filter1d
    from rsm.pipeline import align as AL
    sg, xy = _corner_path()
    kappa, v = 2.5, 6.0
    s_true = np.arange(0, 590.0, 4.0 * kappa)
    t = s_true / v
    th = gaussian_filter1d(np.where(s_true < 300, 0.0, np.pi / 2), 12.0 / (4.0 * kappa))
    al = AL.align(sg, xy, [dict(t=t, s=s_true / kappa, th=th)], kappa, 1.0, t, s_true)
    sd_turn = float(np.interp(300.0 / v, al["t"], al["s_sd"]))
    sd_straight = float(np.interp(100.0 / v, al["t"], al["s_sd"]))
    assert sd_turn < 6.0 and sd_straight > 2.0 * sd_turn
    assert abs(np.interp(300.0 / v, al["t"], al["s_mean"]) - 300.0) < 8.0


# ------------------------------------------------------------------ GPX raster (C.GPX_HZ points per video second)
def test_grid_flags_same_rules_on_both_grids():
    from rsm.pipeline.steps_c import grid_flags
    post_ = dict(t=np.arange(0.0, 31.0), p_vit=np.linspace(0.5, 1.0, 31))
    args = (2.0, 28.0, post_, [dict(t0=5.0, t1=7.0)], [dict(t0=20.0, t1=21.0)], [(10.0, 12.0)], [(15.0, 15.5)], [(24.0, 26.0)])
    t1 = np.arange(0.0, 31.0)
    t5 = np.arange(30 * 5 + 1) / 5
    a, b = grid_flags(t1, *args), grid_flags(t5, *args)
    on_sec = np.isclose(t5 % 1.0, 0.0)
    for x, y in zip(a, b):
        assert np.array_equal(np.asarray(x), np.asarray(y)[on_sec])       # the raster agrees with the 1 s grid at every whole second
    conf, extrap, in_gap, in_still, in_prior = b
    assert in_gap[(t5 > 10) & (t5 <= 12)].all() and not in_gap[np.isclose(t5, 10.0)].any()
    assert in_gap[(t5 > 15) & (t5 <= 16)].all() and in_still[(t5 >= 24) & (t5 <= 26)].all() and not in_gap[in_still].any()
    assert (conf[in_prior] <= C.PRIOR_DECIDED_CONF).all() and extrap[t5 < 2].all() and (conf[extrap] == 0).all()


def test_export_uses_the_gpx_raster(tmp_path):
    from rsm.pipeline import export as X
    d = tmp_path / "run"
    _fake_export_run(d)
    f = d / "refine" / "result.npz"
    R = dict(np.load(f))
    hz = 5
    tg = np.arange(int(R["t"][-1]) * hz + 1) / hz
    R.update(gx_hz=np.array(hz), gx_t=tg, gx_s=np.interp(tg, R["t"], R["s"]), gx_s_sd=np.ones(len(tg)), gx_conf=np.interp(tg, R["t"], R["conf"]),
             gx_extrap=(tg < 3) | (tg > R["t"][-1] - 2), gx_in_gap=np.zeros(len(tg), bool), gx_in_still=np.zeros(len(tg), bool))
    np.savez_compressed(f, **R)
    summ = X.export(d, tmp_path / "r.gpx", tmp_path / "r.json", None)
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    times = [np.datetime64(p.find("g:time", ns).text.rstrip("Z")) for p in ET.parse(tmp_path / "r.gpx").getroot().findall(".//g:trkpt", ns)]
    ms = np.diff(times).astype("timedelta64[ms]").astype(int)
    assert (ms == 200).mean() > 0.9 and np.all(ms > 0)                         # five points per second, strictly increasing
    assert summ["points_per_second"] == 5 and summ["seconds_exported"] == 115 and summ["trimmed_head_s"] == 3 and summ["trimmed_tail_s"] == 2


def test_out_grid_falls_back_to_seconds(tmp_path):
    d = tmp_path / "run"
    _fake_export_run(d)
    G = steps_d.out_grid(np.load(d / "refine" / "result.npz"))
    assert G["hz"] == 1 and np.array_equal(G["t"], np.arange(120.0)) and not G["in_still"].any()


def test_retime_writes_the_gpx_raster(tmp_path):
    _fake_project(tmp_path)
    rp = json.loads((tmp_path / "route_points.json").read_text())
    rp["gpx_points"] = [dict(p, t=i / 5) for i, p in enumerate(rp["points"])]
    (tmp_path / "route_points.json").write_text(json.dumps(rp))
    steps_d.retime(tmp_path, "2000-01-01T00:00:00Z")
    ns = {"g": "http://www.topografix.com/GPX/1/1"}
    tx = [t.text for t in ET.parse(tmp_path / "route.gpx").getroot().findall(".//g:trkpt/g:time", ns)]
    assert tx == ["2000-01-01T00:00:00Z", "2000-01-01T00:00:00.200Z", "2000-01-01T00:00:00.400Z", "2000-01-01T00:00:00.600Z"]


# ------------------------------------------------------------------ contract: the route side never reads the video (docs/CONCEPT_test_strategy.md, A)
ROUTE_STEPS = ("map_step", "route_search", "plausibility", "refine", "gpx_step")


def _no_video(monkeypatch):
    """every way the pipeline decodes a video raises"""
    import cv2
    from rsm.pipeline import cuts as K
    from rsm.pipeline.vmsx import decode as DEC

    def boom(*a, **k):
        raise AssertionError("a route-side step read the video")
    for mod, name in ((DEC, "frames"), (DEC, "probe"), (K, "grey_frames"), (K, "probe"), (cv2, "VideoCapture")):
        if hasattr(mod, name):
            monkeypatch.setattr(mod, name, boom)


def test_route_search_runs_without_the_video(tmp_path, monkeypatch):
    """with a finished image side (motion.json present, standstills in rotation/) and a video path that does not exist, route_search reads no frame"""
    from rsm.pipeline import steps_b
    _no_video(monkeypatch)
    monkeypatch.setattr(steps_b, "_search", lambda d, P, W, g, E, st, cons, label="scan": dict(
        step_t=np.arange(3.0), step_cell=np.arange(3), f_eff=400.0, kappa=1.2, a_ang=1.1, score=-1.0, score_per_km=-1.0, km=1.0,
        surface=dict(interior_f=True, interior_kappa=True, best_minus_median=9.0), conf_mean=0.99, conf_below_half=0.0, edge_share=0.0,
        _ll=np.array([[5.0, 45.0]] * 3), _xy=np.zeros((3, 2)), post=None))
    monkeypatch.setattr(steps_b.T, "steps_of", lambda tr: type("S", (), {"km": 1.0})())
    monkeypatch.setattr(steps_b, "load_map", lambda d, n: (None, np.arange(3)))
    import pickle
    for k in ("rotation", "motion", "map"):
        (tmp_path / k).mkdir()
    pickle.dump([], open(tmp_path / "rotation" / "tracks.pkl", "wb"))
    (tmp_path / "motion" / "motion.json").write_text(json.dumps(dict(horizon=170.0)))
    (tmp_path / "motion" / "summary.json").write_text(json.dumps(dict(usable_share=1.0)))
    (tmp_path / "rotation" / "summary.json").write_text(json.dumps(dict(features=dict(yaw_ratio=1.0))))
    (tmp_path / "rotation" / "vehicle.json").write_text(json.dumps(dict(requested="bike", effective="bike")))
    (tmp_path / "rotation" / "standstill.json").write_text(json.dumps(dict(version=2, spans=[])))

    class W:
        def progress(self, *a, **k): pass
        def log(self, level, msg): pass
        def status(self, sig, lev, val, msg): pass
    out = steps_b.route_search(tmp_path, dict(bbox=dict(south=44.0, west=4.0, north=45.0, east=5.0), video=str(tmp_path / "missing.mp4")), W())
    assert out["edge_set"] == "real"
    assert (tmp_path / "rotation" / "standstill.json").exists()          # the image side's result stays; route_search does not own it


def test_route_side_modules_call_no_decoder():
    """the modules of the route-side steps call no video decoder (P["video"] may still name the result, as gpx_step does with the file stem)"""
    import inspect
    from rsm.pipeline import odofail, steps_b, steps_c, steps_d
    assert all(hasattr(m, n) for m in (steps_b, steps_c, steps_d) for n in ROUTE_STEPS if n in vars(m)) and \
        {n for m in (steps_b, steps_c, steps_d) for n in ROUTE_STEPS if n in vars(m)} == set(ROUTE_STEPS)
    for m in (steps_b, steps_c, steps_d, odofail):
        src = inspect.getsource(m)
        for tok in ("vmsx.decode", "frames(", "probe(", "VideoCapture", "grey_frames", "SS.detect", "veto_same_scene", "ffmpeg"):
            assert tok not in src, (m.__name__, tok)


def test_standstill_is_part_of_the_rotation_step(tmp_path, monkeypatch):
    """steps_a.standstill: detection with the video into rotation/standstill.json; a stale file goes when the detection does not run"""
    from rsm.pipeline import steps_a
    (tmp_path / "rotation").mkdir(); (tmp_path / "motion").mkdir()
    (tmp_path / "motion" / "motion.json").write_text("{}")
    seen = []

    def fake_detect(d, video, progress=None):
        seen.append(video)
        (Path(d) / "rotation" / "standstill.json").write_text(json.dumps(dict(spans=[[1.0, 4.0]])))
        return dict(spans=[[1.0, 4.0]], n_candidates=1, n_runs=1, n_tested=1, seconds=0.0)
    monkeypatch.setattr(steps_a.SS, "detect", fake_detect)

    class W:
        ev = []
        def progress(self, *a, **k): pass
        def log(self, level, msg): pass
        def status(self, sig, lev, val, msg): self.ev.append(sig)
    w = W()
    steps_a.standstill(tmp_path, dict(video="/v.mp4"), w)
    assert seen == ["/v.mp4"] and "standstill" in w.ev
    assert json.loads((tmp_path / "rotation" / "standstill.json").read_text())["spans"] == [[1.0, 4.0]]
    steps_a.standstill(tmp_path, dict(), w)                               # no video: nothing detected, no stale result left
    assert not (tmp_path / "rotation" / "standstill.json").exists()
