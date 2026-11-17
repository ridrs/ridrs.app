# SPDX-License-Identifier: AGPL-3.0-or-later
"""Whole-video tracker: synthetic road with a junction, forward and backward tracking, mirrored control, clustering."""
from types import SimpleNamespace

import numpy as np

from rsm.network.graph import NetGraph
from rsm.track import consensus, graphs, route, tracker, vtrack


def make_graph(lines):
    """directed graph with both directions of every polyline; nodes at the polyline ends (merged when equal)"""
    nodes = []

    def nid(p):
        for i, q in enumerate(nodes):
            if np.hypot(*(np.asarray(p) - q)) < 1e-6:
                return i
        nodes.append(np.asarray(p, float))
        return len(nodes) - 1

    eu, ev, geoms = [], [], []
    for ln in lines:
        ln = np.asarray(ln, float)
        a, b = nid(ln[0]), nid(ln[-1])
        eu += [a, b]; ev += [b, a]; geoms += [ln, ln[::-1]]
    off = np.concatenate([[0], np.cumsum([len(g) for g in geoms])])
    L = np.array([np.hypot(*np.diff(g, axis=0).T).sum() for g in geoms])
    E = len(geoms)
    z = np.array([""] * E)
    return NetGraph(crs="EPSG:32631", node_xy=np.array(nodes), node_osm=np.arange(len(nodes)), edge_u=np.array(eu), edge_v=np.array(ev), edge_len=L, edge_way=np.arange(E),
                    edge_off=off, edge_geom=np.vstack(geoms), edge_name=z, edge_ref=z, edge_highway=z, edge_tunnel=np.zeros(E, bool), edge_bridge=np.zeros(E, bool), edge_oneway=np.zeros(E, bool))


def road():
    """east 500 m, junction, north branch 500 m, east branch 500 m"""
    return make_graph([[(0, 0), (250, 0), (500, 0)], [(500, 0), (500, 250), (500, 500)], [(500, 0), (750, 0), (1000, 0)]])


def vms_track(turn_deg, n_before=500.0, n_after=400.0, v=5.0):
    s = np.arange(0.0, n_before + n_after, 4.0)
    th = np.zeros_like(s)
    k = (s > n_before) & (s < n_before + 30)
    th[k] = np.radians(turn_deg) * (s[k] - n_before) / 30.0
    th[s >= n_before + 30] = np.radians(turn_deg)
    return [dict(t=s / v, s=s, th=th)]


def setup(turn_deg, mirror=False):
    g = road()
    fw, rv = graphs.Net.build(g)
    sn = graphs.Snap(fw)
    tracks = vms_track(turn_deg)
    sf = vtrack.make_seq(tracks, mirror=mirror); sb = vtrack.make_seq(tracks, reverse=True, mirror=mirror)
    ctx = tracker.make_ctx(fw, rv, sn, 1.0, 1.0)
    return g, fw, ctx, sf, sb


def edge_of(fw, xy):
    d = [np.min(np.hypot(*(fw.g.geom(e) - xy).T)) for e in range(fw.g.n_edges)]
    return int(np.argmin(d))


def test_profiles_heading_and_reverse():
    g = road()
    fw, rv = graphs.Net.build(g)
    e = 0  # east edge
    assert abs(fw.phi(e, 100.0)) < 1e-6
    n = 2  # north edge
    assert abs(fw.phi(n, 100.0) - np.pi / 2) < 1e-6
    # reverse view of the east edge heads west
    assert abs(abs(rv.phi(e, 100.0)) - np.pi) < 1e-6
    assert abs(rv.L[e] - fw.L[e]) < 1e-9


def test_junction_decision_follows_the_vms_turn():
    for turn, expect_north in ((90.0, True), (0.0, False)):
        g, fw, ctx, sf, sb = setup(turn)
        r = route.track_anchor(ctx, sf, sb, 10.0, 0, 50.0)  # anchor 50 m along the first edge, at t = 10 s (50 m)
        last = r.xy[-1]
        assert (last[1] > 300) == expect_north, (turn, last)
        assert r.cost_per_km < 40
        assert r.n_jumps == 0


def test_mirrored_vms_costs_more_than_the_true_one():
    _, _, ctx, sf, sb = setup(90.0)
    good = route.track_anchor(ctx, sf, sb, 10.0, 0, 50.0)
    _, _, ctx2, sf2, sb2 = setup(90.0, mirror=True)
    bad = route.track_anchor(ctx2, sf2, sb2, 10.0, 0, 50.0)
    assert bad.cost_per_km > 2 * good.cost_per_km


def test_backward_run_reaches_the_video_start():
    _, fw, ctx, sf, sb = setup(90.0)
    # anchor in the north branch, 250 m up (video time of the point 750 m from the start); tracking backward must return to the first edge
    t_a = (500.0 + 30.0 + 200.0) / 5.0
    e_north = edge_of(fw, np.array([500.0, 250.0]))
    assert fw.phi(e_north, 50.0) > 1.0  # northward
    r = route.track_anchor(ctx, sf, sb, t_a, e_north, 200.0)
    assert r.xy[0][0] < 60 and abs(r.xy[0][1]) < 30, r.xy[0]
    assert r.dirn[0] == -1 and r.dirn[-1] == 1


def test_sequence_reversal():
    tr = vms_track(90.0)
    f = vtrack.make_seq(tr); b = vtrack.make_seq(tr, reverse=True)
    assert f.segs[0].ds[0] == 0 and b.segs[0].ds[0] == 0
    assert abs(f.segs[0].s[-1] - b.segs[0].s[-1]) < 1e-9
    assert b.segs[0].t[0] > b.segs[0].t[-1]
    assert abs(b.segs[0].th[0]) < 1e-12


def _fake_route(xy, cost):
    n = len(xy)
    return SimpleNamespace(t=np.arange(n) * 2.0, xy=np.asarray(xy, float), inc=np.full(n, cost), cost_per_km=cost * 125, dirn=np.zeros(n, int))


def test_clusters_and_auc():
    base = np.column_stack([np.arange(300) * 8.0, np.zeros(300)])
    routes = [_fake_route(base, 0.1), _fake_route(base + [5, 5], 0.12), _fake_route(base + [0, 900], 0.1), _fake_route(base + [0, -1500], 0.3)]
    cl = consensus.cluster(routes, consensus.CParams())
    assert len(cl["clusters"][0]) == 2 and set(cl["clusters"][0]) == {0, 1}
    assert consensus.auc([1, 2], [3, 4]) == 1.0 and consensus.auc([3], [1]) == 0.0
