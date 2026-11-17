# SPDX-License-Identifier: AGPL-3.0-or-later
"""Elevation from the Copernicus DEM GLO-30 (1 x 1 degree Cloud-Optimised GeoTIFF tiles), numpy + zlib only (TIFF reader: tiff.py).
Regional / national sources and the multi-source road-height estimator: demsrc.py and robust_profile() below.
Then: bilinear sampling, tunnel / bridge interpolation, noise-adaptive robust smoothing along the path (lower quantile + Gaussian where
the DEM is clean, median + robust local-linear fit where it is noisy), drift-free grade clamp, ascent with hysteresis."""
from __future__ import annotations

import math
import os
from pathlib import Path

import numpy as np

from .tiff import Tiff, UnsupportedTiff, undo_fp_predictor  # noqa: F401  (re-exported)

ATTRIB_DEM = ("Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, "
              "provided under COPERNICUS by the European Union and ESA")
URL = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"

# elevation corrections along the path (metres)
SAMPLE_M = 5.0           # DEM samples along the path
# The DEM is a surface model: trees and buildings beside the road only ever raise it. So the robust filter is a running LOWER quantile
# (25 % over 200 m), not the median, followed by a Gaussian (sigma 60 m). Chosen on five Van Gestel GPS tracks in the Drome (ascent within
# 1-16 % of the barometric reference; the median 25 m + Gaussian 20 m of the plan overestimated the ascent by 5-40 %, x3 on the flat
# Roanne valley); Roanne was held out (FEATURE_incyclist_export.md, PIPELINE_CLI.md).
LOWQ = 25.0              # percentile
LOWQ_M = 200.0           # window of the percentile
GAUSS_SIGMA_M = 60.0     # Gaussian after the percentile
# Noise-adaptive part (Amalfi feedback, 2026-11-13): on a road cut into a cliff the 30 m DSM pixels mix the rock above with the sea or a
# gorge below, so the DEM errs DOWN as often as up (+-30 m within 100 m). There the lower quantile follows the gorges and the profile
# gets 40 % too much ascent. The local noise (RMS of the raw DEM around a robust 60 m local-linear fit, over +-300 m) picks the filter:
# below NOISE_LO_M the plain lower quantile + Gaussian above, above NOISE_HI_M the median (HIGH_Q) followed by a robust local-linear
# fit (bisquare, sigma RLOESS_SIGMA_M), linear blend between. Chosen on Amalfi against Strava; Roanne and five Drome GPS tracks checked.
NOISE_SIGMA_M = 60.0     # robust fit the noise is measured around
NOISE_WIN_M = 300.0      # Gaussian window of the local noise RMS
NOISE_LO_M = 3.0         # local noise RMS below this: lower-quantile filter only
NOISE_HI_M = 10.0        # above this: median + robust local-linear fit only
HIGH_Q = 50.0            # percentile used where the DEM is noisy (errors go both ways)
RLOESS_SIGMA_M = 150.0   # Gaussian kernel of the robust local-linear fit where the DEM is noisy
RLOESS_ITERS = 4         # bisquare reweighting passes
RLOESS_C_MIN_M = 5.0     # bisquare cut-off: max(this, 6 x median |residual|)
GRADE_MAX = 0.18         # +-18 % (no steep-edge tag is read yet)
PORTAL_PAD_M = 15.0      # tunnel / bridge runs are widened by this much on both sides (the 30 m DEM blurs abutments and portals)
HYST_M = 3.0             # ascent / descent hysteresis


def tile_name(lat_floor: int, lon_floor: int) -> str:
    ns = f"{'N' if lat_floor >= 0 else 'S'}{abs(lat_floor):02d}_00"
    ew = f"{'E' if lon_floor >= 0 else 'W'}{abs(lon_floor):03d}_00"
    return f"Copernicus_DSM_COG_10_{ns}_{ew}_DEM"


def tiles_for_bbox(s: float, w: float, n: float, e: float) -> list[str]:
    return [tile_name(la, lo) for la in range(math.floor(s), math.floor(n) + 1) for lo in range(math.floor(w), math.floor(e) + 1)]


