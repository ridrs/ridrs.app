# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.hmm: grid, exact inference (Viterbi, forward-backward), memory budget, decoys."""
import numpy as np
import pytest

from rsm.hmm import dp, grid, route, seq
from tests.test_track2 import make_graph


def city():
    """a 4 x 4 block of streets, 240 m spacing, plus a dead-end spur"""
    lines = []
    for i in range(4):
        for j in range(3):
            lines.append([(i * 240.0, j * 240.0), (i * 240.0, (j + 1) * 240.0)])
            lines.append([(j * 240.0, i * 240.0), ((j + 1) * 240.0, i * 240.0)])
    lines.append([(720.0, 720.0), (720.0, 960.0)])
    return make_graph(lines)


def heading_series(g, edge_seq, d0=30.0):
    """straight polyline of the edges in sequence -> track {t, s, th}: smoothed heading of the polyline against metres"""
    pts = [g.geom(edge_seq[0])]
    for e in edge_seq[1:]:
        pts.append(g.geom(e)[1:])
    p = np.vstack(pts)
    d = np.hypot(*np.diff(p, axis=0).T)
    c = np.concatenate([[0], np.cumsum(d)])
    s = np.arange(0.0, c[-1], 4.0)
    x = np.interp(s, c, p[:, 0]); y = np.interp(s, c, p[:, 1])
    from scipy.ndimage import gaussian_filter1d
    x = gaussian_filter1d(x, 3); y = gaussian_filter1d(y, 3)
    th = np.unwrap(np.arctan2(np.gradient(y), np.gradient(x)))
    return [dict(t=s / 8.0, s=s, th=th - th[0])]


def random_walk(g, rng, n=14):
    out = int(rng.integers(g.n_edges))
    path = [out]
    for _ in range(n):
        cand = [e for e in range(g.n_edges) if g.edge_u[e] == g.edge_v[path[-1]] and g.edge_v[e] != g.edge_u[path[-1]]]
        h0 = np.arctan2(*(g.geom(path[-1])[-1] - g.geom(path[-1])[0])[::-1])
        turning = [e for e in cand if abs(np.sin(np.arctan2(*(g.geom(e)[-1] - g.geom(e)[0])[::-1]) - h0)) > 0.5]
        cand = turning or cand
        if not cand:
            break
        path.append(int(rng.choice(cand)))
    return path


def test_grid_cells_and_entries():
    g = city()
    G = grid.build(g, None, h=30.0)
    assert G.N == int(np.maximum(1, np.rint(g.edge_len / 30.0)).sum())
    k1 = G.groups[1]
    assert k1.k == 1 and np.all(k1.D > 0)
    # inside an edge the cell advance is one cell: heading change of a straight street is ~0
    assert np.abs(k1.dphi[np.abs(k1.dphi) < 0.01]).max() < 0.01
    # a node with 3 continuations + the U-turn twin: out-degree of the last cell of an edge entering a 4-way node
    assert grid.memory_estimate(G.N, 1000)["total"] == G.N * 1000 * 3


def test_memory_budget_aborts_before_allocation():
    with pytest.raises(MemoryError):
        grid.check_budget(2_000_000, 3000)  # 2M states x 3000 steps x 3 bytes = 18 GB
    assert grid.check_budget(120_000, 3800)["total_gb"] < 4.0


def test_viterbi_recovers_walk_and_posterior_is_normalised():
    g = city()
    rng = np.random.default_rng(3)
    ok = 0
    for trial in range(6):
        path = random_walk(g, rng, 16)
        tr = heading_series(g, path)
        if tr[0]["s"][-1] < 600:
            continue
        st = seq.make_steps(tr, d0=30.0)
        G = grid.build(g, None, h=30.0)
        pre = dp.prepare(G, dp.Par())
        r = dp.viterbi(pre, st, backptr=True)
        rt = route.decode(G, st, r["cell_path"])
        # the decoded cells sit on the true edges for most steps (a symmetric street grid has ambiguities; allow some)
        true_edges = set(path)
        on = np.mean([int(G.cell_edge[c]) in true_edges for c in r["cell_path"]])
        ok += on > 0.6
        fb = dp.forward_backward(pre, st, r["cell_path"])
        assert np.all((fb["p_vit"] >= 0) & (fb["p_vit"] <= 1 + 1e-6))
        assert np.all(fb["p_max"] >= fb["p_vit"] - 1e-6)
        assert np.isfinite(fb["logev"]) and fb["logev"] >= r["score"] - 5.0 - np.log(G.N)
        assert len(rt.t) > 10
    assert ok >= 2  # a regular street grid is ambiguous: equal blocks, equal turns


