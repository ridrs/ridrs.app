# SPDX-License-Identifier: AGPL-3.0-or-later
"""Speed against gradient: GPX elevation -> gradient over a distance window; vms relative speed -> log speed over the same window.

Both series live on one grid of GPS arc length (stops collapsed, as in rsm.quanta.gps). The vms speed is cut to the same distance windows through the
aligned video time of the GPS curve (GPS time - per-window lag of work/vangestel/align_<video>.json, reused from rsm.quanta.gps). The vms pairs are gated
exactly as in rsm.odometry (flags == 0); a window needs >= 50 % usable pairs. Nothing here is read by the matching pipeline.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.odometry import gating
from rsm.odometry.vms_csv import load_pairs
from rsm.quanta import gps, video

_PT = re.compile(r'<trkpt lat="([-\d.]+)" lon="([-\d.]+)">(.*?)</trkpt>', re.S)
ELE_SIGMA_M = 20.0
GRID_M = 25.0


def load_gpx_ele(path: Path) -> dict:
    txt = Path(path).read_text()
    lat, lon, ele, tt = [], [], [], []
    for m in _PT.finditer(txt):
        e = re.search(r"<ele>([^<]+)</ele>", m.group(3))
        t = re.search(r"<time>([^<]+)</time>", m.group(3))
        if e is None or t is None:
            continue
        lat.append(float(m.group(1))); lon.append(float(m.group(2))); ele.append(float(e.group(1)))
        tt.append(datetime.fromisoformat(t.group(1).replace("Z", "+00:00")).timestamp())
    t = np.array(tt) - tt[0]
    return dict(lat=np.array(lat), lon=np.array(lon), ele=np.array(ele), t=t)


def _utm(lon, lat):
    from pyproj import Transformer
    zone = int((np.mean(lon) + 180) // 6) + 1
    return Transformer.from_crs(4326, 32600 + zone, always_xy=True).transform(lon, lat)


def gps_profile(video_name: str, path: Path | None = None) -> dict:
    """arc length s (m, stops collapsed), elevation z(s) on a 1 m grid (Gaussian ELE_SIGMA_M), GPS time and aligned video time per s"""
    g = load_gpx_ele(path or gps.ROOT / video_name / "track.gpx")
    x, y = _utm(g["lon"], g["lat"])
    x, y = np.asarray(x), np.asarray(y)
    d = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    keep = np.concatenate([[True], np.diff(d) > 0.05])
    d, z, t = d[keep], g["ele"][keep], g["t"][keep]
    s = np.arange(0.0, d[-1], 1.0)
    zs = gaussian_filter1d(np.interp(s, d, z), ELE_SIGMA_M, mode="nearest")
    tg = np.interp(s, d, t)
    tv = np.maximum.accumulate(tg - gps.lag_fn(video_name)(tg))
    return dict(s=s, z=zs, t_gps=tg, t_vid=tv, length=float(d[-1]), n_raw=int(len(g["ele"])))


def gradient_at(prof: dict, centres: np.ndarray, win_m: float) -> np.ndarray:
    """mean gradient (rise over run, m/m) over [c - win/2, c + win/2]"""
    a = np.clip(centres - win_m / 2, 0, prof["length"] - 1); b = np.clip(centres + win_m / 2, 0, prof["length"] - 1)
    za = np.interp(a, prof["s"], prof["z"]); zb = np.interp(b, prof["s"], prof["z"])
    return (zb - za) / np.maximum(b - a, 1.0)


class Speed:
    """vms log relative speed with a cumulative sum for fast window means"""

    def __init__(self, vid: str, label: str = "refined", floor_rel: float = 0.02):
        cfg = video.config(label, vid)
        p = load_pairs(cfg["csv"])
        fl = gating.pair_flags(p)
        ok = (fl == 0) & np.isfinite(p.rel_speed)
        med = np.median(p.rel_speed[ok])
        self.t = p.time
        self.logv = np.where(ok, np.log(np.maximum(p.rel_speed, floor_rel * med)), 0.0)
        self.ok = ok
        self.cs = np.concatenate([[0.0], np.cumsum(self.logv)])
        self.cn = np.concatenate([[0], np.cumsum(ok)])
        self.med = float(med)

    def window_mean(self, t_a: np.ndarray, t_b: np.ndarray, min_valid: float = 0.5) -> np.ndarray:
        ia = np.searchsorted(self.t, t_a); ib = np.searchsorted(self.t, t_b)
        n = ib - ia
        nv = self.cn[ib] - self.cn[ia]
        with np.errstate(invalid="ignore", divide="ignore"):
            m = (self.cs[ib] - self.cs[ia]) / np.maximum(nv, 1)
        return np.where((n >= 3) & (nv >= min_valid * np.maximum(n, 1)), m, np.nan)


def aligned_series(vid: str, win_m: float, grid_m: float = GRID_M, prof: dict | None = None, spd: Speed | None = None) -> dict:
    """centres c (GPS arc length), gradient g, log vms speed lv, log GPS speed lg (window length / GPS time spent), aligned video time"""
    prof = prof or gps_profile(vid)
    spd = spd or Speed(vid)
    c = np.arange(win_m / 2, prof["length"] - win_m / 2, grid_m)
    g = gradient_at(prof, c, win_m)
    ta = np.interp(c - win_m / 2, prof["s"], prof["t_vid"]); tb = np.interp(c + win_m / 2, prof["s"], prof["t_vid"])
    lv = spd.window_mean(ta, tb)
    ga = np.interp(c - win_m / 2, prof["s"], prof["t_gps"]); gb = np.interp(c + win_m / 2, prof["s"], prof["t_gps"])
    lg = np.log(win_m / np.maximum(gb - ga, 1e-3))
    # vms coverage: video time must lie inside the vms time range
    inside = (ta >= spd.t[0]) & (tb <= spd.t[-1])
    lv = np.where(inside, lv, np.nan)
    return dict(c=c, g=g, lv=lv, lg=lg, t=0.5 * (ta + tb), win_m=win_m, grid_m=grid_m, length=prof["length"])