def expand_bbox(lat, lon, pad_m: float = 500.0):
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    dlat = pad_m / 111_320.0
    dlon = pad_m / (111_320.0 * max(0.1, math.cos(math.radians(float(np.mean(lat))))))
    return float(lat.min() - dlat), float(lon.min() - dlon), float(lat.max() + dlat), float(lon.max() + dlon)


# ------------------------------------------------------------------ TIFF (rsm.pipeline.tiff; the names stay importable from here)
Cog = Tiff


class Dem:
    """the tiles in a directory; a `<name>.none` marker means 'no tile here' (sea), sampled as 0 m"""

    def __init__(self, dem_dir):
        self.dir = Path(dem_dir)
        self.cogs: dict[str, Cog | None] = {}

    def missing(self, names: list[str]) -> list[str]:
        return [n for n in names if not (self.dir / f"{n}.tif").exists() and not (self.dir / f"{n}.none").exists()]

    def _cog(self, name: str):
        if name not in self.cogs:
            p = self.dir / f"{name}.tif"
            self.cogs[name] = Cog(p) if p.exists() else None
        return self.cogs[name]

    def sample(self, lat, lon) -> np.ndarray:
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        out = np.zeros(len(lat))
        la, lo = np.floor(lat).astype(int), np.floor(lon).astype(int)
        for a, b in set(zip(la.tolist(), lo.tolist())):
            m = (la == a) & (lo == b)
            c = self._cog(tile_name(a, b))
            if c is not None:
                out[m] = c.sample(lon[m], lat[m])
        return out

    def close(self):
        for c in self.cogs.values():
            if c is not None:
                c.close()


# ------------------------------------------------------------------ corrections along the path
def interp_runs(z: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, float]:
    """replace masked runs by the straight line between the unmasked neighbours (constant at the ends). -> (z, metres of path changed)"""
    z = np.asarray(z, float).copy()
    ok = ~np.asarray(mask, bool)
    if ok.all():
        return z, 0
    if not ok.any():
        return z, len(z)
    idx = np.arange(len(z))
    z[~ok] = np.interp(idx[~ok], idx[ok], z[ok])
    return z, int((~ok).sum())


def widen(mask: np.ndarray, n: int) -> np.ndarray:
    if n <= 0 or not mask.any():
        return mask.copy()
    k = np.convolve(mask.astype(float), np.ones(2 * n + 1), mode="same")
    return k > 0


