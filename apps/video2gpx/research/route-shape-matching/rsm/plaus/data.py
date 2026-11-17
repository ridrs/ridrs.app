# SPDX-License-Identifier: AGPL-3.0-or-later
"""Heading/distance tracks of the video (vms segments, or the GPS track as upper bound) and video-time windows cut from them.

A track is a list of segments {t, s, th}: video seconds, nominal metres, heading (rad, left +, 0 at the segment start) on a 4 m grid of s
(heading smoothed with a 6 m Gaussian). Gaps between segments stay explicit. Same vms processing as rsm.quanta.video (frozen configs).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.odometry import gating, heading
from rsm.odometry.vms_csv import load_pairs
from rsm.quanta import video

DS = 4.0  # m grid
SM_M = 6.0  # heading smoothing, m
MIN_SEG_SAMPLES = 10


def _resample(t, s, th) -> dict | None:
    s = np.asarray(s, float)
    s = s - s[0]
    if s[-1] < DS * MIN_SEG_SAMPLES:
        return None
    se = s + 1e-9 * np.arange(len(s))  # strictly increasing for interp
    g = np.arange(0.0, s[-1], DS)
    thg = gaussian_filter1d(np.interp(g, se, th), SM_M / DS, mode="nearest")
    return dict(t=np.interp(g, se, t), s=g, th=thg)


def vms_tracks(vid: str, label: str) -> list[dict]:
    cfg = video.config(label, vid)
    p = load_pairs(cfg["csv"])
    fl = gating.pair_flags(p)
    out = []
    for sg in gating.build_segments(p, fl, gating.GateParams()):
        if not sg.usable:
            continue
        tr = heading.integrate(p, sg, fl, cfg["f360"], dist_scale=cfg.get("dist_scale", 1.0))
        r = _resample(tr.t, tr.s, tr.theta)
        if r is not None:
            out.append(r)
    return out


def gps_tracks(gc: dict) -> list[dict]:
    r = _resample(gc["t"], gc["s"], gc["theta"])
    return [r]


def mirror_tracks(tracks: list[dict]) -> list[dict]:
    return [dict(t=x["t"], s=x["s"], th=-x["th"]) for x in tracks]


@dataclass
class VWin:
    t: np.ndarray  # (n) video seconds
    sloc: np.ndarray  # nominal m since segment start
    th: np.ndarray  # rad relative to segment start
    seg: np.ndarray  # (n) segment index 0..M-1
    tau: np.ndarray  # seconds since segment start
    S: np.ndarray  # (M) nominal length of each segment (incl. one grid step)
    gnom: np.ndarray  # (M-1) nominal metres estimated for the gap after segment m (mean speed x gap time)
    gdur: np.ndarray  # (M-1) gap seconds
    t0: float
    t1: float

    @property
    def M(self) -> int:
        return len(self.S)

    @property
    def n(self) -> int:
        return len(self.t)

    def sigma(self, gam=None) -> np.ndarray:
        """global nominal distance of each sample; gaps counted with factor gam (default 1)."""
        gam = np.ones(self.M - 1) if gam is None else gam
        off = np.concatenate([[0.0], np.cumsum(self.S[:-1] + gam * self.gnom)])
        return off[self.seg] + self.sloc

    def sigma_at(self, tq: float) -> float:
        sg = self.sigma()
        return float(np.interp(tq, self.t, sg))


def cut(tracks: list[dict], ta: float, tb: float, min_s: float = 40.0, min_dur: float = 6.0) -> VWin | None:
    parts = []
    for x in tracks:
        k = np.flatnonzero((x["t"] >= ta) & (x["t"] <= tb))
        if len(k) < MIN_SEG_SAMPLES:
            continue
        if x["s"][k[-1]] - x["s"][k[0]] < min_s or x["t"][k[-1]] - x["t"][k[0]] < min_dur:
            continue
        parts.append((x["t"][k], x["s"][k] - x["s"][k[0]], x["th"][k] - x["th"][k[0]]))
    if not parts:
        return None
    T, SL, TH, SG, TAU, S, gn, gd = [], [], [], [], [], [], [], []
    for m, (t, s, th) in enumerate(parts):
        T.append(t); SL.append(s); TH.append(th); SG.append(np.full(len(t), m)); TAU.append(t - t[0]); S.append(s[-1] + DS)
        if m > 0:
            tp = parts[m - 1][0]
            dt = max(t[0] - tp[-1], 0.0)
            v = 0.5 * (S[m - 1] / max(tp[-1] - tp[0], 1.0) + S[m] / max(t[-1] - t[0], 1.0))
            gd.append(dt); gn.append(v * dt)
    return VWin(np.concatenate(T), np.concatenate(SL), np.concatenate(TH), np.concatenate(SG), np.concatenate(TAU), np.array(S), np.array(gn), np.array(gd),
                float(parts[0][0][0]), float(parts[-1][0][-1]))
