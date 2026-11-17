# SPDX-License-Identifier: AGPL-3.0-or-later
"""rsm.core.similarity: exact recovery, agreement with scikit-image, no reflection, degenerate input."""
from __future__ import annotations

import numpy as np
import pytest

from rsm.core.similarity import DegenerateFit, fit_similarity, fit_similarity_batch
import synthetic as syn

TRUE = dict(scale=1.3, angle=0.7, shift=(1000.0, -500.0))


def spiral(n=80):
    t = np.linspace(0, 4 * np.pi, n)
    return np.column_stack([(20 + 6 * t) * np.cos(t), (20 + 6 * t) * np.sin(t)])


def test_exact_recovery():
    a = spiral()
    b = syn.move(a, **TRUE)
    f = fit_similarity(a, b)
    assert f.scale == pytest.approx(1.3, abs=1e-12)
    assert f.rotation == pytest.approx(0.7, abs=1e-12)
    assert f.translation == pytest.approx((1000.0, -500.0), abs=1e-8)
    assert f.rms < 1e-9 and f.max_residual < 1e-9 and not f.scale_clamped
    np.testing.assert_allclose(f.apply(a), b, atol=1e-8)


def test_negative_rotation_and_wraparound():
    a = spiral()
    f = fit_similarity(a, syn.move(a, 0.8, -3.0, (5, 5)))
    assert f.rotation == pytest.approx(-3.0, abs=1e-12) and f.scale == pytest.approx(0.8)


def test_agrees_with_skimage_on_noisy_data():
    skt = pytest.importorskip("skimage.transform")
    rng = np.random.default_rng(3)
    a = spiral()
    b = syn.move(a, **TRUE) + rng.normal(0, 2.0, a.shape)
    ours = fit_similarity(a, b)
    ref = skt.SimilarityTransform.from_estimate(a, b)
    assert ref, "skimage failed to estimate"
    assert ours.scale == pytest.approx(ref.scale, rel=1e-9)
    assert ours.rotation == pytest.approx(ref.rotation, abs=1e-9)
    np.testing.assert_allclose(ours.translation, ref.translation, atol=1e-6)
    # and the noise level is recovered, not just the parameters
    assert ours.rms == pytest.approx(2.0 * np.sqrt(2), rel=0.15)  # sigma 2 per axis -> RMS distance 2 sqrt(2)
    np.testing.assert_allclose(ours.apply(a), ref(a), atol=1e-6)


def test_batch_matches_single():
    rng = np.random.default_rng(5)
    a = spiral(60)
    targets = np.stack([syn.move(a, s, th, (x, 3)) + rng.normal(0, 1.0, a.shape) for s, th, x in [(0.8, 0.1, 0), (1.2, -2.0, 7), (1.0, 3.0, -9)]])
    bounds = (0.9, 1.1)
    batch = fit_similarity_batch(a, targets, bounds)
    for i, b in enumerate(targets):
        f = fit_similarity(a, b, bounds)
        assert batch["scale"][i] == pytest.approx(f.scale, abs=1e-10)
        assert batch["rotation"][i] == pytest.approx(f.rotation, abs=1e-10)
        assert (batch["tx"][i], batch["ty"][i]) == pytest.approx(f.translation, abs=1e-8)
        assert batch["rms"][i] == pytest.approx(f.rms, abs=1e-9)
        assert bool(batch["scale_clamped"][i]) == f.scale_clamped
        assert batch["scale_free"][i] == pytest.approx(f.scale_unclamped, abs=1e-10)


def test_mirrored_input_is_not_fitted_well():
    a = syn.wiggly(4, 400.0)[::4]
    noise = 1.0
    rng = np.random.default_rng(1)
    good = fit_similarity(a, syn.move(a, 1.1, 0.4, (3, 4)) + rng.normal(0, noise, a.shape))
    mirrored = fit_similarity(a, syn.move(a, 1.1, 0.4, (3, 4), mirror=True) + rng.normal(0, noise, a.shape))
    assert good.rms < 1.5 * noise
    assert mirrored.rms > 20 * noise  # a reflection is not available: the best proper rotation fits badly
    # the batch implementation behaves the same
    b = fit_similarity_batch(a, np.stack([syn.move(a, 1.1, 0.4, (3, 4), mirror=True)]))
    assert b["rms"][0] > 20 * noise


