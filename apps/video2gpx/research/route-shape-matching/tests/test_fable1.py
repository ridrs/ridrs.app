# SPDX-License-Identifier: AGPL-3.0-or-later
import numpy as np

from rsm.decoy import rank, signals
from rsm.grade import stats


def _sig(n=4000, seed=0):
    rng = np.random.default_rng(seed)
    return rng.normal(0, 0.01, n), np.full(n, 8.0)  # 32 km


def test_blocks_cover_and_sizes():
    om, ds = _sig()
    e = signals.block_edges(ds, np.random.default_rng(1))
    assert e[0] == 0 and e[-1] == len(ds)
    km = np.array([ds[a:b].sum() for a, b in zip(e[:-1], e[1:])])
    assert km.min() >= 2000 - 8 and km.max() <= 5000 + 2000


def test_transforms_preserve_what_they_should():
    om, ds = _sig()
    m, d, _ = signals.transform(om, ds, "mirror", 0)
    assert np.allclose(m, -om)
    s, d, info = signals.transform(om, ds, "shuffle", 3)
    assert len(s) == len(om) and np.isclose(np.sort(s).sum(), np.sort(om).sum()) and not np.array_equal(s, om)
    assert np.allclose(np.sort(s), np.sort(om))
    f, d, info = signals.transform(om, ds, "flip", 3)
    assert np.allclose(np.abs(f), np.abs(om)) and info["kept_longest_km"] <= 6.0 and info["flipped_share"] >= 0.3
    r, dr, _ = signals.transform(om, ds, "reverse", 0)
    assert np.allclose(r, -om[::-1])
    a = signals.transform(om, ds, "shuffle", 5)[0]
    assert np.array_equal(a, signals.transform(om, ds, "shuffle", 5)[0])


def test_rank_ties_against_real():
    assert rank.rank_of(5.0, [6, 7, 8], False) == (1, 0.25)
    assert rank.rank_of(5.0, [5, 7], False)[0] == 2
    assert rank.rank_of(3, [1, 3, 2], True)[0] == 2


def test_spearman_and_shift_null():
    x = np.sin(np.linspace(0, 40, 800)); y = -x + np.random.default_rng(0).normal(0, 0.1, 800)
    assert stats.spearman(x, y) < -0.9
    nul = stats.shift_null(x, y, 25.0, 2000.0, 100)
    assert np.nanmedian(np.abs(nul)) < 0.9
    assert len(nul) <= 100
