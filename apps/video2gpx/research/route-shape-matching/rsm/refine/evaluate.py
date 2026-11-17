# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scoring helpers: GPS (scoring only) projected on the fixed path, error metrics, error against distance to the nearest anchor."""
from __future__ import annotations

import numpy as np


def project(path, xy: np.ndarray, s_ref: np.ndarray, win: float = 600.0):
    """arc length of the point of the path nearest to every xy (searched within +-win m of s_ref) and the distance to it (= cross-track error)"""
    sg = path.sg
    n = len(sg)
    s = np.empty(len(xy)); d = np.empty(len(xy))
    for i in range(len(xy)):
        lo = int(np.clip(s_ref[i] - win, 0, n - 1)); hi = int(np.clip(s_ref[i] + win, lo + 1, n))
        dd = np.hypot(path.xy[lo:hi, 0] - xy[i, 0], path.xy[lo:hi, 1] - xy[i, 1])
        j = int(np.argmin(dd))
        s[i] = sg[lo + j]; d[i] = dd[j]
    return s, d


def on_correct_road(ctx, truth, tt: np.ndarray, win: float = 40.0) -> np.ndarray:
    """the edge of the decoded route at tt is on the map-matched GPS path within +-win s (the definition of rsm.track2.score)"""
    mm = truth.mm
    j = np.clip(np.searchsorted(ctx.t_step, tt), 0, len(ctx.t_step) - 1)
    out = np.zeros(len(tt), bool)
    for i in range(len(tt)):
        lo, hi = np.searchsorted(mm["t"], [tt[i] - win, tt[i] + win])
        out[i] = bool((mm["edge"][lo:hi] == ctx.step_edge[j[i]]).any())
    return out


def stats(err: np.ndarray, d2: np.ndarray) -> dict:
    n = len(err)
    if n == 0:
        return dict(n=0)
    a = np.abs(err)
    return dict(n=int(n), signed_mean=float(err.mean()), signed_median=float(np.median(err)), abs_mean=float(a.mean()), abs_median=float(np.median(a)), abs_p90=float(np.percentile(a, 90)),
                w10=float((d2 <= 10).mean()), w20=float((d2 <= 20).mean()), w30=float((d2 <= 30).mean()))


BINS = (0.0, 50.0, 150.0, 300.0, np.inf)


def by_anchor_distance(err: np.ndarray, dist: np.ndarray, bins=BINS) -> list[dict]:
    out = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (dist >= lo) & (dist < hi)
        out.append(dict(lo=float(lo), hi=float(hi), n=int(m.sum()), abs_mean=float(np.abs(err[m]).mean()) if m.any() else np.nan, abs_median=float(np.median(np.abs(err[m]))) if m.any() else np.nan,
                        signed_mean=float(err[m].mean()) if m.any() else np.nan))
    return out


def nearest_anchor_distance(s: np.ndarray, anchors) -> np.ndarray:
    if not anchors:
        return np.full(len(s), np.inf)
    a = np.array([x.s for x in anchors])
    return np.abs(s[:, None] - a[None, :]).min(1)


def project_dp(path, xy: np.ndarray, s_ref: np.ndarray, win: float = 600.0, step: float = 5.0, sigma: float = 15.0, back: float = 10.0, fwd: float = 40.0):
    """arc length of the GPS point on the path with a MONOTONE track (1 s samples): Viterbi over the 5 m arc grid within +-win of s_ref, emission = squared distance to the
    path point (sigma 15 m), transition: arc advance between consecutive samples in [-back, fwd] m (so a hairpin's neighbouring leg cannot be picked by a jump).
    -> (s, cross-track distance at s)"""
    n5 = int(path.sg[-1] // step) + 1
    grid_s = np.arange(n5) * step
    pxy = path.xy_at(grid_s)
    nb, nf = int(back // step), int(fwd // step)
    T = len(xy)
    cost = np.full(n5, np.inf)
    bp = np.zeros((T, n5), np.uint8)
    BIG = np.inf
    for i in range(T):
        lo = int(np.clip((s_ref[i] - win) // step, 0, n5 - 1)); hi = int(np.clip((s_ref[i] + win) // step + 1, lo + 1, n5))
        d = np.hypot(pxy[lo:hi, 0] - xy[i, 0], pxy[lo:hi, 1] - xy[i, 1])
        em = 0.5 * (d / sigma) ** 2
        if i == 0:
            new = np.full(n5, BIG); new[lo:hi] = em
        else:
            best = np.full(n5, BIG); arg = np.zeros(n5, np.uint8)
            for p in range(-nb, nf + 1):  # predecessor = j - p
                sh = np.full(n5, BIG)
                if p >= 0:
                    sh[p:] = cost[:n5 - p] if p > 0 else cost
                else:
                    sh[:p] = cost[-p:]
                m = sh < best
                best = np.where(m, sh, best); arg = np.where(m, np.uint8(p + nb), arg)
            new = np.full(n5, BIG); new[lo:hi] = best[lo:hi] + em
            bp[i] = arg
        cost = new
    j = int(np.argmin(cost))
    idx = np.empty(T, np.int64); idx[-1] = j
    for i in range(T - 1, 0, -1):
        j = j - (int(bp[i][j]) - nb); idx[i - 1] = j
    s = grid_s[idx]
    d = np.hypot(*(pxy[idx] - xy).T)
    return s, d


def signed_cross(path, s: np.ndarray, xy: np.ndarray) -> np.ndarray:
    """lateral offset (m) of xy from the path point at arc s: + = left of the direction of travel, - = right"""
    p = path.xy_at(s); a = path.xy_at(s - 2.0); b = path.xy_at(s + 2.0)
    t = b - a
    t = t / np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    d = xy - p
    return t[:, 0] * d[:, 1] - t[:, 1] * d[:, 0]
