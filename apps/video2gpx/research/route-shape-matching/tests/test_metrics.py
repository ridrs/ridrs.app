# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.core.metrics: known values and invariances (DTW lives in rsm.bench.dtw, see test_dtw.py)."""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy.spatial.distance import directed_hausdorff

from rsm.core import metrics as M
import synthetic as syn


def line(n=50, length=100.0, y=0.0):
    return np.column_stack([np.linspace(0, length, n), np.full(n, y)])


def test_identical_curves_are_zero():
    a = syn.wiggly(1, 300.0)[::5]
    for f in (M.frechet, M.hausdorff, M.rmse, M.heading_signature_distance):
        assert f(a, a) == pytest.approx(0.0, abs=1e-9)


def test_parallel_offset_known_values():
    a, b = line(), line(y=7.0)
    assert M.frechet(a, b) == pytest.approx(7.0)
    assert M.hausdorff(a, b) == pytest.approx(7.0)
    assert M.rmse(a, b) == pytest.approx(7.0)
    assert M.heading_signature_distance(a, b) == pytest.approx(0.0, abs=1e-12)


def test_frechet_matches_shapely_and_is_a_max_statistic():
    import shapely
    a = syn.wiggly(2, 300.0)[::5]
    b = a + np.random.default_rng(0).normal(0, 2.0, a.shape)
    assert M.frechet(a, b) == pytest.approx(shapely.frechet_distance(shapely.linestrings(a), shapely.linestrings(b)))
    ln = line(50, 100.0)
    bump = ln.copy()
    bump[len(ln) // 2] += [0.0, 30.0]  # one outlier perpendicular to a line: the max statistic sees it, the RMS dilutes it
    assert M.frechet(ln, bump) == pytest.approx(30.0) and M.rmse(ln, bump) == pytest.approx(30.0 / math.sqrt(len(ln)))


def test_hausdorff_ignores_order_frechet_does_not():
    a = line()
    b = a[::-1].copy()
    assert M.hausdorff(a, b) == pytest.approx(0.0, abs=1e-9)
    assert M.frechet(a, b) == pytest.approx(100.0)  # walking the other way: the leash spans the whole line
    # a path that goes out and comes back over itself has the same point set as the line
    out_back = np.vstack([line(30, 100.0), line(30, 100.0)[::-1]])
    assert M.hausdorff(a, out_back) == pytest.approx(0.0, abs=1e-9)
    assert M.frechet(a, out_back) > 40.0


def test_hausdorff_agrees_with_point_set_value_when_densely_sampled():
    a = syn.wiggly(3, 300.0)[::2]
    b = syn.move(a, 1.0, 0.0, (3.0, 0.0)) + np.random.default_rng(2).normal(0, 1.0, a.shape)
    ref = max(directed_hausdorff(a, b)[0], directed_hausdorff(b, a)[0])
    assert M.hausdorff(a, b) == pytest.approx(ref, rel=0.15)  # GEOS measures to the segments, so slightly smaller or equal
    assert M.hausdorff(a, b) <= ref + 1e-9


def test_rmse_resamples_by_arc_length():
    a = line(40, 100.0)
    b = line(70, 100.0, y=3.0)
    assert M.rmse(a, b, n=64) == pytest.approx(3.0)
    with pytest.raises(ValueError):
        M.rmse(a, b)  # different lengths without n
    # irregular sampling of the same curve gives ~0 once resampled
    c = syn.irregular_resample(syn.wiggly(7, 300.0), 2.0, 1)
    d = syn.irregular_resample(syn.wiggly(7, 300.0), 3.5, 2)
    assert M.rmse(c, d, n=300) < 0.2


@pytest.mark.parametrize("seed", range(3))
def test_heading_signature_invariances(seed):
    a = syn.wiggly(seed, 400.0)
    b = syn.move(a, 0.6, 1.9, (500.0, -300.0))
    assert M.heading_signature_distance(a, b) == pytest.approx(0.0, abs=1e-9)  # rotation, translation, scale
    c = syn.irregular_resample(b, 2.5, seed)
    assert M.heading_signature_distance(a, c) < 0.02  # resampling


def test_heading_signature_mirror_and_difference():
    a = syn.wiggly(1, 400.0)
    same = M.heading_signature_distance(a, syn.move(a, 1.0, 0.3, (1, 2)))
    mirrored = M.heading_signature_distance(a, syn.move(a, 1.0, 0.3, (1, 2), mirror=True))
    other = M.heading_signature_distance(a, syn.wiggly(2, 400.0))
    assert same < 1e-9 < 0.3 < mirrored and other > 0.3
    # a straight line mirrored is the same line
    assert M.heading_signature_distance(line(), syn.move(line(), mirror=True)) == pytest.approx(0.0, abs=1e-9)


def test_inputs_validated():
    for f in (M.frechet, M.hausdorff):
        with pytest.raises(ValueError):
            f(np.zeros((3, 3)), line())
        with pytest.raises(ValueError):
            f(np.array([[0.0, np.nan], [1.0, 1.0]]), line())
    with pytest.raises(ValueError):
        M.heading_signature_distance(np.zeros((5, 2)), line())  # zero-length polyline
