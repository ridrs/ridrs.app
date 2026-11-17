# SPDX-License-Identifier: AGPL-3.0-or-later
"""Independent checks of a decided route (no GPS): OSM tunnels against the dark video intervals, place names against signs, heading shape against COLMAP,
and the time series for a map / Street View check. All thresholds are in evidence.json (written before the route was looked at) or stated here a priori."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

from . import cfg

TOL_S = 10.0
SIGN_RADIUS_M = 600.0  # a priori: place node of a village within 600 m of the route at the sign time +-30 s
SIGN_WIN_S = 30.0


def step_series(route, g):
    """per route step: t, tunnel flag of the step's edge; plus gap intervals [(t_a, t_b, any gap edge tunnel)] between steps more than 2 s apart."""
    t = np.asarray(route.t, float)
    tun = np.asarray(g.edge_tunnel, bool)[np.asarray(route.E, int)]
    gaps = []
    gi = {}
    for tt, w in route.gap_edges:
        gi.setdefault(round(float(tt), 3), []).extend(int(x) for x in w)
    for k in range(len(t) - 1):
        if t[k + 1] - t[k] > 2.0:
            w = gi.get(round(float(t[k]), 3), []) + gi.get(round(float(t[k + 1]), 3), [])
            gaps.append((float(t[k]), float(t[k + 1]), bool(np.any(np.asarray(g.edge_tunnel, bool)[w])) if w else False, len(w)))
    return t, tun, gaps


def tunnel_grid(route, g, T):
    """1 s grid 0..T: True where the route is in an OSM tunnel edge (step edge, or the whole gap if a walked gap edge is a tunnel)."""
    t, tun, gaps = step_series(route, g)
    grid = np.zeros(int(T) + 2, bool)
    for a, f in zip(t, tun):
        if f:
            grid[int(round(a))] = True
    for a, b, f, n in gaps:
        if f:
            grid[int(a):int(b) + 1] = True
    # fill one-second holes between tunnel steps (steps are about 1-2 s apart)
    return np.convolve(grid.astype(int), np.ones(3, int), "same") > 0


def tunnel_check(route, g, intervals, T=7631, tol=TOL_S, n_perm=2000, seed=3):
    grid = tunnel_grid(route, g, T)
    cov = np.zeros(len(grid), bool)
    cov[int(route.t[0]):int(route.t[-1]) + 1] = True
    rows = []
    for iv in intervals:
        a, b = int(iv["t0"] - tol), int(iv["t1"] + tol) + 1
        hit = bool(grid[max(a, 0):b].any())
        near = None
        if not hit:  # nearest tunnel second
            idx = np.flatnonzero(grid)
            if len(idx):
                mid = 0.5 * (iv["t0"] + iv["t1"])
                near = float(idx[np.argmin(np.abs(idx - mid))] - mid)
        xy = np.array([np.interp(0.5 * (iv["t0"] + iv["t1"]), route.t, route.xy[:, 0]), np.interp(0.5 * (iv["t0"] + iv["t1"]), route.t, route.xy[:, 1])])
        rows.append(dict(t0=iv["t0"], t1=iv["t1"], hit=hit, nearest_tunnel_s=near, route_xy=xy.tolist(), covered=bool(cov[int(iv["t0"]):int(iv["t1"]) + 1].all())))
    # chance level: the same intervals against the route shifted in time
    rng = np.random.default_rng(seed)
    hits = sum(r["hit"] for r in rows)
    ge = 0
    base = []
    for _ in range(n_perm):
        sh = int(rng.integers(60, 1500)) * rng.choice([-1, 1])
        h = 0
        for iv in intervals:
            a, b = int(iv["t0"] - tol) + sh, int(iv["t1"] + tol) + 1 + sh
            if a < 0 or b > len(grid):
                a = max(a, 0); b = min(b, len(grid))
            h += bool(grid[a:b].any()) if b > a else 0
        base.append(h)
        ge += h >= hits
    return dict(rows=rows, hits=hits, n=len(rows), tunnel_share_of_route_time=float(grid[cov].mean()), shifted_hits_mean=float(np.mean(base)), shifted_hits_p95=float(np.percentile(base, 95)),
                p_shift=(ge + 1) / (n_perm + 1))


def tunnel_ways_on_route(route, g):
    """OSM tunnel runs on the route: [(t_start, t_end, length_m)] from the steps' edges."""
    t, tun, gaps = step_series(route, g)
    out, i = [], 0
    while i < len(t):
        if tun[i]:
            j = i
            while j + 1 < len(t) and tun[j + 1]:
                j += 1
            out.append((float(t[i]), float(t[j])))
            i = j + 1
        else:
            i += 1
    return out, gaps


def place_nodes(bbox, pbf=cfg.PBF, cache=cfg.WORK / "cache" / "places.json") -> list:
    """place=* nodes with a name inside the bbox (PBF read in place)."""
    if cache.exists():
        return json.loads(cache.read_text())
    import osmium
    out = []
    fp = osmium.FileProcessor(str(pbf), osmium.osm.NODE).with_filter(osmium.filter.KeyFilter("place"))
    for n in fp:
        if not n.is_node():
            continue
        t = n.tags
        nm = t.get("name")
        if nm is None or not n.location.valid():
            continue
        la, lo = n.location.lat, n.location.lon
        if bbox["south"] <= la <= bbox["north"] and bbox["west"] <= lo <= bbox["east"]:
            out.append(dict(name=nm, place=t.get("place"), lat=la, lon=lo))
    cache.write_text(json.dumps(out))
    return out


