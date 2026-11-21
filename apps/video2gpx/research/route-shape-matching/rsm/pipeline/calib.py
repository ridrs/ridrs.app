# SPDX-License-Identifier: AGPL-3.0-or-later
"""Calibration candidates of the route search: which cells of the f_eff x kappa scan are physically possible, and which peaks of the surface are worth a decode.

Why: the scan surface can have two maxima. On the Madone video without hints the global one is a corner of the extended grid (f_eff 150, kappa 6.6) whose decode
would mean 110 km/h and 9 m/s2 of lateral acceleration on a mountain road; the true calibration is an interior local maximum 15 nats/km lower with a posterior of
0.94 (FINDINGS "Calibration candidates"). Speed and lateral acceleration need no map: the tracks store the heading at the reference focal length and the nominal
distance, so speed scales with kappa and the yaw rate with F_REF / f_eff.

Pure functions, no I/O. The limits are PROVISIONAL (config.CAL_*)."""
from __future__ import annotations

import numpy as np

from . import config as C


def motion_stats(tracks, win: int = 5) -> dict:
    """speed and lateral acceleration of the video at the reference calibration (f_eff = F_REF, kappa = 1), over windows of `win` samples of the 4 m track grid:
    v99 = 99th percentile of the speed (m/s), alat95 = 95th percentile of |yaw rate x speed| (m/s2), n = number of windows"""
    v, a = [], []
    for k in tracks:
        t, s, th = (np.asarray(k[x], float) for x in ("t", "s", "th"))
        if len(t) <= win:
            continue
        dt = np.maximum(t[win:] - t[:-win], 1e-3)
        sp = (s[win:] - s[:-win]) / dt
        v.append(sp)
        a.append(np.abs((th[win:] - th[:-win]) / dt) * sp)
    if not v:
        return dict(v99=float("nan"), alat95=float("nan"), n=0)
    v, a = np.concatenate(v), np.concatenate(a)
    return dict(v99=float(np.percentile(v, 99)), alat95=float(np.percentile(a, 95)), n=int(len(v)))


def at(stats: dict, f: float, kappa: float) -> dict:
    """the motion statistics at the calibration (f, kappa): speed x kappa, lateral acceleration x kappa x F_REF / f"""
    return dict(v99=stats["v99"] * kappa, alat95=stats["alat95"] * kappa * C.F_REF / f)


def plausible(stats: dict, f: float, kappa: float, alat_max: float | None = None, vmax: float | None = None) -> bool:
    """False if the video would need more lateral acceleration (95th percentile) or speed (99th percentile) at this calibration than a road vehicle has.
    Without usable statistics every cell is plausible."""
    if not stats or not stats.get("n") or not np.isfinite(stats["alat95"]):
        return True
    m = at(stats, f, kappa)
    return bool(m["alat95"] <= (C.CAL_ALAT_MAX if alat_max is None else alat_max) and m["v99"] <= (C.CAL_VMAX if vmax is None else vmax))


def vmax_for(vehicle: str | None) -> float:
    """F2: the speed limit of the plausibility check for the effective vehicle (estimate or explicit profile): C.CAL_VMAX_BIKE for a bike, C.CAL_VMAX otherwise"""
    return C.CAL_VMAX_BIKE if vehicle == "bike" else C.CAL_VMAX


def horizon_mode(vehicle: str | None) -> str:
    """the horizon of the road-flow fit for this vehicle: "running" (A24) for a motor vehicle, "fixed" (the calibrated row) for a bike (C.HZ_RUNNING_VEHICLES)"""
    return "running" if vehicle in C.HZ_RUNNING_VEHICLES else "fixed"


def plausible_mask(stats: dict, fg, kg, vmax: float | None = None) -> np.ndarray:
    """bool (len fg, len kg). If no cell is plausible the mask is all True (nothing is excluded; the caller reports it)."""
    M = np.array([[plausible(stats, f, k, vmax=vmax) for k in kg] for f in fg], bool)
    return M if M.any() else np.ones_like(M)


def is_peak(S: np.ndarray, fi: int, ki: int) -> bool:
    """the cell is not lower than any of its 4 neighbours on the full surface (NaN neighbours do not count)"""
    v = S[fi, ki]
    for a, b in ((fi - 1, ki), (fi + 1, ki), (fi, ki - 1), (fi, ki + 1)):
        if 0 <= a < S.shape[0] and 0 <= b < S.shape[1] and np.isfinite(S[a, b]) and S[a, b] > v:
            return False
    return bool(np.isfinite(v))


def best_cell(S: np.ndarray, mask: np.ndarray | None = None) -> tuple[int, int]:
    """the best finite cell among the masked ones (the global maximum without a mask)"""
    A = np.where(mask, S, np.nan) if mask is not None else S
    if not np.isfinite(A).any():
        A = S
    fi, ki = np.unravel_index(np.nanargmax(A), A.shape)
    return int(fi), int(ki)


def candidates(S: np.ndarray, mask: np.ndarray | None = None, n: int | None = None) -> list[tuple[int, int]]:
    """calibration candidates, best first: the best plausible cell (the primary; today's choice when it is the global maximum), then the other plausible cells that
    are local maxima of the full surface, by score; at most n. Two candidates are never 4-neighbours."""
    n = C.CAL_N_CAND if n is None else n
    mask = np.ones(S.shape, bool) if mask is None else mask
    first = best_cell(S, mask)
    peaks = [(int(a), int(b)) for a, b in zip(*np.nonzero(mask & np.isfinite(S))) if (a, b) != first and is_peak(S, a, b)]
    peaks.sort(key=lambda c: -S[c])
    out = [first]
    for c in peaks:
        if len(out) >= n:
            break
        if all(abs(c[0] - o[0]) + abs(c[1] - o[1]) > 1 for o in out):
            out.append(c)
    return out


def surface_at(S: np.ndarray, km: float, fg, kg, fi: int, ki: int) -> dict:
    """the description of the surface around the cell (fi, ki), in the format of steps_b.surface. `interior` needs a cell inside the grid on that axis AND a local
    maximum of the full surface: the best plausible cell next to a higher implausible one is at an edge (of the plausible region), not a peak.
    For the global maximum this is exactly steps_b.surface."""
    A = S / km
    nb = [A[a, b] for a, b in ((fi - 1, ki), (fi + 1, ki), (fi, ki - 1), (fi, ki + 1)) if 0 <= a < A.shape[0] and 0 <= b < A.shape[1]]
    pk = is_peak(S, fi, ki)
    return dict(best=float(A[fi, ki]), fi=int(fi), ki=int(ki), f=fg[fi], kappa=kg[ki], interior_f=bool(0 < fi < A.shape[0] - 1 and pk), interior_kappa=bool(0 < ki < A.shape[1] - 1 and pk),
                neighbour_mean=float(np.mean(nb)), median_all=float(np.nanmedian(A)), best_minus_median=float(A[fi, ki] - np.nanmedian(A)))


def choose(cands: list[dict]) -> int:
    """index of the candidate to use. Each: dict(rank = verdict rank 0..2, interior = bool, plausible = bool, score_per_km). The primary (index 0) stays unless another
    candidate has a strictly better (verdict rank, plausible, interior peak); among those the highest score wins. A higher score alone never replaces the primary."""
    key = lambda c: (int(c["rank"]), bool(c.get("plausible", True)), bool(c["interior"]))
    best = 0
    for i, c in enumerate(cands[1:], 1):
        if key(c) > key(cands[best]) or (best != 0 and key(c) == key(cands[best]) and c["score_per_km"] > cands[best]["score_per_km"]):
            best = i
    return best
