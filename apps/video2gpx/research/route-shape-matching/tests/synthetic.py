# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synthetic trajectories, generated in code. Frame: x right, y forward; left turns are positive."""
from __future__ import annotations

import numpy as np

from rsm.core.trajectory import RelativeTrajectory


def line(length=100.0, n=201, angle=np.pi / 2) -> RelativeTrajectory:
    s = np.linspace(0, length, n)
    return RelativeTrajectory(np.column_stack([s * np.cos(angle), s * np.sin(angle)]))


def arc(radius=40.0, angle=np.pi / 2, n=400, left=True) -> RelativeTrajectory:
    """Starts at the origin heading +y; left (counter-clockwise) turn when `left`."""
    a = np.linspace(0, angle, n)
    sign = 1.0 if left else -1.0
    return RelativeTrajectory(np.column_stack([-sign * radius * (1 - np.cos(a)), radius * np.sin(a)]))


def hairpin(length=30.0, n=300, left=True) -> RelativeTrajectory:
    """180 degree turn within `length` metres of path (radius length/pi)."""
    return arc(radius=length / np.pi, angle=np.pi, n=n, left=left)


def circle(radius=30.0, n=400) -> RelativeTrajectory:
    """Closed counter-clockwise loop, start == end, heading +y at the start."""
    return arc(radius=radius, angle=2 * np.pi, n=n, left=True)


def s_curve(radius=40.0, quarter=np.pi / 3, n=300) -> RelativeTrajectory:
    """Left arc of `quarter` radians followed by a right arc of the same size: net turn 0."""
    a = arc(radius, quarter, n, left=True).points
    b = arc(radius, quarter, n, left=False).points
    h = quarter  # heading change after the first arc: rotate the second arc by it
    c, s = np.cos(h), np.sin(h)
    R = np.array([[c, -s], [s, c]])
    return RelativeTrajectory(np.vstack([a, a[-1] + b[1:] @ R.T]))


def irregular(seed=1, total=200.0) -> RelativeTrajectory:
    """Gentle S-shaped road sampled at random spacing 0.2 to 3 m."""
    rng = np.random.default_rng(seed)
    s = np.concatenate([[0.0], np.cumsum(rng.uniform(0.2, 3.0, int(total / 1.6) * 2))])
    s = s[s <= total]
    # integrate heading analytically-ish: x' = cos(ang), y' = sin(ang) along s (fine integration)
    fine = np.linspace(0, total, 40001)
    fa = 0.5 * np.sin(fine / 40.0) + np.pi / 2
    fx = np.concatenate([[0], np.cumsum(np.cos(fa[:-1]) * np.diff(fine))])
    fy = np.concatenate([[0], np.cumsum(np.sin(fa[:-1]) * np.diff(fine))])
    return RelativeTrajectory(np.column_stack([np.interp(s, fine, fx), np.interp(s, fine, fy)]))


def noisy(base: RelativeTrajectory, sigma=0.3, seed=7) -> RelativeTrajectory:
    rng = np.random.default_rng(seed)
    return RelativeTrajectory(base.points + rng.normal(0, sigma, base.points.shape))


def wiggly(seed: int, length: float = 800.0, step: float = 1.0) -> np.ndarray:
    """(N, 2) road-like path: heading is a sum of three sinusoids (wavelengths 70 to 450 m, amplitudes up to ~1.2 rad each)."""
    rng = np.random.default_rng(seed)
    s = np.arange(0.0, length + step, step)
    h = np.zeros_like(s)
    for _ in range(3):
        h += rng.uniform(0.3, 1.2) * np.sin(2 * np.pi * s / rng.uniform(70, 450) + rng.uniform(0, 2 * np.pi))
    h += rng.uniform(0, 2 * np.pi)
    d = np.column_stack([np.cos(h[:-1]), np.sin(h[:-1])]) * step
    return np.vstack([[0.0, 0.0], np.cumsum(d, axis=0)])


def move(points: np.ndarray, scale=1.0, angle=0.0, shift=(0.0, 0.0), mirror=False) -> np.ndarray:
    p = np.asarray(points, dtype=float) * (np.array([-1.0, 1.0]) if mirror else 1.0)
    c, s = np.cos(angle), np.sin(angle)
    return scale * p @ np.array([[c, -s], [s, c]]).T + np.asarray(shift)


def irregular_resample(points: np.ndarray, mean_step: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(points, axis=0).T))])
    pos = np.concatenate([[0.0], np.cumsum(mean_step * rng.uniform(0.3, 1.7, int(s[-1] / mean_step) * 4))])
    pos = np.append(pos[pos < s[-1] - 1e-9], s[-1])
    return np.column_stack([np.interp(pos, s, points[:, 0]), np.interp(pos, s, points[:, 1])])
