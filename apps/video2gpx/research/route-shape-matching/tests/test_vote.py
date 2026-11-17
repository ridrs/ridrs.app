# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.vote: the unbounded fit reaches an angle scale far outside the plaus prior, a tight re-fit stays at the voted scale, the vote finds a planted peak."""
import numpy as np

from rsm.plaus import data, fit as pf
from rsm.vote import fit as VF, vote
from tests.test_plaus import serpentine, video_from


def _case(rho, kappa=1.0):
    pts = serpentine([80, -70, 90, -100, 75, -85, 90], [300, 220, 360, 250, 300, 280, 330, 300])
    mp, tr = video_from(pts, rho=rho, kappa=kappa)
    vw = data.cut(tr, tr[0]["t"][0], tr[0]["t"][-1])
    anchors = [(float(vw.t[0]), 0.0), (float(vw.t[-1]), float(mp.u[-1]))]
    return vw, mp, anchors


def test_free_fit_reaches_rho_outside_the_plaus_prior():
    vw, mp, anc = _case(rho=1.6)  # video heading = map heading / 1.6: the fit must multiply by 1.6
    fb = pf.fit_candidate(vw, mp, pf.PRIORS["measured"], anc)
    ff = VF.fit_free(vw, mp, anc)
    assert abs(ff.rho - 1.6) < 0.1 and not ff.atbound
    assert ff.snorm < 0.5 * fb.snorm


def test_fixed_refit_is_tight():
    vw, mp, anc = _case(rho=1.6)
    f = VF.fit_free(vw, mp, anc, rho_fixed=(1.0, 0.03), kappa_fixed=(1.0, 0.15))
    assert 0.97 * 0.99 <= f.rho <= 1.03 * 1.01 and f.snorm > 0.1  # wrong scale: forced, so it fits badly


def test_peak_finds_planted_cluster_and_ignores_bound_points():
    rng = np.random.default_rng(0)
    n = 300
    P = np.column_stack([np.full(n, 449.0), np.arange(n), rng.uniform(0.4, 3.0, n), rng.uniform(0.4, 2.5, n), np.full(n, 0.2), np.zeros(n), np.full(n, 3.0), np.zeros(n)])
    c = 40
    Q = np.column_stack([np.full(c, 449.0), np.arange(c), 449 / 273 * np.exp(rng.normal(0, 0.01, c)), 1.1 * np.exp(rng.normal(0, 0.01, c)), np.full(c, 0.05), np.zeros(c), np.full(c, 3.0), np.ones(c)])
    B = Q.copy(); B[:, 5] = 1.0  # at a bound: must not vote
    pk = vote.peak(vote.select(np.vstack([P, Q])))
    assert abs(pk["f_eff"] / 273 - 1) < 0.05 and abs(pk["kappa"] / 1.1 - 1) < 0.05 and pk["mass"] > 20
    assert vote.peak(vote.select(np.vstack([P, B])))["mass"] < 10
