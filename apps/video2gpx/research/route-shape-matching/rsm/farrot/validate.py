# SPDX-License-Identifier: AGPL-3.0-or-later
"""Yaw series against references (scoring only): GPS heading (bike videos, lag-corrected per work/vangestel) and the COLMAP optical-axis heading (Amalfi 780-960 s)."""
from __future__ import annotations

import numpy as np

from rsm.angle import refs

from . import series as S_


def heading_fn(S: S_.Series, which: str):
    t, h = S_.heading(S, which)
    return lambda x: np.interp(x, t, h)


def robust_slope(x, y):
    """slope of y on x through the origin (IRLS Huber)"""
    if len(x) < 5 or (x @ x) == 0:
        return float("nan")
    return refs.robust_slope(np.asarray(x, float), np.asarray(y, float))


def block_compare(ref_inc: np.ndarray, ser_inc: np.ndarray, turn_deg: float = 8.0, t_blocks: np.ndarray | None = None, drift_s: float = 300.0, block_s: float = 4.0) -> dict:
    """increments (rad) of the reference and of one series over the same blocks.
    slope = series per reference (through the origin), r = Pearson r of the increments, resid_deg = rms of (series / slope - ref) after the gain,
    ratio_* = quantiles of series / ref over blocks with |ref| >= turn_deg (the per-curve ratio), drift = rms / max of the gain-corrected heading error over `drift_s` windows."""
    m = np.isfinite(ref_inc) & np.isfinite(ser_inc)
    x, y = ref_inc[m], ser_inc[m]
    sl = robust_slope(x, y)
    r = float(np.corrcoef(x, y)[0, 1])
    big = np.abs(x) >= np.radians(turn_deg)
    rat = y[big] / x[big]
    out = dict(n=int(m.sum()), n_turn_blocks=int(big.sum()), slope=sl, r=r, resid_deg=float(np.degrees(np.sqrt(np.mean((y / sl - x) ** 2)))),
               resid_turn_deg=float(np.degrees(np.sqrt(np.mean((y[big] / sl - x[big]) ** 2)))) if big.any() else float("nan"))
    if len(rat) >= 5:
        q = np.percentile(rat, [10, 25, 50, 75, 90])
        out.update(ratio_p10=float(q[0]), ratio_p25=float(q[1]), ratio_median=float(q[2]), ratio_p75=float(q[3]), ratio_p90=float(q[4]), ratio_cv=float(1.4826 * np.median(np.abs(rat - np.median(rat))) / abs(np.median(rat))))
    if t_blocks is not None:
        e = np.where(m, y / sl - ref_inc, 0.0)
        ce = np.concatenate([[0.0], np.cumsum(e)])
        n = int(drift_s / block_s)
        if len(ce) > n + 1:
            dr = ce[n:] - ce[:-n]
            out.update(drift_rms_deg=float(np.degrees(np.sqrt(np.mean(dr ** 2)))), drift_p95_deg=float(np.degrees(np.percentile(np.abs(dr), 95))), drift_s=drift_s)
    return out


def gps_blocks(name_gps: str, S: S_.Series, which: str, block_s: float = 4.0, t_range=None):
    """(ref increments, series increments, t0 of the blocks) over non-overlapping blocks, GPS heading at video time t = GPS at t + lag (work/vangestel)"""
    gc = refs.gps_curve(name_gps)
    lag = refs.lag_fn(name_gps)
    h = heading_fn(S, which)
    t0s = np.arange(S.ta[0] + 10, S.tb[-1] - block_s - 10, block_s)
    if t_range is not None:
        t0s = t0s[(t0s >= t_range[0]) & (t0s + block_s <= t_range[1])]
    ta = t0s + lag(t0s + block_s / 2); tb = t0s + block_s + lag(t0s + block_s / 2)
    ref = refs.gps_theta(gc, tb) - refs.gps_theta(gc, ta)
    ser = h(t0s + block_s) - h(t0s)
    return ref, ser, t0s


def colmap_blocks(S: S_.Series, which: str, route: str = "amalfi-780", block_s: float = 2.0, t_range=(780.0, 960.0)):
    w = refs.load_windows(route)[0]
    t, psi = w.t, w.psi_rot
    h = heading_fn(S, which)
    t0s = np.arange(max(t[0], t_range[0]) + 1, min(t[-1], t_range[1]) - block_s - 1, block_s)
    ref = np.interp(t0s + block_s, t, psi) - np.interp(t0s, t, psi)
    ser = h(t0s + block_s) - h(t0s)
    return ref, ser, t0s


def colmap_curves(S: S_.Series, which: str, route: str = "amalfi-780", min_deg: float = 25.0):
    """per COLMAP turn (rsm detector on the optical-axis heading): ratio series / COLMAP over the turn's time span"""
    from rsm.odometry.turns import TurnParams, detect_turns
    w = refs.load_windows(route)[0]
    th = w.psi_rot
    turns = detect_turns(w.s, th, w.t, TurnParams(min_angle_deg=min_deg))
    h = heading_fn(S, which)
    rows = []
    for tn in turns:
        t0, t1 = tn.t_start, tn.t_end
        ref = float(np.interp(t1, w.t, th) - np.interp(t0, w.t, th))
        ser = float(h(t1) - h(t0))
        rows.append(dict(t0=float(t0), t1=float(t1), colmap_deg=float(np.degrees(ref)), series_deg=float(np.degrees(ser)), ratio_colmap_over_series=ref / ser if abs(ser) > 1e-6 else float("nan")))
    return rows


def coverage(S: S_.Series, t0s: np.ndarray, block_s: float) -> np.ndarray:
    """share of the windows of each block whose source is the far fit"""
    cs = np.concatenate([[0.0], np.cumsum(S.src == 0)])
    a = np.searchsorted(S.ta, t0s); b = np.searchsorted(S.ta, t0s + block_s)
    return (cs[b] - cs[a]) / np.maximum(b - a, 1)
