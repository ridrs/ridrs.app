# SPDX-License-Identifier: AGPL-3.0-or-later
"""Quantum record shared by video, GPS and map: (turn1, straight, turn2) with scale-free length ratios.

Arrays-of-fields (struct of arrays) so the index and the HMM can work vectorised. Angles are absolute degrees, signs +1 left / -1 right.
lr1 = ln(len1 / straight), lr2 = ln(len2 / straight), lrp = ln(straight_k / straight_{k-1}) (nan where undefined).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

FIELDS = ("sign1", "ang1", "sign2", "ang2", "len1", "len2", "straight", "lr1", "lr2", "lrp", "unc", "tm1", "tm2", "t0", "t1")


@dataclass
class TurnRec:
    """A detected turn in whatever frame (video seconds, GPS, map). s0/s1 are positions along the carrier curve (m)."""
    sign: int
    angle: float  # absolute degrees
    length: float
    s0: float
    s1: float
    t0: float = float("nan")
    t1: float = float("nan")
    seg: int = 0  # carrier (vms segment index); consecutive turns of different carriers have an uncertain straight
    clipped: bool = False


def quanta_from_turns(turns: list[TurnRec], straights: list[float] | None = None, unc: list[bool] | None = None) -> dict[str, np.ndarray]:
    """Consecutive turn pairs. `straights[k]` (m) between turn k and k+1 overrides s0 - s1 (needed across carriers); `unc[k]` marks a
    quantum whose length information is uncertain (gap crossed, clipped turn)."""
    n = len(turns) - 1
    out = {k: np.full(max(n, 0), np.nan) for k in FIELDS}
    out["unc"] = np.zeros(max(n, 0), bool)
    prev = float("nan")
    for k in range(max(n, 0)):
        a, b = turns[k], turns[k + 1]
        st = straights[k] if straights is not None else b.s0 - a.s1
        st_c = max(st, 1.0)
        out["sign1"][k], out["sign2"][k] = a.sign, b.sign
        out["ang1"][k], out["ang2"][k] = a.angle, b.angle
        out["len1"][k], out["len2"][k] = a.length, b.length
        out["straight"][k] = st
        out["lr1"][k], out["lr2"][k] = math.log(max(a.length, 1.0) / st_c), math.log(max(b.length, 1.0) / st_c)
        out["lrp"][k] = math.log(st_c / prev) if prev == prev else float("nan")
        prev = st_c
        out["tm1"][k], out["tm2"][k] = 0.5 * (a.t0 + a.t1), 0.5 * (b.t0 + b.t1)
        out["t0"][k], out["t1"][k] = a.t0, b.t1
        out["unc"][k] = bool(unc[k]) if unc is not None else False
    return out


def take(q: dict[str, np.ndarray], idx) -> dict[str, np.ndarray]:
    return {k: v[idx] for k, v in q.items()}


def mirror(q: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Left and right swapped (control)."""
    m = {k: v.copy() for k, v in q.items()}
    m["sign1"], m["sign2"] = -q["sign1"], -q["sign2"]
    return m
