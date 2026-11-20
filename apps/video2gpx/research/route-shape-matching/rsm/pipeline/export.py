# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.pipeline export: the Incyclist GPX of a finished run (trim, speed-spike guard, standstill thinning, elevation from the
Copernicus DEM plus the cached national / regional sources (demsrc, ELEVATION_STRATEGY.md) with tunnel / bridge interpolation, robust
estimation and grade clamp) plus a JSON summary. No checkpoint: an export is cheap."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import numpy as np

from . import VERSION, dem as D, offset as O
from .common import emit, frozen_info, jdump, jload
from .steps_d import ATTRIB, fmt, out_grid, parse_time

VMAX = {"bike": 25.0, "motorcycle": 50.0, "car": 50.0}   # m/s, plausible maximum per vehicle (speed-spike guard)
STAND_M = 0.5        # standstill thinning: at most one point per 0.5 m of progress
MIN_STEP_M = 0.1     # kept points are at least this far apart (no exact duplicates)
DEM_PAD_M = 500.0    # tiles cover the route bbox plus this margin
EPOCH0 = "2000-01-01T00:00:00Z"
NS_RSM = "https://ridrs.org/rsm/1"
NS_GTE = "http://www.gpstrackeditor.com/xmlschemas/General/1"


def progress(pct: float, phase: str):
    emit({"type": "step", "id": "export", "index": 1, "of": 1, "state": "running", "pct": round(float(pct), 1), "phase": phase})


def corrected_elevation(dem_dir: Path, glat: np.ndarray, glon: np.ndarray, grid: np.ndarray, tunnel: np.ndarray, bridge: np.ndarray,
                        diag: dict | None = None) -> tuple[np.ndarray, np.ndarray, dict]:
    """road elevation every SAMPLE_M along the path from the Copernicus tiles in dem_dir plus whatever extra sources are cached under
    dem_dir/<source>/ (demsrc; none cached = exactly the P13 profile of Copernicus) -> (z, z_raw Copernicus at the axis, stats incl.
    sources_used, source, attribution). `diag` (a dict, optional) receives the arrays of the elevation view (see elevation_diag); the
    result does not depend on it."""
    from . import demsrc as S
    dm = D.Dem(dem_dir)
    multi = S.Multi(dem_dir) if D.MULTI_SOURCE else None
    try:
        Sm = D.collect_samples(glat, glon, dm, multi)
        z_raw = Sm["cop"]["z"][:, 1]
        if multi is None:
            z, st = D.profile(grid, z_raw, tunnel, bridge)
            st["sources_used"] = ["copernicus"]
            if diag is not None:
                diag.update(z_p13=z, gap=np.zeros(len(z), bool), rug=np.zeros(len(z)), w_dtm=np.zeros(len(z)), est=None, S=Sm)
        else:
            z, st = D.profile_multi(grid, Sm, tunnel, bridge, diag=diag)
        if diag is not None:
            diag["S"] = Sm
    finally:
        dm.close()
        if multi is not None:
            multi.close()
    used = st["sources_used"]
    st["source"] = " + ".join(["Copernicus DEM GLO-30"] + [S.SOURCES[n].title for n in used if n in S.SOURCES])
    st["attribution"] = "; ".join([D.ATTRIB_DEM] + [S.SOURCES[n].attribution for n in used if n in S.SOURCES and n != "cop_flm"])
    st["sources"] = [dict(name="copernicus", title="Copernicus DEM GLO-30", licence="Copernicus DEM licence", attribution=D.ATTRIB_DEM)] + [
        dict(name=n, title=S.SOURCES[n].title, licence=S.SOURCES[n].licence, attribution=S.SOURCES[n].attribution) for n in used if n in S.SOURCES]
    return z, z_raw, st


# ------------------------------------------------------------------ elevation diagnostics (elevation_diag.json, for the app's Hoehe stage)
DIAG_VERSION = 2
DIAG_FILE = "elevation_diag.json"
GRADE_WIN_M = 50.0     # window of the maximum grade


