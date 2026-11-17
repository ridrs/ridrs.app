# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rotation-only image flow of far features and the fit of the focal length from its x^2 curvature (numpy only).

For a camera rotation (wx, wy, wz) and no translation the flow does not depend on depth (x right, y down, from the principal point):

    dx = A (1 + x^2/f^2) + B x y / f^2 + C y        A = -wy f  (yaw, px)
    dy = B (1 + y^2/f^2) + A x y / f^2 - C x        B =  wx f  (pitch, px), C = wz f (roll, px)

The yaw sets the constant part A, f sets the curvature A/f^2 across the image width. Far features still move with the forward
motion (radial expansion about the vanishing point, linear in x, y): a nuisance term e (x, y) is fitted too. An optional radial
distortion k1 (observed = undistorted (1 + k1 r^2), r in units of f) is handled exactly to first order in the flow.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Information about f lives in the curvature; the rest are nuisance parameters: [A, B, C, e].
NPAR = 4


def _undistort(xn: np.ndarray, yn: np.ndarray, k1: float, iters: int = 4):
    xu, yu = xn, yn
    if k1 == 0.0:
        return xu, yu
    for _ in range(iters):
        s = 1.0 + k1 * (xu * xu + yu * yu)
        xu, yu = xn / s, yn / s
    return xu, yu


def design(x: np.ndarray, y: np.ndarray, f: float, k1: float = 0.0) -> np.ndarray:
    """(2n, 4) matrix mapping [A, B, C, e] (px) to the flow [dx rows, then dy rows] at points x, y (px from the principal point)."""
    xn, yn = x / f, y / f
    xu, yu = _undistort(xn, yn, k1)
    # undistorted-plane flow per unit parameter (A, B, C, e); then the Jacobian of the distortion maps it to the observed plane
    ux = np.column_stack([1 + xu * xu, xu * yu, yu, xu])
    uy = np.column_stack([xu * yu, 1 + yu * yu, -xu, yu])
    if k1 != 0.0:
        r2 = (xu * xu + yu * yu)[:, None]
        s = 1.0 + k1 * r2
        px = s * ux + 2 * k1 * xu[:, None] * (xu[:, None] * ux + yu[:, None] * uy)
        py = s * uy + 2 * k1 * yu[:, None] * (xu[:, None] * ux + yu[:, None] * uy)
        ux, uy = px, py
    return np.vstack([ux, uy])


def synth_flow(x, y, f, k1, A, B=0.0, C=0.0, e=0.0) -> np.ndarray:
    """(n, 2) flow of the model, for tests and simulations."""
    d = design(x, y, f, k1) @ np.array([A, B, C, e])
    n = len(x)
    return np.column_stack([d[:n], d[n:]])


@dataclass
class PairFit:
    inl: np.ndarray  # bool mask of the points kept
    n_inl: int
    sigma: float  # px, residual rms of the best grid point
    chi2: np.ndarray  # (nf, nk) SSE(f, k1) / sigma^2
    A: np.ndarray  # (nf, nk) fitted yaw constant (px per interval)
    xspread: float  # std of x of the inliers, as a share of the half width


def _lstsq(M, b):
    p, *_ = np.linalg.lstsq(M, b, rcond=None)
    return p


def ransac_inliers(x, y, flow, f0, k1, thr, rng, iters=80) -> np.ndarray:
    """Consensus set of the rotation(+expansion) model at (f0, k1): the far points. Parallax points (near objects) disagree and are rejected."""
    n = len(x)
    M = design(x, y, f0, k1)
    b = np.concatenate([flow[:, 0], flow[:, 1]])
    best, best_cost = np.zeros(n, bool), np.inf
    for _ in range(iters):
        idx = rng.choice(n, 3, replace=False)
        rows = np.concatenate([idx, idx + n])
        p = _lstsq(M[rows], b[rows])
        res = b - M @ p
        d = np.hypot(res[:n], res[n:])
        cost = np.minimum(d, thr).sum()  # truncated sum: prefers tight consensus
        if cost < best_cost:
            best_cost, best = cost, d < thr
    return best


def _trim(M, b, n, keep, floor, rounds=4):
    for _ in range(rounds):
        rows = np.concatenate([keep, keep])
        if keep.sum() < 12:
            return keep, None
        p = _lstsq(M[rows], b[rows])
        res = b - M @ p
        d = np.hypot(res[:n], res[n:])
        thr = max(floor, 2.5 * 1.4826 * float(np.median(d[keep])))
        new = d < thr
        if np.array_equal(new, keep):
            break
        keep = new
    return keep, p


def fit_pair(x, y, flow, f_grid, k_grid, f0, scale=1.0, rng=None, min_inl=40, sigma_floor=0.12) -> PairFit | None:
    """Profile of the rotation fit over the grid of (f, k1) for one tracked frame pair. All lengths in px at the analysis size; `scale` = rows / 360."""
    rng = rng or np.random.default_rng(0)
    n = len(x)
    if n < min_inl:
        return None
    b = np.concatenate([flow[:, 0], flow[:, 1]])
    keep = ransac_inliers(x, y, flow, f0, 0.0, 1.2 * scale, rng)
    M0 = design(x, y, f0, 0.0)
    keep, _ = _trim(M0, b, n, keep, 0.3 * scale)
    if keep.sum() < min_inl:
        return None
    for _pass in range(2):
        rows = np.concatenate([keep, keep])
        chi = np.empty((len(f_grid), len(k_grid)))
        Aall = np.empty_like(chi)
        for i, f in enumerate(f_grid):
            for j, k in enumerate(k_grid):
                M = design(x, y, f, k)
                p = _lstsq(M[rows], b[rows])
                r = b[rows] - M[rows] @ p
                chi[i, j] = float(r @ r)
                Aall[i, j] = p[0]
        i, j = np.unravel_index(np.argmin(chi), chi.shape)
        if _pass == 0:  # re-select the inliers at the best grid point
            M = design(x, y, f_grid[i], k_grid[j])
            new, _ = _trim(M, b, n, keep, 0.3 * scale)
            if new.sum() < min_inl:
                return None
            if np.array_equal(new, keep):
                break
            keep = new
    dof = max(1, 2 * int(keep.sum()) - NPAR)
    sigma = max(sigma_floor * scale, float(np.sqrt(chi[i, j] / dof)))
    xs = float(np.std(x[keep]) / (0.29 * 2 * np.max(np.abs(x)) + 1e-9)) if keep.sum() > 3 else 0.0
    return PairFit(keep, int(keep.sum()), sigma, chi / sigma**2, Aall, xs)


def pooled_argmin(chi2: np.ndarray, f_grid: np.ndarray, k_grid: np.ndarray, fix_k: int | None = None):
    """Minimum of a summed chi2 curve: (f, k1, index i, index j), with a parabola through the three log f points of the k1 column."""
    c = chi2 if fix_k is None else chi2[:, fix_k:fix_k + 1]
    i, j = np.unravel_index(np.argmin(c), c.shape)
    j = j if fix_k is None else fix_k
    lf = np.log(f_grid)
    f = float(f_grid[i])
    if 0 < i < len(f_grid) - 1:
        y0, y1, y2 = chi2[i - 1, j], chi2[i, j], chi2[i + 1, j]
        den = y0 - 2 * y1 + y2
        if den > 0:
            h = 0.5 * (y0 - y2) / den
            f = float(np.exp(lf[i] + h * (lf[i + 1] - lf[i - 1]) / 2))
    return f, float(k_grid[j]), int(i), int(j)
