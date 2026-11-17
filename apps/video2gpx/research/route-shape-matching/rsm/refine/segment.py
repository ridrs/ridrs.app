# SPDX-License-Identifier: AGPL-3.0-or-later
"""Segment correction: between two consecutive accepted anchors the map arc length L_map is known and the vms distance L_vms is measured, k_i = L_map / L_vms;
position = anchor arc + k_i x (vms distance since the anchor). Does not know the kinds of the anchors.
Outside the first/last anchor and in segments with an implausible k the global kappa is used. Segments whose vms distance is mostly an estimated gap distance
(gap share > gap_exempt) keep their k (both anchors are firm, the interpolation is proportional to the estimated distance)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .anchors import Anchor, arc_tol, k_plausible, pair_k


@dataclass
class Segment:
    t0: float
    t1: float
    s0: float
    s1: float
    L_map: float
    L_vms: float
    k: float            # measured L_map / L_vms (NaN: no vms distance)
    k_used: float
    gap_share: float
    flag: str           # "" | "implausible" | "no_vms" | "gap" (gap-dominated, kept) | "head" | "tail"
    kinds: tuple = ()


def segments(anchors: list[Anchor], D, gapfrac, kg: float, k_range=(0.5, 2.0), min_vms=15.0, gap_exempt=0.5) -> list[Segment]:
    out = []
    for a, b in zip(anchors[:-1], anchors[1:]):
        k, Lm, Lv, gf = pair_k(a, b, D, gapfrac)
        flag, ku = "", k
        if not (Lv >= min_vms):
            flag, ku = "no_vms", kg
        elif gf > gap_exempt:
            flag = "gap"
        elif not k_plausible(Lm, Lv, kg, k_range, arc_tol(a, b)):
            flag, ku = "implausible", kg
        out.append(Segment(a.t, b.t, a.s, b.s, Lm, Lv, k, ku, gf, flag, (a.kind, b.kind)))
    return out


def position(t: np.ndarray, anchors: list[Anchor], D, gapfrac, kg: float, s_max: float | None = None, **kw) -> tuple[np.ndarray, list[Segment]]:
    """arc length at the times t. No anchors: returns NaN."""
    t = np.asarray(t, float)
    if not anchors:
        return np.full(len(t), np.nan), []
    seg = segments(anchors, D, gapfrac, kg, **kw)
    at = np.array([a.t for a in anchors]); asx = np.array([a.s for a in anchors])
    Dt = D(t); Da = D(at)
    j = np.clip(np.searchsorted(at, t, side="right") - 1, -1, len(anchors) - 1)
    s = np.empty(len(t))
    for i in range(len(t)):
        if j[i] < 0:                                   # before the first anchor: global kappa backwards
            s[i] = asx[0] + kg * (Dt[i] - Da[0])
        elif j[i] == len(anchors) - 1:                 # after the last anchor
            s[i] = asx[-1] + kg * (Dt[i] - Da[-1])
        else:
            sg = seg[j[i]]
            if sg.flag == "no_vms":                    # no vms distance: linear in time between the firm anchors
                f = (t[i] - sg.t0) / max(sg.t1 - sg.t0, 1e-9)
                s[i] = sg.s0 + f * sg.L_map
            else:
                s[i] = asx[j[i]] + sg.k_used * (Dt[i] - Da[j[i]])
    if s_max is not None:
        s = np.clip(s, 0.0, s_max)
    return s, seg


def position_global(t, anchors: list[Anchor], D, kg: float, s_max: float | None = None) -> np.ndarray:
    """step 2 alone: the refined anchor arc with the OLD ruler (global kappa) from the nearest anchor in time"""
    t = np.asarray(t, float)
    if not anchors:
        return np.full(len(t), np.nan)
    at = np.array([a.t for a in anchors]); asx = np.array([a.s for a in anchors])
    i = np.searchsorted(at, t)
    lo = np.clip(i - 1, 0, len(at) - 1); hi = np.clip(i, 0, len(at) - 1)
    near = np.where(np.abs(at[lo] - t) <= np.abs(at[hi] - t), lo, hi)
    s = asx[near] + kg * (D(t) - D(at[near]))
    return np.clip(s, 0.0, s_max) if s_max is not None else s