def _arr(x, nd: int) -> list:
    """rounded list, NaN -> None (compact JSON arrays)"""
    a = np.asarray(x, float)
    return [round(float(v), nd) if np.isfinite(v) else None for v in a]


def route_blocks(glat: np.ndarray, glon: np.ndarray, dem_dir: Path) -> dict:
    """blocks of the extra sources that the route has in the cache (offline): {source: n present}. A profile made from other blocks is stale."""
    from . import demsrc as S
    p = S.plan(glat, glon, Path(dem_dir))
    return {n: int(v["blocks"]) - int(v["missing"]) for n, v in p["sources"].items()}


def elevation_diag(d: dict, z: np.ndarray, st: dict, ds: float = D.SAMPLE_M, s0: float = 0.0) -> dict:
    """what the profile was made of, on its grid (index i = arc s0 + i * ds); `d` is the diag dict filled by corrected_elevation.
    Per source: z the axis sample (cross-slope corrected, datum-aligned like the estimator sees it), w the plausibility the estimator gave the
    sample at its last pass (0..1; null where the estimator did not run), sh the share of the source in the final height (0..1)."""
    from . import demsrc as S
    z = np.asarray(z, float)
    n = len(z)
    Sm, est = d["S"], d.get("est")
    w_dtm = np.clip(np.asarray(d["w_dtm"], float), 0, 1)
    Zst = D._stack(Sm, ds)[0]
    tot = est["w"].sum(1) if est else np.zeros(n)
    srcs, off, share = [], 0, {}
    for name, nc in D.stack_columns(Sm):
        o = np.asarray(Sm[name]["o"], float)
        j = int(np.argmin(np.abs(o)))
        zz = Zst[:, off + j]
        sh_est = (est["w"][:, off:off + nc].sum(1) / np.where(tot > 0, tot, 1.0)) if est else np.zeros(n)
        sh = w_dtm * sh_est + (1.0 - w_dtm) * (1.0 if name == "cop" else 0.0)
        out_name = "copernicus" if name == "cop" else name
        info = S.SOURCES.get(out_name)
        srcs.append(dict(name=out_name, title=info.title if info else "Copernicus DEM GLO-30", colour=len(srcs), z=_arr(zz, 1),
                         w=_arr(est["cau"][:, off + j], 2) if est else None, sh=_arr(sh, 2)))
        share[out_name] = round(float(sh.mean()), 3)
        off += nc
    k = max(1, int(round(GRADE_WIN_M / ds)))
    g = np.abs(z[k:] - z[:-k]) / (k * ds) * 100.0 if n > k else np.zeros(0)
    up, down = D.ascent_descent(z)
    up13, down13 = D.ascent_descent(np.asarray(d["z_p13"], float))
    robust = float((w_dtm >= 0.5).mean()) if n else 0.0
    return dict(version=DIAG_VERSION, ds=ds, s0=s0, n=n, pipeline_hash=frozen_info().get("code_hash"),
                z_p13=_arr(d["z_p13"], 1), rug=_arr(d["rug"], 2), filled=[int(v) for v in ~np.isin(Sm["flm"][:, 1], D.FLM_TDX)],
                gap=[int(v) for v in np.asarray(d["gap"], bool)], w_dtm=_arr(w_dtm, 2), sources=srcs,
                strategy_share=dict(robust=round(robust, 3), p13=round(1.0 - robust, 3)), source_share=share,
                max_grade_pct=round(float(g.max()), 1) if len(g) else 0.0,
                ascent_p13_m=round(up13, 1), descent_p13_m=round(down13, 1), ascent_m=round(up, 1), descent_m=round(down, 1))


