# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scoring of tracked routes against the GPS (GPS enters ONLY here): share of video time within 30 m of the GPS position at the same (lag corrected)
video time, share of junction decisions that follow the map-matched GPS path, anchor labels."""
from __future__ import annotations

import numpy as np

from rsm.quanta import gps, mapmatch

from .graphs import WORK

TOL_M = 30.0


class Truth:
    def __init__(self, video: str, g, fwd, log=print):
        self.video, self.g, self.fwd = video, g, fwd
        self.gc = gps.gps_curve(video, g.crs)
        f = WORK / "cache" / f"truth_{video}.npz"
        if f.exists():
            z = np.load(f)
            self.mm = {k: z[k] for k in z.files}
        else:
            ix = mapmatch.EdgeIndex(g)
            mm = mapmatch.match_track(ix, self.gc)
            self.mm = {k: np.asarray(mm[k]) for k in ("s", "t", "x", "y", "edge", "off")}
            np.savez_compressed(f, **self.mm)
            log(f"  truth map-matching done ({int((self.mm['edge']<0).sum())} unmatched samples)")
        self.t0, self.t1 = float(self.gc["t"][0]), float(self.gc["t"][-1])

    def pos(self, t) -> np.ndarray:
        return gps.pos_at(self.gc, t)

    def dist(self, t, xy) -> np.ndarray:
        return np.hypot(*(self.pos(t) - xy).T)

    def anchor_ok(self, a, tol=60.0) -> bool:
        if not (self.t0 <= a["t"] <= self.t1):
            return False
        return bool(self.dist([a["t"]], a["xy"][None])[0] <= tol)


def weights(t: np.ndarray, cap: float = 6.0) -> np.ndarray:
    dt = np.diff(t, prepend=t[0] - 2.0, append=t[-1] + 2.0)
    return np.minimum(0.5 * (dt[1:] + dt[:-1]), cap)


def junctions(route, truth: Truth, win: float = 30.0) -> dict:
    """decisions at junctions with >= 2 continuations along consecutive observed steps. -> counts correct / wrong / offroute (previous edge not on the GPS path)."""
    fw = truth.fwd
    mm = truth.mm
    cor = wr = off = 0
    ev = []
    for i in range(len(route.t) - 1):
        e0, e1 = int(route.E[i]), int(route.E[i + 1])
        if e0 == e1 or route.flag[i] or route.flag[i + 1] or abs(route.t[i + 1] - route.t[i]) > 6.0:
            continue
        if len(fw.succ(e0)) < 2 or e1 not in set(fw.succ(e0).tolist()):
            continue
        tj = float(route.t[i + 1])
        near = np.flatnonzero((np.abs(mm["t"] - tj) <= win) & (mm["edge"] == e0))
        if len(near) == 0:
            off += 1; ev.append((tj, "off")); continue
        j = near[np.argmin(np.abs(mm["t"][near] - tj))]
        nxt = mm["edge"][j + 1:j + 40]
        nxt = nxt[(nxt >= 0) & (nxt != e0)]
        if len(nxt) == 0:
            continue
        if int(nxt[0]) == e1:
            cor += 1; ev.append((tj, "ok"))
        else:
            wr += 1; ev.append((tj, "wrong"))
    n = cor + wr + off
    return dict(correct=cor, wrong=wr, offroute=off, n=n, share=cor / n if n else np.nan, share_on_route=cor / (cor + wr) if cor + wr else np.nan, events=ev)


def score_route(route, truth: Truth) -> dict:
    t = route.t
    ok = (t >= truth.t0) & (t <= truth.t1)
    d = truth.dist(t, route.xy)
    w = weights(t) * ok
    W = max(w.sum(), 1e-9)
    # road-level: route edge on the map-matched GPS path within +-40 s
    mm = truth.mm
    on_edge = np.zeros(len(t), bool)
    for i in np.flatnonzero(ok)[::1]:
        lo, hi = np.searchsorted(mm["t"], [t[i] - 40, t[i] + 40])
        on_edge[i] = bool((mm["edge"][lo:hi] == route.E[i]).any())
    j = junctions(route, truth)
    return dict(on30=float((w * (d <= TOL_M)).sum() / W), on100=float((w * (d <= 100)).sum() / W), on_road=float((w * on_edge).sum() / W), median_d=float(np.median(d[ok])) if ok.any() else np.nan,
                junc_share=j["share"], junc_share_on_route=j["share_on_route"], junc_n=j["n"], junc_correct=j["correct"], junc_wrong=j["wrong"], junc_off=j["offroute"],
                dist=d, ok=ok, w=w)
