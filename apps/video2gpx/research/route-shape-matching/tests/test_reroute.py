# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for fast interactive rerouting (rsm.pipeline.reroute & CLI `reroute`)."""
from __future__ import annotations

import json
import pickle
from pathlib import Path

import numpy as np
import pytest
from pyproj import Transformer

from rsm.network.graph import NetGraph
from rsm.pipeline import cli, osm, reroute as RR
from rsm.pipeline.common import jdump, jload


def _make_grid_graph(crs: str = "EPSG:32632", x0: float = 500000.0, y0: float = 5200000.0) -> tuple[NetGraph, float, float]:
    """2-row x 5-col grid: main road at y=y0 (x=0..1200 step 300), parallel cycleway at y=y0+100, cross streets at every 300 m."""
    xs = [x0 + 300.0 * i for i in range(5)]
    ys = [y0, y0 + 100.0]
    nodes = [(x, y) for y in ys for x in xs]  # 0..4 bottom, 5..9 top
    nxy = np.array(nodes, float)
    nosm = np.arange(1, len(nodes) + 1, dtype=np.int64)

    eu, ev, elen, eway, eoff, egeom, ename, eref, ehw, etu, ebr, eow = [], [], [], [], [0], [], [], [], [], [], [], []
    wid = 100

    def add_seg(u: int, v: int, hw: str, name: str):
        nonlocal wid
        wid += 1
        p0, p1 = nxy[u], nxy[v]
        # 5-point polyline for realistic geometry
        pts = np.column_stack([np.linspace(p0[0], p1[0], 5), np.linspace(p0[1], p1[1], 5)])
        L = float(np.hypot(*(p1 - p0)))
        for a, b, g_ in ((u, v, pts), (v, u, pts[::-1])):
            eu.append(a); ev.append(b); elen.append(L); eway.append(wid)
            egeom.append(g_); eoff.append(eoff[-1] + len(g_))
            ename.append(name); eref.append(""); ehw.append(hw)
            etu.append(False); ebr.append(False); eow.append(False)

    for i in range(4):
        add_seg(i, i + 1, "secondary", "Hauptstrasse")
        add_seg(5 + i, 5 + i + 1, "cycleway", "Radweg")
    for i in range(5):
        add_seg(i, 5 + i, "residential", f"Querstrasse {i}")

    g = NetGraph(
        crs=crs,
        node_xy=nxy,
        node_osm=nosm,
        edge_u=np.array(eu, np.int32),
        edge_v=np.array(ev, np.int32),
        edge_len=np.array(elen, float),
        edge_way=np.array(eway, np.int64),
        edge_off=np.array(eoff, np.int64),
        edge_geom=np.vstack(egeom),
        edge_name=np.array(ename),
        edge_ref=np.array(eref),
        edge_highway=np.array(ehw),
        edge_tunnel=np.array(etu, bool),
        edge_bridge=np.array(ebr, bool),
        edge_oneway=np.array(eow, bool),
    )
    return g, x0, y0


