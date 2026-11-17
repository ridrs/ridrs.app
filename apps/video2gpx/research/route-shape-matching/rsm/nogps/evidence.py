# SPDX-License-Identifier: AGPL-3.0-or-later
"""Video-only evidence (no route involved): dark intervals (tunnel candidates) from the mean luminance at 2 fps.

A-PRIORI RULE (written before any route was looked at): a frame is dark when its mean grey level (8-bit, tv range, 64 x 36 area-downscaled) is below
DARK_REL x the median of the whole video; a dark interval is a run of dark frames lasting at least MIN_S seconds, runs closer than MERGE_S are merged.
Each interval is later confirmed (or rejected) by looking at frames, not at the map.
"""
from __future__ import annotations

import numpy as np

FPS = 2.0
DARK_REL = 0.5
MIN_S = 2.0
MERGE_S = 1.5


def load_lum(path) -> np.ndarray:
    n = path.stat().st_size // 2304
    a = np.fromfile(path, np.uint8, count=n * 2304).reshape(n, 36, 64).astype(float)
    return a


def dark_intervals(a: np.ndarray, rel=DARK_REL, min_s=MIN_S, merge_s=MERGE_S):
    m = a.mean((1, 2))
    thr = rel * float(np.median(m))
    d = m < thr
    idx = np.flatnonzero(d)
    runs = []
    for i in idx:
        if runs and i - runs[-1][1] <= merge_s * FPS:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    out = []
    for a0, b0 in runs:
        dur = (b0 - a0 + 1) / FPS
        if dur >= min_s:
            out.append(dict(t0=a0 / FPS, t1=(b0 + 1) / FPS, dur=dur, min_lum=float(m[a0:b0 + 1].min())))
    return out, thr, float(np.median(m))
