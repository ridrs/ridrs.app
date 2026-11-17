# SPDX-License-Identifier: AGPL-3.0-or-later
"""RelativeTrajectory: a 2D path in an arbitrary local metric frame, and pure operations on it.

Conventions
-----------
- Frame: x right, y forward, metres, right-handed (counter-clockwise is positive, as on a map).
- Heading: angle of the direction of travel, atan2(dy, dx), radians, measured counter-clockwise
  from +x. Travelling along +y is pi/2.
- Turning angle: unwrapped heading minus the heading at the start. LEFT turns are POSITIVE,
  right turns negative. A mirrored trajectory has the opposite sign.
- Arc length / "distance" is the length of the polyline through the points.

Every operation is pure and deterministic and returns a new trajectory; arrays are read-only.
No silent fixes: invalid input raises ValueError. The metadata dict is copied on construction
but is a plain dict (shallow immutability only).
"""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np
from scipy.ndimage import gaussian_filter1d


@dataclass(frozen=True)
class ScalePrior:
    """Prior on the true scale of the trajectory (true metres = scale * trajectory metres)."""

    known: bool = False
    min: float = 0.7
    max: float = 1.4

    def __post_init__(self) -> None:
        for name in ("min", "max"):
            v = getattr(self, name)
            if not (isinstance(v, (int, float)) and math.isfinite(v) and v > 0):
                raise ValueError(f"scale prior {name} must be a finite positive number, got {v!r}")
        if self.max < self.min:
            raise ValueError(f"scale prior max {self.max} < min {self.min}")
        if not isinstance(self.known, bool):
            raise ValueError(f"scale prior 'known' must be a bool, got {self.known!r}")


@dataclass(frozen=True)
class Transform:
    """Similarity transform used by `RelativeTrajectory.normalized`: p' = scale * R(angle) (p - origin).

    `angle` is the counter-clockwise rotation in radians. z and uncertainty are multiplied by
    `scale` (z is not translated).
    """

    origin: tuple[float, float]
    angle: float
    scale: float = 1.0

    def _rot(self) -> np.ndarray:
        c, s = math.cos(self.angle), math.sin(self.angle)
        return np.array([[c, -s], [s, c]])

    def apply(self, points: np.ndarray) -> np.ndarray:
        p = np.asarray(points, dtype=np.float64)
        return self.scale * ((p - np.asarray(self.origin)) @ self._rot().T)

    def invert(self, points: np.ndarray) -> np.ndarray:
        p = np.asarray(points, dtype=np.float64)
        return (p / self.scale) @ self._rot() + np.asarray(self.origin)

    def apply_to(self, traj: "RelativeTrajectory") -> "RelativeTrajectory":
        return traj._derive(
            self.apply(traj.points),
            None if traj.z is None else traj.z * self.scale,
            traj.t,
            None if traj.uncertainty is None else traj.uncertainty * self.scale,
            junctions=tuple(j * self.scale for j in traj.junctions),
        )

    def invert_trajectory(self, traj: "RelativeTrajectory") -> "RelativeTrajectory":
        return traj._derive(
            self.invert(traj.points),
            None if traj.z is None else traj.z / self.scale,
            traj.t,
            None if traj.uncertainty is None else traj.uncertainty / self.scale,
            junctions=tuple(j / self.scale for j in traj.junctions),
        )


def _ro(a: np.ndarray | None) -> np.ndarray | None:
    if a is None:
        return None
    a = np.array(a, dtype=np.float64, copy=True)
    a.setflags(write=False)
    return a


