# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reference angle scales (numpy / scipy only).

GPS (bike videos): f_eff = slope of the vms yaw px (sum over a window) on the GPS heading change (rad) over the same window, lag-corrected per
300 s window as in work/vangestel (align_*.json); windows of W s, robust IRLS slope, block bootstrap.
COLMAP (Gotthard, Cayolle, Amalfi): slope of vms heading increments on the COLMAP optical-axis heading increments, pooled over windows (see colmap_f_eff).
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

from .videos import ROOT, VAN


def load_gps(name: str):
    from pyproj import Transformer
    txt = (VAN / name / "track.gpx").read_text()
    pts = re.findall(r'<trkpt lat="([-\d.]+)" lon="([-\d.]+)">(.*?)</trkpt>', txt, re.S)
    lat = np.array([float(a) for a, _, _ in pts]); lon = np.array([float(b) for _, b, _ in pts])
    t = np.array([datetime.fromisoformat(re.search(r"<time>([^<]+)</time>", c).group(1).replace("Z", "+00:00")).timestamp() for _, _, c in pts])
    t -= t[0]
    zone = int((lon.mean() + 180) // 6) + 1
    x, y = Transformer.from_crs(4326, 32600 + zone, always_xy=True).transform(lon, lat)
    return t, np.asarray(x), np.asarray(y)


def gps_curve(name: str, step=1.0, sm=2.0):
    """Heading (rad, left positive, unwrapped) over arc length, and the time of each arc-length sample (same as work/vangestel vq.gps_curve)."""
    t, x, y = load_gps(name)
    d = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    keep = np.concatenate([[True], np.diff(d) > 0.05])
    d, x, y, t = d[keep], x[keep], y[keep], t[keep]
    s = np.arange(0, d[-1], step)
    xs = gaussian_filter1d(np.interp(s, d, x), sm / step, mode="nearest")
    ys = gaussian_filter1d(np.interp(s, d, y), sm / step, mode="nearest")
    th = np.unwrap(np.arctan2(np.gradient(ys, step), np.gradient(xs, step)))
    return dict(s=s, theta=th - th[0], t=np.interp(s, d, t))


def gps_theta(gc, tgrid):
    sg = np.interp(tgrid, gc["t"], gc["s"])
    return np.interp(sg, gc["s"], gc["theta"])


def lag_fn(gps_name: str):
    a = json.loads((ROOT / "work/vangestel" / f"align_{gps_name}.json").read_text())
    u = np.array(a["used"])  # (window centre, lag s); video t = gps t - lag
    return lambda t: np.interp(t, u[:, 0], u[:, 1])


def robust_slope(x, y, iters=40):
    w = np.ones_like(x)
    b = (x * y).sum() / (x * x).sum()
    for _ in range(iters):
        b = (w * x * y).sum() / (w * x * x).sum()
        r = y - b * x
        s = 1.4826 * np.median(np.abs(r)) + 1e-9
        w = 1 / np.maximum(1, np.abs(r) / (1.5 * s))
    return float(b)


def block_boot(x, y, block, n_boot=400, seed=1):
    n = len(x)
    nb = max(1, n // block)
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_boot):
        pick = rng.integers(0, nb, nb)
        idx = np.concatenate([np.arange(b * block, min(n, (b + 1) * block)) for b in pick])
        out.append(robust_slope(x[idx], y[idx]))
    return float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))


