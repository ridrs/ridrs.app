# SPDX-License-Identifier: AGPL-3.0-or-later
"""The tracker on its own: GPS fed in as if it were vms (heading and distance from the GPS curve, rho = kappa = 1), 5 anchors at the true position at equally
spaced times. 'gps' = the aligned 1 Hz GPS curve; 'mm' = the map-matched GPS path (road geometry, no GPS noise). GPS is also the scoring truth here.
python -m rsm.track2.gpsfed <video> <config> ...  -> prints one line per config and source
"""
from __future__ import annotations

import dataclasses
import pickle
import sys

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.plaus import data

from . import exp, run, score, tracker, vtrack


def mm_curve(T):
    mm = T.mm
    ok = mm["edge"] >= 0
    x, y, t = mm["x"][ok], mm["y"][ok], mm["t"][ok]
    d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    keep = np.concatenate([[True], np.diff(d) > 0.05])
    d, x, y, t = d[keep], x[keep], y[keep], t[keep]
    s = np.arange(0, d[-1], 1.0)
    xs = gaussian_filter1d(np.interp(s, d, x), 2.0, mode="nearest"); ys = gaussian_filter1d(np.interp(s, d, y), 2.0, mode="nearest")
    th = np.unwrap(np.arctan2(np.gradient(ys), np.gradient(xs))); th -= th[0]
    return dict(s=s, theta=th, t=np.maximum.accumulate(np.interp(s, d, t)))


def run_gpsfed(video, cfgs, sources=("gps", "mm"), n_anchor=5, log=print):
    S = run.setup(video)
    T = score.Truth(video, S["g"], S["fw"], log=lambda *a: None)
    ts = np.linspace(T.t0 + 0.1 * (T.t1 - T.t0), T.t0 + 0.9 * (T.t1 - T.t0), n_anchor)
    an = []
    for t in ts:
        xy = T.pos([t])[0]; hd = float(np.arctan2(*(T.pos([t + 3])[0] - T.pos([t - 3])[0])[::-1]))
        an.append(dict(kind="gps", t=float(t), xy=xy, hd=hd, plaus_correct=True, snorm=0.0, L=0, lo=0, rank=0, span=(0, 0)))
    res = {}
    for src in sources:
        gc = T.gc if src == "gps" else mm_curve(T)
        tr = data.gps_tracks(gc)
        S["sf"] = vtrack.make_seq(tr, flank=False); S["sb"] = vtrack.make_seq(tr, reverse=True, flank=False)
        for name in cfgs:
            prm = exp.CONFIGS[name][0] if name in exp.CONFIGS else tracker.Params()
            S["ctx"] = tracker.make_ctx(S["fw"], S["rv"], S["sn"], 1.0, 1.0, prm)
            rs, sec = run.track_all(S, an, procs=5, log=lambda *a: None)
            sc = [score.score_route(r, T) for r in rs if r is not None]
            res[(src, name)] = dict(on30=[s["on30"] for s in sc], on100=[s["on100"] for s in sc], on_road=[s["on_road"] for s in sc],
                                    jc=sum(s["junc_correct"] for s in sc), jw=sum(s["junc_wrong"] for s in sc), jo=sum(s["junc_off"] for s in sc), seconds=sec,
                                    cpk=[r.cost_per_km for r in rs if r is not None])
            r = res[(src, name)]
            log(f"{video} {src:3s} {name:14s} on30 mean {np.mean(r['on30']):.2f} min {np.min(r['on30']):.2f} | on100 {np.mean(r['on100']):.2f} | on road {np.mean(r['on_road']):.2f} | junctions {r['jc']}/{r['jw']}/{r['jo']} | cpk {np.median(r['cpk']):.1f}")
    return res


if __name__ == "__main__":
    out = {}
    for v in exp.VIDEOS:
        out[v] = run_gpsfed(v, sys.argv[1:])
    pickle.dump(out, open(exp.WORK / "res" / "gpsfed.pkl", "wb"))