def running_quantile(z: np.ndarray, n: int, q=50.0) -> np.ndarray:
    """q-th percentile (scalar, or one per sample) over a centred window of n samples (n odd), edges padded; linear between order statistics"""
    z = np.asarray(z, float)
    if n <= 1 or len(z) < 3:
        return z.copy()
    h = n // 2
    p = np.pad(z, h, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(p, 2 * h + 1)
    if np.ndim(q) == 0:
        return np.percentile(win, float(q), axis=1)
    win = np.sort(win, axis=1)
    pos = np.clip(np.asarray(q, float), 0, 100) / 100 * (2 * h)
    lo = np.floor(pos).astype(int)
    f = pos - lo
    hi = np.minimum(lo + 1, 2 * h)
    r = np.arange(len(z))
    return win[r, lo] * (1 - f) + win[r, hi] * f


def _corr(x: np.ndarray, k: np.ndarray) -> np.ndarray:
    """out[j] = sum_u k[u] x[j + u] (u centred), zero outside"""
    h = len(k) // 2
    return np.convolve(np.pad(x, h), k[::-1], mode="valid")


def robust_local_linear(z: np.ndarray, sigma: float, iters: int = RLOESS_ITERS, c_min: float = RLOESS_C_MIN_M) -> np.ndarray:
    """robust LOESS: Gaussian-weighted local linear fit (sigma in samples), reweighted `iters` times with Tukey's bisquare
    (cut-off max(c_min, 6 x median |residual|)). A local line keeps grades and climbs that a plain average would flatten at the ends."""
    z = np.asarray(z, float)
    if sigma <= 0 or len(z) < 3:
        return z.copy()
    h = int(math.ceil(3 * sigma))
    u = np.arange(-h, h + 1, dtype=float)
    K = np.exp(-0.5 * (u / sigma) ** 2)
    w = np.ones(len(z))
    fit = z
    for it in range(iters + 1):
        a0, a1, a2 = _corr(w, K), _corr(w, K * u), _corr(w, K * u * u)
        b0, b1 = _corr(w * z, K), _corr(w * z, K * u)
        det = a0 * a2 - a1 ** 2
        good = det > 1e-6 * np.maximum(a0, 1e-12) ** 2
        fit = np.where(good, (a2 * b0 - a1 * b1) / np.where(good, det, 1.0), b0 / np.maximum(a0, 1e-12))
        if it == iters:
            break
        r = z - fit
        c = max(c_min, 6.0 * float(np.median(np.abs(r))))
        w = np.clip(1.0 - (r / c) ** 2, 0.0, 1.0) ** 2
    return fit


def local_noise(z: np.ndarray, ds: float) -> np.ndarray:
    """local RMS (Gaussian window NOISE_WIN_M) of the DEM around a robust local-linear fit (NOISE_SIGMA_M), metres"""
    r = np.asarray(z, float) - robust_local_linear(z, NOISE_SIGMA_M / ds)
    return np.sqrt(gauss(r ** 2, NOISE_WIN_M / ds))


def gauss(z: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0 or len(z) < 3:
        return z.copy()
    h = int(math.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-h, h + 1) / sigma) ** 2)
    k /= k.sum()
    p = np.pad(z, h, mode="edge")
    return np.convolve(p, k, mode="valid")


def clamp_grade(z: np.ndarray, ds: float, gmax: float = GRADE_MAX, max_iter: int = 20000) -> tuple[np.ndarray, float]:
    """limit |dz/ds| to gmax by alternating projections: every too steep step moves its two ends towards each other by half the
    excess (even steps, then odd steps, until none is left). Each move keeps the local mean, so nothing drifts: a too steep bit
    only changes the profile around itself. (The earlier clip-and-re-integrate left a step of up to 13 m behind it for the rest
    of the route on Amalfi.) -> (z, metres of height clipped from the input steps)"""
    z = np.asarray(z, float).copy()
    if len(z) < 2:
        return z, 0.0
    lim = gmax * ds
    g = np.diff(z)
    clipped = float(np.maximum(np.abs(g) - lim, 0).sum())
    if clipped == 0:
        return z, 0.0
    for _ in range(max_iter):
        moved = 0.0
        for par in (0, 1):
            i = np.arange(par, len(z) - 1, 2)
            d = z[i + 1] - z[i]
            ex = np.sign(d) * np.maximum(np.abs(d) - lim, 0.0)
            z[i] += ex / 2
            z[i + 1] -= ex / 2
            moved += float(np.abs(ex).sum())
        if moved < 1e-6:
            break
    # the projections approach the limit asymptotically: clip the last micrometres exactly (re-integrating them cannot drift visibly)
    z = z[0] + np.concatenate([[0.0], np.cumsum(np.clip(np.diff(z), -lim, lim))])
    return z, clipped


def ascent_descent(z: np.ndarray, hyst: float = HYST_M) -> tuple[float, float]:
    """total climb and descent, counting a change only once it exceeds `hyst` from the last turning point"""
    z = np.asarray(z, float)
    if len(z) < 2:
        return 0.0, 0.0
    up = down = 0.0
    ref = z[0]
    for v in z[1:]:
        if v - ref >= hyst:
            up += v - ref; ref = v
        elif ref - v >= hyst:
            down += ref - v; ref = v
    return up, down


