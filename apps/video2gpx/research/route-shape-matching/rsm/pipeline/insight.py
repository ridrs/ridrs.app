# SPDX-License-Identifier: AGPL-3.0-or-later
"""Analysis viewer data of a finished run (read only; docs/FEATURE_analysis_insight.md, Part A). Two CLI commands (rsm.pipeline inspect-series / inspect-frame):

- `series(d)`: per video second, from the stored outputs only: speed, rotation, curvature of the video against the curvature of the matched map line, quality,
  and the stretches the map marks as weak (confidence class low / none) with the causes measured on them. Nothing is recomputed that a step stored;
  odofail and the series builder are the pipeline's own functions on the stored inputs.
- `frame(d, t)`: the points the pipeline tracked for one frame pair (vms) and one far-feature window at video time t, with the pipeline's own parameters
  (config C.VMS, C.FAR, the horizon of motion.json, the band rows of rotation/win_video_base.npz), the fit, and the stored row for comparison. The points are
  not stored by the steps, so they are tracked again; it writes nothing and never changes a result.

The module changes no step: it only imports what the steps use.
"""
from __future__ import annotations

import json
import math
import pickle
import time
from pathlib import Path

import numpy as np

from . import config as C
from .common import frozen_info, jload

VERSION = 1

# ---- choices where the spec left room (docs/FEATURE_analysis_insight.md, "Implementation notes (Part A)")
WINDOW_M = 30.0          # curvature window: heading change over this many metres (video: of its own distance, map: of arc), between the pipeline's 6 m and 18 m smoothing
MAX_HALF_S = 10.0        # a curvature window never spans more than +-this many seconds (a standstill has no curvature)
KAPPA_FLOOR = 1 / 300.0  # 1/m, for the match measure: curves tighter than R = 300 m count as curves
CELL_M = 100.0           # match measure per this many metres of route
STRETCH_MERGE_S = 3.0    # weak seconds closer than this are one stretch
STRETCH_MIN_S = 4.0      # shorter stretches are not listed
# thresholds of the causes; each one is a measured value against a limit (see `causes`)
TH = dict(
    inl_share=0.4,             # median inliers of the stretch below this share of the run's median: the road flow rests on few points
    speed_rel=0.25,            # video speed (vms x kappa) differs from the fused speed by more than this share over the stretch
    usable=C.ODO_LOW_USABLE,   # share of usable vms pairs below which the pipeline itself widens the distance sd (0.6)
    far_share=0.5,             # windows with a valid far-feature fit below this share: rotation comes from the vms fallback
    yaw_noise_x=2.5,           # local sd of the vms-far yaw difference against the median of the project
    kappa_dev_x=1.5,           # curve rate: mean |video - map| (degrees per 100 m) above this x the median over the run's confident 20 s windows ...
    kappa_dev_floor=20.0,      # ... but at least this (degrees per 100 m) ...
    kappa_rel=0.9,             # ... and the disagreement at least this share of the curve content (sum |video - map| / larger of the two sums) ...
    kappa_min_turn=8.0,        # ... and at least this many degrees of turning (video or map) in the stretch
    gap_share=0.3,             # share of the stretch inside a vms gap / tunnel
    sd_m=20.0,                 # position spread above which a stretch counts as spread out (the p90 of all seconds is about 20 m on a clean run)
    cut_margin_s=5.0,          # a scene cut this close to the stretch
    slow_ms=1.0,               # median speed below this: standstill
    straight_deg=10.0,         # less turning than this over a long stretch: nothing to anchor the position along the road
    straight_m=150.0,
)
WHY_TEXT = ["", "zu wenige Merkmale", "zu wenige Inlier", "Bildbereich zu schmal", "Fit unsicher"]


def _num(x, nd=3):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _arr(a, nd=3):
    a = np.asarray(a, float)
    return [None if not np.isfinite(v) else round(float(v), nd) for v in a]


def _runs(mask):
    e = np.diff(np.concatenate([[0], np.asarray(mask, np.int8), [0]]))
    return list(zip(np.flatnonzero(e == 1).tolist(), np.flatnonzero(e == -1).tolist()))


def _bins(time_, t0, n):
    """second index of every pair: the pairs within +-0.5 s of grid second i belong to i"""
    return np.floor(np.asarray(time_, float) - t0 + 0.5).astype(int)


def _bin_median(bin_idx, vals, n, mask=None):
    """median of `vals` per bin (NaN where empty); bin_idx must be non-decreasing"""
    out = np.full(n, np.nan)
    b = np.asarray(bin_idx)
    v = np.asarray(vals, float)
    ok = (b >= 0) & (b < n) & np.isfinite(v) & (True if mask is None else mask)
    b, v = b[ok], v[ok]
    if not len(b):
        return out
    edges = np.searchsorted(b, np.arange(n + 1))
    for i in range(n):
        if edges[i + 1] > edges[i]:
            out[i] = float(np.median(v[edges[i]:edges[i + 1]]))
    return out


def _bin_mean(bin_idx, vals, n, mask=None):
    b = np.asarray(bin_idx)
    v = np.asarray(vals, float)
    ok = (b >= 0) & (b < n) & np.isfinite(v) & (True if mask is None else mask)
    s = np.bincount(b[ok], weights=v[ok], minlength=n + 1)[:n]
    c = np.bincount(b[ok], minlength=n + 1)[:n]
    return np.where(c > 0, s / np.maximum(c, 1), np.nan)


def _route_info(d: Path) -> dict:
    """what route_search decoded: the distance factor kappa, the effective focal length and the posterior of the decoded road per step (route.pkl);
    without the file the nominal values"""
    try:
        r = pickle.load(open(d / "route_search" / "route.pkl", "rb"))
        post = r.get("post") or {}
        return dict(kappa=float(r["kappa"]), f_eff=float(r["f_eff"]), ok=True, pt=np.asarray(post.get("t", []), float), p_vit=np.asarray(post.get("p_vit", []), float),
                    p_max=np.asarray(post.get("p_max", []), float))
    except Exception:
        return dict(kappa=1.0, f_eff=float(C.F_FAR), ok=False, pt=np.zeros(0), p_vit=np.zeros(0), p_max=np.zeros(0))