# ------------------------------------------------------------------ pieces (unit-tested)
def add_still_edges(R, t: np.ndarray, s: np.ndarray, conf: np.ndarray):
    """the exported raster times plus the exact start and end of every sure standstill inside them (refine/result.npz still_*), in time order
    -> (t, s, conf, in_still). Old results without standstills: unchanged, in_still all False."""
    t, s, conf = np.asarray(t, float), np.asarray(s, float), np.asarray(conf, float)
    if "in_still" not in R.files or len(t) == 0:
        return t, s, conf, np.zeros(len(t), bool)
    gt, gs = ("gx_t", "gx_in_still") if "gx_t" in R.files else ("t", "in_still")     # the GPX raster, old results: their 1 s grid
    in_still = np.interp(t, R[gt].astype(float), R[gs].astype(float)) > 0.5
    et, es, ec = [], [], []
    for t0, t1, s0, cv in zip(R["still_t0"], R["still_t1"], R["still_s0"], R["still_conf"]):
        for te in (float(t0), float(t1)):
            if t[0] <= te <= t[-1] and np.isfinite(s0) and not np.any(np.abs(t - te) < 1e-6):
                et.append(te); es.append(float(s0)); ec.append(float(cv))
    if not et:
        return t, s, conf, in_still
    tt = np.concatenate([t, et]); o = np.argsort(tt, kind="stable")
    return tt[o], np.concatenate([s, es])[o], np.concatenate([conf, ec])[o], np.concatenate([in_still, np.ones(len(et), bool)])[o]


def trim_span(extrap: np.ndarray, mode: str = "auto") -> tuple[int, int]:
    """[i0, i1] inclusive of the exported raster points: the decoded span (extrapolated seconds before and after are dropped)"""
    n = len(extrap)
    if mode == "off" or n == 0:
        return 0, n - 1
    ok = np.flatnonzero(~np.asarray(extrap, bool))
    if len(ok) == 0:
        return 0, n - 1
    return int(ok[0]), int(ok[-1])


def start_frame(t_first: float, fps: float) -> int:
    return int(round(t_first * fps)) + 1


def speed_guard(s: np.ndarray, dt: np.ndarray | float, vmax: float, max_iter: int = 50) -> tuple[np.ndarray, int]:
    """s monotone positions at times with steps dt. Every step faster than vmax is capped; its excess distance is spread over the
    neighbouring steps (growing window) up to their headroom, so the start, the end and the total length stay. -> (s, steps fixed)"""
    s = np.maximum.accumulate(np.asarray(s, float))
    if len(s) < 2:
        return s, 0
    d = np.diff(s)
    dt = np.broadcast_to(np.asarray(dt, float), d.shape).astype(float)
    cap = vmax * dt
    fixed = int((d > cap + 1e-9).sum())
    for _ in range(max_iter):
        bad = np.flatnonzero(d > cap + 1e-9)
        if len(bad) == 0:
            break
        i = int(bad[0])
        lo, hi = i, i + 1
        while True:
            seg, c = d[lo:hi], cap[lo:hi]
            if seg.sum() <= c.sum() or (lo == 0 and hi == len(d)):
                break
            lo, hi = max(0, lo - 1), min(len(d), hi + 1)
        seg, c = d[lo:hi].copy(), cap[lo:hi]
        tot = seg.sum()
        if tot > c.sum():                      # cannot be satisfied anywhere: uniform at the mean speed
            d[lo:hi] = tot * dt[lo:hi] / dt[lo:hi].sum()
            break
        over = np.maximum(seg - c, 0).sum()
        seg = np.minimum(seg, c)
        room = c - seg
        seg += over * room / room.sum()
        d[lo:hi] = seg
    return s[0] + np.concatenate([[0.0], np.cumsum(d)]), fixed


