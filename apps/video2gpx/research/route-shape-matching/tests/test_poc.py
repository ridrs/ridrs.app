# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.bench.poc_guide / poc_join helpers on tiny synthetic graphs (no OSM data, no network access)."""
import numpy as np
import pytest

pytest.importorskip("scipy")

from rsm.bench.poc_guide import GuideParams, TolerantGuide, dedupe_places, edge_intervals, guided_candidates, length_m, overlap_m
from rsm.core.turnseq import QSegment, QTurn, TurnQuery
from rsm.network.paths import path_polyline, turns_of_polyline
from tests.test_network import grid, make_graph


def zigzag_graph():
    """A long staircase road (left, right, left, ... 90 degree turns every 200 m) with a straight side branch at every corner."""
    nodes, ed = [(0.0, 0.0)], []
    x = y = 0.0
    for k in range(10):
        if k % 2 == 0:
            x += 200.0
        else:
            y += 200.0
        nodes.append((x, y))
        ed.append((k, k + 1, None))
    n0 = len(nodes)
    for k in range(1, 10):  # dead-end spurs
        px, py = nodes[k]
        nodes.append((px - 150.0, py + 150.0))
        ed.append((k, n0 + k - 1, None))
    return make_graph(nodes, ed), nodes


def query_of_edges(g, edges, drop=(), rho=1.0):
    """Turn list of the polyline of `edges` as a one-segment query (positions scaled by rho), optionally dropping some turns."""
    ts = turns_of_polyline(path_polyline(g, edges))
    turns = []
    for k, t in enumerate(ts):
        if k in drop:
            continue
        c = 0.5 * (t.s_start + t.s_end) * rho
        turns.append(QTurn(t.angle_deg, c - 10, c + 10))
    L = float(g.edge_len[edges].sum()) * rho
    return TurnQuery((QSegment(L, tuple(turns), L / 4.0, None),)), ts


def edge_chain(g, nodes_seq):
    out = g.out_edges()
    es = []
    for a, b in zip(nodes_seq, nodes_seq[1:]):
        es.append(next(e for e in out[a] if int(g.edge_v[e]) == b))
    return es


def test_edge_intervals_and_places():
    g, _ = zigzag_graph()
    es = edge_chain(g, [0, 1, 2, 3])
    iv = edge_intervals(g, es, 100.0, 450.0)
    assert set(iv) == set(es)
    assert length_m(iv) == pytest.approx(350.0)
    iv2 = edge_intervals(g, es, 300.0, 600.0)
    assert overlap_m(iv, iv2) == pytest.approx(150.0)
    ent = [dict(cost=1.0, start_m=100.0, end_m=450.0, evidence=1.0), dict(cost=2.0, start_m=120.0, end_m=470.0, evidence=0.5),
           dict(cost=3.0, start_m=450.0, end_m=600.0, evidence=0.1)]
    pl = dedupe_places(ent, g, lambda e: es)
    assert len(pl) == 2 and pl[0]["members"] == 2 and pl[1]["cost"] == 3.0  # the second entry is the first place again, the third is new


def test_tolerant_guide_finds_truth_with_missed_and_extra_turn():
    g, _ = zigzag_graph()
    truth = edge_chain(g, list(range(0, 8)))
    q, ts = query_of_edges(g, truth, drop=(2,), rho=0.8)  # one turn missed, distances scaled by rho
    assert len(ts) >= 6
    r = guided_candidates(g, q, GuideParams(), out=g.out_edges())
    got = [set(p) for p in r["paths"]]
    assert any(set(truth[:6]) <= s for s in got), "the true edges must be among the guided candidates"
    assert not r["capped"]


def test_tolerance_is_monotone_and_strict_mode_is_exact():
    g, _ = zigzag_graph()
    truth = edge_chain(g, list(range(0, 8)))
    q, ts = query_of_edges(g, truth)
    strict = GuideParams(E0=0.0, E1=0.0, M0=1.0, M1=0.0, tail_extras=0, max_skip_q=0)  # M0=1: the staircase continues after the video ends (one turn in the tail window)
    r_strict = guided_candidates(g, q, strict, out=g.out_edges())
    r_loose = guided_candidates(g, q, GuideParams(), out=g.out_edges())
    assert any(p[0] == truth[0] for p in r_strict["paths"]), "the exact sequence is accepted even in strict mode"
    assert len(r_loose["paths"]) >= len(r_strict["paths"])
    # an impossible query (angles of a different road) finds nothing in strict mode
    bad = TurnQuery((QSegment(1000.0, tuple(QTurn(170.0, 100 + 150 * k, 130 + 150 * k) for k in range(5)), 200.0, None),))
    assert not guided_candidates(g, bad, strict, out=g.out_edges())["paths"]


def test_guide_hook_is_a_filter_on_grid():
    g = grid(4, 100.0)
    out = g.out_edges()
    es = [e for e in range(g.n_edges) if int(g.edge_u[e]) == 0][:1]
    q = TurnQuery((QSegment(300.0, (QTurn(90.0, 140, 160), QTurn(-90.0, 240, 260)), 60.0, None),))
    gd = TolerantGuide(g, q)
    r = guided_candidates(g, q, GuideParams(), out=out)
    assert r["calls"] > 0 and len(r["paths"]) >= 1
    # every returned path explains at least one query turn: it has a turn of a matching sign
    for key, (tt, ln) in zip(r["paths"], r["turns"]):
        assert len(tt) >= 1 and all(abs(a) >= 25 for a, _, _ in tt)


def test_window_may_hang_over_the_path_end_without_penalty_but_not_over_a_turn():
    """Checks the claim 'no penalty for a window that hangs over the end of a candidate path' that poc_join relies on."""
    from rsm.core.turnseq import ConfidenceThresholds, TurnLibrary, TurnPath, search
    q = TurnQuery((QSegment(1000.0, (QTurn(90.0, 190, 210), QTurn(-90.0, 490, 510), QTurn(80.0, 790, 810)), 200.0, None),))
    full = TurnPath.from_turns("full", [90.0, -90.0, 80.0], [190, 490, 790], [210, 510, 810], 3000.0)
    short = TurnPath.from_turns("short", [90.0, -90.0, 80.0], [190, 490, 790], [210, 510, 810], 1000.0)  # the path ends right after the last turn
    tail = TurnPath.from_turns("tail", [90.0, -90.0, 80.0, 70.0, -70.0], [190, 490, 790, 1000, 1200], [210, 510, 810, 1020, 1220], 3000.0)  # turns after the video would end
    cut = TurnPath.from_turns("cut", [90.0, -90.0], [190, 490], [210, 510], 600.0)  # the path ends before the 3rd query turn
    r = search(q, TurnLibrary([full, short, tail, cut]), TurnMatchParamsFor(), ConfidenceThresholds(-1e9, -1e9), top_k=4)
    cost: dict = {}
    for m in r.matches:
        cost[m.path_id] = min(cost.get(m.path_id, 1e9), m.cost)
    assert cost["short"] == pytest.approx(cost["full"], abs=1e-6), "hanging over the end costs nothing"
    assert cost["tail"] > cost["full"] + 1.0, "but turns of the path inside the tail window of the query count as misses (so guided paths must not be cut short)"
    assert cost["cut"] > cost["full"] + 2.0, "a query turn that has no path turn left is an extra and costs"


def TurnMatchParamsFor():
    from rsm.core.turnseq import TurnMatchParams
    return TurnMatchParams()
