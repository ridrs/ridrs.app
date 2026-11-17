# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.plaus: stage A copy equals the frozen chain matcher, stage B fit recovers known corrections and rejects a wrong path, decision rules."""
import math

import numpy as np

from rsm.plaus import data, decide, fit, path, stagea
from rsm.quanta import chain
from tests.test_quanta import TURNS, SEG, build_map, toy_graph


def serpentine(turns_deg, segs, step=2.0):
    pts, th = [(0.0, 0.0)], 0.0
    for i, L in enumerate(segs):
        n = max(int(L / step), 1)
        for _ in range(n):
            pts.append((pts[-1][0] - step * math.sin(th), pts[-1][1] + step * math.cos(th)))
        if i < len(turns_deg):  # turn spread over 20 m
            k = 10
            for _ in range(k):
                th += math.radians(turns_deg[i]) / k
                pts.append((pts[-1][0] - step * math.sin(th), pts[-1][1] + step * math.cos(th)))
    return np.array(pts)


def video_from(pts, rho=1.0, kappa=1.0, drift_deg_s=0.0, speed=8.0, noise=0.0, seed=0):
    """vms-like segment: nominal distance = map distance / kappa, heading = (map heading + drift t) / rho, on the 4 m grid."""
    p = path.path_from_xy(pts)
    s_nom = np.arange(0, p.U / kappa - 5, data.DS)
    u = s_nom * kappa
    t = s_nom / speed
    th = (np.interp(u, p.u, p.phi) - p.phi[0]) / rho + np.deg2rad(drift_deg_s) * t / rho
    th = th + np.random.default_rng(seed).normal(0, noise, len(th))
    tr = [dict(t=t, s=s_nom, th=th - th[0])]
    return p, tr


def test_stage_a_copy_matches_frozen_chain():
    g = toy_graph()
    m = build_map(g)
    ix = chain.MapIndex(m)
    from rsm.quanta import evalrun  # noqa: F401
    from rsm.quanta.qdef import TurnRec, quanta_from_turns
    ts, s = [], 0.0
    for i, a in enumerate(TURNS):
        ts.append(TurnRec(1 if a > 0 else -1, abs(a), 30.0, s, s + 30.0, t0=s / 8, t1=(s + 30) / 8))
        s += 30.0 + SEG[i + 1]
    q = quanta_from_turns(ts)
    a = chain.match_window(ix, q, 0, 6)
    b = stagea.match_window_k(ix, q, 0, 6, K=50)
    assert [round(c.score, 6) for c in a] == [round(c.score, 6) for c in b[:len(a)]]


def test_fit_recovers_corrections_and_rejects_mirror():
    pts = serpentine([80, -70, 90, -100, 75, -85, 90], [300, 220, 360, 250, 300, 280, 330, 300])
    mp, tr = video_from(pts, rho=1.1, kappa=0.9, drift_deg_s=0.1)
    vw = data.cut(tr, tr[0]["t"][0], tr[0]["t"][-1])
    anchors = [(float(vw.t[0]), 0.0), (float(vw.t[-1]), float(mp.u[-1]))]
    f = fit.fit_candidate(vw, mp, fit.PRIORS["measured"], anchors)
    assert f.ok and f.snorm < 0.05
    assert abs(f.rho - 1 / 1.1) < 0.05 or abs(f.rho - 1.1) < 0.05  # video heading = map/1.1 -> rho = 1.1 multiplies the video heading back
    assert abs(f.kappa - 0.9) < 0.1 or abs(f.kappa - 1 / 0.9) < 0.15
    # mirrored map path (left <-> right) must fit clearly worse
    mir = pts.copy(); mir[:, 0] *= -1
    mp2 = path.path_from_xy(mir)
    f2 = fit.fit_candidate(vw, mp2, fit.PRIORS["measured"], anchors)
    assert f2.snorm > 3 * f.snorm


def test_tight_prior_refuses_large_scale():
    pts = serpentine([80, -70, 90, -100], [300, 220, 360, 250, 300])
    mp, tr = video_from(pts, rho=1.0, kappa=1.0)
    for x in tr:
        x["s"] = x["s"] * 0.5  # video distance half of the map's: kappa = 2
    vw = data.cut(tr, tr[0]["t"][0], tr[0]["t"][-1])
    anchors = [(float(vw.t[0]), 0.0), (float(vw.t[-1]), float(mp.u[-1]))]
    ft = fit.fit_candidate(vw, mp, fit.PRIORS["tight"], anchors)
    fl = fit.fit_candidate(vw, mp, fit.PRIORS["loose"], anchors)
    assert ft.kappa <= 1.3 + 1e-6 and fl.kappa > 1.5  # the hard bound of the tight prior binds, the loose one reaches the truth
    assert ft.snorm > fl.snorm


def test_cut_keeps_gaps_explicit():
    t = np.arange(0, 100, 0.5)
    mk = lambda a, b: dict(t=t[(t >= a) & (t < b)], s=np.arange(0, 4.0 * len(t[(t >= a) & (t < b)]), 4.0), th=np.zeros(len(t[(t >= a) & (t < b)])))
    tr = [mk(0, 30), mk(40, 90)]
    vw = data.cut(tr, 0, 90)
    assert vw.M == 2 and len(vw.gnom) == 1 and abs(vw.gdur[0] - 10.0) < 1.0 and vw.gnom[0] > 0
    s = vw.sigma()
    assert s[vw.seg == 1][0] > vw.S[0]  # the gap is counted in the global distance


def _rec(rank, snorm, correct, edges, cost=None, n=100, setting="measured"):
    f = dict(ok=True, snorm=snorm, cost=cost if cost is not None else snorm * n, n=n, rho=1.0, kappa=1.0, rate=np.zeros(1), lam=0.0, trace=None, atbound=False, rms=1.0)
    return dict(rank=rank, correct=correct, edges=frozenset(edges), fits={setting: f})


def test_decision_rule():
    rec = dict(L=5, lo=0, hi=5, cands=[_rec(0, 0.05, True, [1, 2, 3]), _rec(1, 0.30, False, [7, 8, 9]), _rec(2, 0.06, False, [1, 2, 4])])
    tau = decide.calibrate_tau([rec], "measured")["tau"]
    assert abs(tau - 0.05) < 1e-9
    d = decide.decide(rec, "measured", 0.1, 0.0)
    assert d[0]["rank"] == 0 and d[2] == np.inf  # the second accepted candidate shares edges with the first -> same road, no margin competitor
    rec["cands"][2]["edges"] = frozenset([20, 21, 22])
    d = decide.decide(rec, "measured", 0.1, 0.0)
    assert abs(d[2] - 0.01) < 1e-9
    assert decide.decide(rec, "measured", 0.1, 0.05) is None
    assert decide.outcome(decide.decide(rec, "measured", 0.1, 0.0)) == "correct"


def test_adjacency():
    def fitd(x0):
        t = np.linspace(0, 100, 11)
        return dict(trace=(t, np.column_stack([x0 + 10 * t, np.zeros(11)])))
    recs = [dict(L=5, lo=0, hi=5), dict(L=5, lo=2, hi=7)]
    a, b = fitd(0.0), fitd(30.0)
    assert decide.adjacent(a, b) is True
    c = fitd(5000.0)
    assert decide.adjacent(a, c) is False
    dec = [({"correct": True}, a, 1.0), ({"correct": False}, c, 1.0)]
    out, n, bad = decide.apply_adjacency(recs, dec)
    assert (n, bad) == (1, 1) and out == [None, None]