def profile(s_grid: np.ndarray, z_raw: np.ndarray, tunnel: np.ndarray, bridge: np.ndarray, ds: float = SAMPLE_M) -> tuple[np.ndarray, dict]:
    """z_raw sampled every ds metres along the path -> corrected profile and the correction statistics"""
    pad = int(round(PORTAL_PAD_M / ds))
    tu, br = widen(np.asarray(tunnel, bool), pad), widen(np.asarray(bridge, bool), pad)
    z1, n_tb = interp_runs(z_raw, tu | br)
    n_q = max(1, int(round(LOWQ_M / ds))) | 1
    if len(z1) >= 3:
        noise = local_noise(z1, ds)
        a = np.clip((noise - NOISE_LO_M) / (NOISE_HI_M - NOISE_LO_M), 0.0, 1.0)        # 0 = clean DEM, 1 = noisy DEM
        zq = running_quantile(z1, n_q, LOWQ + (HIGH_Q - LOWQ) * a)
        z2 = (1 - a) * gauss(zq, GAUSS_SIGMA_M / ds) + a * (robust_local_linear(zq, RLOESS_SIGMA_M / ds) if a.any() else zq)
    else:
        noise, a, z2 = np.zeros(len(z1)), np.zeros(len(z1)), z1.copy()
    z3, clipped = clamp_grade(z2, ds)
    runs = lambda m: int(np.count_nonzero(np.diff(np.concatenate([[0], m.astype(int), [0]])) == 1))
    st = dict(tunnel_m=float(np.asarray(tunnel, bool).sum() * ds), bridge_m=float(np.asarray(bridge, bool).sum() * ds),
              tunnels=runs(np.asarray(tunnel, bool)), bridges=runs(np.asarray(bridge, bool)),
              interpolated_m=float(n_tb * ds), smoothing_abs_mean_m=float(np.mean(np.abs(z2 - z1))) if len(z1) else 0.0, grade_clamped_m=round(clipped, 2),
              noise_median_m=round(float(np.median(noise)), 2) if len(noise) else 0.0, noisy_share=round(float(np.mean(a > 0.5)), 3) if len(a) else 0.0,
              grade_max=GRADE_MAX, low_quantile=LOWQ, low_quantile_window_m=LOWQ_M, gauss_sigma_m=GAUSS_SIGMA_M,
              noise_lo_m=NOISE_LO_M, noise_hi_m=NOISE_HI_M, high_quantile=HIGH_Q, rloess_sigma_m=RLOESS_SIGMA_M,
              portal_pad_m=PORTAL_PAD_M, sample_m=ds)
    return z3, st


def env_dem_dir() -> str | None:
    return os.environ.get("RSM_DEM_DIR") or None


# ------------------------------------------------------------------ multi-source road height (ELEVATION_STRATEGY.md)
MULTI_SOURCE = True           # False: the P13 profile of Copernicus alone, extra sources ignored (the way back)
# Copernicus FLM classes that are TanDEM-X (1 = edited, 2 = neither edited nor filled); 0 = mask not available (treated as TanDEM-X)
FLM_TDX = (0, 1, 2)
COP_SIGMA_M, COP_FILLED_SIGMA_M, COP_OFFSETS = 2.0, 10.0, (-15.0, 0.0, 15.0)
FILL_FEATHER_M = 30.0         # Gaussian feather of the FLM fill weight (DEM_STUDY 5)
# robust estimator (penalised spline, Cauchy plausibility weights with graduated non-convexity), chosen on Amalfi + 3 Drome routes,
# held out: Roanne, Rousset, Pontaix and 13 further routes (ELEVATION_STRATEGY.md 4)
RS_ELL_FLAT_M = 60.0          # spline stiffness length where the terrain is gentle and the samples agree (keeps short ramps)
RS_ELL_RUG_M = 100.0          # ... where it is rugged: stiffer between the consensus hits
RS_K_UP = 4.0                 # DSM samples below the profile are tolerated x this more than those above (canopy, roofs) in gentle terrain; x1 (symmetric) in rugged terrain
RS_C_FINAL = 1.5              # final Cauchy scale in units of each sample's sigma (gentle terrain) ...
RS_C_RUG = 1.0                # ... and in rugged terrain (harder plausibility test)
RS_SCHEDULE = (8.0, 4.0, 2.0, 1.0, 1.0)  # graduated non-convexity: Cauchy scale multipliers of the passes
RS_C_FLOOR_M = 1.0            # ... and the scale is at least this many metres x the multiplier (a 0.5 m LiDAR sample starts at 8 m, not 4 m)
RUG_SLOPE = (0.3, 0.9)        # cross slope (Copernicus, +-15 m, smoothed 100 m) mapped to ruggedness 0..1
RUG_NOISE = (3.0, 10.0)       # local DEM noise (as in the P13 filter) mapped to 0..1
RUG_SMOOTH_M = 100.0
DTM_BLEND_M = 100.0           # where no terrain model has data the fused P13 profile is used; feathered over this