def gps_f_eff(gps_name: str, csv_path: str, W: int = 24, big_deg: float = 0.0, t_range=None) -> dict:
    """f_eff of the vms yaw against the GPS heading, windows of W s (non overlapping), only windows with >= 95 % usable pairs."""
    d = np.genfromtxt(csv_path, delimiter=",", names=True, dtype=float, filling_values=np.nan)
    t, yaw, inl, rms = d["time"], d["yaw"], d["inliers"], d["rms_px"]
    ok = np.isfinite(yaw) & (inl >= 20) & (rms <= 2.0)
    T = int(t[-1])
    sec = np.floor(t).astype(int)
    ysum = np.bincount(sec, weights=np.where(ok, yaw, 0), minlength=T + 2)
    cnt = np.bincount(sec, weights=ok.astype(float), minlength=T + 2)
    tot = np.bincount(sec, minlength=T + 2)
    # scale bins with some missing pairs up to the full bin
    ysum = np.where(tot > 0, ysum * tot / np.maximum(cnt, 1), 0.0)
    good = cnt >= 0.9 * np.maximum(tot, 1)
    cs, cg = np.concatenate([[0], np.cumsum(ysum)]), np.concatenate([[0], np.cumsum(good)])
    gc = gps_curve(gps_name)
    lag = lag_fn(gps_name)
    X, Y, T0 = [], [], []
    lo, hi = (10, T - W) if t_range is None else (int(t_range[0]), int(t_range[1]) - W)
    for a in range(lo, hi + 1, W):
        if cg[a + W] - cg[a] < 0.95 * W:
            continue
        ta = np.array([a, a + W], float)
        th = gps_theta(gc, ta + lag(ta + W / 2))
        X.append(th[1] - th[0]); Y.append(cs[a + W] - cs[a]); T0.append(a)
    X, Y = np.array(X), np.array(Y)
    sel = np.abs(np.degrees(X)) >= big_deg
    X, Y = X[sel], Y[sel]
    f = robust_slope(X, Y)
    lo, hi = block_boot(X, Y, 5)
    return dict(f_eff=f, lo=lo, hi=hi, n=int(len(X)), W=W, net_deg=float(np.degrees(np.abs(X)).sum()))


# ---------------------------------------------------------------- COLMAP
def colmap_windows():
    from ..bench.odo_colmap import load_route
    return load_route


def colmap_f_eff(windows, vms, f_nom: float, min_net_deg: float = 0.0, inc_s: float = 2.0, n_boot: int = 400, seed: int = 1) -> dict:
    """Pooled slope of vms heading increments (rad, at f_nom) on COLMAP optical-axis heading increments over the given windows
    (`rsm.bench.odo_colmap.Window`, `rsm.bench.odo_compare.Vms`): f_eff = f_nom * slope."""
    from ..bench import odo_compare as oc
    blocks, per = [], {}
    for w in windows:
        dx, dy = [], []
        for pc in oc.pieces_for(w, vms, f_nom):
            tg = oc._grid(w, pc)
            if len(tg) < 8:
                continue
            th = np.interp(tg, pc.t, pc.theta)
            rot = np.interp(tg, w.t, w.psi_rot)
            n = int(round(inc_s / oc.GRID_DT))
            idx = np.arange(0, len(tg) - n, n)
            dx.append(rot[idx + n] - rot[idx]); dy.append(th[idx + n] - th[idx])
        if not dx:
            continue
        dxa, dya = np.concatenate(dx), np.concatenate(dy)
        net = float(np.degrees(np.abs(dxa).sum()))
        per[w.name] = dict(net_deg=net, n=int(len(dxa)), slope=float((dxa @ dya) / (dxa @ dxa)) if dxa @ dxa > 0 else np.nan)
        if net < min_net_deg:
            continue
        for i in range(0, len(dxa), 5):
            blocks.append((dxa[i:i + 5], dya[i:i + 5]))
    if not blocks:
        return dict(f_eff=np.nan, n_blocks=0, per_window=per)
    sxx = sum(float(a @ a) for a, _ in blocks)
    slope = sum(float(a @ b) for a, b in blocks) / sxx
    rng = np.random.default_rng(seed)
    bs = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(blocks), len(blocks))
        bs.append(sum(float(blocks[i][0] @ blocks[i][1]) for i in pick) / sum(float(blocks[i][0] @ blocks[i][0]) for i in pick))
    return dict(f_eff=slope * f_nom, lo=float(np.percentile(bs, 2.5) * f_nom), hi=float(np.percentile(bs, 97.5) * f_nom), n_blocks=len(blocks), per_window=per)


