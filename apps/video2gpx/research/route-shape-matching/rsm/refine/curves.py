# SPDX-License-Identifier: AGPL-3.0-or-later
"""Anchor producer 1: curve refinement. The route is fixed, so the problem is 1-D: where along the path is each video turn?

For every video turn (rsm.odometry.turns on the vms heading, scaled by the angle factor of the HMM) the video heading profile over a window around the turn
(a x theta_vms, 4 m nominal grid) is compared with the OSM polyline heading of the path around the baseline (Viterbi) position:
    x_map(tau) = phi(s_h + delta + k tau)       delta: shift 5 m grid +-200 m, k: LOCAL map-per-nominal scale (7 values around kappa),
and the map heading is smoothed with a Gaussian of sigma = (6 m video smoothing) x k x {0.7, 1, 1.4}: locally adapted smoothing.
Score = sum of Student-t (nu 3) log densities of the heading-profile residual with a free heading offset, plus a Gaussian prior on delta (sd 80 m: the HMM position).
Anchor = the video turn's APEX (the point where the heading change reaches half of the turn) at path arc s_h + delta*. Apex rather than start/end: the ends of a turn
are blurred by the 6 m heading smoothing and depend on the lead-in, the half-angle point is invariant to symmetric blur; a single anchor per turn is also what the
alignment really measures (a window profile). Quality: margin (nats) between the best shift and the best shift outside the main lobe, times the explained variance R^2.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.odometry.turns import TurnParams, detect_turns

from .anchors import Anchor


@dataclass
class CurveParams:
    min_angle_deg: float = 25.0
    delta_max: float = 200.0
    dstep: float = 5.0
    prior_sd: float = 80.0
    k_rel: tuple = (0.7, 0.8, 0.9, 1.0, 1.12, 1.25, 1.4)     # local map-per-nominal scale relative to the global kappa
    sig_rel: tuple = (0.7, 1.0, 1.4)
    smooth_m: float = 6.0                                    # video heading smoothing (nominal m)
    nu: float = 3.0
    s0: float = 0.06                                         # rad, noise floor of the heading profile
    s_rel: float = 0.10                                      # relative noise of the profile (angle factor)
    win_min: float = 45.0
    win_max: float = 110.0
    min_margin: float = 3.0
    min_r2: float = 0.6
    q_max: float = 0.85                                      # cap: a model-derived curve match must not outrank a physical event (portal)
    min_cover: float = 0.6                                   # share of the window inside the vms segment


def _t_logpdf(r, s, nu):
    return -(nu + 1) / 2 * np.log1p((r / s) ** 2 / nu)


class CurveAnchors:
    name = "curve"

    def __init__(self, params: CurveParams | None = None):
        self.p = params or CurveParams()
        self.last: list[dict] = []   # per video turn diagnostics (accepted or not)

    def _phis(self, ctx):
        kg = ctx.kappa
        return {(i, j): gaussian_filter1d(ctx.path.phi, self.p.smooth_m * kg * kr * sr, mode="nearest")
                for i, kr in enumerate(self.p.k_rel) for j, sr in enumerate(self.p.sig_rel)}

    def anchors(self, ctx) -> list[Anchor]:
        p, kg, a = self.p, ctx.kappa, ctx.a_ang
        phis = self._phis(ctx)
        kabs = np.array(p.k_rel) * kg
        deltas = np.arange(-p.delta_max, p.delta_max + 1e-9, p.dstep)
        prior = -0.5 * (deltas / p.prior_sd) ** 2
        sg_max = ctx.path.sg[-1]
        out, self.last = [], []
        for si, tr in enumerate(ctx.tracks):
            s_tr, t_tr, th = np.asarray(tr["s"]), np.asarray(tr["t"]), a * np.asarray(tr["th"])
            for tn in detect_turns(s_tr, th, t_tr, TurnParams(min_angle_deg=p.min_angle_deg)):
                d = dict(seg=si, angle_deg=tn.angle_deg, len_nom=tn.length_m, accepted=False, why="")
                self.last.append(d)
                i0, i1 = np.searchsorted(s_tr, [tn.s_start, tn.s_end])
                i0 = min(i0, len(th) - 1); i1 = min(max(i1, i0 + 1), len(th) - 1)
                ap = i0 + int(np.argmax(np.abs(th[i0:i1 + 1] - th[i0]) >= 0.5 * abs(th[i1] - th[i0])))
                s_c = float(s_tr[ap]); t_c = float(t_tr[ap])
                W = float(np.clip(0.5 * tn.length_m + 30.0, p.win_min, p.win_max))
                tau = np.arange(-W, W + 1e-9, 4.0)
                inside = (s_c + tau >= s_tr[0]) & (s_c + tau <= s_tr[-1])
                if inside.mean() < p.min_cover:
                    d["why"] = "window outside the vms segment"; continue
                tau = tau[inside]
                xv = np.interp(s_c + tau, s_tr, th)
                x0 = float(np.interp(s_c, s_tr, th))
                sd = np.sqrt(p.s0 ** 2 + (p.s_rel * (xv - x0)) ** 2)
                s_h = float(ctx.s_baseline(t_c))
                S = np.full((len(deltas), len(kabs), len(p.sig_rel)), -np.inf)
                for (i, j), ph in phis.items():
                    sm = np.clip(s_h + deltas[:, None] + kabs[i] * tau[None, :], 0, sg_max)
                    xm = np.interp(sm, ctx.path.sg, ph)
                    r = (xv[None, :] - xm)
                    r = r - r.mean(1, keepdims=True)
                    S[:, i, j] = _t_logpdf(r, sd[None, :], p.nu).sum(1)
                Sd = S.reshape(len(deltas), -1).max(1) + prior
                ib = int(np.argmax(Sd))
                kb, sb = np.unravel_index(int(np.argmax(S[ib])), S[ib].shape)
                # sub-grid peak
                dstar = deltas[ib]
                curv = np.nan
                if 0 < ib < len(deltas) - 1:
                    y0, y1, y2 = Sd[ib - 1], Sd[ib], Sd[ib + 1]
                    den = y0 - 2 * y1 + y2
                    if den < -1e-9:
                        dstar += 0.5 * (y0 - y2) / den * p.dstep
                        curv = -den / p.dstep ** 2
                lk = max(20.0, 0.5 * tn.length_m * kg + 15.0)
                side = np.abs(deltas - deltas[ib]) > lk
                margin = float(Sd[ib] - Sd[side].max()) if side.any() else np.nan
                ph = phis[(kb, sb)]
                xm = np.interp(np.clip(s_h + dstar + kabs[kb] * tau, 0, sg_max), ctx.path.sg, ph)
                r = xv - xm; r = r - r.mean()
                r2 = 1.0 - float((r ** 2).sum() / max(((xv - xv.mean()) ** 2).sum(), 1e-12))
                d.update(t=t_c, s_h=s_h, delta=float(dstar), k_local=float(kabs[kb] / kg), sig=float(p.sig_rel[sb]), margin=margin, r2=r2, curv=curv, W=W, seg_s=float(s_c))
                if abs(dstar) >= p.delta_max - p.dstep:
                    d["why"] = "shift at the search edge"; continue
                if not (margin >= p.min_margin):
                    d["why"] = "weak (margin)"; continue
                if r2 < p.min_r2:
                    d["why"] = "weak (R2)"; continue
                q = float(self.p.q_max * (1 - np.exp(-margin / 6.0)) * min(1.0, max(r2, 0.0)))
                sig_s = float(np.clip(1 / np.sqrt(curv), 2.0, 60.0)) if np.isfinite(curv) and curv > 0 else 10.0
                d["accepted"] = True
                out.append(Anchor(t_c, s_h + dstar, self.name, q, 0.5, sig_s, dict(delta=float(dstar), margin=margin, r2=r2, angle=tn.angle_deg, k_local=float(kabs[kb] / kg))))
        return out