def _make_finished_run(tmp_path: Path, g: NetGraph, x0: float, y0: float, true_detour: bool = True) -> Path:
    """Create a minimal finished pipeline output directory on the grid graph (no PBF needed; falls back to map/graph.npz)."""
    d = tmp_path / "out"
    for sub in ("map", "motion", "rotation", "route_search", "refine", "steps"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    g.save(d / "map" / "graph.npz")

    # Original detected route: straight along y=y0 from x0 to x0+1200 (1200 m)
    sg = np.arange(0.0, 1201.0, 1.0)
    orig_xy = np.column_stack([x0 + sg, np.full_like(sg, y0)])
    n_s = len(sg)

    # Video tracks: speed 10 m/s. If true_detour=True, video actually turned left at 300 m -> rode 600 m on y0+100 -> turned right at 900 m (1400 m total, 140 s)
    if true_detour:
        pts_true = np.array([
            [x0, y0], [x0 + 300, y0], [x0 + 300, y0 + 100], [x0 + 900, y0 + 100], [x0 + 900, y0], [x0 + 1200, y0],
        ], float)
    else:
        pts_true = np.array([[x0, y0], [x0 + 1200, y0]], float)
    seg_d = np.hypot(*np.diff(pts_true, axis=0).T)
    cp = np.concatenate([[0.0], np.cumsum(seg_d)])
    L_true = float(cp[-1])
    speed = 10.0  # m/s
    dur = L_true / speed
    # 4 m nominal track samples (kappa = 1.0)
    s_tr = np.arange(0.0, L_true + 1e-6, 4.0)
    t_tr = s_tr / speed
    tx = np.interp(s_tr, cp, pts_true[:, 0])
    ty = np.interp(s_tr, cp, pts_true[:, 1])
    th_tr = np.unwrap(np.arctan2(np.gradient(ty), np.gradient(tx)))
    tracks = [dict(t=t_tr, s=s_tr, th=th_tr)]
    pickle.dump(tracks, open(d / "rotation" / "tracks.pkl", "wb"))

    # Minimal motion.csv (2 Hz pairs, matching rsm.odometry.vms_csv.COLUMNS)
    dt = 0.5
    tm = np.arange(0.25, dur, dt)
    lines = ["frame,time,corners,tracked,inliers,rms_px,s,c,yaw,pitch,roll,diff,rel_speed"]
    for i, t_ in enumerate(tm):
        lines.append(f"{i},{t_:.3f},60,50,40,0.4,{speed * dt:.4f},0,0,0,0,0,{speed:.4f}")
    (d / "motion" / "motion.csv").write_text("\n".join(lines) + "\n")
    jdump(d / "motion" / "summary.json", dict(duration_s=dur, usable_share=0.98))
    jdump(d / "rotation" / "summary.json", dict(features=dict(yaw_ratio=0.95)))

    # Minimal route_search outputs
    pickle.dump(
        dict(kappa=1.0, a_ang=1.0, conf_mean=0.95, conf_below_half=0.0, surface=dict(interior_f=True, interior_kappa=True, best_minus_median=12.0)),
        open(d / "route_search" / "route.pkl", "wb"),
    )
    jdump(d / "route_search" / "vehicle_final.json", dict(vehicle="bike", from_kappa=False))
    jdump(d / "route_search" / "summary.json", dict(f_eff=400.0, kappa=1.0, score_per_km=0.0, peak_ratio=1.5, margin=10.0, conf_mean=0.95, coverage=1.0, yaw_ratio=1.0, n_steps=40, path_km=1.2))

    # Minimal refine/result.npz on original straight route
    t_all = np.arange(0.0, np.floor(dur) + 1.0)
    s_all = np.clip(t_all * (1200.0 / dur), 0.0, 1200.0)
    s_sd = np.full_like(t_all, 5.0)
    conf = np.full_like(t_all, 0.92)
    extrap = np.zeros(len(t_all), bool)
    in_gap = np.zeros(len(t_all), bool)
    in_still = np.zeros(len(t_all), bool)
    np.savez_compressed(
        d / "refine" / "result.npz",
        t=t_all, s=s_all, s_sd=s_sd, conf=conf, extrap=extrap, in_gap=in_gap,
        still_t0=np.zeros(0), still_t1=np.zeros(0), still_s0=np.zeros(0), still_s1=np.zeros(0), still_sd=np.zeros(0), still_conf=np.zeros(0), in_still=in_still,
        sg=sg, xy=orig_xy, oneway=np.zeros(n_s, bool), tunnel=np.zeros(n_s, bool), bridge=np.zeros(n_s, bool), crs=np.array(g.crs),
        highway=np.full(n_s, "secondary"), width=np.full(n_s, np.nan, np.float32), lanes=np.zeros(n_s, np.int8), lanes_fwd=np.zeros(n_s, np.int8),
        roundabout=np.zeros(n_s, bool), marked=np.full(n_s, -1, np.int8), cycle=np.zeros(n_s, np.int8),
        gx_hz=np.array(1), gx_t=t_all, gx_s=s_all, gx_s_sd=s_sd, gx_conf=conf, gx_extrap=extrap, gx_in_gap=in_gap, gx_in_still=in_still,
    )
    jdump(d / "refine" / "summary.json", dict(path_km=1.2, conf_mean=0.92))
    jdump(d / "steps" / "refine.done.json", dict(id="refine", summary=dict(path_km=1.2, conf_mean=0.92)))

    tr = Transformer.from_crs(g.crs, "EPSG:4326", always_xy=True)
    lon0, lat0 = tr.transform(x0, y0)
    lon1, lat1 = tr.transform(x0 + 1200.0, y0 + 100.0)
    P = dict(
        video=str(tmp_path / "demo.mp4"),
        pbf="",
        bbox=dict(south=min(lat0, lat1) - 0.01, north=max(lat0, lat1) + 0.01, west=min(lon0, lon1) - 0.01, east=max(lon0, lon1) + 0.01),
        vehicle="bike",
        offset_m=0.0,
        start_time=None,
        traffic_side="right",
        decoys=0,
    )
    jdump(d / "project.params.json", P)
    return d


def test_route_through_via_parallel_path():
    g, x0, y0 = _make_grid_graph()
    orig_xy = np.column_stack([x0 + np.arange(0.0, 1201.0, 1.0), np.full(1201, y0)])
    via_xy = np.array([x0 + 600.0, y0 + 100.0])  # on the parallel cycleway

    path = RR.route_through_waypoints(g, orig_xy, orig_xy[0], orig_xy[-1], [(via_xy, 600.0)], start_moved=False, end_moved=False)
    # Must start near (x0, y0), end near (x0+1200, y0), and pass right through (x0+600, y0+100)
    assert np.hypot(*(path.xy[0] - orig_xy[0])) < 2.0
    assert np.hypot(*(path.xy[-1] - orig_xy[-1])) < 2.0
    d_via = np.min(np.hypot(path.xy[:, 0] - via_xy[0], path.xy[:, 1] - via_xy[1]))
    assert d_via < 2.0, f"route missed via dot by {d_via:.1f} m"
    # Detour length: 300 + 100 + 600 + 100 + 300 = 1400 m (no U-turns)
    assert 1380.0 <= path.sg[-1] <= 1420.0


def test_drag_start_and_end_exact_trim():
    g, x0, y0 = _make_grid_graph()
    orig_xy = np.column_stack([x0 + np.arange(0.0, 1201.0, 1.0), np.full(1201, y0)])
    new_start = np.array([x0 + 150.0, y0])  # mid-edge!
    new_end = np.array([x0 + 1050.0, y0])   # mid-edge!

    path = RR.route_through_waypoints(g, orig_xy, new_start, new_end, [], start_moved=True, end_moved=True)
    assert np.hypot(*(path.xy[0] - new_start)) < 2.0
    assert np.hypot(*(path.xy[-1] - new_end)) < 2.0
    assert 895.0 <= path.sg[-1] <= 905.0


def test_reroute_fits_timeline_without_fixed_timestamp_and_resets(tmp_path):
    g, x0, y0 = _make_grid_graph()
    d = _make_finished_run(tmp_path, g, x0, y0, true_detour=True)
    tr = Transformer.from_crs(g.crs, "EPSG:4326", always_xy=True)
    via_lon, via_lat = tr.transform(x0 + 600.0, y0 + 100.0)

    res = RR.reroute(d, dict(start=None, end=None, vias=[dict(lat=via_lat, lon=via_lon, orig_s=600.0)]))
    assert 1.38 <= res["path_km"] <= 1.42
    assert (d / "refine" / "result.orig.npz").exists()
    assert (d / "route.gpx").exists()
    rp = jload(d / "route_points.json")
    proj = jload(d / "project.json")
    assert proj["reroute"]["vias"][0]["lat"] == pytest.approx(via_lat, abs=1e-6)

    # Timeline must align to the 1400 m detour: at t=70 s (midpoint of 140 s), position should be near s=700 m (x0+600, y0+100)!
    pts = rp["points"]
    p_mid = min(pts, key=lambda p: abs(p["t"] - 70.0))
    tr_inv = Transformer.from_crs("EPSG:4326", g.crs, always_xy=True)
    mx, my = tr_inv.transform(p_mid["lon"], p_mid["lat"])
    assert abs(my - (y0 + 100.0)) < 5.0, f"expected mid-point on parallel path y={y0+100}, got {my}"
    assert abs(mx - (x0 + 600.0)) < 35.0, f"expected mid-point near x={x0+600}, got {mx}"

    # Reset restores the original 1.2 km straight route
    res0 = RR.reset_reroute(d)
    assert 1.19 <= res0["path_km"] <= 1.21
    proj0 = jload(d / "project.json")
    assert "reroute" not in proj0


def test_cli_reroute_and_reset(tmp_path, capsys):
    g, x0, y0 = _make_grid_graph()
    d = _make_finished_run(tmp_path, g, x0, y0, true_detour=True)
    tr = Transformer.from_crs(g.crs, "EPSG:4326", always_xy=True)
    s_lon, s_lat = tr.transform(x0 + 300.0, y0)
    e_lon, e_lat = tr.transform(x0 + 900.0, y0)
    spec = json.dumps(dict(start=dict(lat=s_lat, lon=s_lon), end=dict(lat=e_lat, lon=e_lon), vias=[]))

    rc = cli.main(["reroute", "--out", str(d), "--waypoints", spec])
    assert rc == 0
    lines = [json.loads(ln) for ln in capsys.readouterr().out.splitlines() if ln.strip()]
    res = [x for x in lines if x.get("type") == "result"][-1]
    assert 0.58 <= res["path_km"] <= 0.62

    rc2 = cli.main(["reroute", "--out", str(d), "--reset"])
    assert rc2 == 0
    lines2 = [json.loads(ln) for ln in capsys.readouterr().out.splitlines() if ln.strip()]
    res2 = [x for x in lines2 if x.get("type") == "result"][-1]
    assert 1.19 <= res2["path_km"] <= 1.21


def test_reroute_way_ok_keeps_dismount_bridge_footways_and_steps():
    # Exact OSM tags of Drehbrücke (way 79315837) and nearby paths/steps in Marburg
    assert RR.reroute_way_ok({"highway": "path", "bridge": "movable", "bicycle": "dismount", "foot": "designated"}) is True
    assert RR.reroute_way_ok({"highway": "footway", "surface": "asphalt"}) is True
    assert RR.reroute_way_ok({"highway": "steps", "step_count": "17"}) is True
    assert RR.reroute_way_ok({"highway": "service", "service": "parking_aisle"}) is True
    # Truly closed ways without bicycle/foot permission are still excluded
    assert RR.reroute_way_ok({"highway": "service", "access": "private"}) is False
    assert RR.reroute_way_ok({"highway": "path", "access": "no"}) is False
    assert RR.reroute_way_ok({"highway": "path", "access": "no", "bicycle": "yes"}) is True
    assert "steps" in RR.CLASSES_REROUTE


def test_contraflow_bike_oneway_allowed_in_reroute_graph():
    nodes = {1: (50.814, 8.776), 2: (50.815, 8.776)}
    ways = [
        (22756869, {"highway": "residential", "name": "Biegenstraße", "oneway": "yes", "oneway:bicycle": "no"}, [1, 2]),
        (169723496, {"highway": "residential", "name": "Uferstraße", "oneway": "yes", "oneway:bicycle": "yes"}, [1, 2]),
    ]
    g_car = osm.build_graph(ways, nodes, allow_contraflow_bike=False)
    g_bike = osm.build_graph(ways, nodes, allow_contraflow_bike=True)
    # Without contraflow: both are strictly one-way (2 directed edges total)
    assert g_car.n_edges == 2
    # With contraflow: Biegenstraße (oneway:bicycle=no) gets 2 directed edges, Uferstraße (oneway:bicycle=yes) stays 1
    assert g_bike.n_edges == 3
    assert int((g_bike.edge_way == 22756869).sum()) == 2
    assert int((g_bike.edge_way == 169723496).sum()) == 1

