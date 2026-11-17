# SPDX-License-Identifier: AGPL-3.0-or-later
"""Least-squares 2D similarity transform from point correspondences (Umeyama 1991).

Model: ``b_i ~ scale * R(rotation) @ a_i + translation`` with a proper rotation (det R = +1).
**Reflection is disallowed**: when the unconstrained optimum would be a reflection (the SVD
determinant correction of Umeyama's paper), the best proper rotation is returned and the residual
is correspondingly large. A mirrored input is therefore not fitted well, by design.

Frame: x right, y forward, metres, counter-clockwise rotation positive (see `trajectory`).

Two implementations of the same estimator:
- `fit_similarity`: one fit, SVD (`numpy.linalg.svd`), the reference.
- `fit_similarity_batch`: many fits at once for the matcher's window search. In 2D the optimal
  proper rotation and scale are the argument and modulus of one complex number, so this needs no
  SVD and cannot return a reflection. A test checks that both agree.

Scale constraint: ``scale_bounds=(lo, hi)``. For a fixed scale the optimal rotation is the same as
for the free scale, so clamping only changes the scale and the translation is re-solved
(``t = mean_b - scale R mean_a``). `scale_clamped` reports that the bound was active.

Degenerate input:
- fewer than 2 points, non-finite values, source points with (almost) zero variance (all
  identical: scale and rotation are undetermined) or target points with zero variance (the optimal
  scale would be 0): `DegenerateFit` is raised;
- collinear source points are *not* degenerate for a similarity: a line still fixes scale and
  rotation (the fit is exact if the targets are collinear too). A test covers it.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


class DegenerateFit(ValueError):
    """The correspondences do not determine a similarity (e.g. all source points identical)."""


@dataclass(frozen=True)
class Similarity:
    scale: float
    rotation: float  # radians, counter-clockwise
    translation: tuple[float, float]
    rms: float  # root-mean-square residual |b - T(a)|, in the units of b
    max_residual: float
    scale_clamped: bool = False
    scale_unclamped: float = 0.0  # free-scale optimum (== scale unless clamped)

    def matrix(self) -> np.ndarray:
        """(2, 2) matrix scale * R."""
        c, s = np.cos(self.rotation), np.sin(self.rotation)
        return self.scale * np.array([[c, -s], [s, c]])

    def apply(self, points: np.ndarray) -> np.ndarray:
        return np.asarray(points, dtype=np.float64) @ self.matrix().T + np.asarray(self.translation)


def _check(a: np.ndarray, b: np.ndarray, min_variance: float):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.ndim != 2 or a.shape[1] != 2 or a.shape != b.shape:
        raise ValueError(f"a and b must both be (N, 2) with equal N, got {a.shape} and {b.shape}")
    if len(a) < 2:
        raise DegenerateFit(f"need at least 2 correspondences, got {len(a)}")
    if not (np.all(np.isfinite(a)) and np.all(np.isfinite(b))):
        raise DegenerateFit("correspondences contain NaN or infinite values")
    ma, mb = a.mean(axis=0), b.mean(axis=0)
    var_a = float(np.mean(np.sum((a - ma) ** 2, axis=1)))
    if var_a <= min_variance:
        raise DegenerateFit(f"source points have (almost) zero variance ({var_a:.3g}): scale and rotation are undetermined")
    return a, b, ma, mb, var_a


def fit_similarity(a, b, scale_bounds: tuple[float, float] | None = None, min_variance: float = 1e-12) -> Similarity:
    """Least-squares similarity mapping `a` onto `b` (both (N, 2), paired by index). See the module docstring."""
    a, b, ma, mb, var_a = _check(a, b, min_variance)
    ac, bc = a - ma, b - mb
    cov = bc.T @ ac / len(a)  # 2x2: sum b a^T / N
    u, d, vt = np.linalg.svd(cov)
    s_diag = np.array([1.0, 1.0 if np.linalg.det(u) * np.linalg.det(vt) > 0 else -1.0])  # det correction: no reflection
    rot = u @ np.diag(s_diag) @ vt
    scale_free = float(np.sum(d * s_diag) / var_a)
    scale, clamped = scale_free, False
    if scale_bounds is not None:
        lo, hi = scale_bounds
        if not (0 < lo <= hi):
            raise ValueError(f"scale_bounds must satisfy 0 < lo <= hi, got {scale_bounds}")
        scale = min(max(scale_free, lo), hi)
        clamped = scale != scale_free
    if scale_free <= 1e-9:
        raise DegenerateFit("targets have (almost) zero variance: the optimal scale would be 0")
    t = mb - scale * rot @ ma
    res = np.hypot(*(b - (scale * a @ rot.T + t)).T)
    return Similarity(scale, float(np.arctan2(rot[1, 0], rot[0, 0])), (float(t[0]), float(t[1])),
                      float(np.sqrt(np.mean(res ** 2))), float(res.max()), clamped, scale_free)


def fit_similarity_batch(a: np.ndarray, b: np.ndarray, scale_bounds: tuple[float, float] | None = None,
                         min_variance: float = 1e-12):
    """Many similarity fits at once: one source `a` (N, 2) against G targets `b` (G, N, 2).

    Returns a dict of arrays of length G: scale, rotation, tx, ty, rms, scale_clamped (bool),
    scale_free. Same estimator as `fit_similarity` (see module docstring).
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.ndim != 2 or a.shape[1] != 2 or b.ndim != 3 or b.shape[1:] != a.shape:
        raise ValueError(f"expected a (N, 2) and b (G, N, 2), got {a.shape} and {b.shape}")
    za = a[:, 0] + 1j * a[:, 1]
    zb = b[..., 0] + 1j * b[..., 1]
    ma, mb = za.mean(), zb.mean(axis=1)
    zac, zbc = za - ma, zb - mb[:, None]
    var_a = float(np.mean(np.abs(zac) ** 2))
    if var_a <= min_variance:
        raise DegenerateFit(f"source points have (almost) zero variance ({var_a:.3g})")
    coef = (zbc * np.conj(zac)).sum(axis=1) / (len(za) * var_a)  # complex a: modulus scale, argument rotation
    scale_free = np.abs(coef)
    rot = np.where(scale_free > 0, coef / np.where(scale_free > 0, scale_free, 1.0), 1.0 + 0j)
    scale, clamped = scale_free, np.zeros(len(scale_free), dtype=bool)
    if scale_bounds is not None:
        lo, hi = scale_bounds
        scale = np.clip(scale_free, lo, hi)
        clamped = scale != scale_free
    t = mb - scale * rot * ma
    res = zb - (scale * rot)[:, None] * za[None, :] - t[:, None]
    rms = np.sqrt(np.mean(np.abs(res) ** 2, axis=1))
    return {"scale": scale, "rotation": np.angle(rot), "tx": t.real, "ty": t.imag, "rms": rms,
            "scale_clamped": clamped, "scale_free": scale_free}