def map_heading(sg, xy):
    """heading (rad, unwrapped, left = counter-clockwise positive) of the matched OSM line along the arc: (arc at segment midpoints, heading)"""
    dx, dy = np.diff(xy[:, 0]), np.diff(xy[:, 1])
    ok = np.hypot(dx, dy) > 1e-6
    mid = 0.5 * (sg[1:] + sg[:-1])[ok]
    psi = np.unwrap(np.arctan2(dy[ok], dx[ok]))
    return mid, psi


def window_rate(x, theta, dist, half, out_of_range=np.nan):
    """curve rate (rad per m) at the points where `dist` (cumulative metres, non-decreasing) is `dist[i]`: heading change over [dist - L/2, dist + L/2] / L,
    for `theta` given on the same grid. NaN where the window leaves the data"""
    d = dist + 1e-6 * np.arange(len(dist))
    lo, hi = dist - half, dist + half
    ok = (lo >= d[0]) & (hi <= d[-1])
    a = np.interp(lo, d, theta)
    b = np.interp(hi, d, theta)
    return np.where(ok, (b - a) / (2 * half), out_of_range)


def series(d, window_m: float = WINDOW_M) -> dict:
    """everything per video second (see the module doc); `d` is the run directory (out/)"""
    from rsm.farrot import series as fser
    from rsm.odometry import gating
    from rsm.odometry.calib import CAMERA_HEIGHT_M
    from rsm.odometry.vms_csv import load_pairs
    from . import odofail as OF

    d = Path(d)
    t_run = time.perf_counter()
    R = np.load(d / "refine" / "result.npz")
    t = np.asarray(R["t"], float)
    n = len(t)
    t0 = float(t[0])
    s = np.asarray(R["s"], float)
    conf, sd, extrap, in_gap = (np.asarray(R[k]) for k in ("conf", "s_sd", "extrap", "in_gap"))
    ri = _route_info(d)
    kappa_s, f_eff, from_route = ri["kappa"], ri["f_eff"], ri["ok"]
    def post_at(a):
        m = np.isfinite(a) & (np.arange(len(a)) < len(ri["pt"])) if len(a) else np.zeros(0, bool)
        return np.interp(t, ri["pt"][m], a[m], left=np.nan, right=np.nan) if m.sum() > 1 else np.full(n, np.nan)
    p_vit, p_max = post_at(ri["p_vit"]), post_at(ri["p_max"])
    half = window_m / 2

    # ---- video pairs, per second
    csv = d / "motion" / "motion.csv"
    p = load_pairs(str(csv))
    fl = gating.pair_flags(p)
    q = OF.quality(p, fl)
    mj = jload(d / "motion" / "motion.json")
    fps = float(mj.get("fps") or 1.0 / p.dt)
    b = _bins(p.time, t0, n)
    good = fl == 0
    usable = q["usable"](t, 0.5)
    k_nom = C.F360 * CAMERA_HEIGHT_M
    v_vms = kappa_s * k_nom * _bin_median(b, p.rel_speed, n, good)             # m/s of the good pairs
    inl = _bin_median(b, p.inliers, n)
    rms = _bin_median(b, p.rms_px, n, np.isfinite(p.rms_px))
    csvd = np.genfromtxt(csv, delimiter=",", names=True, filling_values=np.nan, usecols=("pitch", "roll"))
    pitch = np.degrees(_bin_mean(b, csvd["pitch"], n, good) * fps / f_eff)      # deg/s, nose up positive
    roll = np.degrees(_bin_mean(b, csvd["roll"], n, good) * fps)

    # ---- far-feature windows -> the series the rotation step builds (the pipeline's own builder, read only)
    old_work = fser.WORK
    fser.WORK = d / "rotation"
    try:
        S = fser.build("video", str(csv), tag="base")
    finally:
        fser.WORK = old_work
    W = np.load(d / "rotation" / "win_video_base.npz")
    wdt = float(S.meta["k"]) / float(S.meta["fps"])
    scale = S.f / f_eff                      # angle = px / f_eff: the decoded effective focal length rescales every window angle
    wb = _bins(0.5 * (S.ta + S.tb), t0, n)
    ok_far = S.src == 0
    deg = lambda x: np.degrees(x * scale / wdt)
    yaw_fused = _bin_mean(wb, deg(S.dth), n)
    yaw_far = _bin_mean(wb, deg(np.where(ok_far, S.dth_far, np.nan)), n)
    yaw_vms = _bin_mean(wb, deg(S.vms), n)
    far_ok = _bin_mean(wb, ok_far.astype(float), n)
    nb = min(3, W["ok"].shape[1])
    any_band = W["ok"][:, :nb].any(1)
    why0 = W["why"][:, 0].astype(int)
    code = np.where(ok_far, 0, np.where(any_band, 4, np.clip(why0, 1, 3)))      # why a window gave no far yaw: 1 few corners, 2 few inliers, 3 narrow, 4 fit not trusted
    why = np.zeros(n, int)
    for i in range(n):
        m = (wb == i) & ~ok_far
        if m.any():
            why[i] = int(np.bincount(code[m], minlength=5).argmax())
    far_inl = _bin_median(wb, S.n_inl.astype(float), n, ok_far)
    # yaw noise: |vms - far| per second, where both exist, local median over 61 s
    diff = np.abs(yaw_vms - yaw_far)

    # ---- curvature: video (heading from the fused series over the video's own distance), map (the matched OSM line over the same distance)
    v_fused = np.gradient(s, t) if n > 1 else np.zeros(n)
    use_v = np.isfinite(v_vms) & (usable >= 0.5)
    v_best = np.where(use_v, v_vms, v_fused)
    v_best = np.maximum(np.nan_to_num(v_best), 0.0)
    dist_v = np.concatenate([[0.0], np.cumsum(0.5 * (v_best[1:] + v_best[:-1]) * np.diff(t))])
    te = np.concatenate([[S.ta[0]], S.tb])
    th_true = np.concatenate([[0.0], np.cumsum(S.dth * scale)])                 # rad, left positive, at the window edges
    theta_t = np.interp(t, te, th_true)
    k_v = window_rate(t, theta_t, dist_v, half)
    # a window that stretches over a standstill or a gap in time is not a curvature
    span = np.interp(dist_v + half, dist_v + 1e-6 * np.arange(n), t) - np.interp(dist_v - half, dist_v + 1e-6 * np.arange(n), t)
    k_v = np.where(span > 2 * MAX_HALF_S, np.nan, k_v)
    mid, psi = map_heading(np.asarray(R["sg"], float), np.asarray(R["xy"], float))
    s_clip = np.maximum.accumulate(s)
    k_m = window_rate(t, np.interp(s_clip, mid, psi), s_clip, half)
    k_m = np.where(extrap, np.nan, k_m)
    cut_t = _cut_times(d)
    near_cut = np.zeros(n, bool)
    for a, bb in cut_t:
        near_cut |= (t >= a - half / max(np.nanmedian(v_best), 1.0) - 1) & (t <= bb + half / max(np.nanmedian(v_best), 1.0) + 1)
    k_v = np.where(near_cut, np.nan, k_v)
    k_d = k_v - k_m
    cells = _cells(t, s_clip, k_v, k_m, extrap)

    # ---- flags per second
    fail = np.zeros(n, bool)
    spans = OF.fail_spans(q)
    for a, bb in spans:
        fail |= (t >= a) & (t <= bb)
    cutf = np.zeros(n, bool)
    for a, bb in cut_t:
        cutf |= (t >= a - 0.5) & (t <= bb + 0.5)
    tunnel = np.asarray(R["tunnel"], bool)[np.clip(np.searchsorted(np.asarray(R["sg"], float), s_clip), 0, len(R["sg"]) - 1)] if "tunnel" in R.files else np.zeros(n, bool)
    local = _local_flags(d, t)
    intro = _intro_end(d)

    out = dict(
        version=VERSION, pipeline_hash=frozen_info()["code_hash"], result_mtime=int((d / "refine" / "result.npz").stat().st_mtime), window_m=window_m,
        n=n, t0=t0, dt=1.0, fps=fps, f_eff=_num(f_eff, 1), kappa=_num(kappa_s, 4), scale_from_route=from_route, intro_end=intro,
        t=_arr(t, 2), s=_arr(s, 1),
        speed_fused=_arr(v_fused, 2), speed_vms=_arr(v_vms, 2),
        yaw_vms=_arr(yaw_vms, 2), yaw_far=_arr(yaw_far, 2), yaw=_arr(yaw_fused, 2), pitch=_arr(pitch, 2), roll=_arr(roll, 2),
        inliers=_arr(inl, 0), rms=_arr(rms, 2), usable=_arr(usable, 2), far_ok=_arr(far_ok, 2), far_inl=_arr(far_inl, 0), far_why=[int(x) for x in why], far_why_text=WHY_TEXT,
        kappa_video=_arr(k_v * 1000, 2), kappa_map=_arr(k_m * 1000, 2), kappa_diff=_arr(k_d * 1000, 2),      # 1/km, left positive
        conf=_arr(conf, 3), p_search=_arr(p_vit, 3), s_sd=_arr(sd, 1), in_gap=[int(x) for x in in_gap], extrap=[int(x) for x in extrap], tunnel=[int(x) for x in tunnel],
        cut=[int(x) for x in cutf], odofail=[int(x) for x in fail], local=[int(x) for x in local],
        cells=cells, odofail_spans=[[round(a, 1), round(bb, 1)] for a, bb in spans], cuts=[[round(a, 2), round(bb, 2)] for a, bb in cut_t],
        limits=dict(TH, conf_low=0.5, conf_high=0.9),
    )
    out["stretches"] = stretches(out, dict(t=t, s=s_clip, conf=conf, sd=sd, extrap=extrap, in_gap=in_gap, tunnel=tunnel, fail=fail, cut=cutf, usable=usable, inl=inl, far_ok=far_ok,
                                            why=why, v_vms=np.where(use_v, v_vms, np.nan), v_fused=v_fused, inl_run=float(np.nanmedian(inl)), p_vit=p_vit, p_max=p_max, local=local, v=v_best, k_v=k_v, k_m=k_m, diff=diff, intro=intro, cuts_list=cut_t))
    out["seconds"] = round(time.perf_counter() - t_run, 2)
    return out


