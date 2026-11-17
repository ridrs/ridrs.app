# SPDX-License-Identifier: AGPL-3.0-or-later
"""GPS track (read in place) as scoring truth and as the 'GPS quanta' upper bound.

Same processing as work/vangestel/code/{gpsload,vq}.py (frozen reference): UTM, arc length with stops collapsed, 1 m resample, Gaussian 2 m
on x,y, heading of the gradient, rsm turn detector with its defaults. Video time = GPS time - lag(t) with the per-window lag of
work/vangestel/align_<name>.json (windowed cross-correlation of the vms yaw rate, built by the calibration agent; reused, not recomputed).
GPS never feeds area, candidates or parameters; it is used for scoring, the map-matching of the truth and the upper-bound control.
"""
from __future__ import annotations

import json
import re
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.odometry.turns import TurnParams, detect_turns

from .qdef import TurnRec

ROOT = Path(__file__).resolve().parents[4] / "test-data" / "vangestel"  # Van Gestel rides, git-ignored (docs/README.md)
ALIGN = Path(__file__).resolve().parents[2] / "work" / "vangestel"
_PT = re.compile(r'<trkpt lat="([-\d.]+)" lon="([-\d.]+)">(.*?)</trkpt>', re.S)


def load_gpx(name: str) -> dict:
    txt = (ROOT / name / "track.gpx").read_text()
    lat, lon, tt = [], [], []
    for m in _PT.finditer(txt):
        lat.append(float(m.group(1)))
        lon.append(float(m.group(2)))
        tt.append(datetime.fromisoformat(re.search(r"<time>([^<]+)</time>", m.group(3)).group(1).replace("Z", "+00:00")).timestamp())
    t = np.array(tt) - tt[0]
    return dict(lat=np.array(lat), lon=np.array(lon), t=t)


def lag_fn(name: str):
    u = np.array(json.loads((ALIGN / f"align_{name}.json").read_text())["used"])
    if len(u) == 0:
        return lambda t: np.zeros_like(np.asarray(t, float))
    return lambda t: np.interp(t, u[:, 0], u[:, 1])


def gps_curve(name: str, crs: str, step: float = 1.0, sm: float = 2.0) -> dict:
    """Aligned GPS curve in the CRS `crs` (the graph's): s (arc length), theta (rad unwrapped, left+), t (video seconds), x, y."""
    from pyproj import Transformer
    g = load_gpx(name)
    x, y = Transformer.from_crs(4326, crs, always_xy=True).transform(g["lon"], g["lat"])
    x, y, t = np.asarray(x), np.asarray(y), g["t"]
    d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    keep = np.concatenate([[True], np.diff(d) > 0.05])
    d, x, y, t = d[keep], x[keep], y[keep], t[keep]
    s = np.arange(0, d[-1], step)
    xs = gaussian_filter1d(np.interp(s, d, x), sm / step, mode="nearest")
    ys = gaussian_filter1d(np.interp(s, d, y), sm / step, mode="nearest")
    th = np.unwrap(np.arctan2(np.gradient(ys, step), np.gradient(xs, step)))
    th = th - th[0]
    tg = np.interp(s, d, t)
    tv = np.maximum.accumulate(tg - lag_fn(name)(tg))
    return dict(name=name, s=s, theta=th, t=tv, t_gps=tg, x=xs, y=ys)


def pos_at(gc: dict, t) -> np.ndarray:
    """GPS position (N,2) at video time t (seconds)."""
    t = np.asarray(t, float)
    return np.column_stack([np.interp(t, gc["t"], gc["x"]), np.interp(t, gc["t"], gc["y"])])


def gps_turns(gc: dict, thr: float, params: TurnParams = TurnParams()) -> list[TurnRec]:
    ts = detect_turns(gc["s"], gc["theta"], gc["t"], replace(params, min_angle_deg=thr))
    return [TurnRec(t.sign, abs(t.angle_deg), t.length_m, t.s_start, t.s_end, t.t_start, t.t_end, seg=0) for t in ts]