def corridor_normals(lat, lon, ds: float = SAMPLE_M, smooth_m: float = 30.0):
    """unit left normals (east, north) of the path, from the positions smoothed over +-smooth_m"""
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    c = math.cos(math.radians(float(np.mean(lat)))) if len(lat) else 1.0
    x, y = lon * 111_320.0 * c, lat * 111_320.0
    k = max(1, int(smooth_m / ds))
    box = np.ones(2 * k + 1) / (2 * k + 1)
    if len(x) < 2:
        return np.zeros(len(x)), np.ones(len(x)), c
    xs, ys = np.convolve(np.pad(x, k, mode="edge"), box, "valid"), np.convolve(np.pad(y, k, mode="edge"), box, "valid")
    dx, dy = np.gradient(xs), np.gradient(ys)
    n = np.hypot(dx, dy) + 1e-9
    return -dy / n, dx / n, c


def collect_samples(lat, lon, cop: "Dem", multi=None, ds: float = SAMPLE_M) -> dict:
    """corridor samples across the road: Copernicus (and its fill mask) and every extra source of `multi` (demsrc.Multi) -> dict of
    name -> dict(z (N, M), o (M,), sigma, dsm); plus 'flm' (N, 3) for the Copernicus columns. NaN where a source has no data."""
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    nx, ny, c = corridor_normals(lat, lon, ds)

    def at(o):
        return lat + ny * o / 111_320.0, lon + nx * o / (111_320.0 * c)
    out = {}
    Z = np.column_stack([cop.sample(*at(o)) for o in COP_OFFSETS])
    out["cop"] = dict(z=Z, o=np.array(COP_OFFSETS), sigma=COP_SIGMA_M, dsm=True, px=30.0)
    out["flm"] = np.column_stack([multi.flm(*at(o)) for o in COP_OFFSETS]) if multi is not None else np.zeros(Z.shape, np.uint8)
    if multi is not None:
        for name, s in multi.src.items():
            if s.kind == "mask":
                continue
            o = np.asarray(s.offsets, float)
            Zs = np.column_stack([multi.sample(name, *at(v)) for v in o])
            if np.isfinite(Zs).any():
                out[name] = dict(z=Zs, o=o, sigma=s.sigma_m, dsm=s.dsm, px=s.res_m if s.kind == "dtm" else 30.0, kind=s.kind)
    return out


def _datum_mode(d: np.ndarray) -> float | None:
    """mode of height differences (0.25 m bins, smoothed): robust to the one-sided canopy tail of a DSM; None if too few"""
    d = d[np.isfinite(d) & (np.abs(d) < 30)]
    if len(d) < 200:
        return None
    h, e = np.histogram(d, bins=np.arange(-30, 30.25, 0.25))
    h = gauss(h.astype(float), 2.0)
    i = int(np.argmax(h))
    return float(0.5 * (e[i] + e[i + 1]))