def _cut_times(d: Path) -> list[tuple[float, float]]:
    f = d / "rotation" / "cuts.json"
    if not f.exists():
        return []
    return [(float(c.get("t_first", c["t"])), float(c.get("t_last", c["t"]))) for c in jload(f).get("cuts", [])]


def _intro_end(d: Path):
    f = d / "rotation" / "cuts.json"
    return _num(jload(f).get("intro_end"), 2) if f.exists() else None


def _local_flags(d: Path, t) -> np.ndarray:
    """0 nothing, 1 a local-pass proposal was tested here and not taken, 2 taken (refine/summary.json local.accept_tested)"""
    out = np.zeros(len(t), int)
    f = d / "refine" / "summary.json"
    if not f.exists():
        return out
    try:
        for x in (jload(f).get("local") or {}).get("accept_tested", []):
            m = (t >= x["t0"]) & (t <= x["t1"])
            out[m] = np.maximum(out[m], 2 if x.get("accepted") else 1)
    except (KeyError, TypeError):
        pass
    return out


def _cells(t, s, k_v, k_m, extrap) -> dict:
    """per CELL_M of route: how well the curve rate of the video matches the map's. dev = mean |difference| in degrees per 100 m; match 0..1 = 1 - rms difference / max(rms map, floor)"""
    k = np.floor(s / CELL_M).astype(int)
    ok = np.isfinite(k_v) & np.isfinite(k_m) & ~extrap
    out = dict(s=[], t0=[], t1=[], dev=[], match=[], turn_v=[], turn_m=[])
    for c in np.unique(k[ok]):
        m = ok & (k == c)
        if m.sum() < 3:
            continue
        dk = k_v[m] - k_m[m]
        rms_d, rms_m = float(np.sqrt(np.mean(dk ** 2))), float(np.sqrt(np.mean(k_m[m] ** 2)))
        out["s"].append(int(c * CELL_M)); out["t0"].append(_num(t[m][0], 1)); out["t1"].append(_num(t[m][-1], 1))
        out["dev"].append(_num(np.degrees(np.mean(np.abs(dk)) * CELL_M), 2))
        out["match"].append(_num(1 - min(1.0, rms_d / max(rms_m, KAPPA_FLOOR)), 2))
        out["turn_v"].append(_num(np.degrees(np.sum(np.abs(k_v[m])) * np.mean(np.diff(s[m])) if m.sum() > 1 else 0), 1))
        out["turn_m"].append(_num(np.degrees(np.sum(np.abs(k_m[m])) * np.mean(np.diff(s[m])) if m.sum() > 1 else 0), 1))
    return out


