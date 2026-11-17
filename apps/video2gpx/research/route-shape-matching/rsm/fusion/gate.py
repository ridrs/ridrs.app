# SPDX-License-Identifier: AGPL-3.0-or-later
"""A-priori gating of curve anchors: yaw-quality features (rsm.fusion.features, no GPS) -> sig_s of the anchor, or reject.

The mapping is monotone, multiplicative and was fixed on the three bike videos (development) by their feature quantiles and by the calibration of
|anchor - GPS| / sig_s there (see work/fusion/RESULTS.md); it is applied UNCHANGED to every other video:

    sig_s = sig_base x f_inlier x f_margin x f_angle x f_noise            (all f >= 1)
    f_inlier = 1 + c_inl x max(0, inl0 - inlier_share)                    share of the profile within 2 sd of the map heading
    f_margin = 1 + max(0, mar0 - margin) / mar_w                          nats of the 1-D alignment
    f_angle  = 1 + c_ang x max(0, min(ang_dev, ang_cap) - ang0)           |log(map turn / vms turn)| at the HMM scale, 3 = opposite signs (capped)
    f_noise  = max(1, yaw_noise / noise0)                                 local yaw noise (rad) against the bike level: position error is linear in it
    reject if the margin < min_margin, the inlier share < min_inlier, or sig_s > max_sig.
Anchors of other kinds (no features) pass unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from rsm.refine.anchors import Anchor


@dataclass
class GateParams:
    sig_base: float = 5.0
    inl0: float = 0.96
    c_inl: float = 8.0
    mar0: float = 30.0
    mar_w: float = 15.0
    ang0: float = 0.25
    c_ang: float = 3.0
    ang_cap: float = 2.0
    noise0: float = 0.006
    min_margin: float = 6.0
    min_inlier: float = 0.35
    max_sig: float = 60.0


def sigma(f: dict, g: GateParams) -> tuple[float, str]:
    """-> (sig_s, reject reason or '')"""
    if f["margin"] < g.min_margin:
        return np.inf, "margin"
    if f["inlier_share"] < g.min_inlier:
        return np.inf, "inlier"
    s = g.sig_base
    s *= 1.0 + g.c_inl * max(0.0, g.inl0 - f["inlier_share"])
    s *= 1.0 + max(0.0, g.mar0 - f["margin"]) / g.mar_w
    s *= 1.0 + g.c_ang * max(0.0, min(f["ang_dev"], g.ang_cap) - g.ang0)
    if np.isfinite(f["yaw_noise"]):
        s *= max(1.0, f["yaw_noise"] / g.noise0)
    if s > g.max_sig:
        return s, "sigma"
    return float(s), ""


def gate(anchors: list[Anchor], feat, g: GateParams | None = None) -> tuple[list[Anchor], list[dict], list[dict]]:
    """-> (kept anchors with sig_s set, rejected [{anchor, reason, feats}], feats per input anchor (aligned, {} for kinds without features))"""
    g = g or GateParams()
    keep, rej, allf = [], [], []
    for a in anchors:
        f = feat.of(a) if a.kind == "curve" else {}
        allf.append(f)
        if not f:
            keep.append(a); continue
        s, why = sigma(f, g)
        if why:
            rej.append(dict(anchor=a, reason=why, feats=f)); continue
        keep.append(replace(a, sig_s=s, meta=dict(a.meta, gated_sig=s)))
    return keep, rej, allf