def load_windows(route: str, min_images: int = 60):
    """COLMAP windows of a route in ../road-reconstruction/routes: kept model (+ other models if work/odometry/colmap has the export)."""
    from ..bench import odo_colmap as oc
    rd = ROOT.parent / "road-reconstruction" / "routes" / route
    mj = ROOT / "work/odometry/colmap" / f"{route}.models.json"
    if mj.exists():
        return oc.load_route(rd, mj, min_images)
    cj = json.loads((rd / "metadata" / "cameras.json").read_text())
    fr = cj["frame"] if "frame" in cj else None
    cams = cj["cameras"]
    t = np.array([c["time"] for c in cams])
    pos = np.array([c["position"] for c in cams])
    fwd = np.array([oc._quat_to_matrix(c["quaternion"]) @ np.array([0.0, 0.0, -1.0]) for c in cams])
    intr = cj["intrinsics"]
    h = intr["height"]
    return [oc._finish(route, route, "0", True, "metadata/cameras.json", t, np.column_stack([pos[:, 0], -pos[:, 2]]), np.column_stack([fwd[:, 0], -fwd[:, 2]]), None,
                       len(cams), intr["fx"] * 360 / h, intr["fy"] * 360 / h, h)]


def pick_turn_window(csv_path: str, dur: float = 60.0, first: float = 60.0) -> tuple[float, float]:
    """Start and net turning (px) of the `dur` s window with the largest sum of |vms yaw| per second (>= 95 % usable pairs). From the video alone, no GPS."""
    d = np.genfromtxt(csv_path, delimiter=",", names=True, dtype=float, filling_values=np.nan)
    t, yaw, inl = d["time"], d["yaw"], d["inliers"]
    ok = np.isfinite(yaw) & (inl >= 20)
    T = int(t[-1]); sec = np.floor(t).astype(int)
    ys = np.bincount(sec, weights=np.where(ok, yaw, 0), minlength=T + 2)
    good = np.bincount(sec, weights=ok.astype(float), minlength=T + 2) >= 0.9 * np.maximum(np.bincount(sec, minlength=T + 2), 1)
    # |net| per 4 s, summed over the window: curvature-rich windows; a window of one long hairpin counts as much as many bends
    W = int(dur); c4 = np.abs(np.convolve(ys, np.ones(4), "valid"))[::4]
    best = (-1.0, 0.0)
    cg = np.concatenate([[0], np.cumsum(good)])
    for a in range(int(first), T - W, 5):
        if cg[a + W] - cg[a] < 0.95 * W:
            continue
        sc = float(np.abs(np.convolve(ys[a:a + W], np.ones(4), "valid")[::4]).sum())
        if sc > best[0]:
            best = (sc, float(a))
    return best[1], best[0]


def load_kept_dir(route_dir) -> list:
    """The kept COLMAP model of a route folder (metadata/cameras.json) as a Window."""
    from ..bench import odo_colmap as oc
    route_dir = Path(route_dir)
    cj = json.loads((route_dir / "metadata" / "cameras.json").read_text())
    cams = cj["cameras"]
    t = np.array([c["time"] for c in cams])
    pos = np.array([c["position"] for c in cams])
    fwd = np.array([oc._quat_to_matrix(c["quaternion"]) @ np.array([0.0, 0.0, -1.0]) for c in cams])
    intr = cj["intrinsics"]
    h = intr["height"]
    return [oc._finish(route_dir.name, route_dir.name, "0", True, "metadata/cameras.json", t, np.column_stack([pos[:, 0], -pos[:, 2]]), np.column_stack([fwd[:, 0], -fwd[:, 2]]), None,
                       len(cams), intr["fx"] * 360 / h, intr["fy"] * 360 / h, h)]
