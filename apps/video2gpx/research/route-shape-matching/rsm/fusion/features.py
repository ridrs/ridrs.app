# SPDX-License-Identifier: AGPL-3.0-or-later
"""A-priori quality features of curve anchors, computed from the vms signal and the map ONLY (no GPS, no truth), for gating.

For every curve anchor (a video turn matched to the route at arc s):
  inlier_share / n_inlier / rms_n : the heading-profile residual (video a x theta against the OSM heading of the path at s, local scale and smoothing of the
                                    alignment, free offset) in units of the profile noise: share and count of points with |r| < 2 sd, median |r|/sd
  ang_dev                         : |log(map turn angle / vms turn angle)| at the HMM scale (global kappa), 3.0 when the signs differ
  margin                          : alignment margin of the 1-D curve matching (nats, producer)
  yaw_noise                       : robust sd of the second difference of the vms heading (4 m grid) within +-300 nominal m (rad): the yaw noise on the neighbouring
                                    stretches (turns are sparse, so the MAD is dominated by straights)
  snr                             : turn angle / (yaw_noise x sqrt(n samples of the turn))
Features that depend on the anchor's arc (inlier, ang_dev) are recomputed for any given arc s, so a shifted (wrong) anchor shows its misfit.
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter1d


class Featurizer:
    def __init__(self, ctx, src):
        self.ctx, self.src, self.p = ctx, src, src.p
        self.kg = ctx.kappa
        self._phis = {}
        self.phi_g = gaussian_filter1d(ctx.path.phi, 6.0 * self.kg, mode="nearest")
        self.diag = {round(d["t"], 3): d for d in src.last if "t" in d and "delta" in d}

    def phi(self, kr: float, sr: float):
        key = (round(kr, 4), round(sr, 4))
        if key not in self._phis:
            self._phis[key] = gaussian_filter1d(self.ctx.path.phi, self.p.smooth_m * self.kg * kr * sr, mode="nearest")
        return self._phis[key]

    def yaw_noise(self, s_tr, th, s_c, half: float = 300.0) -> float:
        g = np.arange(max(s_tr[0], s_c - half), min(s_tr[-1], s_c + half), 4.0)
        if len(g) < 12:
            return float("nan")
        x = np.interp(g, s_tr, th)
        d2 = np.diff(x, 2)
        return float(1.4826 * np.median(np.abs(d2 - np.median(d2))) / np.sqrt(6.0))

    def of(self, a, s: float | None = None) -> dict:
        """features of the curve anchor `a` placed at arc s (default: its own arc)"""
        ctx, p, kg = self.ctx, self.p, self.kg
        d = self.diag.get(round(a.t, 3))
        if d is None:
            return {}
        s = a.s if s is None else s
        tr = ctx.tracks[d["seg"]]
        s_tr, th = np.asarray(tr["s"]), ctx.a_ang * np.asarray(tr["th"])
        s_c, W = d["seg_s"], d["W"]
        tau = np.arange(-W, W + 1e-9, 4.0)
        tau = tau[(s_c + tau >= s_tr[0]) & (s_c + tau <= s_tr[-1])]
        xv = np.interp(s_c + tau, s_tr, th)
        x0 = float(np.interp(s_c, s_tr, th))
        sd = np.sqrt(p.s0 ** 2 + (p.s_rel * (xv - x0)) ** 2)
        kabs = d["k_local"] * kg
        ph = self.phi(d["k_local"], d["sig"])
        xm = np.interp(np.clip(s + kabs * tau, 0, ctx.path.sg[-1]), ctx.path.sg, ph)
        r = xv - xm
        r = r - r.mean()
        z = np.abs(r) / sd
        # turn angle agreement at the HMM scale
        tau_h = 0.5 * d["len_nom"] + 15.0
        v_ch = float(np.interp(s_c + tau_h, s_tr, th) - np.interp(s_c - tau_h, s_tr, th))
        m_ch = float(np.interp(np.clip(s + kg * tau_h, 0, ctx.path.sg[-1]), ctx.path.sg, self.phi_g) - np.interp(np.clip(s - kg * tau_h, 0, ctx.path.sg[-1]), ctx.path.sg, self.phi_g))
        ratio = m_ch / v_ch if abs(v_ch) > 1e-6 else np.nan
        ang_dev = float(abs(np.log(ratio))) if (np.isfinite(ratio) and ratio > 0) else 3.0
        yn = self.yaw_noise(s_tr, th, s_c)
        n_turn = max(d["len_nom"] / 4.0, 1.0)
        A = np.radians(abs(d["angle_deg"]))
        return dict(inlier_share=float((z < 2).mean()), n_inlier=int((z < 2).sum()), n_win=int(len(z)), rms_n=float(np.median(z)), ang_dev=ang_dev, angle_deg=float(abs(d["angle_deg"])),
                    margin=float(d["margin"]), r2=float(d["r2"]), yaw_noise=yn, snr=float(A / (yn * np.sqrt(n_turn) + 1e-9)) if np.isfinite(yn) else np.nan, len_nom=float(d["len_nom"]))