def ruggedness(S: dict, ds: float = SAMPLE_M) -> tuple[np.ndarray, dict]:
    """0 = gentle, open terrain, clean DEM; 1 = rugged (steep cross slope, noisy DEM or void-filled Copernicus); soft OR of the three"""
    Z = S["cop"]["z"]
    zc = Z[:, 1]
    zc = np.where(np.isfinite(zc), zc, np.nanmean(zc) if np.isfinite(zc).any() else 0.0)
    cs = gauss(np.nan_to_num(np.abs(Z[:, 0] - Z[:, 2]) / 30.0), RUG_SMOOTH_M / ds)
    noise = local_noise(zc, ds) if len(zc) >= 3 else np.zeros(len(zc))
    fill = gauss((~np.isin(S["flm"][:, 1], FLM_TDX)).astype(float), RUG_SMOOTH_M / ds)
    r_s = np.clip((cs - RUG_SLOPE[0]) / (RUG_SLOPE[1] - RUG_SLOPE[0]), 0, 1)
    r_n = np.clip((noise - RUG_NOISE[0]) / (RUG_NOISE[1] - RUG_NOISE[0]), 0, 1)
    r_f = np.clip(2 * fill, 0, 1)
    r = np.clip(gauss(1 - (1 - r_s) * (1 - r_n) * (1 - r_f), RUG_SMOOTH_M / ds), 0, 1)
    return r, dict(cross_slope=cs, noise=noise, fill=fill)


def _stack(S: dict, ds: float, align: bool = True):
    """all samples as (N, M) arrays: value (cross-slope corrected), sigma, DSM flag, prior weight; plus the datum offsets applied"""
    zc = S["cop"]["z"][:, 1]
    tdx = np.isin(S["flm"][:, 1], FLM_TDX)
    Zs, Ss, As, Ps, info = [], [], [], [], {}
    for name, s in S.items():
        if name == "flm":
            continue
        Z, o = s["z"].astype(float).copy(), s["o"]
        if align and name != "cop":
            j = int(np.argmin(np.abs(o)))
            off = _datum_mode(zc[tdx] - Z[tdx, j])
            info[name] = off
            if s["dsm"] and off is not None:
                Z = Z + off                         # DSM fills are aligned to Copernicus; terrain models keep their own (national) datum
        if len(o) > 1:                             # each sample estimates the centre height on a locally planar cross section
            cs = gauss(np.nan_to_num((Z[:, -1] - Z[:, 0]) / (o[-1] - o[0])), 50 / ds)
            Z = Z - cs[:, None] * o[None, :]
        else:
            cs = np.zeros(len(Z))
        sl = np.abs(cs)
        Sg = np.full(Z.shape, float(s["sigma"])) + 0.3 * s["px"] * sl[:, None] * (1.0 if s["dsm"] else 0.3) + 0.15 * np.abs(o)[None, :] * sl[:, None]
        if name == "cop":
            Sg = np.where(np.isin(S["flm"], FLM_TDX), Sg, np.maximum(Sg, COP_FILLED_SIGMA_M))
        P = np.broadcast_to(np.exp(-0.5 * (o / max(s["px"], 1e-6)) ** 2), Z.shape).copy()
        Zs.append(Z); Ss.append(Sg); As.append(np.full(Z.shape, bool(s["dsm"]))); Ps.append(P)
    return np.hstack(Zs), np.hstack(Ss), np.hstack(As), np.hstack(Ps), info


def _weighted_median(Z: np.ndarray, w: np.ndarray) -> np.ndarray:
    """per row, the weighted median of Z (weights w >= 0); rows without weight give 0"""
    o = np.argsort(Z, axis=1)
    Zs, ws = np.take_along_axis(Z, o, 1), np.take_along_axis(w, o, 1)
    cw = np.cumsum(ws, axis=1)
    half = 0.5 * cw[:, -1:]
    i = np.minimum((cw < half).sum(1), Z.shape[1] - 1)
    return Zs[np.arange(len(Z)), i]


def _penalty_bands(lam: np.ndarray, n: int) -> np.ndarray:
    """upper banded form (scipy solveh_banded) of D^T diag(lam) D with D the second differences"""
    L = np.zeros(n)
    L[:max(0, n - 2)] = lam[:max(0, n - 2)]
    main = L.copy(); main[1:] += 4 * L[:-1]; main[2:] += L[:-2]
    o1 = np.zeros(n); t = -2 * L[:n - 1].copy(); t[1:] += -2 * L[:n - 2]; o1[1:] = t
    o2 = np.zeros(n); o2[2:] = L[:n - 2]
    return np.vstack([o2, o1, main])


def stack_columns(S: dict) -> list[tuple[str, int]]:
    """(source name, number of columns) in the column order of _stack"""
    return [(name, int(s["z"].shape[1])) for name, s in S.items() if name != "flm"]