# ------------------------------------------------------------------ weak stretches and their causes
def stretches(out: dict, X: dict) -> list[dict]:
    """contiguous seconds the map marks as weak (confidence < 0.5, class low, or outside the decoded span, class none), merged over short breaks, with the causes measured on them"""
    t, conf, extrap = X["t"], X["conf"], X["extrap"]
    weak = (conf < 0.5) | extrap
    if X["intro"] is not None:
        weak &= t > X["intro"]
    runs = [list(r) for r in _runs(weak)]
    merged: list[list[int]] = []
    for r in runs:
        if merged and t[r[0]] - t[merged[-1][1] - 1] <= STRETCH_MERGE_S + 1:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    ref = _reference(X)
    res = []
    for a, bb in merged:
        if t[bb - 1] - t[a] + 1 < STRETCH_MIN_S:
            continue
        sl = slice(a, bb)
        none_share = float(np.mean(extrap[sl]))
        st = dict(t0=_num(t[a], 1), t1=_num(t[bb - 1] + 1, 1), s0=_num(X["s"][a], 1), s1=_num(X["s"][bb - 1], 1), dur=_num(t[bb - 1] + 1 - t[a], 1),
                  kind="none" if none_share >= 0.5 else "low", conf_min=_num(np.min(conf[sl]), 3), conf_mean=_num(np.mean(conf[sl]), 3))
        st["causes"] = causes(sl, X, ref, st)
        res.append(st)
    return res


def curve_stats(kv, km, v) -> tuple[float, float, float] | None:
    """(mean |video - map| in degrees per 100 m weighted by speed, that over the larger curve content, turning in degrees) of a piece; None without data"""
    m = np.isfinite(kv) & np.isfinite(km)
    if m.sum() < 3:
        return None
    d, w = np.abs(kv[m] - km[m]), np.maximum(v[m], 0.1)
    tot = max(float(np.sum(np.abs(kv[m]) * w)), float(np.sum(np.abs(km[m]) * w)))
    return float(np.degrees(np.sum(d * w) / np.sum(w) * 100)), float(np.sum(d * w) / max(tot, 1e-9)), float(np.degrees(tot))


def _reference(X) -> dict:
    """what is normal in this run: the median yaw difference vms-far (for 'rotation noisy') and the median curve-rate disagreement of its confident 20 s windows"""
    d = X["diff"]
    ok = X["conf"] >= 0.9
    devs = []
    for a in range(0, len(ok) - 20, 10):
        if ok[a:a + 20].all():
            r = curve_stats(X["k_v"][a:a + 20], X["k_m"][a:a + 20], X["v"][a:a + 20])
            if r:
                devs.append(r[0])
    return dict(diff_med=float(np.nanmedian(d)) if np.isfinite(d).any() else float("nan"), dev_med=float(np.median(devs)) if len(devs) >= 3 else float("nan"), dev_n=len(devs))


