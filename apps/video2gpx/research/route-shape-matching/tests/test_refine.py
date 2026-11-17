# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.refine: anchors / merge / segment correction (kind-agnostic), path building, curve refinement on a synthetic road, tunnel portal times, GPS projection."""
from types import SimpleNamespace

import numpy as np

from rsm.hmm import grid
from rsm.refine import anchors as A
from rsm.refine import curves, evaluate, pathctx, segment, tunnels
from tests.test_hmm import city

D = lambda t: 10.0 * np.asarray(t, float)          # 10 m of nominal vms distance per second
GF = lambda a, b: 0.0
KG = 1.0


def test_segment_correction_is_even_and_kind_blind():
    a, b, c = A.Anchor(0, 0, "curve"), A.Anchor(10, 130, "tunnel_portal"), A.Anchor(20, 230, "bridge")
    s, segs = segment.position(np.array([0, 5, 10, 15, 20, 25]), [a, b, c], D, GF, KG)
    assert np.allclose(s, [0, 65, 130, 180, 230, 280])  # k = 1.3, 1.0, tail with global kappa
    assert [round(x.k, 2) for x in segs] == [1.3, 1.0]
    swapped = [A.Anchor(x.t, x.s, "whatever") for x in (a, b, c)]
    assert np.allclose(segment.position(np.array([5.0, 15.0]), swapped, D, GF, KG)[0], [65, 180])


def test_implausible_k_falls_back_and_gap_segments_keep_k():
    a, b = A.Anchor(0, 0, "x"), A.Anchor(10, 500, "x")
    s, segs = segment.position(np.array([5.0]), [a, b], D, GF, KG)
    assert segs[0].flag == "implausible" and np.isclose(s[0], 50.0)       # k = 5 -> global kappa
    s, segs = segment.position(np.array([5.0]), [a, b], D, lambda p, q: 0.8, KG)  # mostly an estimated gap distance: both anchors are firm
    assert segs[0].flag == "gap" and np.isclose(s[0], 250.0)


def test_stop_inside_a_segment_holds_the_position():
    Dstop = lambda t: 10.0 * np.minimum(np.asarray(t, float), 5.0)    # stands still after 5 s
    s, _ = segment.position(np.array([4.0, 6.0, 9.0]), [A.Anchor(0, 0, "x"), A.Anchor(10, 50, "x")], Dstop, GF, KG)
    assert np.allclose(s, [40, 50, 50])


def test_merge_resolves_conflicts_by_quality_and_order():
    good = [A.Anchor(10 * i, 100.0 * i, "curve", 0.8) for i in range(6)]
    bad = A.Anchor(25, 100.0, "curve", 0.3)                             # arc goes backwards between t=20 and t=30
    acc, rej = A.merge(good + [bad], D, GF, KG)
    assert bad not in acc and len(acc) == 6 and rej[0]["reason"] in ("arc", "k")
    far = A.Anchor(30.1, 900.0, "tunnel_portal", 0.95)                  # inconsistent factor: dropped, the neighbours stay
    acc, rej = A.merge(good + [far], D, GF, KG)
    assert far not in acc and all(g in acc for g in good)
    # a weak pair of close duplicates keeps the stronger one
    d1, d2 = A.Anchor(50, 500, "curve", 0.5), A.Anchor(50.4, 504, "tunnel_portal", 0.9)
    acc, _ = A.merge(good[:5] + [d1, d2], D, GF, KG)
    assert d2 in acc and d1 not in acc


def test_local_outlier_rule():
    good = [A.Anchor(10 * i, 100.0 * i, "curve", 0.8) for i in range(12)]
    off = A.Anchor(60, 600 + 45.0, "curve", 0.8)
    L = [g for g in good if g.t != 60] + [off]
    acc, rej = A.merge(L, D, GF, KG, local_tol=0.3)
    assert off not in acc and rej[0]["reason"] == "local"
    acc2, _ = A.merge(L, D, GF, KG)  # without the rule k = 1.45 / 0.55 passes the plausibility range
    assert off in acc2


