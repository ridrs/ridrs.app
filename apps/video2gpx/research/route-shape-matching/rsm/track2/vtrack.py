# SPDX-License-Identifier: AGPL-3.0-or-later
"""Video side of the tracker: vms segments as step sequences (8 m nominal steps) with explicit gaps, forward or time-reversed, optionally mirrored.

A Seg holds, per step k: t (video s), s (nominal m since segment start), th (rad relative to the segment start, left +), tau (s since segment start),
ds (nominal m since the previous step; 0 at k = 0). Between consecutive Segs lies a gap (duration, nominal distance estimated as mean flanking
speed x duration, as in rsm.plaus.data.cut). Reversing the video reverses the order of the segments and every segment (th relative to the new start,
tau from the new start); the sign of th is kept (the absolute heading offset b of the tracker absorbs the pi and the constant).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from scipy.ndimage import median_filter, uniform_filter1d

from rsm.plaus import data

STRIDE = 2  # 4 m grid x 2 = 8 m

# annotation thresholds (v3): standstills from the vms speed, straights between video turns, moving U-turns
DWELL_MIN = 2.0  # s of excess time in one 8 m step = a standstill (heading unreliable)
DWELL_UTURN = 6.0  # s: a standstill this long can hide a turn-around
TURN_DEG = 30.0  # heading change over +-16 m that makes a video turn (boundary of a straight)
UT_DEG = (150.0, 200.0)  # a U-turn: heading change in this range over at most UT_M metres
UT_M = 30.0


@dataclass
class Seg:
    t: np.ndarray
    s: np.ndarray
    th: np.ndarray
    tau: np.ndarray
    ds: np.ndarray
    v: float  # nominal m/s over the segment
    vs: np.ndarray | None = None  # local nominal speed (m/s, dwell excluded), smoothed over about +-24 m
    dwell: np.ndarray | None = None  # s of standstill inside the step (excess time over the local speed)
    strt: np.ndarray | None = None  # straight id: counts the video turns (centres) from the segment start
    ut: np.ndarray | None = None  # 0, 1 = standstill that may hide a turn-around (dwell >= DWELL_UTURN), 2 = moving U-turn completed at this step

    @property
    def n(self) -> int:
        return len(self.t)


@dataclass
class Seq:
    segs: list
    gdur: list  # seconds of the gap after seg i
    gnom: list  # nominal metres of the gap after seg i
    reversed: bool = False

    @property
    def n_steps(self) -> int:
        return sum(s.n for s in self.segs)

    def locate(self, t: float):
        """(seg index, step) nearest in video time to t."""
        best = (1e18, 0, 0)
        for i, sg in enumerate(self.segs):
            k = int(np.argmin(np.abs(sg.t - t)))
            d = abs(sg.t[k] - t)
            if d < best[0]:
                best = (d, i, k)
        return best[1], best[2], best[0]


def annotate(sg: Seg) -> Seg:
    """vs, dwell, strt, ut from tau, ds, th of the segment itself (works for the forward and the time-reversed order)."""
    n = sg.n
    dt = np.concatenate([[0.0], np.diff(sg.tau)])
    sp = np.where(dt > 1e-6, sg.ds / np.maximum(dt, 1e-6), 0.0)
    sp[0] = sp[1] if n > 1 else 0.0
    vref = median_filter(sp, size=31, mode="nearest")
    dwell = np.where(dt > 0, np.maximum(dt - sg.ds / np.maximum(vref, 1.0), 0.0), 0.0)
    dwell[0] = 0.0
    dwell = np.where(dwell >= DWELL_MIN, dwell, 0.0)
    move = np.maximum(dt - dwell, 1e-3)
    vs = uniform_filter1d(np.where(dt > 0, sg.ds / move, 0.0), 7, mode="nearest")
    vs[0] = vs[1] if n > 1 else 0.0
    th = np.degrees(sg.th)
    # U-turns: a standstill >= DWELL_UTURN, or a heading change of UT_DEG within UT_M metres (event at the step that completes it)
    ut = np.zeros(n, np.uint8)
    ut[dwell >= DWELL_UTURN] = 1
    k = 0
    while k < n:
        j0 = k
        while j0 > 0 and sg.s[k] - sg.s[j0 - 1] <= UT_M:
            j0 -= 1
        if j0 < k:
            dh = np.max(np.abs(th[k] - th[j0:k]))
            if UT_DEG[0] <= dh <= UT_DEG[1]:
                ut[k] = max(ut[k], 2)
                k += 6  # refractory: the same turn
                continue
        k += 1
    # straights: video turns = heading change >= TURN_DEG over +-2 steps (+-16 m), boundary at the centre of each run; also standstills and U-turn events
    lo = np.clip(np.arange(n) - 2, 0, n - 1); hi = np.clip(np.arange(n) + 2, 0, n - 1)
    mark = np.abs(th[hi] - th[lo]) >= TURN_DEG
    strt = np.zeros(n, np.int64)
    e = np.diff(np.concatenate([[0], mark.astype(int), [0]]))
    cuts = [(a + b - 1) // 2 for a, b in zip(np.flatnonzero(e == 1), np.flatnonzero(e == -1))]
    cuts += list(np.flatnonzero(dwell > 0)) + list(np.flatnonzero(ut == 2))
    for c in sorted(set(cuts)):
        strt[c:] += 1
    return Seg(sg.t, sg.s, sg.th, sg.tau, sg.ds, sg.v, vs, dwell, strt, ut)


def _seg(t, s, th) -> Seg:
    t = np.asarray(t, float)[::STRIDE]; s = np.asarray(s, float)[::STRIDE]; th = np.asarray(th, float)[::STRIDE]
    th = th - th[0]
    s = s - s[0]
    ds = np.concatenate([[0.0], np.diff(s)])
    dur = max(t[-1] - t[0], 1.0)
    return Seg(t, s, th, t - t[0], ds, float(s[-1] / dur))  # annotate() is applied in make_seq


def make_seq(tracks: list[dict], reverse: bool = False, mirror: bool = False, flank: bool = True) -> Seq:
    """tracks: rsm.plaus.data tracks (list of {t, s, th} on a 4 m grid) in time order."""
    if mirror:
        tracks = data.mirror_tracks(tracks)
    segs = [annotate(_seg(x["t"], x["s"], x["th"])) for x in tracks if len(x["t"]) >= 2 * STRIDE]
    gdur, gnom = [], []
    for a, b in zip(segs[:-1], segs[1:]):
        d = max(b.t[0] - a.t[-1], 0.0)
        gdur.append(d)
        w = float(np.exp(-d / 20.0)) if flank else 0.0  # short gaps: the flanking local speeds; long gaps: the segment means
        va = w * float(np.mean(a.vs[-5:])) + (1 - w) * a.v
        vb = w * float(np.mean(b.vs[:5])) + (1 - w) * b.v
        gnom.append(0.5 * (va + vb) * d)
    if not reverse:
        return Seq(segs, gdur, gnom, False)
    rs = []
    for sg in segs[::-1]:
        s2 = sg.s[-1] - sg.s[::-1]
        th2 = sg.th[::-1] - sg.th[-1]
        t2 = sg.t[::-1]
        ds2 = np.concatenate([[0.0], np.diff(s2)])
        rs.append(annotate(Seg(t2, s2, th2, sg.t[-1] - t2, ds2, sg.v)))
    return Seq(rs, gdur[::-1], gnom[::-1], True)
