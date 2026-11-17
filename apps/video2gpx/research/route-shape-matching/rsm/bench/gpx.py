# SPDX-License-Identifier: AGPL-3.0-or-later
"""GPX loading for the benchmark and the tests. Never imported by `rsm.core`."""
from __future__ import annotations

import math
from pathlib import Path

import gpxpy
import numpy as np
from scipy.ndimage import gaussian_filter1d

from ..core.trajectory import RelativeTrajectory

EARTH_R = 6371000.0
GPX_SIGMA_S = 4.0  # smoothing of GPX in time, as road-reconstruction alignment.gpx_distance

DOWNLOADS = Path.home() / "Downloads"
GPX_FILES = {
    "pennes": DOWNLOADS / "FR_Col_de_Pennes" / "FR_Col_de_Pennes.gpx",
    "menglonnais": DOWNLOADS / "FR_Le_petit_Menglonnais" / "FR_Le_petit_Menglonnais.gpx",
    "rousset": DOWNLOADS / "FR_Rousset_Part_4" / "FR_Col_de_Rousset_Die.gpx",
}


def load_gpx_local(path, require_time: bool = True) -> np.ndarray:
    """(t, x, y) with t seconds since the first point (NaN if the file has no time and `require_time` is False) (as road-reconstruction alignment.gpx_track),
    x east and y north in metres.

    Local equirectangular projection about the first point: x = R dlon cos(lat0), y = R dlat. Over
    the extent of one track (tens of km) the projection distorts distances by well under 1 %
    (the scale error grows with the squared distance from lat0; not measured here beyond the
    1 km case), which is far below the shape errors under study; pyproj would add a dependency.
    """
    with open(path) as f:
        g = gpxpy.parse(f)
    pts = [p for tr in g.tracks for seg in tr.segments for p in seg.points]
    if len(pts) < 2:
        raise ValueError(f"{path}: need at least 2 track points")
    if pts[0].time is None or any(p.time is None for p in pts):
        if require_time:
            raise ValueError(f"{path}: track points without time")
        t = np.full(len(pts), np.nan)
    else:
        t0 = pts[0].time
        t = np.array([(p.time - t0).total_seconds() for p in pts])
    lat0, lon0 = pts[0].latitude, pts[0].longitude
    x = np.radians([p.longitude - lon0 for p in pts]) * EARTH_R * math.cos(math.radians(lat0))
    y = np.radians([p.latitude - lat0 for p in pts]) * EARTH_R
    return np.column_stack([t, x, y])


def gpx_window(g: np.ndarray, t0: float, t1: float) -> RelativeTrajectory:
    """GPX position over video time t0..t1 (video time == GPX time since its first point), smoothed
    with a Gaussian of GPX_SIGMA_S seconds on a 0.5 s grid."""
    tt = np.arange(t0 - 30, t1 + 30, 0.5)
    x = gaussian_filter1d(np.interp(tt, g[:, 0], g[:, 1]), GPX_SIGMA_S / 0.5)
    y = gaussian_filter1d(np.interp(tt, g[:, 0], g[:, 2]), GPX_SIGMA_S / 0.5)
    k = (tt >= t0) & (tt <= t1)
    return RelativeTrajectory(np.column_stack([x[k], y[k]]))
