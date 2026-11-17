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

from rsm.plaus import data

STRIDE = 2  # 4 m grid x 2 = 8 m


@dataclass
class Seg:
    t: np.ndarray
    s: np.ndarray
    th: np.ndarray
    tau: np.ndarray
    ds: np.ndarray
    v: float  # nominal m/s over the segment

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


def _seg(t, s, th) -> Seg:
    t = np.asarray(t, float)[::STRIDE]; s = np.asarray(s, float)[::STRIDE]; th = np.asarray(th, float)[::STRIDE]
    th = th - th[0]
    s = s - s[0]
    ds = np.concatenate([[0.0], np.diff(s)])
    dur = max(t[-1] - t[0], 1.0)
    return Seg(t, s, th, t - t[0], ds, float(s[-1] / dur))


def make_seq(tracks: list[dict], reverse: bool = False, mirror: bool = False) -> Seq:
    """tracks: rsm.plaus.data tracks (list of {t, s, th} on a 4 m grid) in time order."""
    if mirror:
        tracks = data.mirror_tracks(tracks)
    segs = [_seg(x["t"], x["s"], x["th"]) for x in tracks if len(x["t"]) >= 2 * STRIDE]
    gdur, gnom = [], []
    for a, b in zip(segs[:-1], segs[1:]):
        d = max(b.t[0] - a.t[-1], 0.0)
        gdur.append(d)
        gnom.append(0.5 * (a.v + b.v) * d)
    if not reverse:
        return Seq(segs, gdur, gnom, False)
    rs = []
    for sg in segs[::-1]:
        s2 = sg.s[-1] - sg.s[::-1]
        th2 = sg.th[::-1] - sg.th[-1]
        t2 = sg.t[::-1]
        ds2 = np.concatenate([[0.0], np.diff(s2)])
        rs.append(Seg(t2, s2, th2, sg.t[-1] - t2, ds2, sg.v))
    return Seq(rs, gdur[::-1], gnom[::-1], True)
