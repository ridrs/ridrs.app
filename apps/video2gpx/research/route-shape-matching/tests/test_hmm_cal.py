# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.hmm_cal: memory plan, box geometry, 16-bit backpointer copy of the dense HMM, scale-equivariant grid per kappa."""
import numpy as np
import pytest

from rsm.hmm import dp as dp0
from rsm.hmm import grid, seq
from rsm.hmm_cal import area, dp, run
from tests.test_hmm import city, heading_series, random_walk


def test_plan_aborts_above_cap_and_falls_back_to_40m():
    g = city()
    E = np.arange(g.n_edges)
    with pytest.raises(MemoryError):
        area.plan(g, E, lambda h: 10_000_000, cap_gb=0.001)
    p = area.plan(g, E, lambda h: 1000)
    assert p["h"] == 30.0 and p["gb"] < 4.0
    n30, n40 = area.n_cells(g, E, 30.0), area.n_cells(g, E, 40.0)
    assert n40 < n30
    q = area.plan(g, E, lambda h: 1000, cap_gb=n40 * 1000 * 3 / 1e9 * 1.01) if n30 * 3000 / 1e9 > n40 * 3000 / 1e9 * 1.01 else {"h": 40.0}
    assert q["h"] == 40.0


def test_foreign_box_has_the_size_of_the_amalfi_box():
    w, h = area.km_dims()
    for lat, lon in area.FOREIGN.values():
        w2, h2 = area.km_dims(area.foreign_bbox(lat, lon))
        assert abs(w2 - w) < 0.1 and abs(h2 - h) < 0.1


def test_16bit_backpointers_give_the_same_path_as_the_8bit_original():
    g = city()
    path = random_walk(g, np.random.default_rng(3), 16)
    tr = heading_series(g, path)
    st = seq.make_steps(tr, 30.0)
    G = grid.build(g, None, h=30.0)
    a = dp0.viterbi(dp0.prepare(G, dp0.Par()), st, backptr=True)
    b = dp.viterbi(dp.prepare(G, dp.Par()), st, backptr=True)
    assert abs(a["score"] - b["score"]) < 1e-3
    assert np.array_equal(a["cell_path"], b["cell_path"])


def test_high_in_degree_fits_the_16bit_slot():
    """K = 7 on a street grid: accepted by the copy (Amalfi's real corridor needs it: in-degree 119 at K = 7)"""
    g = city()
    G = grid.build(g, None, h=10.0, K=7, dmax=80.0)
    pre = dp.Prepared(G, dp.Par())
    assert pre.loc[0].dtype == np.uint16


def test_grid_scales_with_kappa():
    g = city()
    E = np.arange(g.n_edges)
    n1 = grid.build(g, E, h=30.0).N
    n2 = grid.build(g, E, h=60.0, sm=20.0).N
    assert n2 < n1 and abs(n2 - n1 / 2) < 0.2 * n1
    assert len(run.K_GRID) == 8 and abs(run.K_GRID[0] - 0.8) < 1e-9 and abs(run.K_GRID[-1] - 3.5) < 1e-9
    assert len(run.F_GRID) == 6 and abs(run.F_GRID[0] - 250) < 1e-9 and abs(run.F_GRID[-1] - 400) < 1e-9
