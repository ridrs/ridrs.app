# SPDX-License-Identifier: AGPL-3.0-or-later
"""Anchor producer 2: tunnel portals (Amalfi, phase 2). Video side: entry / exit time from the luminance of the video (2 fps, 64x36 grey); route side: the OSM
tunnel=yes edges on the path. Portal times are refined by a FIXED rule written before any route was looked at:
    L_out = median luminance 2..8 s outside the dark interval, L_in = minimum inside; entry (exit) = the half-way crossing (L_out + L_in)/2, linearly interpolated,
    searched backwards from the start (forwards from the end) of the dark interval (dark = < 0.5 x video median, rule of work/amalfi/evidence.json)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .anchors import Anchor

FPS = 2.0
LUM = Path(__file__).resolve().parents[2] / "work" / "amalfi" / "lum64x36.raw"
EVID = Path(__file__).resolve().parents[2] / "work" / "amalfi" / "evidence.json"


def luminance() -> np.ndarray:
    a = np.fromfile(LUM, np.uint8).reshape(-1, 36 * 64)
    return a.mean(1)


def _cross(lum, i_from: int, step: int, mid: float, inside_low: bool = True) -> float:
    """time (s) where the luminance crosses `mid`, scanning from sample i_from (inside the dark part) in direction `step` until it is >= mid"""
    i = i_from
    while 0 <= i + step < len(lum) and lum[i] < mid:
        i += step
    j = i - step                                    # last sample below mid... i is first >= mid (or the edge)
    a, b = lum[j], lum[i]
    f = 0.0 if b == a else float(np.clip((mid - a) / (b - a), 0, 1))
    return (j + f * (i - j)) / FPS


def portal_times(lum: np.ndarray | None = None, evid: dict | None = None) -> list[dict]:
    lum = luminance() if lum is None else lum
    ev = json.loads(EVID.read_text()) if evid is None else evid
    sm = np.convolve(lum, np.ones(3) / 3, mode="same")
    out = []
    for iv in ev["dark_intervals"]:
        if not iv.get("tunnel_by_eye"):
            continue
        a, b = int(round(iv["t0"] * FPS)), int(round(iv["t1"] * FPS))
        L_in = float(sm[a:b + 1].min())
        pre = np.median(lum[max(0, a - 16):max(1, a - 4)]); post = np.median(lum[b + 4:b + 16])
        t_in = _cross(sm, a, -1, 0.5 * (pre + L_in))
        t_out = _cross(sm, b, +1, 0.5 * (post + L_in))
        out.append(dict(dark_t0=iv["t0"], dark_t1=iv["t1"], t_entry=float(t_in), t_exit=float(t_out), L_in=L_in, L_before=float(pre), L_after=float(post)))
    return out


def match_runs(ctx, portals: list[dict], tol: float = 10.0) -> list[dict]:
    """tunnel interval <-> OSM tunnel run of the path: the run whose time span (Viterbi baseline, +-tol s) contains the interval and whose centre is nearest. One-to-one."""
    runs = ctx.path.tunnel_runs()
    tv = ctx.t_step; sv = ctx.s_vit
    def t_at(s):
        return float(np.interp(s, sv, tv))
    spans = [(t_at(a), t_at(b)) for a, b in runs]
    used, rows = set(), []
    for i, p in enumerate(portals):
        mid = 0.5 * (p["dark_t0"] + p["dark_t1"])
        cand = [(abs(0.5 * (ta + tb) - mid), j) for j, (ta, tb) in enumerate(spans) if ta - tol <= p["dark_t1"] and tb + tol >= p["dark_t0"] and j not in used]
        if not cand:
            rows.append(dict(**p, run=None)); continue
        j = min(cand)[1]; used.add(j)
        rows.append(dict(**p, run=j, s_entry=runs[j][0], s_exit=runs[j][1], len_osm=runs[j][1] - runs[j][0]))
    return rows


class TunnelAnchors:
    name = "tunnel_portal"

    def __init__(self, portals: list[dict] | None = None, q_ok: float = 0.95, q_odd: float = 0.4):
        self.portals = portals if portals is not None else portal_times()
        self.q_ok, self.q_odd = q_ok, q_odd
        self.matched: list[dict] = []

    def anchors(self, ctx) -> list[Anchor]:
        self.matched = match_runs(ctx, self.portals)
        out = []
        for i, r in enumerate(self.matched):
            if r.get("run") is None:
                continue
            Lv = float(ctx.D(r["t_exit"]) - ctx.D(r["t_entry"]))
            ratio = r["len_osm"] / (ctx.kappa * Lv) if Lv > 1 else np.nan
            r["len_ratio"] = ratio
            q = self.q_ok if (np.isnan(ratio) or 0.4 <= ratio <= 2.5) else self.q_odd
            for kind, t, s in (("entry", r["t_entry"], r["s_entry"]), ("exit", r["t_exit"], r["s_exit"])):
                out.append(Anchor(float(t), float(s), self.name, q, 0.7, 5.0, dict(tunnel=i, portal=kind)))
        return out