def robust_road_height(S: dict, gap: np.ndarray, rug: np.ndarray, ds: float = SAMPLE_M, ell_flat: float | None = None, ell_rug: float | None = None,
                       k_up: float | None = None, c_final: float | None = None, c_rug: float | None = None, schedule=None, diag: dict | None = None):
    """the most plausible continuous road profile through all corridor samples (penalised spline, IRLS with Cauchy weights, GNC).
    Rugged terrain: stiffer spline (ell_rug), tighter plausibility, symmetric DSM errors; gentle terrain: softer, DSM errs upward.
    `diag` (a dict, optional) receives the final weights for the app's elevation view: `w` (N, M) the weight of every sample in the last pass,
    `cau` (N, M) its plausibility factor 1 / (1 + (residual / scale)^2) in 0..1 (0 where there is no sample). Nothing else changes."""
    from scipy.linalg import solveh_banded
    ell_flat = RS_ELL_FLAT_M if ell_flat is None else ell_flat
    ell_rug = RS_ELL_RUG_M if ell_rug is None else ell_rug
    k_up = RS_K_UP if k_up is None else k_up
    c_final = RS_C_FINAL if c_final is None else c_final
    c_rug = RS_C_RUG if c_rug is None else c_rug
    schedule = RS_SCHEDULE if schedule is None else schedule
    Z, Sg, A, P, info = _stack(S, ds)
    ok = np.isfinite(Z) & ~np.asarray(gap, bool)[:, None]
    Zf = np.where(ok, Z, 0.0)
    n = len(Z)
    r = np.clip(np.asarray(rug, float), 0, 1)
    ell = ell_flat * (ell_rug / ell_flat) ** r
    kup = k_up ** (1 - r)
    cmin = c_final * (c_rug / c_final) ** r
    w0 = np.where(ok, P / Sg ** 2, 0.0)
    W0 = w0.sum(1)
    if not (W0 > 0).any():
        return np.full(n, np.nan), dict(datum=info)
    Wref = float(np.median(W0[W0 > 0]))
    f = _weighted_median(Zf, w0)                              # robust start: a far-off source cannot drag the first fit towards itself
    if (W0 == 0).any():
        f[W0 == 0] = np.interp(np.flatnonzero(W0 == 0), np.flatnonzero(W0 > 0), f[W0 > 0])
    ab = _penalty_bands(Wref * (ell / ds) ** 4, n)
    Wd = W0
    for cm in schedule:
        c = np.maximum(np.maximum(cm, cmin)[:, None] * Sg, RS_C_FLOOR_M * cm)      # precise sources still see the early, wide passes
        res = Z - f[:, None]
        cu = np.where(A & (res < 0), c * kup[:, None], c)          # a DSM sample below the profile is not canopy: tolerated more
        w = np.where(ok, P / Sg ** 2 / (1 + (res / cu) ** 2), 0.0)
        if diag is not None:
            diag["cau"] = np.where(ok, 1.0 / (1.0 + (res / cu) ** 2), 0.0)
        Wd = w.sum(1)
        ab2 = ab.copy(); ab2[2] += Wd + 1e-9 * Wref
        f = solveh_banded(ab2, (w * Zf).sum(1))
    if diag is not None:
        diag["w"] = w
    # share of the prior weight that the final plausibility test kept, per station (consensus strength)
    kept = Wd / np.maximum(W0, 1e-12)
    return f, dict(datum=info, ell_mean_m=round(float(ell.mean()), 1), consensus_median=round(float(np.median(kept[W0 > 0])), 3))


