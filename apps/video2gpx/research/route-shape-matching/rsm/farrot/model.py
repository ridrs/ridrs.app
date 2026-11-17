# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fit of the rotation (A yaw, B pitch, C roll, e expansion) of one tracked window at a FIXED focal length (numpy only). Uses rsm.angle.rotflow unchanged.

Units: px at 360 rows per window (a window = k frames). Sign convention of rsm.angle: A > 0 is a left turn of the camera (scene moves right); A / f = heading increment
(rad, left positive). B / f = pitch up increment, C / f = roll increment (clockwise seen from behind = lean to the right).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from rsm.angle import rotflow

NAN = float("nan")


@dataclass
class WindowFit:
    ok: bool
    A: float = NAN
    B: float = NAN
    C: float = NAN
    e: float = NAN
    sA: float = NAN         # 1-sigma of A (px), from the residual rms and the covariance of the fit, inflated for correlated tracking error
    sB: float = NAN
    sC: float = NAN
    corrAC: float = NAN
    sigma: float = NAN      # residual rms (px)
    n_pts: int = 0
    n_inl: int = 0
    xspread: float = NAN
    why: str = ""


def fit_window(x, y, flow, f: float, scale: float = 1.0, rng=None, min_inl: int = 30, min_xspread: float = 0.30, sigma_floor: float = 0.10,
               infl: float = 2.0, thr0: float = 1.2) -> WindowFit:
    """Robust (RANSAC + trimmed least squares) fit of [A, B, C, e] to the tracked flow of one window. x, y: px from the principal point, flow: (n, 2) px.
    Parallax / near features disagree with the common model and are trimmed."""
    rng = rng or np.random.default_rng(0)
    n = len(x)
    if n < min_inl:
        return WindowFit(False, n_pts=n, why="few corners")
    b = np.concatenate([flow[:, 0], flow[:, 1]])
    M = rotflow.design(x, y, f, 0.0)
    keep = rotflow.ransac_inliers(x, y, flow, f, 0.0, thr0 * scale, rng)
    keep, p = rotflow._trim(M, b, n, keep, 0.3 * scale)
    if p is None or keep.sum() < min_inl:
        return WindowFit(False, n_pts=n, n_inl=int(keep.sum()), why="few inliers")
    rows = np.concatenate([keep, keep])
    Mk = M[rows]
    r = b[rows] - Mk @ p
    dof = max(1, len(r) - rotflow.NPAR)
    sigma = max(sigma_floor * scale, float(np.sqrt(r @ r / dof)))
    cov = np.linalg.inv(Mk.T @ Mk) * sigma ** 2 * infl ** 2
    xs = float(np.std(x[keep]) / (0.29 * 2 * np.max(np.abs(x)) + 1e-9))
    if xs < min_xspread:
        return WindowFit(False, n_pts=n, n_inl=int(keep.sum()), xspread=xs, why="narrow")
    return WindowFit(True, float(p[0]), float(p[1]), float(p[2]), float(p[3]), float(np.sqrt(cov[0, 0])), float(np.sqrt(cov[1, 1])), float(np.sqrt(cov[2, 2])),
                     float(cov[0, 2] / np.sqrt(cov[0, 0] * cov[2, 2])), sigma, n, int(keep.sum()), xs)