def test_increments_ignore_heading_offset():
    """the emission compares heading INCREMENTS: a constant heading offset in the video changes nothing"""
    g = city()
    path = random_walk(g, np.random.default_rng(5), 14)
    tr = heading_series(g, path)
    G = grid.build(g, None, h=30.0)
    pre = dp.prepare(G, dp.Par())
    a = dp.viterbi(pre, seq.make_steps(tr, 30.0))["score"]
    tr2 = [dict(t=tr[0]["t"], s=tr[0]["s"], th=tr[0]["th"] + 0.7)]
    b = dp.viterbi(pre, seq.make_steps(tr2, 30.0))["score"]
    assert abs(a - b) < 1e-3


def test_mirror_scores_below_real():
    g = city()
    path = random_walk(g, np.random.default_rng(11), 16)
    tr = heading_series(g, path)
    st = seq.make_steps(tr, 30.0)
    G = grid.build(g, None, h=30.0)
    pre = dp.prepare(G, dp.Par())
    assert dp.viterbi(pre, st)["score"] >= dp.viterbi(pre, seq.mirror(st))["score"] - 1e-3


def test_block_shuffle_keeps_content():
    tr = [dict(t=np.arange(0, 1200.0, 0.25), s=np.arange(0, 1200.0, 0.25) * 8.0 / 2, th=np.cumsum(np.random.default_rng(0).normal(0, 0.01, 4800)))]
    tr[0]["s"] = np.arange(0, 4800) * 4.0
    st = seq.make_steps(tr, 30.0)
    sh = seq.block_shuffle(st, np.random.default_rng(1))
    assert np.allclose(np.sort(st.dth[~np.isnan(st.dth)]), np.sort(sh.dth[~np.isnan(sh.dth)]))
    assert not np.allclose(st.dth[1:], sh.dth[1:], equal_nan=True)
    assert np.array_equal(st.t, sh.t)


def test_gap_steps_have_no_emission():
    s = np.arange(0, 600.0, 4.0)
    a = dict(t=s / 8, s=s, th=np.zeros_like(s))
    b = dict(t=s / 8 + 200.0, s=s, th=np.zeros_like(s))
    st = seq.make_steps([a, b], 30.0)
    assert st.gap.sum() >= 3 and np.all(np.isnan(st.dth[st.gap])) and st.rel[st.gap].max() > 0.3


def test_jacobian_keeps_scale_scan_from_collapsing():
    """data that match the map at a = 1: the best-path score must not increase towards a -> 0 (without the Jacobian log a per emitting step it does)"""
    g = city()
    path = random_walk(g, np.random.default_rng(21), 18)
    tr = heading_series(g, path)
    st = seq.make_steps(tr, 30.0)
    G = grid.build(g, None, h=30.0)
    sc = {a: dp.viterbi(dp.prepare(G, dp.Par(a_ang=a)), st)["score"] for a in (0.3, 0.5, 1.0, 1.7)}
    assert sc[1.0] > sc[0.3] and sc[1.0] > sc[0.5], sc


def test_uturn_is_penalised_but_possible():
    g = city()
    G = grid.build(g, None, h=30.0, uturns=False)
    G2 = grid.build(g, None, h=30.0, uturns=True)
    assert G2.groups[1].n > G.groups[1].n
    assert G2.groups[1].w.min() < 0 and G.groups[1].w.min() == 0