def fused_raw(S: dict, ds: float = SAMPLE_M) -> tuple[np.ndarray, list]:
    """DEM_STUDY 4 recipe at the road axis: Copernicus, its void-filled pixels (FLM) replaced by the mean of the fill sources (aligned),
    feathered over FILL_FEATHER_M -> (z, the fill sources used)"""
    zc = S["cop"]["z"][:, 1]
    filled = ~np.isin(S["flm"][:, 1], FLM_TDX)
    tdx = ~filled
    fills, used = [], []
    for name, s in S.items():
        if name in ("flm", "cop") or s.get("kind") != "fill":
            continue
        zf = s["z"][:, int(np.argmin(np.abs(s["o"])))].astype(float)
        off = _datum_mode(zc[tdx] - zf[tdx])
        fills.append(zf + (off or 0.0)); used.append(name)
    if not fills or not filled.any():
        return zc.copy(), []
    g = np.nanmean(np.column_stack(fills), axis=1)
    w = np.clip(gauss(filled.astype(float), FILL_FEATHER_M / ds) * 2, 0, 1)
    w = np.where(np.isfinite(g), w, 0.0)
    return (1 - w) * zc + w * np.nan_to_num(g), used if (w > 0.5).any() else []


def profile_multi(s_grid: np.ndarray, S: dict, tunnel: np.ndarray, bridge: np.ndarray, ds: float = SAMPLE_M, diag: dict | None = None) -> tuple[np.ndarray, dict]:
    """road profile from the corridor samples of all sources (collect_samples):
    - where a terrain model (kind dtm) has data: the robust multi-source estimator (robust_road_height);
    - elsewhere: Copernicus with its void-filled pixels replaced (fused_raw), then the P13 filter (profile);
    feathered over DTM_BLEND_M; then the tunnel / bridge interpolation and the grade clamp. -> (z, stats incl. 'sources_used')
    `diag` (a dict, optional) receives the intermediate arrays for the elevation view (elevation_diag.json): z_p13, gap, rug, w_dtm and, where the
    robust estimator ran, its weights (est). The profile does not depend on it."""
    tunnel, bridge = np.asarray(tunnel, bool), np.asarray(bridge, bool)
    pad = int(round(PORTAL_PAD_M / ds))
    gap = widen(tunnel, pad) | widen(bridge, pad)
    zfu, fills_used = fused_raw(S, ds)
    z_p13, st = profile(s_grid, zfu, tunnel, bridge, ds)
    dtm = [k for k, s in S.items() if k != "flm" and s.get("kind") == "dtm"]
    have = np.zeros(len(s_grid))
    for k in dtm:
        have = np.maximum(have, np.isfinite(S[k]["z"]).mean(1))
    used = ["copernicus"] + fills_used
    if diag is not None:
        diag.update(z_p13=z_p13, gap=gap, rug=ruggedness(S, ds)[0] if len(s_grid) >= 3 else np.zeros(len(s_grid)), w_dtm=np.zeros(len(s_grid)), est=None)
    st.update(strategy="p13+fill" if fills_used else "p13", fill_share=round(float((~np.isin(S["flm"][:, 1], FLM_TDX)).mean()), 3), dtm_share=0.0)
    if dtm and (have > 0.5).any() and len(s_grid) >= 5:
        rug, _ = ruggedness(S, ds)
        est = {} if diag is not None else None
        zr, info = robust_road_height(S, gap, rug, ds, diag=est)
        zr, _ = interp_runs(zr, gap)
        w = np.clip(gauss((have > 0.5).astype(float), DTM_BLEND_M / ds) * 2 - 0.0, 0, 1) * (have > 0.0)
        if diag is not None:
            diag.update(w_dtm=w, est=est, rug=rug)
        z2 = w * zr + (1 - w) * z_p13
        z3, clipped = clamp_grade(z2, ds)
        used += [k for k in dtm if np.isfinite(S[k]["z"]).any()] + [k for k, s in S.items() if k != "flm" and s.get("kind") == "fill" and k not in used]
        st.update(strategy="robust-multi", dtm_share=round(float((have > 0.5).mean()), 3), ruggedness_mean=round(float(rug.mean()), 3),
                  grade_clamped_m=round(clipped, 2), rs_ell_flat_m=RS_ELL_FLAT_M, rs_ell_rug_m=RS_ELL_RUG_M, rs_k_up=RS_K_UP, **info)
        z_out = z3
    else:
        z_out = z_p13
    st["sources_used"] = used
    return z_out, st
