# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sequence-driven path search: the principled bound when the unguided count explodes.

`TurnGuide` is an `allow(prefix_edges, length)` hook for paths.enumerate_paths: after each added edge it computes the turns of the
prefix, takes those that are finished (s_end <= length - commit_margin; later geometry cannot change them beyond the detector's smoothing
window), and requires them to be a contiguous run of the QUERY turn list starting at path-turn index j <= max_lead (the video begins
somewhere inside the first edge, so up to max_lead turns of the node-start path may precede it). Per matched turn: same sign, |angle|
within angle_rel of the larger one, and the gap to the previous matched turn (mid-to-mid, m) within [scale_lo, scale_hi] x the query gap
(+ gap_abs_m). Query turns are (angle_deg, s_mid_m) in video (nominal) metres. The cost is a function of the query, not of the network.
"""
from __future__ import annotations

from .graph import NetGraph
from .paths import path_polyline, turns_of_polyline


class TurnGuide:
    def __init__(self, g: NetGraph, query: list[tuple[float, float]], *, max_lead: int = 3, angle_rel: float = 0.3, scale_lo: float = 0.5,
                 scale_hi: float = 2.0, gap_abs_m: float = 25.0, commit_margin: float = 40.0):
        self.g, self.q = g, list(query)
        self.max_lead, self.angle_rel, self.lo, self.hi, self.gap_abs, self.margin = max_lead, angle_rel, scale_lo, scale_hi, gap_abs_m, commit_margin
        self.calls = 0

    def _ok_from(self, C, j):
        for k in range(min(len(C) - j, len(self.q))):
            a, m = C[j + k]
            qa, qm = self.q[k]
            if (a > 0) != (qa > 0) or abs(a - qa) > self.angle_rel * max(abs(a), abs(qa)):
                return False
            if k:
                g_c, g_q = m - C[j + k - 1][1], qm - self.q[k - 1][1]
                if not (self.lo * g_q - self.gap_abs <= g_c <= self.hi * g_q + self.gap_abs):
                    return False
        return True

    def __call__(self, prefix, length: float) -> bool:
        self.calls += 1
        ts = turns_of_polyline(path_polyline(self.g, prefix))
        C = [(t.angle_deg, (t.s_start + t.s_end) / 2) for t in ts if t.s_end <= length - self.margin]
        return any(self._ok_from(C, j) for j in range(0, min(self.max_lead, len(C)) + 1))