def thin_standstills(s: np.ndarray, step: float = STAND_M, min_step: float = MIN_STEP_M) -> tuple[np.ndarray, np.ndarray]:
    """indices to keep and the (possibly nudged) positions: at most one point per `step` of progress, but the first and the last second of a
    standstill are both kept (so the video time of the standstill maps to almost no distance and Incyclist passes over it). No two kept
    points closer than min_step."""
    s = np.asarray(s, float).copy()
    n = len(s)
    if n == 0:
        return np.zeros(0, int), s
    keep = [0]
    for i in range(1, n):
        if s[i] - s[keep[-1]] >= step:
            if i - 1 != keep[-1]:
                j = i - 1                                   # last second of the standstill
                if s[j] - s[keep[-1]] < min_step:
                    s[j] = s[keep[-1]] + min_step
                keep.append(j)
            keep.append(i)
    if keep[-1] != n - 1 and s[n - 1] - s[keep[-1]] >= min_step:
        keep.append(n - 1)
    k = np.array(keep, int)
    return k, s


def point_speed(s: np.ndarray, t: np.ndarray) -> np.ndarray:
    """m/s at each point: central difference (one-sided at the ends)"""
    if len(s) < 2:
        return np.zeros(len(s))
    return np.gradient(s, t)


# ------------------------------------------------------------------ bridges of results made before refine stored them
def bridges_from_graph(g, xy: np.ndarray, tol_m: float = 2.0, max_angle_deg: float = 30.0) -> np.ndarray:
    """mark path points (1 m grid) that lie on a bridge edge of the graph (within tol, nearly parallel). The path polyline is the OSM
    geometry itself, so an edge the path runs on is at ~0 m; a bridge crossing over the road is rejected by the angle."""
    from scipy.spatial import cKDTree
    out = np.zeros(len(xy), bool)
    eb = np.flatnonzero(np.asarray(g.edge_bridge, bool))
    if len(eb) == 0 or len(xy) < 2:
        return out
    pts, dirs = [], []
    for e in eb:
        p = g.geom(int(e))
        if len(p) < 2:
            continue
        seg = np.diff(p, axis=0)
        L = np.hypot(*seg.T)
        for a, v, l in zip(p[:-1], seg, L):
            if l <= 0:
                continue
            k = max(1, int(np.ceil(l)))
            f = (np.arange(k) / k)[:, None]
            pts.append(a + f * v)
            dirs.append(np.repeat((v / l)[None], k, axis=0))
        pts.append(p[-1:]); dirs.append((seg[-1] / max(L[-1], 1e-9))[None])
    P, Dn = np.vstack(pts), np.vstack(dirs)
    tree = cKDTree(P)
    dist, idx = tree.query(xy, distance_upper_bound=tol_m + 0.75)
    hit = np.isfinite(dist)
    if not hit.any():
        return out
    pd = np.gradient(xy, axis=0)
    pd /= np.maximum(np.hypot(*pd.T), 1e-9)[:, None]
    cosang = np.abs((pd[hit] * Dn[idx[hit]]).sum(1))
    out[np.flatnonzero(hit)[cosang >= np.cos(np.radians(max_angle_deg))]] = True
    return out