def place_check(route, g, places, name, t_sign, radius=SIGN_RADIUS_M, win=SIGN_WIN_S):
    """distance of the route (|t - t_sign| <= win) from the named place nodes; also the nearest named place to the route position at t_sign."""
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, g.crs, always_xy=True)
    P = [(p, tr.transform(p["lon"], p["lat"])) for p in places]
    k = (route.t >= t_sign - win) & (route.t <= t_sign + win)
    xy = route.xy[k] if k.any() else route.xy[[int(np.argmin(np.abs(route.t - t_sign)))]]
    x0 = np.array([np.interp(t_sign, route.t, route.xy[:, 0]), np.interp(t_sign, route.t, route.xy[:, 1])])
    cand = [(p, np.hypot(*(np.array(q) - xy).T).min()) for p, q in P if name.lower() in p["name"].lower()]
    near = sorted(((p["name"], p["place"], float(np.hypot(*(np.array(q) - x0)))) for p, q in P), key=lambda r: r[2])[:5]
    return dict(named=[dict(name=p["name"], place=p["place"], dist_m=float(d)) for p, d in cand], nearest_places_at_t=near, route_xy=x0.tolist())


def heading_series(t, xy, step=1.0, sm=3.0):
    tg = np.arange(np.ceil(t[0]), t[-1], step)
    x = gaussian_filter1d(np.interp(tg, t, xy[:, 0]), sm / step, mode="nearest")
    y = gaussian_filter1d(np.interp(tg, t, xy[:, 1]), sm / step, mode="nearest")
    h = np.unwrap(np.arctan2(np.gradient(y), np.gradient(x)))
    return tg, h


def colmap_shape(route, traj_json, t0=780.0, t1=960.0):
    """compare the heading change over video time of the route with the COLMAP camera path of the same window (angle only, scale-free).
    -> dict(corr of turn rate at the best lag in +-10 s, rms of the relative heading after removing nothing, net turns, same for the mirrored COLMAP and for the route
    shifted by other times)"""
    d = json.loads(Path(traj_json).read_text())
    P = np.array([[p["t"], p["x"], p["y"]] for p in d["points"]])
    tc, hc = heading_series(P[:, 0], P[:, 1:3], sm=3.0)
    tr_, hr = heading_series(np.asarray(route.t), np.asarray(route.xy), sm=3.0)
    tg = np.arange(max(t0, tc[0], tr_[0]) + 5, min(t1, tc[-1], tr_[-1]) - 5, 1.0)
    if len(tg) < 30:
        return dict(ok=False)

    def rate(tt, hh, tq):
        return np.gradient(np.interp(tq, tt, hh))

    def rel(tt, hh, tq):
        v = np.interp(tq, tt, hh)
        return v - v[0]

    rc = rate(tc, hc, tg)

    def score(tt, hh, sgn=1, shift=0.0):
        best = (-2, 0)
        for lag in range(-10, 11):
            rr = sgn * rate(tt, hh, tg + shift + lag)
            c = float(np.corrcoef(rc, rr)[0, 1]) if rr.std() > 0 else np.nan
            if c > best[0]:
                best = (c, lag)
        r = sgn * rel(tt, hh, tg + shift + best[1])
        rms = float(np.sqrt(np.mean((r - rel(tc, hc, tg)) ** 2)))
        return dict(corr=best[0], lag=best[1], rms_rad=rms)

    out = dict(ok=True, window=[float(tg[0]), float(tg[-1])], colmap_net_deg=float(np.degrees(hc[np.searchsorted(tc, tg[-1])] - hc[np.searchsorted(tc, tg[0])])),
               route_net_deg=float(np.degrees(np.interp(tg[-1], tr_, hr) - np.interp(tg[0], tr_, hr))))
    out["route"] = score(tr_, hr)
    out["route_mirrored"] = score(tr_, hr, sgn=-1)
    sh = []
    for s in list(range(-900, -60, 40)) + list(range(60, 900, 40)):
        if tg[0] + s > tr_[0] and tg[-1] + s < tr_[-1] - 12:
            sh.append(score(tr_, hr, shift=s)["corr"])
    out["shifted_corr"] = dict(n=len(sh), median=float(np.median(sh)), p95=float(np.percentile(sh, 95)), max=float(np.max(sh)))
    return out


def route_points(route, g, step=2.0, cp=None, fit_thr=0.45, out=None):
    """time series of the route: t, lat, lon, compass heading (deg from north, clockwise), locally-fitting flag, whether the point lies in a vms gap (interpolated)."""
    from scipy.ndimage import uniform_filter1d
    t = np.asarray(route.t, float)
    xy = np.asarray(route.xy, float)
    lc = uniform_filter1d(route.inc, 15, mode="nearest")
    tg = np.arange(np.ceil(t[0]), t[-1], step)
    x = gaussian_filter1d(np.interp(tg, t, xy[:, 0]), 2.0, mode="nearest")
    y = gaussian_filter1d(np.interp(tg, t, xy[:, 1]), 2.0, mode="nearest")
    dx, dy = np.gradient(x), np.gradient(y)
    hd = (np.degrees(np.arctan2(dx, dy)) + 360.0) % 360.0
    ll = g.to_wgs84(np.column_stack([x, y]))
    k = np.clip(np.searchsorted(t, tg), 1, len(t) - 1)
    in_gap = (t[k] - t[k - 1]) > 2.0
    fit = np.interp(tg, t, lc) <= fit_thr
    names = np.asarray(g.edge_name)
    E = np.asarray(route.E, int)
    ek = np.clip(np.searchsorted(t, tg), 0, len(t) - 1)
    pts = [dict(t=float(a), lat=float(b[1]), lon=float(b[0]), heading_deg=float(h), fitting=bool(f), in_vms_gap=bool(gp),
                road=str(names[E[e]]), tunnel=bool(g.edge_tunnel[E[e]])) for a, b, h, f, gp, e in zip(tg, ll, hd, fit, in_gap, ek)]
    return pts
