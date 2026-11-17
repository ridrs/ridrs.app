# SPDX-License-Identifier: AGPL-3.0-or-later
"""Common anchor type, the producer protocol and the one merge step. Nothing here knows what kind an anchor is.

An anchor says: at video time t the vehicle was at arc length s of the (fixed) route path. `quality` in [0, 1] decides conflicts; `sig_t` / `sig_s` are optional
1-sigma uncertainties (seconds, metres), NaN when unknown. `kind` is a label ("curve", "tunnel_portal", later "bridge", "place", ...) used only for reports."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol

import numpy as np


@dataclass(frozen=True)
class Anchor:
    t: float
    s: float
    kind: str
    quality: float = 1.0
    sig_t: float = float("nan")
    sig_s: float = float("nan")
    meta: dict = field(default_factory=dict, compare=False, hash=False)


class AnchorSource(Protocol):
    """pluggable producer: returns the anchors it finds on the route given by `ctx` (rsm.refine.pathctx.RouteCtx)"""
    name: str

    def anchors(self, ctx) -> list[Anchor]: ...


def pair_k(a: Anchor, b: Anchor, D: Callable, gapfrac: Callable) -> tuple[float, float, float, float]:
    """(k, L_map, L_vms, gap share of the vms distance) of the segment between consecutive anchors"""
    Lm = b.s - a.s
    Lv = float(D(b.t) - D(a.t))
    return (Lm / Lv if Lv > 1e-6 else float("nan")), Lm, Lv, float(gapfrac(a.t, b.t))


def arc_tol(a: Anchor, b: Anchor, base: float = 12.0) -> float:
    """slack (m) on the arc length difference of two anchors: a base plus their own uncertainties"""
    sa = 0.0 if np.isnan(a.sig_s) else a.sig_s; sb = 0.0 if np.isnan(b.sig_s) else b.sig_s
    return base + float(np.hypot(sa, sb))


def k_plausible(Lm: float, Lv: float, kg: float, k_range, tol: float) -> bool:
    """k = Lm / Lv inside the range, allowing the arc difference to be off by `tol` metres (short pairs: positions are only known to some metres)"""
    return k_range[0] * kg * Lv - tol <= Lm <= k_range[1] * kg * Lv + tol


def violation(a: Anchor, b: Anchor, D, gapfrac, kg: float, k_range=(0.5, 2.0), min_vms=15.0, gap_exempt=0.5, dup=(1.0, 12.0)) -> str | None:
    if b.t - a.t < -1e-9:
        return "time"
    tol = arc_tol(a, b)
    if b.s - a.s < -tol:
        return "arc"
    if b.t - a.t < dup[0] and abs(b.s - a.s) < dup[1]:
        return "dup"
    k, Lm, Lv, gf = pair_k(a, b, D, gapfrac)
    if Lv >= min_vms and gf <= gap_exempt:  # k is measurable (not mostly an estimated gap distance)
        if not k_plausible(Lm, Lv, kg, k_range, tol):
            return "k"
    return None


def _k_arr(cur, D, gapfrac, min_vms=15.0, gap_exempt=0.5):
    k = np.full(max(len(cur) - 1, 0), np.nan)
    for i in range(len(cur) - 1):
        kk, Lm, Lv, gf = pair_k(cur[i], cur[i + 1], D, gapfrac)
        if Lv >= min_vms and gf <= gap_exempt:
            k[i] = kk
    return k


def local_outlier(cur, D, gapfrac, tol: float, nb: int = 4, bridge_tol: float = 0.5):
    """index of the anchor that sticks out most from the local distance factor, or None. For anchor j: k_left / k_right (its two pairs) against the median k of the nb pairs on
    each side that do not involve j; j is an outlier if one of them deviates by more than `tol` (relative) AND the bridge k over (j-1, j+1) deviates by less than
    bridge_tol x tol (removing j repairs the local factor). Returns (j, score)"""
    k = _k_arr(cur, D, gapfrac)
    best = None
    for j in range(1, len(cur) - 1):
        kl, kr = k[j - 1], k[j]
        ctxk = np.concatenate([k[max(0, j - 1 - nb):j - 1], k[j + 1:j + 1 + nb]])
        ctxk = ctxk[np.isfinite(ctxk)]
        if len(ctxk) < 3 or not (np.isfinite(kl) or np.isfinite(kr)):
            continue
        med = float(np.median(ctxk))
        dev = max(abs(kl / med - 1) if np.isfinite(kl) else 0.0, abs(kr / med - 1) if np.isfinite(kr) else 0.0)
        if dev <= tol:
            continue
        kb, _, Lv, gf = pair_k(cur[j - 1], cur[j + 1], D, gapfrac)
        if Lv < 15.0 or gf > 0.5 or abs(kb / med - 1) > bridge_tol * tol:
            continue
        if best is None or dev > best[1]:
            best = (j, dev)
    return best


def merge(anchors: list[Anchor], D: Callable, gapfrac: Callable, kg: float, k_range=(0.5, 2.0), local_tol: float | None = None, **kw) -> tuple[list[Anchor], list[dict]]:
    """sort by time; repeatedly drop the anchor that takes part in the most violating neighbour pairs (ties: lower quality) until every consecutive pair is consistent
    (monotone in time and arc, not a duplicate, plausible k). Returns (accepted, rejected [{anchor, reason}])"""
    cur = sorted(anchors, key=lambda a: (a.t, -a.quality))
    rejected = []
    while True:
        v = [violation(cur[i], cur[i + 1], D, gapfrac, kg, k_range, **kw) for i in range(len(cur) - 1)]
        if not any(v):
            lo = local_outlier(cur, D, gapfrac, local_tol) if local_tol else None
            if lo is None:
                return cur, rejected
            rejected.append(dict(anchor=cur[lo[0]], reason="local"))
            cur = cur[:lo[0]] + cur[lo[0] + 1:]
            continue
        cnt = np.zeros(len(cur))
        for i, x in enumerate(v):
            if x:
                cnt[i] += 1; cnt[i + 1] += 1
        top = np.flatnonzero(cnt == cnt.max())

        def after(i):  # violations left in the neighbourhood if anchor i is removed
            lo, hi = max(i - 2, 0), min(i + 3, len(cur))
            sub = cur[lo:i] + cur[i + 1:hi]
            return sum(1 for x, y in zip(sub[:-1], sub[1:]) if violation(x, y, D, gapfrac, kg, k_range, **kw))

        j = int(min(top, key=lambda i: (after(i), cur[i].quality, -i)))
        why = next((v[i] for i in (j - 1, j) if 0 <= i < len(v) and v[i]), "k")
        rejected.append(dict(anchor=cur[j], reason=why))
        cur = cur[:j] + cur[j + 1:]
