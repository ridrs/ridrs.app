# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reader for the CSV that `vms motion` writes: frame,time,corners,tracked,inliers,rms_px,s,c,yaw,pitch,roll,diff,rel_speed.

One row per frame pair; `time` is the middle of the pair (video seconds); empty fields (no fit) become NaN. `yaw` is the
constant horizontal flow `a` (px per frame pair at 360 rows) of the model dx = s*X*U + c*U + a - r*Yc, dy = s*U^2 + b + r*X,
i.e. the flow on the horizon row, where the translation terms vanish. `s = v*dt/(f*h)` per pair, rel_speed = s/dt.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

import numpy as np

COLUMNS = ("frame", "time", "corners", "tracked", "inliers", "rms_px", "s", "c", "yaw", "pitch", "roll", "diff", "rel_speed")


@dataclass(frozen=True)
class Pairs:
    time: np.ndarray  # pair midpoints, video seconds
    inliers: np.ndarray
    rms_px: np.ndarray
    s: np.ndarray
    yaw: np.ndarray
    diff: np.ndarray
    rel_speed: np.ndarray
    dt: float  # seconds per pair (median spacing of `time`)
    c: np.ndarray | None = None  # fitted lateral term (CSV column `c`), used only by the optional horizon correction

    def __len__(self) -> int:
        return len(self.time)


def load_pairs(path: str | Path) -> Pairs:
    with open(path, newline="") as fh:
        rd = csv.DictReader(fh)
        missing = set(COLUMNS) - set(rd.fieldnames or ())
        if missing:
            raise ValueError(f"{path}: missing column(s) {sorted(missing)}")
        cols = {k: [] for k in ("time", "inliers", "rms_px", "s", "yaw", "diff", "rel_speed", "c")}
        for r in rd:
            for k, v in cols.items():
                x = r[k]
                v.append(float(x) if x != "" else np.nan)
    a = {k: np.array(v, dtype=np.float64) for k, v in cols.items()}
    if len(a["time"]) < 3:
        raise ValueError(f"{path}: fewer than 3 rows")
    if np.any(np.diff(a["time"]) <= 0):
        raise ValueError(f"{path}: time is not strictly increasing")
    return Pairs(a["time"], a["inliers"], a["rms_px"], a["s"], a["yaw"], a["diff"], a["rel_speed"], float(np.median(np.diff(a["time"]))), a["c"])
