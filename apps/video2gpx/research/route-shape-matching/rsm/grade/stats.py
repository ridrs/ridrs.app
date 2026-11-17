# SPDX-License-Identifier: AGPL-3.0-or-later
"""Spearman correlation, circular-shift null, class split, random-profile discrimination."""
from __future__ import annotations

import numpy as np
from scipy.stats import rankdata


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < 10:
        return np.nan
    ra, rb = rankdata(a[m]), rankdata(b[m])
    ra -= ra.mean(); rb -= rb.mean()
    d = np.sqrt((ra * ra).sum() * (rb * rb).sum())
    return float((ra * rb).sum() / d) if d > 0 else np.nan


def shift_null(g: np.ndarray, lv: np.ndarray, grid_m: float, min_shift_m: float = 2000.0, n_max: int = 2000) -> np.ndarray:
    """Spearman r of the gradient against the log-speed series circularly shifted by >= min_shift_m (both directions), all shifts (thinned to n_max)"""
    n = len(lv)
    k0 = int(np.ceil(min_shift_m / grid_m))
    ks = np.arange(k0, n - k0 + 1)
    if len(ks) > n_max:
        ks = ks[np.linspace(0, len(ks) - 1, n_max).astype(int)]
    return np.array([spearman(g, np.roll(lv, k)) for k in ks])


def curve(g: np.ndarray, lv: np.ndarray, grid_m: float, max_shift_m: float, step_m: float | None = None):
    """r against (non-circular) shift in metres; positive shift = speed series moved forward along the route"""
    step = int(round((step_m or grid_m) / grid_m))
    K = int(max_shift_m / grid_m)
    ks = np.arange(-K, K + 1, step)
    out = []
    for k in ks:
        if k >= 0:
            a, b = g[k:], lv[:len(lv) - k] if k else lv
        else:
            a, b = g[:k], lv[-k:]
        out.append(spearman(a[:len(b)], b[:len(a)]))
    return ks * grid_m, np.array(out)


def classes(g: np.ndarray, lv: np.ndarray, lo: float = -0.02, hi: float = 0.02) -> dict:
    out = {}
    for name, m in (("climb", g > hi), ("flat", np.abs(g) <= hi), ("descent", g < lo)):
        out[name] = dict(n=int((m & np.isfinite(lv)).sum()), r=spearman(g[m], lv[m]), median_lv=float(np.nanmedian(lv[m])) if (m & np.isfinite(lv)).any() else np.nan)
    return out


def discrimination(profiles: dict, lv_true: dict, stretch_m: float, grid_m: float, n_rand: int = 50, seed: int = 0, min_sep_m: float = 1000.0) -> dict:
    """For every stretch of the true route (non overlapping, `stretch_m` long): Spearman r of its log speed against the gradient of the true stretch and of
    n_rand random equal-length stretches of the gradient profiles of ALL tracks (the three GPX tracks), excluding stretches that overlap the true stretch of the
    same track (+- min_sep_m). Rank of the true r (most negative = 1) among n_rand + 1. profiles: video -> gradient array; lv_true: video -> log speed array (same grid)."""
    rng = np.random.default_rng(seed)
    n = int(stretch_m / grid_m)
    out = {}
    for vid, g in profiles.items():
        lv = lv_true[vid]
        ranks, rs = [], []
        for a in range(0, len(g) - n + 1, n):
            x = lv[a:a + n]
            if np.isfinite(x).mean() < 0.8:
                continue
            r_true = spearman(g[a:a + n], x)
            if not np.isfinite(r_true):
                continue
            cand = []
            for v2, g2 in profiles.items():
                for b in range(0, len(g2) - n + 1, max(n // 4, 1)):
                    if v2 == vid and abs(b - a) * grid_m < stretch_m + min_sep_m:
                        continue
                    cand.append((v2, b))
            pick = rng.choice(len(cand), n_rand, replace=False)
            rr = np.array([spearman(profiles[cand[i][0]][cand[i][1]:cand[i][1] + n], x) for i in pick])
            rr = rr[np.isfinite(rr)]
            ranks.append(1 + int((rr <= r_true).sum() - 0))  # ties against the true one
            rs.append(r_true)
        out[vid] = dict(n_stretches=len(ranks), ranks=ranks, r_true=rs, share_rank1=float(np.mean(np.array(ranks) == 1)) if ranks else np.nan,
                        share_top5=float(np.mean(np.array(ranks) <= 5)) if ranks else np.nan, median_rank=float(np.median(ranks)) if ranks else np.nan)
    return out