# ------------------------------------------------------------------ GPX
def write_gpx(path: Path, rows: list[dict], meta: dict) -> None:
    has_ele = any(r.get("ele") is not None for r in rows)
    link = f'<link href={quoteattr(meta["link"])}><text>{escape(meta.get("link_text") or meta["link"])}</text></link>' if meta.get("link") else ""
    head = (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<gpx version="1.1" creator={quoteattr(meta["creator"])} xmlns="http://www.topografix.com/GPX/1/1" xmlns:gte="{NS_GTE}" xmlns:rsm="{NS_RSM}">\n'
            f'<metadata><name>{escape(meta["name"])}</name><desc>{escape(meta["desc"])}</desc>'
            f'<author><name>video2gpx</name></author>'
            f'<copyright author="OpenStreetMap contributors"><year>{meta["year"]}</year><license>https://opendatacommons.org/licenses/odbl/</license></copyright>'
            f'{link}<time>{meta["time"]}</time>'
            f'<extensions><rsm:verdict>{escape(meta["verdict"])}</rsm:verdict><rsm:driving_line>approximation</rsm:driving_line>'
            f'<rsm:elevation>{escape(meta.get("elevation_sources") or "copernicus-glo30") if has_ele else "none"}</rsm:elevation><rsm:start_frame>{meta["start_frame"]}</rsm:start_frame>'
            f'<rsm:pipeline_hash>{escape(str(meta.get("pipeline") or ""))}</rsm:pipeline_hash><rsm:attribution>{escape(meta["attribution"])}</rsm:attribution></extensions></metadata>\n'
            f'<trk><name>{escape(meta["name"])}</name><trkseg>\n')
    out = []
    for r in rows:
        ele = f'<ele>{r["ele"]:.1f}</ele>' if r.get("ele") is not None else ""
        out.append(f'<trkpt lat="{r["lat"]:.7f}" lon="{r["lon"]:.7f}">{ele}<time>{r["time"]}</time>'
                   f'<extensions><gte:gps speed="{r["speed_kmh"]:.1f}"/><rsm:conf>{r["conf"]:.3f}</rsm:conf></extensions></trkpt>')
    Path(path).write_text(head + "\n".join(out) + "\n</trkseg></trk></gpx>\n", encoding="utf-8")


# ------------------------------------------------------------------ main
def current_profile(out: Path, dem_dir: Path) -> dict | None:
    """out/elevation_profile.json if it is current: made by this pipeline code (hash), after the result, from the extra blocks that are cached now.
    Otherwise None (the caller computes the elevation itself)."""
    out = Path(out)
    f, res = out / "elevation_profile.json", out / "refine" / "result.npz"
    try:
        if not f.exists() or f.stat().st_mtime < res.stat().st_mtime:
            return None
        p = jload(f)
        h = frozen_info().get("code_hash")
        if not h or p.get("pipeline_hash") != h or not isinstance(p.get("blocks"), dict) or not p.get("z") or not isinstance(p.get("corrections"), dict):
            return None
        lat, lon = path_lonlat(out)
        return p if route_blocks(lat, lon, dem_dir) == p["blocks"] else None
    except (OSError, ValueError, KeyError):
        return None


