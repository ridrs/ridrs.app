# SPDX-License-Identifier: AGPL-3.0-or-later
"""Array-level polyline helpers shared by the metrics and the matcher (numpy only).

`RelativeTrajectory.resample_n` is the object-level equivalent; these work on bare (N, 2) arrays
and are vectorised, because the matcher calls them tens of thousands of times per query.
Conventions as in `trajectory`: x right, y forward, heading = atan2(dy, dx), left turns positive.
"""
from __future__ import annotations

import numpy as np


def as_points(a, name: str = "points", min_points: int = 2) -> np.ndarray:
    """Validate and return a float64 (N, 2) array (N >= min_points, finite). Raises ValueError."""
    p = np.asarray(a, dtype=np.float64)
    if p.ndim != 2 or p.shape[1] != 2:
        raise ValueError(f"{name} must have shape (N, 2), got {p.shape}")
    if len(p) < min_points:
        raise ValueError(f"{name} needs at least {min_points} points, got {len(p)}")
    if not np.all(np.isfinite(p)):
        raise ValueError(f"{name} contains NaN or infinite values")
    return p


def cumulative_length(p: np.ndarray) -> np.ndarray:
    """(N,) arc length at each point, starting at 0."""
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])


def interp_at(p: np.ndarray, s: np.ndarray, s_query: np.ndarray) -> np.ndarray:
    """Positions on the polyline `p` (cumulative arc length `s`) at arc lengths `s_query` (any shape).

    Linear interpolation, query values are clamped to [0, s[-1]]. Zero-length steps are ignored.
    Returns an array of shape s_query.shape + (2,).
    """
    keep = np.concatenate([[True], np.diff(s) > 0])
    sk = s[keep]
    q = np.asarray(s_query, dtype=np.float64)
    flat = q.ravel()
    x = np.interp(flat, sk, p[keep, 0])
    y = np.interp(flat, sk, p[keep, 1])
    return np.stack([x, y], axis=-1).reshape(q.shape + (2,))


def resample_arclength(p: np.ndarray, n: int) -> np.ndarray:
    """`n` points equally spaced in arc length, end points included. Raises on a zero-length polyline."""
    if int(n) != n or n < 2:
        raise ValueError(f"n must be an integer >= 2, got {n}")
    s = cumulative_length(p)
    if s[-1] <= 0:
        raise ValueError("polyline has zero length")
    return interp_at(p, s, np.linspace(0.0, s[-1], int(n)))


def headings(p: np.ndarray) -> np.ndarray:
    """Unwrapped segment headings, radians, shape p.shape[:-2] + (N-1,). Works on stacked polylines (..., N, 2)."""
    d = np.diff(p, axis=-2)
    return np.unwrap(np.arctan2(d[..., 1], d[..., 0]), axis=-1)
