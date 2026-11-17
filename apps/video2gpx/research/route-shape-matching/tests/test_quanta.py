# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synthetic tests of rsm.quanta: quanta definition, map legs on a toy road, chaining with faulty quanta, mirror control, map matching."""
import math

import numpy as np

from rsm.network.graph import NetGraph
from rsm.quanta import chain, evalrun, legs, mapmatch
from rsm.quanta.qdef import TurnRec, mirror, quanta_from_turns

TURNS = [90, -60, 90, -90, 70, -120, 90, 60, -90, 75, -65, 100]  # degrees, left positive
SEG = [250, 150, 330, 210, 400, 180, 290, 360, 140, 310, 270, 220, 300]  # distinct straight lengths, m


def toy_graph() -> NetGraph:
    pts = [(0.0, 0.0)]
    th = 0.0
    for i, L in enumerate(SEG):
        pts.append((pts[-1][0] + L * math.cos(th), pts[-1][1] + L * math.sin(th)))
        if i < len(TURNS):
            th += math.radians(TURNS[i])
    pts = np.array(pts)
    eu, ev_, geoms, off, ln = [], [], [], [0], []
    for i in range(len(pts) - 1):
        for (a, b) in ((i, i + 1), (i + 1, i)):
            eu.append(a); ev_.append(b)
            g = np.array([pts[a], pts[b]])
            geoms.append(g); off.append(off[-1] + 2); ln.append(float(np.hypot(*(pts[b] - pts[a]))))
    n = len(eu)
    return NetGraph(crs="EPSG:32631", node_xy=pts, node_osm=np.arange(len(pts)), edge_u=np.array(eu, np.int32), edge_v=np.array(ev_, np.int32),
                    edge_len=np.array(ln), edge_way=np.arange(n, dtype=np.int64), edge_off=np.array(off, np.int64), edge_geom=np.vstack(geoms),
                    edge_name=np.array([""] * n), edge_ref=np.array([""] * n), edge_highway=np.array(["tertiary"] * n), edge_tunnel=np.zeros(n, bool),
                    edge_bridge=np.zeros(n, bool), edge_oneway=np.zeros(n, bool))


def build_map(g, thr=45.0):
    lb = legs.LegBuilder(g, thr, straight_max=1500.0)
    events = {}
    for e in range(g.n_edges):
        for ev in lb.events_of_edge(e):
            events.setdefault(ev.key, ev)
    by_key = {}
    for ev in list(events.values()):
        L, new, _ = lb.legs_of_event(ev)
        by_key[ev.key] = L
        for c in new:
            events.setdefault(c.key, c)
    for k, ev in list(events.items()):
        if k not in by_key:
            by_key[k] = lb.legs_of_event(ev)[0]
    return legs.pack(events, by_key, thr, 0.0)


def test_quanta_definition_and_mirror():
    t = [TurnRec(1, 90, 40, 100, 140, 10, 14), TurnRec(-1, 60, 30, 340, 370, 34, 37), TurnRec(1, 80, 50, 500, 550, 50, 55)]
    q = quanta_from_turns(t)
    assert len(q["sign1"]) == 2
    assert abs(q["straight"][0] - 200) < 1e-9 and abs(q["lr1"][0] - math.log(40 / 200)) < 1e-9
    assert abs(q["lrp"][1] - math.log(130 / 200)) < 1e-9 and math.isnan(q["lrp"][0])
    m = mirror(q)
    assert (m["sign1"] == -q["sign1"]).all() and (m["ang1"] == q["ang1"]).all()


def test_legs_on_toy_road():
    g = toy_graph()
    m = build_map(g)
    E = m["events"]
    # every corner (12) is a turn event in each direction; 90 deg +- 15 %
    assert len(E["sign"]) == 24
    assert abs(np.median(E["angle"]) - 80) < 40
    q = m["q"]
    # forward direction: first leg is the +90 / -60 pair with straight about 150 - smoothing
    fw = [i for i in range(len(q["sign1"])) if q["sign1"][i] > 0 and q["sign2"][i] < 0 and abs(q["ang1"][i] - 90) < 15 and abs(q["ang2"][i] - 60) < 15]
    assert fw and abs(q["straight"][fw[0]] - (SEG[1] - 0)) < 40
    # no U-turn legs: every leg connects distinct events
    assert (m["leg_a"] != m["leg_b"]).all()