def causes(sl, X, ref, st) -> list[dict]:
    """measured causes of one weak stretch, each {id, text, value, limit, unit}; a cause is listed when its value passes its limit (TH). Strongest evidence first."""
    out = []
    add = lambda id_, text, value, limit, unit, rank: out.append(dict(id=id_, text=text, value=_num(value, 2), limit=_num(limit, 2), unit=unit, rank=_num(rank, 2)))
    n = sl.stop - sl.start
    dur = max(n, 1)
    if X["extrap"][sl].mean() >= 0.5:
        add("edge", "Außerhalb des erkannten Abschnitts (Anfang oder Ende der Strecke)", 100 * X["extrap"][sl].mean(), 50, "%", 20)
    spans_fail = float(X["fail"][sl].mean())
    if spans_fail >= 0.3:
        add("odofail", f"Wegmessung ausgefallen (Gegenlicht, glatter Belag o. ä.): {100 * spans_fail:.0f} % der Zeit", 100 * spans_fail, 30, "%", 10 + spans_fail)
    use = float(np.nanmean(X["usable"][sl])) if np.isfinite(X["usable"][sl]).any() else float("nan")
    inl = float(np.nanmedian(X["inl"][sl])) if np.isfinite(X["inl"][sl]).any() else float("nan")
    if np.isfinite(use) and use < TH["usable"] and spans_fail < 0.3:
        add("motion", f"Videobewegung unsicher: nur {100 * use:.0f} % der Bildpaare nutzbar" + (f", im Mittel {inl:.0f} Inlier" if np.isfinite(inl) else ""), 100 * use, 100 * TH["usable"], "%", 9 - use)
    elif np.isfinite(inl) and inl < TH["inl_share"] * X["inl_run"] and spans_fail < 0.3:
        add("motion", f"Videobewegung schwach: im Mittel {inl:.0f} Inlier (sonst {X['inl_run']:.0f})", inl, TH["inl_share"] * X["inl_run"], "Inlier", 8.5)
    vv, vf = X["v_vms"][sl], X["v_fused"][sl]
    okv = np.isfinite(vv)
    if okv.sum() >= max(3, 0.5 * n) and np.mean(vf[okv]) > 1.0 and spans_fail < 0.3:
        rel = (float(np.mean(vv[okv])) - float(np.mean(vf[okv]))) / float(np.mean(vf[okv]))
        if abs(rel) >= TH["speed_rel"]:
            add("speed", f"Geschwindigkeit passt nicht: Video {np.mean(vv[okv]):.1f} m/s, Strecke auf der Karte {np.mean(vf[okv]):.1f} m/s ({100 * rel:+.0f} %)", 100 * rel, 100 * TH["speed_rel"], "%", 6.2)
    far = float(np.nanmean(X["far_ok"][sl])) if np.isfinite(X["far_ok"][sl]).any() else float("nan")
    dm = float(np.nanmedian(X["diff"][sl])) if np.isfinite(X["diff"][sl]).any() else float("nan")
    if np.isfinite(far) and far < TH["far_share"]:
        wy = X["why"][sl][X["why"][sl] > 0]
        top = WHY_TEXT[int(np.bincount(wy).argmax())] if len(wy) else ""
        add("rotation", f"Rotation verrauscht: Fernmerkmale nur in {100 * far:.0f} % der Fenster" + (f" ({top})" if top else ""), 100 * far, 100 * TH["far_share"], "%", 8 - far)
    elif np.isfinite(dm) and np.isfinite(ref["diff_med"]) and ref["diff_med"] > 0 and dm > TH["yaw_noise_x"] * ref["diff_med"] and dm > 0.5:
        add("rotation", f"Rotation verrauscht: Videobewegung und Fernmerkmale weichen um {dm:.1f} °/s ab (sonst {ref['diff_med']:.1f} °/s)", dm, TH["yaw_noise_x"] * ref["diff_med"], "°/s", 7)
    cs = curve_stats(X["k_v"][sl], X["k_m"][sl], X["v"][sl]) if n >= 3 else None
    if cs is not None and np.isfinite(X["k_v"][sl]).sum() >= max(3, 0.3 * n):
        dev, rel, turn = cs
        lim = max(TH["kappa_dev_floor"], TH["kappa_dev_x"] * ref["dev_med"]) if np.isfinite(ref["dev_med"]) else 2 * TH["kappa_dev_floor"]
        if dev >= lim and rel >= TH["kappa_rel"] and turn >= TH["kappa_min_turn"]:
            add("curves", f"Kurven passen nicht zur Karte: Kurvenrate weicht im Mittel um {dev:.0f}° je 100 m ab (sonst {lim / TH['kappa_dev_x']:.0f}°), {turn:.0f}° Drehung im Abschnitt", dev, lim, "°/100 m", 6 + rel)
        elif turn < TH["straight_deg"] and (st["s1"] - st["s0"]) >= TH["straight_m"]:
            add("straight", f"Lange Gerade: nur {turn:.0f}° Drehung auf {st['s1'] - st['s0']:.0f} m, nichts zum Anpassen entlang der Straße", turn, TH["straight_deg"], "°", 4)
    gap = float(X["in_gap"][sl].mean())
    tun = float(X["tunnel"][sl].mean())
    if tun >= TH["gap_share"]:
        add("tunnel", f"Tunnel: {100 * tun:.0f} % des Abschnitts", 100 * tun, 100 * TH["gap_share"], "%", 7.5)
    elif gap >= TH["gap_share"]:
        add("gap", f"Lücke in der Wegmessung (Strecke geschätzt): {100 * gap:.0f} % der Zeit", 100 * gap, 100 * TH["gap_share"], "%", 7.4)
    t0_, t1_ = float(X["t"][sl][0]), float(X["t"][sl][-1])
    cuts = [c for c in X["cuts_list"] if c[1] >= t0_ - TH["cut_margin_s"] and c[0] <= t1_ + TH["cut_margin_s"]]
    if cuts:
        add("cut", f"Szenenschnitt bei {_mmss(cuts[0][0])}", cuts[0][0], TH["cut_margin_s"], "s", 9.5)
    sdm = float(np.nanmedian(X["sd"][sl]))
    if sdm >= TH["sd_m"]:
        add("spread", f"Position streut ± {sdm:.0f} m (im Mittel über den Abschnitt)", sdm, TH["sd_m"], "m", 3 + sdm / 100)
    v = float(np.nanmedian(X["v"][sl]))
    if v < TH["slow_ms"] and dur >= STRETCH_MIN_S:
        add("slow", f"Stillstand oder sehr langsam: {v:.1f} m/s, kaum Weg zum Zuordnen", v, TH["slow_ms"], "m/s", 3.5)
    loc = float(np.mean(X["local"][sl] == 1))
    if loc >= 0.3:
        add("kept", f"Lokale Prüfung: eine andere Straße war ähnlich plausibel, die Suchroute blieb ({100 * loc:.0f} % des Abschnitts, Sicherheit auf 50 % begrenzt)", 100 * loc, 30, "%", 6.5)
    pv = float(np.mean(X["conf"][sl]))
    ps = float(np.nanmean(X["p_vit"][sl])) if np.isfinite(X["p_vit"][sl]).any() else float("nan")
    out.sort(key=lambda c: -c["rank"])
    if not out and pv < 0.5:
        # no measured disturbance: the decoded road is not clearly better than another one (parallel road, junction, a long straight with little shape). The final
        # confidence is the posterior of the local pass; the search posterior (route.pkl, before the local pass) is given for comparison
        add("ambiguous", f"Mehrere Straßen passen ähnlich gut: die gewählte nur mit {100 * pv:.0f} % Wahrscheinlichkeit" + (f" (die Routensuche war hier {100 * ps:.0f} % sicher)" if np.isfinite(ps) else ""), 100 * pv, 50, "%", 0)
    for c in out:
        c.pop("rank", None)
    if not out:
        out.append(dict(id="none", text="Keine eindeutige Ursache gemessen", value=None, limit=None, unit=""))
    return out