def export(out: Path, dest: Path, summary_path: Path, dem_dir: Path | None, fps: float | None = None, trim: str = "auto", start_time: str | None = None,
           title: str | None = None, link: str | None = None, creator_app: str | None = None, use_profile: bool = True) -> dict:
    from pyproj import Transformer
    out = Path(out)
    R = np.load(out / "refine" / "result.npz")
    proj = jload(out / "project.json")
    eff = proj["effective"]
    veh, off, side = eff["vehicle"], float(eff["offset_m"]), eff["traffic_side"]
    progress(5, "load")
    sg, xy = R["sg"], R["xy"]
    PL, _dl, _g = O.driving_line(xy, off, side, R["oneway"])
    tr = Transformer.from_crs(str(R["crs"]), 4326, always_xy=True)
    G = out_grid(R)                                        # the GPX raster (C.GPX_HZ per video second; old results: their 1 s grid)
    t_all, s_all, conf_all, extrap = G["t"], G["s"], G["conf"], G["extrap"]
    i0, i1 = trim_span(extrap, trim)
    t, s, conf = t_all[i0:i1 + 1], s_all[i0:i1 + 1], conf_all[i0:i1 + 1]
    t, s, conf, still = add_still_edges(R, t, s, conf)
    s_mono = np.maximum.accumulate(s)
    vmax = VMAX.get(veh, 50.0)
    dt_g = np.where(still[1:] & still[:-1], 0.0, np.diff(t)) if len(t) > 1 else 1.0   # no capped excess is spread into a sure standstill
    s_g, n_spikes = speed_guard(s_mono, dt_g, vmax)
    s_g = np.clip(s_g, 0.0, float(sg[-1]))
    keep, s_k = thin_standstills(s_g)
    t_k, s_k, conf_k, still_k = t[keep], s_k[keep], conf[keep], still[keep]
    progress(20, "positions")
    px, py = np.interp(s_k, sg, PL[:, 0]), np.interp(s_k, sg, PL[:, 1])
    lon, lat = tr.transform(px, py)
    lon, lat = np.asarray(lon, float), np.asarray(lat, float)
    spd = np.where(still_k, 0.0, point_speed(s_k, t_k))     # a sure standstill stands, also at its edges

    # --- elevation
    ele_info: dict = dict(source=None)
    ele_pts = None
    bb = D.expand_bbox(lat, lon, DEM_PAD_M)
    tiles = D.tiles_for_bbox(*bb)
    ele_info["tiles"] = tiles
    if dem_dir is None:
        ele_info.update(missing=tiles, note="no --dem-dir: exported without elevation")
    else:
        dm = D.Dem(dem_dir)
        miss = dm.missing(tiles)
        if miss:
            ele_info.update(missing=miss, note="DEM tiles missing: exported without elevation")
        else:
            progress(35, "elevation")
            a, b = float(s_k[0]), float(s_k[-1])
            prof = current_profile(out, dem_dir) if use_profile else None
            if prof is not None:
                # the Hoehe stage already made the profile: heights per point are interpolated from it at each point's arc (no second computation)
                pz = np.asarray(prof["z"], float)
                pg = float(prof.get("s0", 0.0)) + np.arange(len(pz)) * float(prof["ds"])
                ele_pts = np.interp(s_k, pg, pz)
                zg = np.interp(np.arange(a, b + D.SAMPLE_M, D.SAMPLE_M), pg, pz)
                up, down = D.ascent_descent(zg)
                ele_info.update(missing=[], bridge_source="profile", profile_reused=True, ascent_m=round(up, 1), descent_m=round(down, 1),
                                min_m=round(float(zg.min()), 1), max_m=round(float(zg.max()), 1), **prof["corrections"])
                ele_info["source"], ele_info["attribution"], ele_info["sources"] = prof["source"], prof["attribution"], prof["sources"]
                dm.close()
            else:
                grid = np.arange(a, b + D.SAMPLE_M, D.SAMPLE_M)
                gx, gy = np.interp(grid, sg, PL[:, 0]), np.interp(grid, sg, PL[:, 1])
                glon, glat = tr.transform(gx, gy)
                progress(60, "corrections")
                gi = np.clip(np.rint(grid).astype(int), 0, len(sg) - 1)
                tunnel = np.asarray(R["tunnel"], bool)[gi]
                if "bridge" in R.files:
                    bridge, bsrc = np.asarray(R["bridge"], bool)[gi], "refine"
                else:
                    bsrc = "none"
                    bridge = np.zeros(len(gi), bool)
                    gf = out / "map" / "graph_real.npz"
                    if gf.exists():
                        from rsm.network.graph import NetGraph
                        bridge = bridges_from_graph(NetGraph.load(gf), xy)[gi]
                        bsrc = "map graph (search road classes)"
                dm.close()
                z, z_raw, st = corrected_elevation(dem_dir, np.asarray(glat), np.asarray(glon), grid, tunnel, bridge)
                ele_pts = np.interp(s_k, grid, z)
                up, down = D.ascent_descent(z)
                ele_info.update(missing=[], bridge_source=bsrc, ascent_m=round(up, 1), descent_m=round(down, 1),
                                min_m=round(float(z.min()), 1), max_m=round(float(z.max()), 1), raw_vs_final_abs_mean_m=round(float(np.mean(np.abs(z - z_raw))), 2), **st)
    progress(80, "write")

    # --- times: the first exported second is 2000-01-01T00:00:00Z unless the user set the video start time (then start + t)
    base = parse_time(start_time) if start_time else parse_time(EPOCH0) - timedelta(seconds=float(t_k[0]))
    times = [fmt(base + timedelta(seconds=float(x))) for x in t_k]
    rows = [dict(lat=float(a_), lon=float(b_), ele=(float(ele_pts[k]) if ele_pts is not None else None), time=times[k], speed_kmh=max(0.0, float(spd[k]) * 3.6), conf=float(conf_k[k]))
            for k, (a_, b_) in enumerate(zip(lat, lon))]
    fps_ = float(fps) if fps else None
    sf = start_frame(float(t_k[0]), fps_) if fps_ else None
    pipe = frozen_info().get("code_hash")
    name = title or Path(proj["params"]["video"]).stem
    conf_dec = conf_all[i0:i1 + 1][~extrap[i0:i1 + 1]]     # the exported raster points, not the inserted standstill edges
    cm = float(conf_dec.mean()) if len(conf_dec) else 0.0
    low = float((conf_dec < 0.5).mean()) if len(conf_dec) else 1.0
    desc = (f"Reconstructed from the video, no GPS. {proj['driving_line']['rule']} Verdict: {proj['verdict']} ({proj.get('verdict_basis', '')}); "
            f"mean confidence {cm:.2f}, {100 * low:.0f} % of the time below 0.5. Map data {ATTRIB}."
            + (f" Elevation: {ele_info['attribution']}." if ele_pts is not None else " No elevation."))
    meta = dict(name=name, desc=desc, year=datetime.now().year, link=link, time=times[0], verdict=proj["verdict"], start_frame=sf if sf is not None else "",
                pipeline=pipe, attribution=ATTRIB + ("; " + ele_info["attribution"] if ele_pts is not None else ""),
                elevation_sources="+".join(["copernicus-glo30"] + [n for n in ele_info.get("sources_used", []) if n not in ("copernicus", "cop_flm")]),
                creator=f"video2gpx {creator_app or '?'} / rsm.pipeline {VERSION} {pipe or ''}".strip())
    write_gpx(Path(dest), rows, meta)
    # country hint: the start (the app reverse-geocodes it)
    summ = dict(gpx=str(dest), points=len(rows), seconds_exported=int(round(t_all[i1] - t_all[i0])) + 1, points_thinned=int(len(t) - len(rows)), points_per_second=G["hz"],
                trimmed_head_s=int(round(t_all[i0] - t_all[0])), trimmed_tail_s=int(round(t_all[-1] - t_all[i1])), t_first=float(t_k[0]), t_last=float(t_k[-1]), fps=fps_, start_frame=sf,
                length_m=round(float(s_k[-1] - s_k[0]), 1), ascent_m=ele_info.get("ascent_m"), descent_m=ele_info.get("descent_m"), elevation=ele_info,
                speed_guard=dict(vmax_ms=vmax, steps_fixed=n_spikes), standstill=dict(step_m=STAND_M, min_step_m=MIN_STEP_M),
                start=dict(lat=float(lat[0]), lon=float(lon[0])), end=dict(lat=float(lat[-1]), lon=float(lon[-1])),
                bbox=dict(south=float(lat.min()), west=float(lon.min()), north=float(lat.max()), east=float(lon.max())),
                confidence_mean=round(cm, 4), confidence_below_05=round(low, 4), verdict=proj["verdict"], verdict_basis=proj.get("verdict_basis"),
                vehicle=veh, offset_m=off, traffic_side=side, start_time=times[0], pipeline_hash=pipe, version=VERSION)
    jdump(Path(summary_path), summ)
    progress(100, "done")
    return summ