def test_scale_constraint_clamps_and_resolves_translation():
    a = spiral()
    b = syn.move(a, 1.3, 0.7, (1000.0, -500.0))
    f = fit_similarity(a, b, scale_bounds=(0.7, 1.0))
    assert f.scale == 1.0 and f.scale_clamped and f.scale_unclamped == pytest.approx(1.3)
    assert f.rotation == pytest.approx(0.7, abs=1e-12)  # the optimal rotation does not depend on the scale
    # translation re-solved so that the centroids still map onto each other
    np.testing.assert_allclose(f.apply(a).mean(axis=0), b.mean(axis=0), atol=1e-9)
    assert f.rms > 1.0
    # inside the bounds nothing changes
    g = fit_similarity(a, b, scale_bounds=(1.0, 2.0))
    assert g.scale == pytest.approx(1.3) and not g.scale_clamped
    with pytest.raises(ValueError):
        fit_similarity(a, b, scale_bounds=(2.0, 1.0))


def test_constrained_scale_is_the_constrained_optimum():
    """Brute force: no other scale in the bounds gives a smaller residual (rotation and translation optimal for each)."""
    rng = np.random.default_rng(9)
    a = spiral()
    b = syn.move(a, 1.3, 0.2, (0, 0)) + rng.normal(0, 3, a.shape)
    f = fit_similarity(a, b, scale_bounds=(0.9, 1.1))
    for s in np.linspace(0.9, 1.1, 21):
        g = fit_similarity(a, b, scale_bounds=(s, s))
        assert g.rms >= f.rms - 1e-9


def test_collinear_points_are_not_degenerate():
    t = np.linspace(0, 100, 20)
    a = np.column_stack([t, np.zeros_like(t)])
    b = syn.move(a, 0.9, 1.0, (4, 5))
    f = fit_similarity(a, b)
    assert f.scale == pytest.approx(0.9) and f.rotation == pytest.approx(1.0) and f.rms < 1e-9
    # collinear source, curved target: still a proper rotation, large residual, no exception
    c = fit_similarity(a, np.column_stack([t, 20 * np.sin(t / 15)]))
    assert np.isfinite(c.rms) and c.rms > 1.0
    assert np.isfinite(fit_similarity_batch(a, np.stack([b]))["rms"][0])


@pytest.mark.parametrize("a,b,msg", [
    (np.zeros((5, 2)), np.ones((5, 2)), "zero variance"),
    (np.array([[1.0, 1.0], [1.0, 1.0]]), np.array([[0.0, 0.0], [5.0, 5.0]]), "zero variance"),
    (np.array([[1.0, 1.0]]), np.array([[2.0, 2.0]]), "at least 2"),
    (np.array([[0.0, 0.0], [np.nan, 1.0]]), np.array([[0.0, 0.0], [1.0, 1.0]]), "NaN"),
])
def test_degenerate_input_raises(a, b, msg):
    with pytest.raises(DegenerateFit, match=msg):
        fit_similarity(a, b)


def test_shape_mismatch_raises():
    with pytest.raises(ValueError):
        fit_similarity(np.zeros((4, 2)), np.zeros((5, 2)))
    with pytest.raises(ValueError):
        fit_similarity_batch(np.zeros((4, 2)), np.zeros((3, 5, 2)))


def test_identical_target_points_raise():
    """All targets identical: the best 'similarity' would have scale 0, which is not a similarity."""
    with pytest.raises(DegenerateFit, match="targets"):
        fit_similarity(spiral(), np.tile([3.0, 4.0], (80, 1)))