def _mmss(t: float) -> str:
    return f"{int(t // 60)}:{int(t % 60):02d}"


# ------------------------------------------------------------------ one frame pair and one far-feature window, tracked again
DESTATIC_WARM = 40      # frames decoded before the pair so the running mean of the destatic filter is the one a decode from the start has (its memory is about 2 frames)


def _video_of(d: Path, video: str | None, mj: dict) -> str:
    if video:
        return video
    f = d / "project.params.json"
    if f.exists():
        try:
            return jload(f)["video"]
        except (KeyError, ValueError):
            pass
    return mj["video"]


def _stored_row(csv: Path, idx: int) -> list[str] | None:
    """the csv row of the pair whose second frame is `idx` (rows are in order; the file is read until it)"""
    import csv as _csv
    with open(csv, newline="") as fh:
        rd = _csv.reader(fh)
        next(rd, None)
        for row in rd:
            if int(row[0]) == idx:
                return row
            if int(row[0]) > idx:
                break
    return None


def _rms_limit(csv: Path) -> float:
    """the gate's high_rms limit for this run's pairs (rsm.odometry.gating.rms_limit: it follows the video's own fit quality)"""
    from rsm.odometry.gating import rms_limit
    from rsm.odometry.vms_csv import load_pairs
    p = load_pairs(str(csv))
    return rms_limit(p.rms_px, p.inliers)


def _polygon(mask) -> list[list[float]]:
    import cv2
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cs:
        return []
    c = max(cs, key=cv2.contourArea)
    ap = cv2.approxPolyDP(c, 1.5, True)
    return [[int(x), int(y)] for x, y in ap.reshape(-1, 2)]


#: point code of the motion overlay: 0 outlier, 1 carries the road fit, 2 passing traffic the speed ignores (decisions A17 / A18)
TRAFFIC = 2
IGNORED = 3          # the point carried the fit of a rejected pair: ignored, but not located traffic (often a soft frame)


def traffic_points(mid, flow, cx: float, cy: float, yh: float, scale: float, plain_inl, stored: dict | None, max_rms: float, alt_thr: float | None = None):
    """the point codes of one pair as the pipeline USES it, and what happened to it (None: plain road pair, the fit is what the step used).
    `replaced`: a road candidate replaced the fit (pick >= 1); its points are the road, the points of the rejected plain fit and of the
    candidates that move at another speed are the traffic. `rejected`: the stored fit is above the gate's rms limit, the pair gives no speed
    (bridged or split by gating); every point that carried the fit is ignored (IGNORED, not TRAFFIC: nothing locates a vehicle there)."""
    from .vmsx import motion as vm
    plain = np.asarray(plain_inl, bool)
    codes = plain.astype(int)
    if stored is None:
        return codes, None
    alts = vm.parse_alts(stored.get("alts", ""))
    pick = stored.get("pick", "")
    try:
        rms = float(stored.get("rms_px") or "nan")
    except ValueError:
        rms = float("nan")
    info = dict(pick=int(pick) if pick.lstrip("-").isdigit() else None, candidates=max(0, len(alts) - 1), rms=_num(rms, 3), limit=_num(max_rms, 3))
    thr = vm.ALT_THR * scale if alt_thr is None else float(alt_thr)        # the candidates' tolerance of the run (motion.json `alt_thr`; older runs: fixed)
    if info["pick"] is not None and 1 <= info["pick"] < len(alts):
        road_p = alts[info["pick"]][0]
        road = vm.near_fit(mid, flow, cx, cy, yh, road_p, thr)
        other = plain & ~road
        for p, _, _ in alts[1:]:
            if abs(p[0] - road_p[0]) > vm.ALT_TOL * max(abs(road_p[0]), 1e-9):
                other |= vm.near_fit(mid, flow, cx, cy, yh, p, thr) & ~road
        codes = np.where(road, 1, np.where(other, TRAFFIC, 0))
        info.update(state="replaced", road_s=float(road_p[0]), plain_s=float(alts[0][0][0]))
    if np.isfinite(rms) and rms > max_rms:
        codes = np.where(codes != 0, IGNORED, 0)
        info["state"] = "rejected"
    if "state" not in info:
        return codes, None if not alts else dict(info, state="kept")
    info["n_traffic"] = int((codes == TRAFFIC).sum())
    info["n_ignored"] = int((codes == IGNORED).sum())
    return codes, info


