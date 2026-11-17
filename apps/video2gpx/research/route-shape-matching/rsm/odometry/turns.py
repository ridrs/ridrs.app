# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn detection on a heading-over-distance curve theta(s) (rad, left positive; s in metres of whatever scale the caller has).

Used unchanged on vms headings (nominal metres) and on COLMAP camera-rotation yaw (camera-height metres).
  1. resample theta(s) to a uniform grid (`step_m`), smooth with a Gaussian of `sigma_m`, curvature kappa = d theta / ds;
  2. a turn core is a run of constant sign with |kappa| >= `enter_deg_per_m`; it is extended on both sides while the sign
     holds and |kappa| >= `exit_deg_per_m` (hysteresis; the exit threshold is also the minimum mean curvature of a turn);
  3. consecutive turns of the same sign whose gap is at most `merge_gap_m` are merged (an opposite-sign turn in between
     prevents it by being a turn of its own);
  4. a turn is kept if |theta(end) - theta(start)| >= `min_angle_deg` and its length >= `min_length_m`.
The angle does not depend on the distance scale; length, positions and the curvature thresholds' meaning do (x0.7 .. x1.4 for
nominal metres). A turn touching the first or last grid point is flagged `clipped`.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d


@dataclass(frozen=True)
class TurnParams:
    step_m: float = 1.0
    sigma_m: float = 6.0
    enter_deg_per_m: float = 0.6  # radius about 95 m
    exit_deg_per_m: float = 0.3  # radius about 190 m
    merge_gap_m: float = 25.0
    min_angle_deg: float = 25.0
    min_length_m: float = 10.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Turn:
    sign: int  # +1 left, -1 right
    angle_deg: float  # signed
    length_m: float
    s_start: float
    s_end: float
    t_start: float | None
    t_end: float | None
    peak_deg_per_m: float
    clipped: bool

    def to_dict(self) -> dict:
        return {k: (None if v is None else (round(v, 3) if isinstance(v, float) else v)) for k, v in asdict(self).items()}


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    e = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(e == 1).tolist(), np.flatnonzero(e == -1).tolist()))


def detect_turns(s, theta, t=None, params: TurnParams = TurnParams()) -> list[Turn]:
    s = np.asarray(s, float)
    theta = np.asarray(theta, float)
    pr = params
    if len(s) < 3 or s[-1] - s[0] < 2 * pr.step_m:
        return []
    su, iu = np.unique(s, return_index=True)  # plateaus (standstill): first occurrence
    sg = np.arange(su[0], su[-1], pr.step_m)
    if len(sg) < 3:
        return []
    th = np.interp(sg, su, theta[iu])
    tg = None if t is None else np.interp(sg, su, np.asarray(t, float)[iu])
    ths = gaussian_filter1d(th, pr.sigma_m / pr.step_m, mode="nearest")
    kap = np.degrees(np.gradient(ths, pr.step_m))  # deg per metre
    sgn = np.sign(kap)
    strong, weak = np.abs(kap) >= pr.enter_deg_per_m, np.abs(kap) >= pr.exit_deg_per_m
    n = len(sg)
    spans: list[list[int]] = []  # [start, end inclusive, sign]
    for sign in (1, -1):
        for a, b in _runs(strong & (sgn == sign)):
            lo, hi = a, b - 1
            while lo > 0 and weak[lo - 1] and sgn[lo - 1] == sign:
                lo -= 1
            while hi < n - 1 and weak[hi + 1] and sgn[hi + 1] == sign:
                hi += 1
            spans.append([lo, hi, sign])
    spans.sort()
    merged: list[list[int]] = []
    for sp in spans:
        if merged and merged[-1][2] == sp[2] and (sp[0] - merged[-1][1]) * pr.step_m <= pr.merge_gap_m:
            merged[-1][1] = max(merged[-1][1], sp[1])
        else:
            merged.append(sp)
    out = []
    for lo, hi, sign in merged:
        ang = math.degrees(ths[hi] - ths[lo])
        length = (hi - lo) * pr.step_m
        if abs(ang) < pr.min_angle_deg or length < pr.min_length_m or ang * sign < 0:
            continue
        out.append(Turn(sign, ang, length, float(sg[lo]), float(sg[hi]), None if tg is None else float(tg[lo]), None if tg is None else float(tg[hi]),
                        float(np.max(np.abs(kap[lo:hi + 1]))), lo == 0 or hi == n - 1))
    return out