def test_cell_layout_matches_grid_build_and_path_arcs_are_monotone():
    g = city()
    G = grid.build(g, None, h=30.0)
    ce, off = pathctx.cell_layout(g, None, 30.0)
    assert np.array_equal(ce, G.cell_edge) and np.allclose(off, G.off)
    # walk along a straight street over two edges
    out = g.out_edges()
    e0 = next(e for e in range(g.n_edges) if g.edge_len[e] == 240.0)
    e1 = next(e for e in out[int(g.edge_v[e0])] if int(g.edge_v[e]) != int(g.edge_u[e0]))
    cells = [c for e in (e0, e1) for c in np.flatnonzero(G.cell_edge == e)]
    path, s = pathctx.build_path(g, G.cell_edge[cells], G.off[cells])
    assert np.all(np.diff(s) >= -1e-9) and abs(path.length - (g.edge_len[e0] + g.edge_len[e1])) < 1.0
    assert path.heading_at([20.0])[0] >= 0


def _synthetic_ctx(shift=40.0, kg=1.2):
    """a road of straights and four bends (heading phi(s) on a 1 m grid); the video sees the same bends scaled by 1/kg with a baseline that is `shift` m too far"""
    sg = np.arange(0.0, 3000.0, 1.0)
    phi = np.zeros_like(sg)
    for c, a in ((600, 1.2), (1100, -1.0), (1700, 1.4), (2300, -1.1)):
        phi += a * 0.5 * (1 + np.tanh((sg - c) / 25.0))
    phi = np.cumsum(np.concatenate([[0], np.diff(phi)]))
    sn = np.arange(0.0, 2400.0 / kg, 4.0)                 # nominal metres
    th = np.interp(kg * sn + 100.0, sg, phi); th = th - th[0]
    tr = dict(t=sn / 8.0, s=sn, th=th)
    path = SimpleNamespace(sg=sg, phi=phi)
    base = lambda t: kg * np.asarray(t, float) * 8.0 + 100.0 + shift
    return SimpleNamespace(path=path, kappa=kg, a_ang=1.0, tracks=[tr], s_baseline=base)


def test_curve_anchors_recover_a_shifted_baseline():
    ctx = _synthetic_ctx(shift=40.0)
    src = curves.CurveAnchors()
    anc = src.anchors(ctx)
    assert len(anc) >= 3
    d = np.array([a.meta["delta"] for a in anc])
    assert np.all(np.abs(d + 40.0) < 8.0), d                # the true arc is 40 m behind the baseline
    for a in anc:                                           # apex of the turn: arc of the true bend centre
        assert min(abs(a.s - c) for c in (600, 1100, 1700, 2300)) < 15.0


def test_tunnel_portal_times_from_luminance():
    lum = np.full(400, 100.0); lum[100:110] = [80, 60, 30, 10, 5, 5, 8, 20, 50, 90]
    ev = dict(dark_intervals=[dict(t0=51.5, t1=53.0, tunnel_by_eye=True)])
    p = tunnels.portal_times(lum, ev)[0]
    assert 49.5 < p["t_entry"] < 52.0 and 52.5 < p["t_exit"] < 55.0 and p["t_entry"] < p["t_exit"]


def test_project_dp_does_not_jump_to_the_neighbouring_hairpin_leg():
    sg = np.arange(0.0, 400.0, 1.0)
    # out 150 m east, 20 m turn, back west 150 m (a hairpin leg 20 m north of the first)
    xy = np.vstack([np.column_stack([np.arange(0, 150.0, 1.0), np.zeros(150)]), np.column_stack([np.full(20, 150.0), np.arange(0, 20.0, 1.0)]),
                    np.column_stack([np.arange(150.0, 0.0, -1.0), np.full(150, 20.0)])])
    sg = np.arange(len(xy), dtype=float)
    path = SimpleNamespace(sg=sg, xy=xy, xy_at=lambda s: np.column_stack([np.interp(np.clip(s, 0, sg[-1]), sg, xy[:, 0]), np.interp(np.clip(s, 0, sg[-1]), sg, xy[:, 1])]))
    t = np.arange(0, 60.0)
    s_true = 5.0 * t
    gps = path.xy_at(s_true) + np.array([0.0, 8.0])   # noisy, 8 m north: for the first leg the other leg (12 m away) is nearly as close
    s, d = evaluate.project_dp(path, gps, s_true + 20.0, win=200.0)
    assert np.abs(s - s_true).max() < 20.0