def motion_pair(d: Path, video: str, mj: dict, t: float, info) -> dict:
    """the vms pair at video time t: the points the road-flow fit saw (inlier or outlier), the fit, and the csv row the step stored for it"""
    from .vmsx import motion as vm
    from .vmsx.decode import frames_from
    from .common import hwaccel_enabled
    H, step, fps = int(mj["height"]), int(mj.get("step", 1)), float(info.fps)
    width = int(mj.get("width") or round(info.width * H / info.height / 2) * 2)
    hz_area = float(mj.get("horizon_vms") if mj.get("horizon_vms") is not None else mj["horizon"])     # the road area hangs from the calibrated row
    top, bottom = (int(x) for x in mj["roi"])
    road_width = mj.get("road_width", vm.ROAD_WIDTH)
    pairs = int(mj.get("pairs", 0)) or None
    j = max(1, int(round((t * fps + step / 2) / step)))
    if pairs:
        j = min(j, pairs)
    idx = j * step
    t_pair = (idx - step / 2) / fps                 # time of the pair, as analyse writes it
    horizon = vm.horizon_at(mj, t_pair)             # the row the pair was fitted with (running horizon, else the calibrated row)
    tracker = vm.Tracker(H, width, top, bottom, hz_area, road_width)
    min_res = vm.MIN_RESIDUAL * tracker.scale
    dt = step / fps
    first = max(0, idx - step * (DESTATIC_WARM + 1))
    first -= (idx - first) % step
    tau = float(mj.get("destatic_tau", 0.0))           # a run before the destatic filter (2026-11-15) has no such key: no filter then
    filt = vm.Destatic(tau) if tau > 0 else None
    prev = prev_f = frame = frame_f = None
    n_dec = 0
    for k, fr in enumerate(frames_from(video, info, H, first, (idx - first) + 1, hwaccel=hwaccel_enabled())):
        if k % step:
            continue
        prev, prev_f = frame, frame_f
        frame = fr
        frame_f = filt(fr) if filt is not None else fr
        n_dec += 1
    if prev is None or frame is None:
        raise ValueError(f"could not decode the frames around t = {t:.2f} s")
    raw = (prev, frame) if filt is not None else None
    row = vm.pair_row(tracker, prev_f, frame_f, idx, t_pair, horizon, min_res, dt, width, H, raw=raw)
    # the same tracking again, keeping the points (pair_row keeps only the fit)
    used = "gefiltert"
    corners, mid, flow = tracker.track(prev_f, frame_f)
    mid, flow = vm.below_horizon(mid, flow, horizon, H)
    fit = vm.fit_fixed_horizon(mid, flow, width / 2, H / 2, horizon, min_res) if len(mid) >= vm.MIN_INLIERS else None
    if fit is None and raw is not None:
        corners, mid, flow = tracker.track(*raw)
        mid, flow = vm.below_horizon(mid, flow, horizon, H)
        fit = vm.fit_fixed_horizon(mid, flow, width / 2, H / 2, horizon, min_res) if len(mid) >= vm.MIN_INLIERS else None
        used = "roh"
    stored = _stored_row(d / "motion" / "motion.csv", idx)
    cols = vm.COLUMNS
    st = dict(zip(cols, stored)) if stored is not None and len(stored) == len(cols) else None
    plain_inl = fit.inliers if fit is not None else np.zeros(len(mid), bool)
    codes, traffic = traffic_points(mid, flow, width / 2, H / 2, horizon, tracker.scale, plain_inl, st, _rms_limit(d / "motion" / "motion.csv"), mj.get("alt_thr"))
    pts = [[round(float(a), 1), round(float(b), 1), round(float(c), 2), round(float(e), 2), int(codes[i])] for i, ((a, b), (c, e)) in enumerate(zip(mid, flow))]
    mine = [str(x) for x in row]
    if stored is not None and len(stored) == len(cols) and "pick" in cols:
        k = cols.index("pick")
        mine[k] = stored[k]                                   # written by the pick pass, not by pair_row
        if stored[k] not in ("", "0", "-1"):                  # a candidate replaced the fit: only the columns it leaves alone must agree
            for c in ("inliers", "rms_px", "s", "c", "yaw", "pitch", "roll", "rel_speed"):
                mine[cols.index(c)] = stored[cols.index(c)]
    same = stored is not None and mine == stored
    kappa_s, f_eff, _ = (lambda r: (r["kappa"], r["f_eff"], r["ok"]))(_route_info(d))
    res = dict(pair=idx, t=_num(t_pair, 4), width=width, height=H, horizon=_num(horizon, 1), roi=[top, bottom], polygon=_polygon(tracker.mask), points=pts, corners=int(corners), tracked=int(len(mid)),
               source=used, row=dict(zip(cols, mine)), stored=None if stored is None else dict(zip(cols, stored)), agree=bool(same))
    res["traffic"] = traffic
    if fit is not None:
        s_, c_, a_, b_, r_ = (float(x) for x in fit.params[:5])
        n_inl, rms_ = int(fit.inliers.sum()), fit.rms
        if traffic is not None and traffic.get("pick") and traffic["pick"] >= 1:     # the road candidate the step used, not the plain fit it replaced
            p_, n_inl, rms_ = vm.parse_alts(st["alts"])[traffic["pick"]]
            s_, c_, a_, b_, r_ = (float(x) for x in p_[:5])
            res["plain_fit"] = dict(inliers=int(fit.inliers.sum()), rms=_num(fit.rms, 3), s=float(fit.params[0]), speed_ms=_num(kappa_s * C.F360 * 1.1 * float(fit.params[0]) / dt, 2))
        res["fit"] = dict(inliers=int(n_inl), rms=_num(rms_, 3), s=s_, yaw_px=_num(a_, 4), pitch_px=_num(b_, 4), roll=r_,
                          speed_ms=_num(kappa_s * C.F360 * 1.1 * s_ / dt, 2), yaw_deg_s=_num(np.degrees(a_ * fps / f_eff), 2), pitch_deg_s=_num(np.degrees(b_ * fps / f_eff), 2))
    else:
        res["fit"] = None
    if stored is not None and not same:
        res["diff"] = {c: [m, sv] for c, m, sv in zip(cols, mine, stored) if m != sv}
    res["decoded"] = n_dec
    return res