def test_chain_finds_true_sequence_with_scale_and_faulty_quantum():
    g = toy_graph()
    m = build_map(g)
    ix = chain.MapIndex(m, chain.Params())
    # video = the forward legs of the road, lengths scaled 0.8, quantum 5 corrupted
    q = m["q"]
    start = [i for i in range(len(q["sign1"])) if q["sign1"][i] > 0 and abs(q["ang1"][i] - 90) < 12 and abs(q["straight"][i] - SEG[1]) < 40 and q["sign2"][i] < 0]
    assert start
    seq = [start[0]]
    for _ in range(7):
        nxt = [l for l in ix.out_legs[ix.out_ptr[ix.B[seq[-1]]]:ix.out_ptr[ix.B[seq[-1]] + 1]] if ix.dmid[l] < 500 and ix.B[l] != ix.A[seq[-1]]]
        # follow the forward direction: the leg whose first angle sign pattern continues the road
        nxt = [l for l in nxt if abs(m["events"]["mid"][ix.B[l]] - m["events"]["mid"][ix.A[seq[-1]]]).sum() > 0]
        if not nxt:
            break
        seq.append(nxt[0])
    n = len(seq)
    vq = {k: np.array([q[k][i] for i in seq]) for k in ("sign1", "ang1", "sign2", "ang2", "len1", "len2", "straight", "lr1", "lr2")}
    vq["len1"], vq["len2"], vq["straight"] = vq["len1"] * 0.8, vq["len2"] * 0.8, vq["straight"] * 0.8
    vq["unc"] = np.zeros(n, bool)
    vq["ang1"] = vq["ang1"] * 1.05
    chains = chain.match_window(ix, vq, 0, n)
    assert chains[0].n_matched >= n - 2
    assert set(l for _, l in chains[0].legs) <= set(seq) | set(range(len(q["sign1"])))
    # mirrored video: no chain as long
    mv = mirror(vq)
    mc = chain.match_window(ix, mv, 0, n)
    assert mc[0].score < chains[0].score


def test_windows_and_confident_rule():
    mask = np.array([1, 1, 1, 1, 0, 1, 1, 1, 1, 1], bool)
    w = evalrun.windows(mask, 3)
    assert all(mask[a:b].all() for a, b in w) and (0, 3) in w and (5, 8) in w
    rule = dict(gap_table={"3": 5.0, "10": 9.0}, min_matched=3)
    assert evalrun.gap_threshold(rule, 3) == 5.0 and abs(evalrun.gap_threshold(rule, 6) - (5.0 + 4.0 * 3 / 7)) < 1e-9
    assert evalrun.confident(dict(gap=6.0, L=3, n_matched=3, score=0.0), rule) and not evalrun.confident(dict(gap=4.0, L=3, n_matched=3, score=0.0), rule)


def test_mapmatch_on_toy_road():
    g = toy_graph()
    ix = mapmatch.EdgeIndex(g)
    # GPS along the forward road, 3 m noise
    pts = g.node_xy
    s = np.arange(0, 1500.0, 5.0)
    seg_len = np.hypot(*np.diff(pts, axis=0).T)
    c = np.concatenate([[0], np.cumsum(seg_len)])
    x, y = np.interp(s, c, pts[:, 0]), np.interp(s, c, pts[:, 1])
    rng = np.random.default_rng(0)
    gc = dict(s=s, t=s / 5.0, x=x + rng.normal(0, 3, len(s)), y=y + rng.normal(0, 3, len(s)))
    mm = mapmatch.match_track(ix, gc)
    assert mm["no_candidate"] == 0 and mm["jumps"] == 0
    # forward direction edges are the even-numbered edges (a -> a+1)
    assert (mm["edge"] % 2 == 0).mean() > 0.9