@dataclass(frozen=True, eq=False)
class RelativeTrajectory:
    """Immutable relative trajectory. See the module docstring for the conventions.

    points: (N, 2) float64 metres. z, t, uncertainty: optional (N,) arrays (height in metres,
    seconds non-decreasing, 1-sigma position uncertainty in metres). junctions: arc-length
    positions in metres of observed side roads (unused so far). `cumulative_distance` is derived
    from `points`, never stored.
    """

    points: np.ndarray
    z: np.ndarray | None = None
    t: np.ndarray | None = None
    uncertainty: np.ndarray | None = None
    scale: ScalePrior = field(default_factory=ScalePrior)
    direction_known: bool = True
    junctions: tuple[float, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        pts = np.asarray(self.points, dtype=np.float64)
        if pts.ndim != 2 or pts.shape[1] != 2:
            raise ValueError(f"points must have shape (N, 2), got {pts.shape}")
        n = len(pts)
        if n < 2:
            raise ValueError(f"need at least 2 points, got {n}")
        if not np.all(np.isfinite(pts)):
            raise ValueError("points contain NaN or infinite values")
        if not np.any(np.any(pts != pts[0], axis=1)):
            raise ValueError("all points are identical: need at least 2 distinct points")
        arrays = {}
        for name in ("z", "t", "uncertainty"):
            v = getattr(self, name)
            if v is None:
                arrays[name] = None
                continue
            a = np.asarray(v, dtype=np.float64)
            if a.shape != (n,):
                raise ValueError(f"{name} must have shape ({n},) to match points, got {a.shape}")
            if not np.all(np.isfinite(a)):
                raise ValueError(f"{name} contains NaN or infinite values")
            arrays[name] = a
        if arrays["t"] is not None and np.any(np.diff(arrays["t"]) < 0):
            raise ValueError("t must be non-decreasing")
        if arrays["uncertainty"] is not None and np.any(arrays["uncertainty"] < 0):
            raise ValueError("uncertainty must be non-negative")
        if not isinstance(self.scale, ScalePrior):
            raise ValueError("scale must be a ScalePrior")
        if not isinstance(self.direction_known, bool):
            raise ValueError("direction_known must be a bool")
        length = float(np.hypot(*np.diff(pts, axis=0).T).sum())
        junctions = tuple(float(j) for j in self.junctions)
        for j in junctions:
            if not math.isfinite(j) or j < 0 or j > length * (1 + 1e-9) + 1e-9:
                raise ValueError(f"junction position {j} outside [0, length={length}]")
        object.__setattr__(self, "points", _ro(pts))
        for name, a in arrays.items():
            object.__setattr__(self, name, _ro(a))
        object.__setattr__(self, "junctions", junctions)
        if not isinstance(self.metadata, dict):
            raise ValueError("metadata must be a dict")
        object.__setattr__(self, "metadata", copy.deepcopy(self.metadata))

    # -- derived -----------------------------------------------------------------------------

    def __len__(self) -> int:
        return len(self.points)

    @property
    def cumulative_distance(self) -> np.ndarray:
        """(N,) arc length at each point, starting at 0. Derived from `points` on every call."""
        d = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(self.points, axis=0).T))])
        d.setflags(write=False)
        return d

    @property
    def length(self) -> float:
        return float(self.cumulative_distance[-1])

    @property
    def warnings(self) -> list[str]:
        return list(self.metadata.get("warnings", []))

    def equals(self, other: "RelativeTrajectory") -> bool:
        """Exact (bitwise float) equality of all fields."""

        def same(a, b):
            return (a is None and b is None) or (a is not None and b is not None and np.array_equal(a, b))

        return (
            same(self.points, other.points) and same(self.z, other.z) and same(self.t, other.t)
            and same(self.uncertainty, other.uncertainty) and self.scale == other.scale
            and self.direction_known == other.direction_known and self.junctions == other.junctions
            and self.metadata == other.metadata
        )

    def _derive(self, points, z, t, uncertainty, junctions=None):
        """New trajectory sharing scale, direction and metadata. Junctions are clipped to the new
        length (arc-length positions are kept, not rescaled) unless `junctions` is given."""
        if junctions is None:
            junctions = self.junctions
        new_len = float(np.hypot(*np.diff(np.asarray(points), axis=0).T).sum())
        junctions = tuple(min(j, new_len) for j in junctions)
        return replace(self, points=points, z=z, t=t, uncertainty=uncertainty, junctions=junctions)

    # -- sampling ----------------------------------------------------------------------------

    def _interp(self, s_new: np.ndarray, a: np.ndarray) -> np.ndarray:
        s = self.cumulative_distance
        keep = np.concatenate([[True], np.diff(s) > 0])  # zero-length steps would make interp ambiguous
        if a.ndim == 1:
            return np.interp(s_new, s[keep], a[keep])
        return np.column_stack([np.interp(s_new, s[keep], a[keep, j]) for j in range(a.shape[1])])

    def point_at(self, s: float) -> np.ndarray:
        """(2,) position at arc length `s` (clamped to [0, length])."""
        return self._interp(np.array([min(max(s, 0.0), self.length)]), self.points)[0]

    def _at(self, s_new: np.ndarray) -> "RelativeTrajectory":
        """Linear interpolation of every channel at arc-length positions `s_new` (inside [0, length])."""
        opt = lambda a: None if a is None else self._interp(s_new, a)
        return self._derive(self._interp(s_new, self.points), opt(self.z), opt(self.t), opt(self.uncertainty))

    def resample_by_distance(self, step: float) -> "RelativeTrajectory":
        """Points every `step` metres along the arc length, linear interpolation of all channels.

        The first and last points are always included. The final interval is the remainder; if the
        remainder is shorter than step/4 the last regular sample is dropped instead, so spacing is
        in [step/4, 1.25 step] at the end and exactly `step` elsewhere (up to float rounding).
        Non-uniform and duplicate input points are handled (zero-length steps are ignored).
        """
        if not (math.isfinite(step) and step > 0):
            raise ValueError(f"step must be positive, got {step}")
        length = self.length
        s_new = np.arange(0.0, length - 1e-9, step)
        if len(s_new) > 1 and length - s_new[-1] < 0.25 * step:
            s_new = s_new[:-1]
        s_new = np.append(s_new, length)
        return self._at(s_new)

    def resample_n(self, n: int) -> "RelativeTrajectory":
        """Exactly `n` points equally spaced in arc length, endpoints included."""
        if int(n) != n or n < 2:
            raise ValueError(f"n must be an integer >= 2, got {n}")
        return self._at(np.linspace(0.0, self.length, int(n)))

    def dedup(self, min_step: float) -> "RelativeTrajectory":
        """Drop consecutive points closer than `min_step` to the last kept point.

        The first point is always kept. The last original point is always kept: if it is closer
        than `min_step` to the last kept point, it replaces that point. Raises (no silent fix) if
        the result is degenerate (all points identical).
        """
        if not (math.isfinite(min_step) and min_step >= 0):
            raise ValueError(f"min_step must be >= 0, got {min_step}")
        p = self.points
        kept = [0]
        for i in range(1, len(p) - 1):
            if np.hypot(*(p[i] - p[kept[-1]])) >= min_step and (min_step > 0 or np.any(p[i] != p[kept[-1]])):
                kept.append(i)
        last = len(p) - 1
        if np.hypot(*(p[last] - p[kept[-1]])) >= min_step and (min_step > 0 or np.any(p[last] != p[kept[-1]])):
            kept.append(last)
        elif len(kept) > 1:
            kept[-1] = last
        else:
            kept.append(last)
        idx = np.array(kept)
        sub = lambda a: None if a is None else a[idx]
        return self._derive(p[idx], sub(self.z), sub(self.t), sub(self.uncertainty))

    def smooth(self, sigma_m: float, step: float | None = None) -> "RelativeTrajectory":
        """Gaussian smoothing in arc-length space.

        Method: resample at `step` metres (default sigma_m/4, at most 1 m), pad both ends by odd
        reflection about the end point (this keeps a straight line exactly straight and pins the
        end points exactly), filter x, y and z with a Gaussian of sigma_m/step samples, crop.
        t and uncertainty are only resampled. The result has the resampled spacing.

        Shrinkage: filtering a curve of constant radius R in arc length reduces R by about
        exp(-sigma^2 / (2 R^2)) (measured: 0.9988 for sigma 2 m, R 40 m; 0.995 for sigma 4 m, R 40 m; 0.916 for sigma 4 m, R 9.5 m),
        and the total length shrinks by the same factor. Close to the ends the odd reflection
        continues the curve as an S, which biases the first and last ~sigma metres slightly toward
        straighter than the data.
        """
        if not (math.isfinite(sigma_m) and sigma_m > 0):
            raise ValueError(f"sigma_m must be positive, got {sigma_m}")
        step = min(1.0, sigma_m / 4) if step is None else step
        base = self.resample_by_distance(step)
        sigma = sigma_m / step
        pad = int(4.0 * sigma + 0.5) + 1

        def filt(a):
            if a is None:
                return None
            padded = np.pad(a, [(pad, pad)] + [(0, 0)] * (a.ndim - 1), mode="reflect", reflect_type="odd")
            return gaussian_filter1d(padded, sigma, axis=0, mode="nearest", truncate=4.0)[pad:-pad]

        return base._derive(filt(base.points), filt(base.z), base.t, base.uncertainty)

    def mirrored(self) -> "RelativeTrajectory":
        """Reflect x -> -x (swaps left and right)."""
        return self._derive(self.points * np.array([-1.0, 1.0]), self.z, self.t, self.uncertainty)

    # -- normalisation -----------------------------------------------------------------------

    def normalized(self, heading_window_m: float = 5.0, unit_length: bool = False) -> tuple["RelativeTrajectory", Transform]:
        """Translate the start to the origin and rotate the initial heading to +y.

        The initial heading is the direction from the start to the point `heading_window_m` metres
        along the path (the whole path if shorter), not the first segment, so GPS-like jitter in
        the first points does not dominate. With `unit_length` the path length is scaled to 1 (z
        and uncertainty are scaled too). Returns (trajectory, transform); `transform.invert_trajectory`
        recovers the input up to float rounding.
        """
        if not (math.isfinite(heading_window_m) and heading_window_m > 0):
            raise ValueError(f"heading_window_m must be positive, got {heading_window_m}")
        k = min(heading_window_m, self.length)
        q = self.point_at(k)
        v = q - self.points[0]
        if np.hypot(*v) < 1e-9:
            raise ValueError("path returns to its start within the heading window: initial heading undefined")
        angle = math.pi / 2 - math.atan2(v[1], v[0])
        tf = Transform(origin=(float(self.points[0, 0]), float(self.points[0, 1])), angle=angle,
                       scale=1.0 / self.length if unit_length else 1.0)
        return tf.apply_to(self), tf

    # -- signatures --------------------------------------------------------------------------

    def heading(self, step: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
        """(s, heading): arc-length positions and unwrapped heading (radians) at the points of the
        trajectory resampled every `step` metres.

        Segment headings are unwrapped; the heading at an interior point is the mean of its two
        neighbouring segment headings, and at the ends it is extrapolated linearly from the first
        or last two segments (exact for a circular arc). Noisy input should be `smooth`ed first.
        """
        r = self.resample_by_distance(step)
        d = np.diff(r.points, axis=0)
        h = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
        if len(h) == 1:
            ph = np.array([h[0], h[0]])
        else:
            ph = np.empty(len(h) + 1)
            ph[1:-1] = 0.5 * (h[:-1] + h[1:])
            ph[0] = 1.5 * h[0] - 0.5 * h[1]
            ph[-1] = 1.5 * h[-1] - 0.5 * h[-2]
        return r.cumulative_distance, ph

    def turning_angle(self, step: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
        """(s, turning): unwrapped heading minus the starting heading, radians. Left is positive."""
        s, h = self.heading(step)
        return s, h - h[0]

    def total_turn(self, step: float = 1.0) -> float:
        """Net turning angle from start to end in radians (left positive)."""
        return float(self.turning_angle(step)[1][-1])