def path_lonlat(out: Path) -> tuple[np.ndarray, np.ndarray]:
    """positions every SAMPLE_M along the whole decoded path, on the driving line (what the profile samples) -> (lat, lon)"""
    from pyproj import Transformer
    out = Path(out)
    R = np.load(out / "refine" / "result.npz")
    eff = jload(out / "project.json")["effective"]
    sg = R["sg"]
    PL, _dl, _g = O.driving_line(R["xy"], float(eff["offset_m"]), eff["traffic_side"], R["oneway"])
    grid = np.arange(0.0, float(sg[-1]) + D.SAMPLE_M, D.SAMPLE_M)
    glon, glat = Transformer.from_crs(str(R["crs"]), 4326, always_xy=True).transform(np.interp(grid, sg, PL[:, 0]), np.interp(grid, sg, PL[:, 1]))
    return np.asarray(glat, float), np.asarray(glon, float)


def elevation_profile(out: Path, dest: Path, dem_dir: Path | None) -> dict:
    """Elevation along the WHOLE decoded path for the app's playback profile: corrected DEM elevation every SAMPLE_M metres of centre-line arc
    (the arc of route_points.json `arc_m`), sampled on the driving line, same corrections as the export. Writes dest (JSON). Raises ValueError if tiles are missing."""
    from pyproj import Transformer
    out = Path(out)
    R = np.load(out / "refine" / "result.npz")
    proj = jload(out / "project.json")
    eff = proj["effective"]
    sg, xy = R["sg"], R["xy"]
    PL, _dl, _g = O.driving_line(xy, float(eff["offset_m"]), eff["traffic_side"], R["oneway"])
    tr = Transformer.from_crs(str(R["crs"]), 4326, always_xy=True)
    progress(10, "load")
    grid = np.arange(0.0, float(sg[-1]) + D.SAMPLE_M, D.SAMPLE_M)
    gx, gy = np.interp(grid, sg, PL[:, 0]), np.interp(grid, sg, PL[:, 1])
    glon, glat = (np.asarray(v, float) for v in tr.transform(gx, gy))
    tiles = D.tiles_for_bbox(*D.expand_bbox(glat, glon, DEM_PAD_M))
    if dem_dir is None:
        raise ValueError(f"no DEM directory; tiles needed: {', '.join(tiles)}")
    dm = D.Dem(dem_dir)
    miss = dm.missing(tiles)
    if miss:
        raise ValueError(f"DEM tiles missing: {', '.join(miss)}")
    dm.close()
    progress(30, "elevation")
    gi = np.clip(np.rint(grid).astype(int), 0, len(sg) - 1)
    tunnel = np.asarray(R["tunnel"], bool)[gi]
    if "bridge" in R.files:
        bridge = np.asarray(R["bridge"], bool)[gi]
    else:
        bridge = np.zeros(len(gi), bool)
        gf = out / "map" / "graph_real.npz"
        if gf.exists():
            from rsm.network.graph import NetGraph
            bridge = bridges_from_graph(NetGraph.load(gf), xy)[gi]
    progress(70, "corrections")
    dg: dict = {}
    z, _z_raw, st = corrected_elevation(dem_dir, glat, glon, grid, tunnel, bridge, diag=dg)
    up, down = D.ascent_descent(z)
    ph = frozen_info().get("code_hash")
    res = dict(version=1, ds=D.SAMPLE_M, s0=0.0, z=[round(float(v), 1) for v in z], tunnel=[int(i) for i in np.flatnonzero(tunnel)],
               ascent_m=round(up, 1), descent_m=round(down, 1), min_m=round(float(z.min()), 1), max_m=round(float(z.max()), 1),
               source=st["source"], attribution=st["attribution"], sources=st["sources"], tiles=tiles, corrections=st, pipeline_hash=ph,
               blocks=route_blocks(glat, glon, dem_dir))
    if dg.get("S") is not None:
        progress(90, "diagnostics")
        dest = Path(dest)
        diag = elevation_diag(dg, z, st)
        tmp = dest.with_name(DIAG_FILE + ".tmp")
        tmp.write_text(json.dumps(diag, separators=(",", ":")))
        os.replace(tmp, dest.with_name(DIAG_FILE))
        res["diag"] = DIAG_FILE
    jdump(Path(dest), res)
    progress(100, "done")
    return dict(points=len(z), ascent_m=res["ascent_m"], descent_m=res["descent_m"], tiles=tiles, sources_used=st["sources_used"])
