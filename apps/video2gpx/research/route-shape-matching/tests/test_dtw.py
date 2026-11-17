# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.bench.dtw: the optional DTW metric (dtaidistance), against an O(NM) reference definition."""
from __future__ import annotations

import math

import numpy as np
import pytest

from rsm.bench import dtw as D
from rsm.core import metrics as M
import synthetic as syn

pytestmark = pytest.mark.skipif(not D.IMPORTABLE, reason="dtaidistance not installed (requirements-bench.txt)")


def ref_dtw_sqrt_sum_sq(a, b):
    """O(NM) reference: sqrt of the minimal sum of squared Euclidean step costs over warping paths."""
    n, m = len(a), len(b)
    d = ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)
    c = np.full((n + 1, m + 1), np.inf)
    c[0, 0] = 0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            c[i, j] = d[i - 1, j - 1] + min(c[i - 1, j], c[i, j - 1], c[i - 1, j - 1])
    return math.sqrt(c[n, m])



def line(n=50, length=100.0, y=0.0):
    return np.column_stack([np.linspace(0, length, n), np.full(n, y)])


@pytest.mark.parametrize("seed", range(4))
def test_dtw_matches_reference_definition(seed):
    rng = np.random.default_rng(seed)
    a = np.cumsum(rng.normal(0, 3, (25, 2)), axis=0)
    b = np.cumsum(rng.normal(0, 3, (31, 2)), axis=0)
    for c in ([False, True] if D.C_AVAILABLE else [False]):
        raw = D.dtw(a, b, use_c=c) * math.sqrt(max(len(a), len(b)))
        assert raw == pytest.approx(ref_dtw_sqrt_sum_sq(a, b), rel=1e-9)


def test_dtw_normalisation_and_ordering():
    a = syn.wiggly(5, 300.0)[::5]
    b = a + np.random.default_rng(1).normal(0, 2.0, a.shape)
    assert D.dtw(a, b) <= M.rmse(a, b) + 1e-9  # warping can only help
    # per-point normalisation: duplicating every point (twice the samples, same curves) leaves the value unchanged
    ln = line(30, 100.0)
    assert D.dtw(ln, ln + [0.0, 3.0]) == pytest.approx(3.0, rel=1e-9)
    assert D.dtw(np.repeat(ln, 2, axis=0), np.repeat(ln + [0.0, 3.0], 2, axis=0)) == pytest.approx(3.0, rel=1e-9)


def test_dtw_c_and_python_agree():
    if not D.C_AVAILABLE:
        pytest.skip("dtaidistance C code not loadable here (libomp)")
    a = syn.wiggly(6, 300.0)[::5]
    b = a + np.random.default_rng(1).normal(0, 2.0, a.shape)
    assert D.dtw(a, b, use_c=True) == pytest.approx(D.dtw(a, b, use_c=False), rel=1e-9)



def test_parallel_offset_and_identity():
    assert D.dtw(line(), line(y=7.0)) == pytest.approx(7.0)
    assert D.dtw(line(), line()) == pytest.approx(0.0, abs=1e-12)
    with pytest.raises(ValueError):
        D.dtw(np.zeros((3, 3)), line())
