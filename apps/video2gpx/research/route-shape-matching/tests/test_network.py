# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.network on tiny synthetic graphs (no OSM, no network access)."""
import math
import subprocess
import sys

import numpy as np
import pytest

pytest.importorskip("scipy")  # these tests need only numpy/scipy

from rsm.network.graph import NetGraph
from rsm.network.guided import TurnGuide
from rsm.network.paths import PathLimitExceeded, enumerate_paths, heading_curve, path_polyline, turns_of_polyline


def make_graph(nodes, edges):
    """edges: (u, v, polyline or None); every edge is added in both directions."""
    nodes = np.array(nodes, float)
    eu, ev, off, geom, ln, way = [], [], [0], [], [], []
    for w, (u, v, pl) in enumerate(edges):
        pl = np.array([nodes[u], nodes[v]]) if pl is None else np.array(pl, float)
        for a, b, p in ((u, v, pl), (v, u, pl[::-1])):
            eu.append(a); ev.append(b); way.append(1000 + w)
            geom.append(p); off.append(off[-1] + len(p)); ln.append(float(np.hypot(*np.diff(p, axis=0).T).sum()))
    E = len(eu)
    z = np.zeros(E, bool)
    s = np.array([""] * E)
    return NetGraph("EPSG:32632", nodes, np.arange(len(nodes)), np.array(eu, np.int32), np.array(ev, np.int32), np.array(ln), np.array(way, np.int64),
                    np.array(off, np.int64), np.vstack(geom), s, s, s, z, z, z)


def grid(n=4, d=100.0):
    nodes = [(x * d, y * d) for y in range(n) for x in range(n)]
    ed = []
    for y in range(n):
        for x in range(n):
            i = y * n + x
            if x + 1 < n:
                ed.append((i, i + 1, None))
            if y + 1 < n:
                ed.append((i, i + n, None))
    return make_graph(nodes, ed)


def brute(g, L):
    out = g.out_edges()
    res = []

    def rec(path, nodes, ln):
        for e in out[nodes[-1]]:
            v = int(g.edge_v[e])
            if v in nodes:
                continue
            l2 = ln + g.edge_len[e]
            if l2 >= L:
                res.append(tuple(path + [e]))
            else:
                rec(path + [e], nodes + [v], l2)

    for s in range(g.n_nodes):
        rec([], [s], 0.0)
    return set(res)


def test_enumeration_bounds_and_no_repeats():
    g = grid(4)
    L = 250.0
    ps = enumerate_paths(g, L)
    got = {tuple(ps.path_edges(i).tolist()) for i in range(len(ps))}
    assert len(got) == len(ps)  # no duplicate paths
    assert got == brute(g, L)
    for p in got:
        nodes = [int(g.edge_u[p[0]])] + [int(g.edge_v[e]) for e in p]
        assert len(set(nodes)) == len(nodes)  # no repeated node, hence no repeated edge and no U-turn
        assert g.edge_len[list(p)].sum() >= L
        assert g.edge_len[list(p[:-1])].sum() < L  # the first edge that reaches L ends the path


def test_no_immediate_uturn_on_a_line():
    g = make_graph([(0, 0), (100, 0), (200, 0)], [(0, 1, None), (1, 2, None)])
    ps = enumerate_paths(g, 150.0)
    paths = sorted(tuple(int(g.edge_u[e]) for e in ps.path_edges(i)) + (int(g.edge_v[ps.path_edges(i)[-1]]),) for i in range(len(ps)))
    assert paths == [(0, 1, 2), (2, 1, 0)]  # 1->0 after 0->1 is not offered


def test_caps_raise_instead_of_truncating():
    with pytest.raises(PathLimitExceeded):
        enumerate_paths(grid(4), 450.0, max_paths=5)
    with pytest.raises(PathLimitExceeded):
        enumerate_paths(grid(4), 450.0, max_expansions=10)


def test_count_only_matches_stored():
    g = grid(4)
    assert enumerate_paths(g, 300.0, store=False).count == len(enumerate_paths(g, 300.0))


