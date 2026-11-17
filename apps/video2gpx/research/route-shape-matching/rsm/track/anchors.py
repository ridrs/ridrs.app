# SPDX-License-Identifier: AGPL-3.0-or-later
"""Anchors for the tracker: speculative (plaus decisions), deliberately wrong (accepted control candidates, stage-A rank 2-5, random road positions).

An anchor = (video time t, map position xy in the graph CRS, travel heading hd, kind, plaus label). The plaus labels (`correct`, from GPS) are carried
for scoring only; the tracker never sees them. Per-video start values (rho0, kappa0) are the video-level medians of the accepted plaus fits
(rsm.plaus.decide.estimate_video_level), i.e. video-only estimates (no GPS).
"""
from __future__ import annotations

import json

import numpy as np

from rsm.plaus import decide as D
from rsm.plaus import experiment as X
from rsm.plaus import pipeline as P

TAG = "f1"
SETTING = "measured"
VIDEO_HALVES = {"col-de-grimone-1": ("DEV-A", "TEST-B"), "vallee-de-roanne": ("DEV-A", "TEST-B"), "col-de-rousset": ("TEST",)}


def _frozen():
    f = json.loads((P.WORK / "frozen.json").read_text())["cal"]["refined"][SETTING]
    return f["tau"], f["m"]


def load_recs(video: str, ctl=None) -> list:
    out = []
    for h in VIDEO_HALVES[video]:
        try:
            out += P.load(X.name(TAG, h, video, "refined", ctl))
        except FileNotFoundError:
            pass
    return out


def video_cal(video: str) -> dict:
    tau, _ = _frozen()
    est = D.estimate_video_level(load_recs(video), SETTING, tau)
    return dict(rho0=est["rho"], kappa0=est["kappa"], n=est["n"])


def _anchor_from_trace(f, c, r, kind) -> dict | None:
    t, xy = f["trace"]
    t = np.asarray(t, float); xy = np.asarray(xy, float)
    if len(t) < 6:
        return None
    i = len(t) // 2
    a, b = max(i - 3, 0), min(i + 3, len(t) - 1)
    hd = float(np.arctan2(xy[b, 1] - xy[a, 1], xy[b, 0] - xy[a, 0]))
    return dict(kind=kind, t=float(t[i]), xy=xy[i].copy(), hd=hd, plaus_correct=bool(c["correct"]), snorm=float(f["snorm"]), L=int(r["L"]), lo=int(r["lo"]),
                rank=int(c["rank"]), span=(float(t[0]), float(t[-1])))


def decisions(video: str, ctl=None) -> list:
    """accepted decisions of the plaus pipeline (measured priors, pass 1) as anchors; kind 'dec' (real) or 'ctl_<name>'."""
    tau, m = _frozen()
    out = []
    for r in load_recs(video, ctl):
        d = D.decide(r, SETTING, tau, m)
        if d is None:
            continue
        a = _anchor_from_trace(d[1], d[0], r, "dec" if ctl is None else f"ctl_{ctl}")
        if a:
            out.append(a)
    return out


def accepted_candidates(video: str, ctl: str) -> list:
    """every accepted candidate (not only decisions) of a control run: wrong by construction."""
    tau, _ = _frozen()
    out = []
    for r in load_recs(video, ctl):
        for c, f in D.accepted(r, SETTING, tau):
            a = _anchor_from_trace(f, c, r, f"ctl_{ctl}")
            if a:
                a["plaus_correct"] = False
                out.append(a)
    return out


def rank25(video: str, per_window: int = 4, cap: int = 60, seed: int = 1) -> list:
    """stage-A candidates of rank 2..5 (0-based 1..4) that were fitted and are not correct: wrong anchors (rejected or not by the plaus fit)."""
    rng = np.random.default_rng(seed)
    out = []
    for r in load_recs(video):
        for c in r["cands"]:
            if not (1 <= c["rank"] <= per_window) or c["correct"]:
                continue
            f = c["fits"].get(SETTING)
            if f and f["ok"]:
                a = _anchor_from_trace(f, c, r, "rank25")
                if a:
                    out.append(a)
    if len(out) > cap:
        out = [out[i] for i in sorted(rng.choice(len(out), cap, replace=False))]
    return out


def random_anchors(fwd, t0: float, t1: float, n: int, seed: int = 7, kind="random") -> list:
    """n random positions on random directed edges (length-weighted), random video times uniform in [t0, t1]."""
    rng = np.random.default_rng(seed)
    L = fwd.L
    p = L / L.sum()
    out = []
    for _ in range(n):
        e = int(rng.choice(len(L), p=p))
        u = float(rng.uniform(0, L[e]))
        xy = fwd.xy(e, u)[0]
        hd = float(fwd.phi(e, u))
        out.append(dict(kind=kind, t=float(rng.uniform(t0, t1)), xy=xy, hd=hd, plaus_correct=False, snorm=np.nan, L=0, lo=0, rank=-1, span=(0, 0), edge=e, u=u))
    return out


def dedupe(anchors: list, dt: float = 20.0, dist: float = 60.0) -> list:
    """merge anchors of overlapping windows that sit at nearly the same video time and place: keep the lowest plaus cost."""
    keep = []
    for a in sorted(anchors, key=lambda a: a["snorm"] if np.isfinite(a["snorm"]) else 9):
        if any(abs(a["t"] - b["t"]) < dt and np.hypot(*(a["xy"] - b["xy"])) < dist for b in keep):
            continue
        keep.append(a)
    return sorted(keep, key=lambda a: a["t"])
