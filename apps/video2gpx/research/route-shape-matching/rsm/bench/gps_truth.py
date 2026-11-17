# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY: the Van Gestel GPS tracks as scoring truth for rsm.bench.regress and rsm.bench.lateral_eval (read in place; never an input of the pipeline).

GPS clock against video clock: the per-window lag of work/vangestel/align_<name>.json where it exists (dev videos, as rsm.quanta.gps), else estimated as in
work/blind/score.py: windowed correlation of the vms yaw rate with the GPS heading rate (300 s windows every 150 s, 0.1 s grid, span +-5 s, corr >= 0.7)."""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

ROOT = Path(__file__).resolve().parents[4] / "test-data" / "vangestel"  # Van Gestel rides, git-ignored (docs/README.md)
ALIGN = Path(__file__).resolve().parents[2] / "work" / "vangestel"
_PT = re.compile(r'<trkpt lat="([-\d.]+)" lon="([-\d.]+)">(.*?)</trkpt>', re.S)


def load_gpx(name: str):
    txt = (ROOT / name / "track.gpx").read_text()
    lat, lon, tt = [], [], []
    for m in _PT.finditer(txt):
        lat.append(float(m.group(1)))
        lon.append(float(m.group(2)))
        tt.append(datetime.fromisoformat(re.search(r"<time>([^<]+)</time>", m.group(3)).group(1).replace("Z", "+00:00")).timestamp())
    return np.array(lat), np.array(lon), np.array(tt) - tt[0]


def gps_base(name: str, crs: str, step: float = 1.0, sm: float = 2.0) -> dict:
    """GPS curve in the CRS `crs` on a 1 m grid: s, theta (unwrapped heading), tg (GPS seconds), x, y (2 m Gaussian)"""
    from pyproj import Transformer
    lat, lon, t = load_gpx(name)
    x, y = Transformer.from_crs(4326, crs, always_xy=True).transform(lon, lat)
    x, y = np.asarray(x), np.asarray(y)
    d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    keep = np.concatenate([[True], np.diff(d) > 0.05])
    d, x, y, t = d[keep], x[keep], y[keep], t[keep]
    s = np.arange(0, d[-1], step)
    xs = gaussian_filter1d(np.interp(s, d, x), sm / step, mode="nearest")
    ys = gaussian_filter1d(np.interp(s, d, y), sm / step, mode="nearest")
    th = np.unwrap(np.arctan2(np.gradient(ys, step), np.gradient(xs, step)))
    return dict(s=s, theta=th - th[0], tg=np.interp(s, d, t), x=xs, y=ys, n_points=len(lat), length_m=float(d[-1]), duration_s=float(t[-1]), spacing_m=float(np.median(np.diff(d))))


def vms_rate(csv: Path) -> np.ndarray:
    """per-second yaw rate (deg/s) of the motion step, NaN where fewer than 10 good pairs"""
    from rsm.odometry import gating
    from rsm.odometry.vms_csv import load_pairs
    p = load_pairs(csv)
    ok = gating.pair_flags(p) == 0
    om = np.degrees(p.yaw / 403.0) / p.dt
    T = int(p.time[-1])
    sec = np.floor(p.time).astype(int)
    num = np.bincount(sec[ok], weights=om[ok], minlength=T + 2)[:T + 2]
    cnt = np.bincount(sec[ok], minlength=T + 2)[:T + 2]
    return np.where(cnt > 10, num / np.maximum(cnt, 1), np.nan)


def fine_lag(om, gb, t0, t1, sig=2.0, span=5.0, step=0.1):
    v = om[t0:t1].copy()
    nanm = np.isnan(v)
    vs = gaussian_filter1d(np.where(nanm, 0, v), sig)
    w = gaussian_filter1d((~nanm).astype(float), sig)
    vs = np.where(w > 0.5, vs / np.maximum(w, 1e-6), np.nan)
    shifts = np.arange(-span, span + 1e-9, step)
    tg = np.arange(t0, t1) + 0.5
    cs = []
    for sh in shifts:
        gr = np.degrees(np.gradient(gaussian_filter1d(np.interp(tg + sh, gb["tg"], gb["theta"]), sig)))
        m = ~np.isnan(vs)
        cs.append(np.corrcoef(gr[m], vs[m])[0, 1] if m.sum() > 30 else np.nan)
    cs = np.array(cs)
    if np.all(np.isnan(cs)):
        return 0.0, np.nan
    i = int(np.nanargmax(cs))
    off = 0.0
    if 0 < i < len(cs) - 1:
        a, b, c = cs[i - 1], cs[i], cs[i + 1]
        den = a - 2 * b + c
        if den != 0:
            off = 0.5 * (a - c) / den * step
    return shifts[i] + off, cs[i]


def estimate_lags(om, gb, win=300, step=150, span=5.0, min_corr=0.7):
    T = min(len(om), int(gb["tg"][-1]) - 6)
    rows = []
    for a in range(0, max(T - win, 1) + 1, step):
        b = min(a + win, T)
        if b - a < win // 2:
            continue
        sh, c = fine_lag(om, gb, a, b, span=span)
        rows.append((0.5 * (a + b), float(sh), float(c)))
    return rows, [(t, s) for t, s, c in rows if c >= min_corr and abs(s) < span - 0.2]


def video_time_gps(name: str, crs: str, motion_csv: Path):
    """-> (tv: video second of every 1 m GPS sample (monotone), xy_of(t) -> (n,2) GPS position at video seconds t, lag info dict)"""
    gb = gps_base(name, crs)
    f = ALIGN / f"align_{name}.json"
    if f.exists():
        u = np.array(json.loads(f.read_text())["used"])
        src = f"work/vangestel/{f.name}"
    else:
        _, used = estimate_lags(vms_rate(motion_csv), gb)
        u = np.array(used)
        src = "estimated (yaw-rate correlation, span 5 s)"
    lag = (lambda t: np.interp(t, u[:, 0], u[:, 1])) if len(u) else (lambda t: np.zeros_like(np.asarray(t, float)))
    tv = np.maximum.accumulate(gb["tg"] - lag(gb["tg"]))
    xy_of = lambda t: np.column_stack([np.interp(t, tv, gb["x"]), np.interp(t, tv, gb["y"])])
    info = dict(source=src, n_windows=int(len(u)), median=float(np.median(u[:, 1])) if len(u) else None, min=float(u[:, 1].min()) if len(u) else None, max=float(u[:, 1].max()) if len(u) else None,
                gps_spacing_m=gb["spacing_m"])
    return tv, xy_of, info
