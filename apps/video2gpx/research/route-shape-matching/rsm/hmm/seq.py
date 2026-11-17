# SPDX-License-Identifier: AGPL-3.0-or-later
"""Video side of the HMM: heading/distance tracks (rsm.plaus.data tracks {t, s, th}) -> a sequence of steps of fixed NOMINAL distance d0.

Why fixed distance and not fixed time: the heading increment and the advance prior are then compared over the same stretch of road, a standstill
costs nothing (it has no steps; its heading is unreliable anyway), the number of steps is length / d0 (memory = cells x steps is set by the route length,
not by how long the rider waited), and one step is about one cell, so the advance is 0..3 cells. Time is kept per step for scoring and posteriors.

Steps of a segment: s = d0, 2 d0, ... ; dth = th(s_j) - th(s_{j-1}) (heading smoothed by a further `smooth_m`), mu = d0 (nominal metres), t = video time at s_j.
A vms gap between segments: n_g = round(gap nominal metres / d0) sub-steps, mu = gnom / n_g, wider advance window (rel = gap_rel sqrt(n_g)); no emission unless
`gap_dth(t0, t1)` gives a heading increment for the sub-step's time span (far features across a vms speed gap, rsm.pipeline.tracks.FarHeading; NaN = none).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter


@dataclass
class Steps:
    t: np.ndarray       # (T,) video time at the END of the step; element 0 = start state
    dth: np.ndarray     # (T,) raw heading increment rad (NaN: no emission, also element 0)
    mu: np.ndarray      # (T,) nominal metres of the step
    rel: np.ndarray     # (T,) relative sd of the advance (extra for gaps)
    v: np.ndarray       # (T,) local nominal speed m/s
    gap: np.ndarray     # (T,) bool
    seg: np.ndarray     # (T,) segment index (gap steps: the segment before)
    d0: float

    @property
    def T(self) -> int:
        return len(self.t)

    @property
    def km(self) -> float:
        return float(self.mu[1:].sum() / 1000)

    def copy(self, **kw) -> "Steps":
        d = {k: getattr(self, k) for k in self.__dataclass_fields__}
        d.update(kw)
        return Steps(**d)


def make_steps(tracks: list[dict], d0: float = 30.0, smooth_m: float = 8.0, gap_rel: float = 0.3, grid_ds: float = 4.0, gap_nom: list | None = None,
               gap_dth=None) -> Steps:
    """gap_nom (optional, one entry per track): MEASURED nominal metres of the gap before that track (e.g. a standstill whose pairs were flagged), None = estimate
    the gap from the speeds before and after it (the default for every gap). gap_dth (optional): (t0, t1) -> heading increment (track units) of a gap sub-step
    over that time span, NaN = no emission; None = gap sub-steps never emit (as before)"""
    T_, DT, MU, REL, V, GAP, SEG = [], [], [], [], [], [], []
    prev = None  # (t_end, speed, leftover metres)
    for si, tr in enumerate(tracks):
        s = np.asarray(tr["s"], float); t = np.asarray(tr["t"], float); th = np.asarray(tr["th"], float)
        th = gaussian_filter1d(th, smooth_m / grid_ds, mode="nearest") if smooth_m > 0 else th
        n = int(s[-1] // d0)
        if n < 2:
            continue
        sg = np.arange(0, n + 1) * d0
        thg = np.interp(sg, s, th); tg = np.interp(sg, s, t)
        dt = np.maximum(np.diff(tg), 0.2)
        v = median_filter(d0 / dt, size=7, mode="nearest")
        if prev is not None:
            t_prev, v_prev, left = prev
            gap_t = max(tg[0] - t_prev, 0.0)
            meas = gap_nom[si] if gap_nom is not None and si < len(gap_nom) else None
            gnom = left + (0.5 * (v_prev + v[0]) * gap_t if meas is None else float(meas))
            ng = max(1, int(round(gnom / d0)))
            for q in range(1, ng + 1):
                ta_, tb_ = t_prev + gap_t * (q - 1) / ng, t_prev + gap_t * q / ng
                T_.append(tb_); DT.append(np.nan if gap_dth is None else float(gap_dth(ta_, tb_))); MU.append(gnom / ng)
                REL.append(min(1.0, gap_rel * np.sqrt(ng))); V.append(0.5 * (v_prev + v[0])); GAP.append(True); SEG.append(si - 1)
        else:
            T_.append(tg[0]); DT.append(np.nan); MU.append(0.0); REL.append(0.0); V.append(v[0]); GAP.append(False); SEG.append(si)
        # the first emitting step of a segment starts at the state reached by the previous step: if there was a gap its last sub-step ends at tg[0]
        for j in range(1, n + 1):
            T_.append(tg[j]); DT.append(thg[j] - thg[j - 1]); MU.append(d0); REL.append(0.0); V.append(v[j - 1]); GAP.append(False); SEG.append(si)
        prev = (float(tg[-1]), float(np.mean(v[-5:])), float(s[-1] - sg[-1]))
    return Steps(np.array(T_), np.array(DT), np.array(MU), np.array(REL), np.array(V), np.array(GAP), np.array(SEG), d0)


def block_shuffle(st: Steps, rng: np.random.Generator, block_m=(200.0, 500.0)) -> Steps:
    """decoy: the heading increments of the emitting steps (pooled over segments) cut into blocks of 200-500 m, blocks permuted. Times, gaps, mu stay."""
    idx = np.flatnonzero(~np.isnan(st.dth))
    cuts = [0]
    pos = 0.0
    while True:
        pos += rng.uniform(*block_m)
        k = int(pos // st.d0)
        if len(idx) - k < block_m[0] / st.d0:
            break
        cuts.append(k)
    cuts.append(len(idx))
    blocks = [idx[a:b] for a, b in zip(cuts[:-1], cuts[1:]) if b > a]
    order = rng.permutation(len(blocks))
    src = np.concatenate([blocks[i] for i in order])
    d = st.dth.copy()
    d[idx] = st.dth[src]
    return st.copy(dth=d)


def mirror(st: Steps) -> Steps:
    return st.copy(dth=-st.dth)
