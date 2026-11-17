# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.track2 (v3): standstills and U-turns in the video design, speed-dependent distance scale, straight stretching, combination of routes."""
import dataclasses
from types import SimpleNamespace

import numpy as np

from rsm.network.graph import NetGraph
from rsm.track2 import calib, combine, consensus, graphs, route, tracker, vtrack


def make_graph(lines):
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
    return NetGraph(crs="EPSG:32631", node_xy=np.array(nodes), node_osm=np.arange(len(nodes)), edge_u=np.array(eu), edge_v=np.array(ev), edge_len=L, edge_way=np.repeat(np.arange(E // 2), 2),
                    edge_off=off, edge_geom=np.vstack(geoms), edge_name=z, edge_ref=z, edge_highway=z, edge_tunnel=np.zeros(E, bool), edge_bridge=np.zeros(E, bool), edge_oneway=np.zeros(E, bool))


def road():
    """east 1100 m (x = -100 to the junction at 1000), then a north branch 600 m or an east branch 600 m"""
    return make_graph([[(-100, 0), (500, 0), (1000, 0)], [(1000, 0), (1000, 300), (1000, 600)], [(1000, 0), (1300, 0), (1600, 0)]])


def track(turn_deg=90.0, before=1000.0, after=500.0, v=5.0, scale=1.0, stop_at=None, stop_s=0.0):
    s = np.arange(0.0, before + after, 4.0)
    th = np.zeros_like(s)
    k = (s > before) & (s < before + 30)
    th[k] = np.radians(turn_deg) * (s[k] - before) / 30.0
    th[s >= before + 30] = np.radians(turn_deg)
    t = s / (v * scale)  # the vms distance is `scale` too short / long: map distance = s / scale ... (see tests)
    if stop_at is not None:
        t = t + np.where(s >= stop_at, stop_s, 0.0)
    return [dict(t=t, s=s, th=th)]


def setup(tracks, prm=None, kappa=1.0):
    g = road()
    fw, rv = graphs.Net.build(g)
    sn = graphs.Snap(fw)
    sf = vtrack.make_seq(tracks); sb = vtrack.make_seq(tracks, reverse=True)
    ctx = tracker.make_ctx(fw, rv, sn, kappa, 1.0, prm or tracker.Params())
    return g, fw, ctx, sf, sb


def edge_of(fw, xy):
    d = [np.min(np.hypot(*(fw.g.geom(e) - xy).T)) for e in range(fw.g.n_edges)]
    return int(np.argmin(d))


def test_annotate_standstill_uturn_and_straights():
    s = np.arange(0.0, 800.0, 4.0)
    th = np.zeros_like(s)
    t = s / 5.0
    t = t + np.where(s >= 400, 12.0, 0.0)  # a 12 s standstill at s = 400
    k = (s > 600) & (s < 624)  # 180 deg within 24 m: a U-turn
    th[k] = np.pi * (s[k] - 600) / 24.0
    th[s >= 624] = np.pi
    sq = vtrack.make_seq([dict(t=t, s=s, th=th)])
    sg = sq.segs[0]
    assert (sg.dwell > 0).sum() == 1 and sg.dwell.max() > 10
    assert (sg.ut == 1).sum() == 1 and (sg.ut == 2).sum() == 1
    assert sg.strt[-1] >= 2  # the standstill and the U-turn are boundaries of straights
    # the reversed sequence has the same events
    sb = vtrack.make_seq([dict(t=t, s=s, th=th)], reverse=True).segs[0]
    assert (sb.dwell > 0).sum() == 1 and (sb.ut == 2).sum() == 1


def test_speed_dependent_scale_moves_faster_at_speed():
    tr = track(0.0, 1000.0, 400.0, v=6.0)
    g, fw, ctx, sf, sb = setup(tr)
    a = route.track_anchor(ctx, sf, sb, 10.0, 0, 50.0)
    ctx2 = dataclasses.replace(ctx, prm=dataclasses.replace(ctx.prm, speed_b=0.05))
    b = route.track_anchor(ctx2, sf, sb, 10.0, 0, 50.0)
    assert b.km > a.km * 1.05  # (6 - 3) * 0.05 = +15 % per step on the stretch above the knee


def test_straight_is_stretched_evenly_and_costs_once():
    g, fw, ctx, sf, sb = setup(track(0.0, 1000.0, 0.0))
    n = 100
    adv = np.full(n, 8.0); adv[0] = 0.0
    du = np.zeros(n); du[-1] = -48.0  # the tracker snapped 48 m back at the end of a 792 m straight (6 %)
    U = np.cumsum(adv + du) + 50.0
    E = np.zeros(n, np.int64)
    comp = np.zeros((n, tracker.NCOMP), np.float32); comp[-1, route.ICOMP["stretch"]] = 3.0
    st = np.zeros(n, np.int64); flag = np.zeros(n, np.uint8)
    E2, U2, comp2, info = route._spread(fw, E, U, adv, du, st, flag, comp, True)
    step = np.diff(U2)
    assert abs(info[0][2] - (1 - 48.0 / 792.0)) < 1e-6  # factor of the straight
    assert step.std() < 1e-6 and abs(step.mean() - 8.0 * info[0][2]) < 1e-6  # constant scale from the start to the end, no snap at the end
    assert abs(U2[-1] - U[-1]) < 1e-6 and abs(comp2[:, route.ICOMP["stretch"]].sum() - 3.0) < 1e-6  # the end point and the total cost are kept, the cost is spread evenly
    assert comp2[:, route.ICOMP["stretch"]].std() < 1e-6
    # a snap larger than str_max is not a stretch: left where the tracker put it
    du2 = np.zeros(n); du2[-1] = -300.0
    E3, U3, _, info3 = route._spread(fw, E, np.cumsum(adv + du2) + 400.0, adv, du2, st, flag, comp, True)
    assert abs(U3[-2] - (np.cumsum(adv + du2)[-2] + 400.0)) < 1e-9


def test_uturn_at_a_standstill_spawns_reversed_hypotheses():
    # out 800 m, 15 s standstill, then on (the vms cannot see the turn-around: the heading stays)
    s = np.arange(0.0, 1400.0, 4.0)
    t = s / 5.0 + np.where(s >= 800, 15.0, 0.0)
    tr = [dict(t=t, s=s, th=np.zeros_like(s))]
    g, fw, ctx, sf, sb = setup(tr)
    i0, k0, _ = sf.locate(30.0)
    run = tracker.run_direction(ctx, False, sf, i0, k0, 0, 250.0)
    assert any((h["flag"] & tracker.F_UTURN).any() for h in run.hist)
    run0 = tracker.run_direction(tracker.make_ctx(fw, ctx.rev, ctx.snap, 1.0, 1.0, tracker.v2_params(uturn_pen=None)), False, vtrack.make_seq(tr, flank=False), k0=k0, i0=i0, e0=0, u0=250.0)
    assert not any((h["flag"] & tracker.F_UTURN).any() for h in run0.hist)
    # a short stop (4 s) is a standstill (heading unreliable, straight boundary) but no U-turn candidate
    t2 = s / 5.0 + np.where(s >= 800, 4.0, 0.0)
    sg = vtrack.make_seq([dict(t=t2, s=s, th=np.zeros_like(s))]).segs[0]
    assert (sg.dwell > 0).sum() == 1 and (sg.ut == 1).sum() == 0


def _fake(t, xy, inc):
    n = len(t)
    return SimpleNamespace(t=np.asarray(t, float), xy=np.asarray(xy, float), inc=np.asarray(inc, float), E=np.zeros(n, np.int64), U=np.asarray(xy, float)[:, 0], cost_per_km=50.0,
                           flag=np.zeros(n, np.uint8), dirn=np.zeros(n, int))


def test_combine_joins_complementary_routes_and_rejects_a_wrong_one():
    tr = track(0.0, 1500.0, 0.0, v=5.0)
    g, fw, ctx, sf, sb = setup(tr)
    S = dict(fw=fw, sf=sf, ctx=ctx)
    t = np.arange(2.0, 300.0, 2.0)
    x = 5.0 * t
    good_a = np.where(t < 140, 0.1, 1.5)
    good_b = np.where(t > 160, 0.1, 1.5)
    ra = _fake(t, np.column_stack([x, np.zeros_like(x)]), good_a)  # right in the first half
    rb = _fake(t, np.column_stack([x, np.zeros_like(x)]), good_b)  # right in the second half (positions equal where both are right)
    rb.xy = rb.xy.copy(); rb.xy[t < 150, 1] = 400.0  # and elsewhere on another road
    ra.xy = ra.xy.copy(); ra.xy[t > 150, 1] = -400.0
    wrong = _fake(t, np.column_stack([x, np.full_like(x, 900.0)]), np.where((t > 60) & (t < 200), 0.2, 1.5))  # fits for a while, nowhere near
    res = combine.combine([ra, rb, wrong], S, consensus.CParams())
    src = res["src"]
    first = src[(res["t"] > 20) & (res["t"] < 120)]; second = src[(res["t"] > 180) & (res["t"] < 280)]
    assert (first == 0).mean() > 0.9 and (second == 1).mean() > 0.9, (first, second)
    assert 2 not in set(src.tolist()) or (src == 2).mean() < 0.05


def test_speed_fit_recovers_the_slope():
    rng = np.random.default_rng(1)
    X = rng.uniform(0, 4, 600)
    R = 0.03 * X + rng.normal(0, 0.01, 600)
    a, b, n, _ = calib.fit(X, R, np.ones(600))
    assert abs(b - 0.03) < 0.006 and abs(a) < 0.02
