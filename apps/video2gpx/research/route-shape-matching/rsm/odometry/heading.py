# SPDX-License-Identifier: AGPL-3.0-or-later
"""Heading over distance and the dead-reckoned path of one segment.

Per frame pair i of a segment (unusable pairs inside it bridged by linear interpolation of yaw and s):
    omega_i = YAW_SIGN * yaw_i / f360        rad per pair, left positive (the vms constant horizontal flow a, px, over f in px)
    ds_i    = k * max(s_i, 0), k = f360 * h  nominal metres per pair (s = v dt / (f h)  =>  v dt = s f h, i.e. k * rel_speed * dt)
Arrays at the pair edges: theta_0 = 0, theta_{i+1} = theta_i + omega_i; s_0 = 0, s_{i+1} = s_i + ds_i; t at the edges.
The path starts at the origin heading +y (rsm frame: x right, y forward, left turn positive):
    x += -ds sin(theta_mid), y += ds cos(theta_mid).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .calib import CAMERA_HEIGHT_M, YAW_SIGN
from .gating import Segment
from .vms_csv import Pairs


@dataclass(frozen=True)
class SegmentTrack:
    t: np.ndarray  # (n+1) video seconds at the pair edges
    theta: np.ndarray  # (n+1) rad, left positive, 0 at the start
    s: np.ndarray  # (n+1) nominal metres
    yaw_px: np.ndarray  # (n) bridged yaw per pair, px
    bridged: np.ndarray  # (n) bool
    f360: float
    k: float


def _fill(x: np.ndarray, good: np.ndarray) -> np.ndarray:
    idx = np.arange(len(x))
    return np.interp(idx, idx[good], x[good])


def integrate(p: Pairs, seg: Segment, flags: np.ndarray, f360: float, height_m: float = CAMERA_HEIGHT_M,
              yaw_sign: float = YAW_SIGN, dist_scale: float = 1.0, c_delta_px: float = 0.0) -> SegmentTrack:
    """Defaults reproduce the original behaviour. `dist_scale` multiplies the distance factor k (calibration). `c_delta_px` adds
    c * delta to the yaw flow (post-hoc first-order horizon correction: a(h + delta) = a(h) + c * delta, see calibration.json); needs the CSV column c."""
    sl = slice(seg.i0, seg.i1)
    ok = flags[sl] == 0
    yaw = _fill(p.yaw[sl], ok)
    if c_delta_px:
        if p.c is None:
            raise ValueError("c_delta_px needs the CSV column c")
        yaw = yaw + c_delta_px * _fill(p.c[sl], ok)
    sp = np.maximum(_fill(p.s[sl], ok), 0.0)
    k = f360 * height_m * dist_scale
    omega = yaw_sign * yaw / f360
    theta = np.concatenate([[0.0], np.cumsum(omega)])
    s = np.concatenate([[0.0], np.cumsum(k * sp)])
    tm = p.time[sl]
    t = np.concatenate([tm - p.dt / 2, [tm[-1] + p.dt / 2]])
    return SegmentTrack(t, theta, s, yaw, ~ok, f360, k)


def dead_reckon(theta: np.ndarray, s: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """x, y at the edges (arrays like theta) for heading theta (rad, left positive, start heading +y)."""
    mid = 0.5 * (theta[1:] + theta[:-1])
    ds = np.diff(s)
    x = np.concatenate([[0.0], np.cumsum(-ds * np.sin(mid))])
    y = np.concatenate([[0.0], np.cumsum(ds * np.cos(mid))])
    return x, y
