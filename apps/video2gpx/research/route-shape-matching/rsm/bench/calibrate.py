# SPDX-License-Identifier: AGPL-3.0-or-later
"""Error-model calibration from the two real (GPX-free video reconstruction, GPX) pairs. Not part of `rsm.core`.

For each pair: the GPX window over the video's time span, extended by 15 % of the duration at both ends, is
a single candidate; the matcher (`rsm.core.matcher`, alignment by relative residual) finds the best window and
the similarity fit. Measured after that fit:
- cross-track residual of the video points to the matched GPX window: RMS and maximum (m), signed lateral
  residual used for the smoothness measures; the fit's own correspondence RMS is reported as well;
- heading drift per 100 m: heading difference (video minus GPX, both smoothed with sigma 8 m, paired at equal
  normalised arc length) versus arc length, least-squares line, slope in degrees per 100 m;
- residual scale: fitted scale (true GPX metres per video metre), its inverse, and the plain length ratio;
- smoothness of the lateral residual (2 m grid): correlation length (first lag where the autocorrelation
  falls below 1/e), fraction of the variance at wavelengths > 100 m / 30 to 100 m / < 30 m (Hann-windowed FFT,
  linear trend removed), and the RMS of the second difference at 10 m spacing;
- as a control, a plain similarity fit with TIME correspondences (video t == GPX t) and its RMS.

Limits (also written into the JSON): two pairs only; the GPX is itself noisy and, for Pennes, sampled every
4 s (18 points in the window, about 16 m apart), so the residual is an upper bound mixing video and GPS error;
the heading and lateral measures of the 280 m Pennes window rest on a handful of GPX points; and using
the same two pairs later as test queries is circular.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from ..core.geometry import cumulative_length, headings, interp_at, resample_arclength
from ..core.matcher import Candidate, MatchOptions, StatusThresholds, match
from ..core.similarity import fit_similarity
from ..core.trajectory import RelativeTrajectory
from ..io import road_reconstruction
from .gpx import GPX_FILES, gpx_window, load_gpx_local

ROUTES = Path(__file__).resolve().parents[3] / "road-reconstruction" / "routes"
PAIRS = {"pennes": "pennes-9140-nogpx", "menglonnais": "menglonnais-240-nogpx"}
EXPECTED_VIDEO_OVER_GPX = 1.2  # Phase 1: assumed mount height 1.1 m against 0.92 m implied by the GPX
HEADING_SMOOTH_M = 8.0


def _acf_length(x: np.ndarray, step: float) -> float:
    x = x - x.mean()
    n = len(x)
    if n < 8 or not np.any(x):
        return float("nan")
    acf = np.correlate(x, x, "full")[n - 1:] / (x @ x)
    below = np.nonzero(acf < 1 / math.e)[0]
    if len(below) == 0:
        return float("nan")
    i = below[0]
    if i == 0:
        return 0.0
    return float(step * (i - 1 + (acf[i - 1] - 1 / math.e) / (acf[i - 1] - acf[i])))


def _band_fractions(x: np.ndarray, step: float) -> dict[str, float]:
    n = len(x)
    t = np.arange(n)
    x = x - np.polyval(np.polyfit(t, x, 1), t)
    spec = np.abs(np.fft.rfft(x * np.hanning(n))) ** 2
    freq = np.fft.rfftfreq(n, step)[1:]
    spec = spec[1:]
    tot = spec.sum()
    if tot <= 0:
        return {"gt_100m": float("nan"), "30_100m": float("nan"), "lt_30m": float("nan")}
    wl = 1.0 / freq
    return {"gt_100m": float(spec[wl > 100].sum() / tot), "30_100m": float(spec[(wl <= 100) & (wl >= 30)].sum() / tot),
            "lt_30m": float(spec[wl < 30].sum() / tot)}


def measure_pair(video: RelativeTrajectory, gpx_ext: RelativeTrajectory, video_t: np.ndarray | None = None,
                 gpx_at_time=None) -> dict:
    """Measure the error model of one pair. `gpx_ext` is the GPX window extended at both ends (the search space).
    `gpx_at_time(t) -> (n, 2)` (optional) gives GPX positions at the video times for the time-aligned control."""
    cand = Candidate("gpx", gpx_ext.points)
    res = match(video, [cand], MatchOptions(rank_by="rmse_rel", thresholds=StatusThresholds(1.0, float("inf")), spacing_m=5.0, n_max=300,
                                            coarse_n_scales=9, refine_n_start=15, refine_n_scale=11, refine_rounds=6))
    m = res.distinct[0]
    # the fit on the full-resolution video points: matched window resampled to the video's own point count
    gs = cumulative_length(gpx_ext.points)
    n = len(video)
    vr = video.resample_n(n).points
    win = interp_at(gpx_ext.points, gs, m.window_start_m + m.window_length_m * np.linspace(0, 1, n))
    fit = fit_similarity(vr, win, scale_bounds=(video.scale.min, video.scale.max))
    vt = fit.apply(video.points)  # video in the GPX frame
    # cross-track residual to the matched window (dense polyline)
    dense_s = np.arange(m.window_start_m, m.window_start_m + m.window_length_m, 0.5)
    dense = interp_at(gpx_ext.points, gs, dense_s)
    tang = np.gradient(dense, axis=0)
    tang /= np.maximum(np.hypot(*tang.T), 1e-12)[:, None]
    dist, idx = cKDTree(dense).query(vt)
    off = vt - dense[idx]
    signed = tang[idx, 0] * off[:, 1] - tang[idx, 1] * off[:, 0]  # left of the GPX direction positive
    keep = (idx > 0) & (idx < len(dense) - 1)  # drop points projecting beyond the window ends
    # lateral residual on a 2 m grid along the video path (for smoothness)
    vs = cumulative_length(vt)
    grid = np.arange(0, vs[-1], 2.0)
    lat = np.interp(grid, vs[keep], signed[keep]) if keep.sum() > 4 else np.zeros_like(grid)
    # heading drift
    sm = lambda p: RelativeTrajectory(p).smooth(HEADING_SMOOTH_M)
    hv = headings(resample_arclength(sm(vt).points, 100))
    hg = headings(resample_arclength(sm(dense).points, 100))
    dh = np.unwrap(hv - hg)
    s_axis = (np.arange(len(dh)) + 0.5) / len(dh) * m.window_length_m
    slope, intercept = np.polyfit(s_axis, dh, 1)
    pred = slope * s_axis + intercept
    r2 = float(1 - np.sum((dh - pred) ** 2) / max(np.sum((dh - dh.mean()) ** 2), 1e-12))
    d2 = np.diff(lat[:: 5], 2) if len(lat) > 12 else np.array([0.0])
    out = {
        "video_length_m": video.length, "gpx_window_length_m": float(m.window_length_m), "matched_window_start_m": float(m.window_start_m),
        "gpx_ext_length_m": gpx_ext.length, "n_video_points": n, "n_gpx_points_in_window": int(np.sum((gpx_ext.cumulative_distance >= m.window_start_m) &
                                                                                            (gpx_ext.cumulative_distance <= m.window_start_m + m.window_length_m))),
        "fit": {"scale": fit.scale, "inverse_scale": 1 / fit.scale, "rotation_deg": math.degrees(fit.rotation), "scale_clamped": fit.scale_clamped,
                "length_ratio_video_over_gpx": video.length / m.window_length_m, "expected_video_over_gpx": EXPECTED_VIDEO_OVER_GPX},
        "residual": {"crosstrack_rms_m": float(np.sqrt(np.mean(signed[keep] ** 2))), "crosstrack_max_m": float(np.abs(signed[keep]).max()),
                     "crosstrack_mean_m": float(signed[keep].mean()), "correspondence_rms_m": fit.rms, "correspondence_max_m": fit.max_residual,
                     "n_points_used": int(keep.sum())},
        "heading_drift": {"slope_deg_per_100m": float(math.degrees(slope) * 100), "r2": r2, "rms_difference_deg": float(math.degrees(np.sqrt(np.mean(dh ** 2)))),
                          "total_difference_change_deg": float(math.degrees(dh[-1] - dh[0]))},
        "smoothness": {"corr_length_m": _acf_length(lat, 2.0), "variance_fractions_by_wavelength": _band_fractions(lat, 2.0),
                       "second_difference_rms_10m_m": float(np.sqrt(np.mean(d2 ** 2))), "grid_points": int(len(lat))},
    }
    if video_t is not None and gpx_at_time is not None:
        g = gpx_at_time(video_t)
        f2 = fit_similarity(video.points, g)
        out["time_aligned_control"] = {"rms_m": f2.rms, "max_m": f2.max_residual, "scale": f2.scale}
    return out


def recommend(pairs: dict[str, dict]) -> dict:
    """Perturbation parameters for the benchmark, from the measured pairs with margin (see the notes)."""
    inv = [p["fit"]["scale"] for p in pairs.values()]
    lat = [p["residual"]["crosstrack_rms_m"] for p in pairs.values()]
    cl = [p["smoothness"]["corr_length_m"] for p in pairs.values() if p["smoothness"]["corr_length_m"] == p["smoothness"]["corr_length_m"]]
    dr = [abs(p["heading_drift"]["slope_deg_per_100m"]) for p in pairs.values()]
    return {
        "scale_bias": float(np.mean(inv)), "scale_sigma": float(max(0.08, 2 * (max(inv) - min(inv)))), "scale_clip": [0.72, 1.35],
        "lateral_rms_m": float(max(lat)), "lateral_corr_len_m": float(min(max(np.mean(cl), 15.0), 120.0)) if cl else 40.0,
        "drift_deg_per_100m": float(max(dr)),
        "notes": ["margin: lateral RMS and drift are the larger of the two pairs; scale_sigma >= 0.08 (two pairs cannot give a spread)",
                  "lateral_corr_len_m clipped to [15, 120] m; the drift model is a random walk in arc length (assumption: the length dependence is not measured, only the 280 / 540 m windows)",
                  "the residual is an UPPER BOUND on video error: it also contains GPX noise (Pennes: 4 s sampling) and the effect of the drift is counted in both lateral and drift terms",
                  "calibrated on 2 pairs; using the same pairs later as test queries is circular"]}


def main(out_path: str, routes_dir: Path = ROUTES) -> int:
    pairs: dict[str, dict] = {}
    for name, route in PAIRS.items():
        gpx_path = GPX_FILES[name]
        if not gpx_path.exists() or not (routes_dir / route).exists():
            print(f"error: missing {gpx_path if not gpx_path.exists() else routes_dir / route}: cannot calibrate (nothing was written)", file=sys.stderr)
            return 2
        video = road_reconstruction.load(routes_dir / route)
        g = load_gpx_local(gpx_path)
        t0, t1 = float(video.t[0]), float(video.t[-1])
        pad = 0.15 * (t1 - t0)
        ext = gpx_window(g, t0 - pad, t1 + pad)
        from scipy.ndimage import gaussian_filter1d
        tt = np.arange(0, g[-1, 0], 0.5)
        gx = gaussian_filter1d(np.interp(tt, g[:, 0], g[:, 1]), 8.0)
        gy = gaussian_filter1d(np.interp(tt, g[:, 0], g[:, 2]), 8.0)
        at_time = lambda t, gx=gx, gy=gy, tt=tt: np.column_stack([np.interp(t, tt, gx), np.interp(t, tt, gy)])
        pairs[name] = measure_pair(video, ext, video.t, at_time)
        pairs[name]["route"] = route
        pairs[name]["gpx_points_in_video_window_raw"] = int(np.sum((g[:, 0] >= t0) & (g[:, 0] <= t1)))
        print(f"{name}: " + json.dumps({k: pairs[name][k] for k in ("fit", "residual", "heading_drift")}))
    doc = {"pairs": pairs, "recommended": recommend(pairs), "limits": [
        "two pairs only", "the GPX is noisy and for Pennes sampled every 4 s (18 points in the window): the residual is an upper bound mixing video and GPS error",
        "the same pairs used later as test queries make that test circular", "a rigid similarity fit absorbs part of the drift: the drift slope and the lateral residual are not independent"]}
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(doc, indent=1))
    print(f"wrote {p}")
    return 0