def far_window(d: Path, video: str, mj: dict, t: float, info, seed: int = 0) -> dict:
    """the far-feature window containing video time t: for every band the points the window fit saw, the fit, and the stored fit of the same window"""
    import cv2
    from rsm.angle import farfeat, rotflow
    from rsm.farrot import model, series as fser
    from . import steps_a as SA
    z = np.load(d / "rotation" / "win_video_base.npz")
    meta = json.loads(str(z["meta"]))
    k, fps, f, H = int(meta["k"]), float(meta["fps"]), float(meta["f"]), 360
    n_win = int(meta["n_windows"])
    i = int(min(max(math.floor(t * fps / k), 0), n_win - 1))
    band_ends = [float(x) for x in meta["band_ends"]]
    F = C.FAR
    p = farfeat.Params(min_inl=F["min_inl"], band_off=float(meta.get("band_off", farfeat.Params.band_off)))
    W = round(info.width * H / info.height / 2) * 2
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(1) as ex:            # the decode (an ffmpeg process) runs while the generator is replayed
        job = ex.submit(lambda: list(SA.ffmpeg_frames(video, info, H, i * k, 2, k)))
        rng = _replay_rng(z, i, k, fps, F)
        fr = job.result()
    if len(fr) < 2:
        raise ValueError(f"could not decode the far-feature window around t = {t:.2f} s")
    prev, cur = fr[0], fr[1]
    SP = fser.SeriesParams()
    bands = []
    chosen = -1
    for b, e in enumerate(band_ends):
        m = np.zeros((H, W), np.uint8)
        mx = int(0.02 * W)
        m[:int(e), mx:W - mx] = 255
        tr = farfeat.track_pair(cv2, m, prev, cur, p, H / 360)
        st = dict(band=b, end=_num(e, 1), ok=False, why="", n_pts=0, n_inl=0, points=[])
        sto = {name: _num(float(z["data"][i, b, j]), 3) for j, name in enumerate(SA.FIELDS)}
        stored = dict(ok=bool(z["ok"][i, b]), n_pts=int(z["n_pts"][i, b]), n_inl=int(z["n_inl"][i, b]), why=SA.WHY[int(z["why"][i, b])] if int(z["why"][i, b]) < len(SA.WHY) else "", **sto)
        if tr is not None:
            q0, fl = tr
            x, y = q0[:, 0] - W / 2, q0[:, 1] - H / 2
            wf = model.fit_window(x, y, fl, f, scale=H / 360, rng=rng, min_inl=F["min_inl"], min_xspread=0.0)
            res = np.hypot(*(fl - _model_flow(x, y, f, wf)).T) if np.isfinite(wf.A) else np.full(len(x), np.inf)
            inl = np.zeros(len(x), bool)
            if wf.n_inl > 0:
                inl[np.argsort(res)[:wf.n_inl]] = True
            st.update(ok=bool(wf.ok), why=wf.why, n_pts=int(wf.n_pts), n_inl=int(wf.n_inl),
                      points=[[round(float(a), 1), round(float(c), 1), round(float(u), 2), round(float(v), 2), int(w)] for a, c, (u, v), w in zip(q0[:, 0], q0[:, 1], fl, inl)])
            for a in SA.FIELDS:
                st[a] = _num(getattr(wf, a), 3)
            gate = bool(wf.ok and wf.n_inl >= SP.min_inl and wf.sA <= SP.max_sA and abs(wf.e) / f <= SP.max_eps)
            st["usable"] = gate
            if gate and chosen < 0:
                chosen = b
        else:
            st["why"] = "few corners"
            st["usable"] = False
        st["stored"] = stored
        close = lambda a, c, tol: (a is None and c is None) or (a is not None and c is not None and abs(a - c) <= tol)
        st["agree"] = bool(st["ok"] == stored["ok"] and st["n_pts"] == stored["n_pts"] and (not st["ok"] or all(close(st.get(a), stored[a], 0.05 if a in ("A", "B", "C", "e") else 0.1) for a in ("A", "B", "C", "e"))))
        bands.append(st)
    out = dict(window=i, ta=_num(i * k / fps, 3), tb=_num((i + 1) * k / fps, 3), k=k, width=W, height=H, horizon=_num(meta.get("horizon"), 1), band_ends=band_ends, bands=bands, chosen=chosen,
               agree=all(b["agree"] for b in bands))
    if chosen >= 0:
        _, f_eff, _ = (lambda r: (r["kappa"], r["f_eff"], r["ok"]))(_route_info(d))
        A = bands[chosen]["A"]
        out["yaw_deg_s"] = _num(np.degrees(A / f_eff * fps / k), 2)
        out["pitch_deg_s"] = _num(np.degrees(bands[chosen]["B"] / f_eff * fps / k), 2)
    return out


def _replay_rng(z, i: int, k: int, fps: float, F: dict):
    """the random generator of the rotation step's chunk as it stands before window i. A chunk seeds one generator (1000 + its first window) and every window and band
    that fits (>= min_inl points) draws 80 triples from it, so the draws before window i follow from the stored point counts: replaying them gives the same
    RANSAC consensus the step had, and with it the same fit"""
    cw = max(10, int(round(F["chunk_s"] * fps / k)))
    w0 = (i // cw) * cw
    rng = np.random.default_rng(1000 + w0)
    n_pts = z["n_pts"][w0:i]
    for row in n_pts:
        for n in row:
            n = int(n)
            if n >= F["min_inl"]:
                for _ in range(RANSAC_ITERS):
                    rng.choice(n, 3, replace=False)
    return rng


RANSAC_ITERS = 80       # rsm.angle.rotflow.ransac_inliers default


def _model_flow(x, y, f, wf):
    """(n, 2) flow of the window's fitted model (rotation + expansion) at the points"""
    from rsm.angle import rotflow
    return rotflow.synth_flow(x, y, f, 0.0, wf.A, wf.B, wf.C, wf.e)


def frame(d, t: float, video: str | None = None, what=("motion", "rotation")) -> dict:
    """the analysis frame at video time t (see the module doc): {"t", "video", "motion"?, "rotation"?, "seconds"}; each part has its own error entry if it cannot be made"""
    from .vmsx.decode import probe
    d = Path(d)
    t_run = time.perf_counter()
    mj = jload(d / "motion" / "motion.json")
    v = _video_of(d, video, mj)
    info = probe(v)
    out = dict(t=_num(t, 3), video=v, fps=_num(info.fps, 4), frame_width=int(round(info.width * 360 / info.height / 2) * 2), frame_height=360)
    from concurrent.futures import ThreadPoolExecutor
    fns = {"motion": motion_pair, "rotation": far_window}

    def run(name):
        try:
            return fns[name](d, v, mj, t, info)
        except Exception as e:                           # one part failing (no far windows stored, a decode error) must not hide the other
            return dict(error=f"{type(e).__name__}: {e}")
    todo = [n for n in fns if n in what]
    with ThreadPoolExecutor(max(1, len(todo))) as ex:    # both parts mostly wait for their ffmpeg decode: run them side by side
        for n, r in zip(todo, ex.map(run, todo)):
            out[n] = r
    out["seconds"] = round(time.perf_counter() - t_run, 3)
    return out