def test_reversal_onto_another_way_at_a_node_is_a_uturn():
    """fix R1: a reversal through a node onto a DIFFERENT way (opposite carriageway, link) pays pen_uturn when uturn_deg is set; a 90 deg turn stays free"""
    # way 0: east to the node (100, 0); way 1: back west on a parallel carriageway 4 m north (bearing ~157 deg over its first 12 m); way 2: north
    g = make_graph([[(0.0, 0.0), (100.0, 0.0)], [(100.0, 0.0), (98.0, 4.0), (0.0, 4.0)], [(100.0, 0.0), (100.0, 100.0)]])

    def w(G, a, b):
        k1 = G.groups[1]
        m = (k1.src == G.estart[a + 1] - 1) & (k1.dst == G.estart[b])
        assert m.sum() == 1
        return float(k1.w[m][0])

    old = grid.build(g, None, h=10.0)
    assert w(old, 0, 2) == 0.0 and w(old, 0, 4) == 0.0        # before: the reversal onto way 1 was free
    new = grid.build(g, None, h=10.0, pen_uturn=7.0, uturn_deg=150.0, uturn_span=12.0)
    assert w(new, 0, 2) == pytest.approx(-7.0)                 # reversal onto the other carriageway: a U-turn
    assert w(new, 0, 4) == 0.0                                 # left turn north: free
    assert w(new, 0, 1) == pytest.approx(-7.0)                 # the twin keeps its penalty
    nou = grid.build(g, None, h=10.0, uturns=False, uturn_deg=150.0)
    k1 = nou.groups[1]
    assert not np.any((k1.src == nou.estart[1] - 1) & (k1.dst == nou.estart[2]))   # uturns=False drops it like the twin
    b0, b1 = grid.end_bearings(g, np.array([0, 2]), 12.0)
    assert np.rad2deg(b1[0]) == pytest.approx(0.0, abs=1e-6) and 150.0 < np.rad2deg(b0[1]) < 165.0


def test_uturn_flag_and_cost_without_video_reversal():
    """fix R1 round 2: entries through a U-turn are flagged (Group.ut); hmm_cal.dp.ut_cost charges them only where the video does not reverse"""
    from rsm.hmm.seq import Steps
    from rsm.hmm_cal import dp as cdp
    g = make_graph([[(0.0, 0.0), (100.0, 0.0)], [(100.0, 0.0), (98.0, 4.0), (0.0, 4.0)], [(100.0, 0.0), (100.0, 100.0)]])
    G = grid.build(g, None, h=10.0, uturn_deg=120.0)
    assert G.groups[1].ut.any()
    for gr in G.groups[1:]:
        assert gr.ut.any() or gr.n == 0 or gr.k > 1
        assert np.array_equal(np.sort(gr.ut[gr.border].astype(int)), np.sort(gr.b_ut.astype(int)))
        assert np.all(gr.w[gr.ut] < 0)                      # every flagged entry carries the U-turn penalty
    T = 41
    straight = Steps(t=np.arange(T, dtype=float), dth=np.r_[np.nan, np.zeros(T - 1)], mu=np.r_[0.0, np.full(T - 1, 15.0)], rel=np.full(T, 0.2),
                     v=np.full(T, 5.0), gap=np.zeros(T, bool), seg=np.zeros(T, int), d0=15.0)
    par = cdp.Par(ut_extra=20.0, ut_video_deg=135.0, ut_win_m=60.0)
    assert np.all(cdp.ut_cost(par, straight)[1:] == 20.0)
    dth = straight.dth.copy(); dth[20] = np.pi                   # a real reversal at step 20
    c = cdp.ut_cost(par, straight.copy(dth=dth))
    assert c[20] == 0.0 and c[17] == 0.0 and c[1] == 20.0 and c[-1] == 20.0
    dth[30] = np.nan                                             # no heading: unknown, no extra cost
    assert cdp.ut_cost(par, straight.copy(dth=dth))[30] == 0.0
    assert np.all(cdp.ut_cost(cdp.Par(), straight) == 0.0)       # off by default