def arc(r, a0, a1, n=91, cx=0.0, cy=0.0):
    t = np.linspace(a0, a1, n)
    return np.column_stack([cx + r * np.cos(t), cy + r * np.sin(t)])


def test_turn_sequence_of_a_known_polyline():
    # north 150 m, then a quarter circle r=60 m to the LEFT (towards -x), then west 150 m: one left turn of +90 deg
    r = 60.0
    pl = np.vstack([[[0, 0], [0, 150]], arc(r, 0.0, math.pi / 2, cx=-r, cy=150)[1:], [[-r - 150, 150 + r]]])
    tt = turns_of_polyline(pl)
    assert len(tt) == 1 and tt[0].sign == 1 and tt[0].angle_deg == pytest.approx(90, abs=4)
    assert 130 < tt[0].s_start + (tt[0].s_end - tt[0].s_start) / 2 < 150 + r * math.pi / 4 + 20
    mir = pl * np.array([-1, 1])  # mirror: right turn
    tm = turns_of_polyline(mir)
    assert len(tm) == 1 and tm[0].sign == -1 and tm[0].angle_deg == pytest.approx(-90, abs=4)


def test_heading_convention_left_positive():
    s, th, tot = heading_curve(np.array([[0, 0], [0, 10], [-10, 10]], float))
    assert th[0] == pytest.approx(0) and th[-1] == pytest.approx(math.pi / 2) and tot == pytest.approx(20)


def test_junction_turn_and_straight_through():
    # corner at node 1 (left 90 deg), node 2 straight on to node 3
    g = make_graph([(0, 0), (0, 200), (-200, 200), (-400, 200)], [(0, 1, None), (1, 2, None), (2, 3, None)])
    ps = enumerate_paths(g, 600.0)
    assert len(ps) == 2
    for i in range(len(ps)):
        e = ps.path_edges(i)
        tt = turns_of_polyline(path_polyline(g, e, 600.0))
        if int(g.edge_u[e[0]]) == 0:
            assert [t.sign for t in tt] == [1] and tt[0].angle_deg == pytest.approx(90, abs=3)
            assert tt[0].s_start < 200 < tt[0].s_end  # the turn sits on the junction
        else:
            assert [t.sign for t in tt] == [-1]


def test_hairpin_is_near_180():
    # up 150 m, tight bend with ONE vertex (sparse OSM geometry), back down 150 m 5 m to the side
    pl = np.array([[0, 0], [0, 150], [5, 150], [5, 0]], float)
    tt = turns_of_polyline(pl)
    assert len(tt) == 1 and abs(tt[0].angle_deg) == pytest.approx(180, abs=5)


def test_polyline_cut_at_L():
    g = grid(3)
    ps = enumerate_paths(g, 150.0)
    p = path_polyline(g, ps.path_edges(0), 150.0)
    assert np.hypot(*np.diff(p, axis=0).T).sum() == pytest.approx(150.0)


def test_turn_guide_prunes_and_keeps_the_true_path():
    # a comb-like zig-zag network: the query is the turn list of one particular path; guided search must find it with fewer expansions
    g = grid(5, 120.0)
    L = 600.0
    full = enumerate_paths(g, L)
    # choose a path with >= 2 turns
    best = None
    for i in range(len(full)):
        tt = turns_of_polyline(path_polyline(g, full.path_edges(i), L))
        if len(tt) >= 3:
            best, q = i, [(t.angle_deg, (t.s_start + t.s_end) / 2) for t in tt]
            break
    assert best is not None
    guide = TurnGuide(g, q, max_lead=0)
    gp = enumerate_paths(g, L, allow=guide)
    got = {tuple(gp.path_edges(i).tolist()) for i in range(len(gp))}
    assert tuple(full.path_edges(best).tolist()) in got
    assert len(gp) < len(full) and gp.expansions < full.expansions


def test_core_does_not_import_network():
    code = "import sys, rsm.core.matcher, rsm.core.trajectory; assert not [m for m in sys.modules if m.startswith('rsm.network') or m in ('osmnx', 'pyproj', 'osmium')]"
    subprocess.run([sys.executable, "-c", code], check=True)
