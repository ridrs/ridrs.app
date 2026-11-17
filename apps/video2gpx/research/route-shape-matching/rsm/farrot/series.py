# SPDX-License-Identifier: AGPL-3.0-or-later
"""Window fits -> yaw / roll / lean series (numpy only).

Per window (tiling the time axis): heading increment `dth` (rad, left positive), 1-sigma `sig`, inlier count, source flag (far = far-feature fit, vms = fallback).
Steps: validity gate of the window fit, correction of the translation leak (fitted yaw A_fit = A - eps * x0 with eps = e / f the fitted expansion and x0 the focal point
column, estimated per video on windows with no turning), lean from the integrated, high-passed roll, world-vertical rotation from the full 3-D rotation:

    heading increment = (A cos(phi) - B sin(phi)) / f          phi = lean (right positive), B = pitch (up positive)

Fallback to the vms yaw (scaled by its regression on the far yaw) where the window is not valid; the sources are recorded.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

from . import track as _t  # noqa: F401  (FIELDS only; cv2 is imported inside the worker functions)

WORK = Path(__file__).resolve().parents[2] / "work" / "farrot"


@dataclass
class SeriesParams:
    min_inl: int = 40
    max_sA: float = 1.2           # px per window (360 rows); beyond this the window is not trusted
    max_eps: float = 0.12         # fitted expansion e / f: beyond this the "far" consensus is mostly near stuff
    x0_correct: bool = True
    sig_x0: float = 15.0          # px, uncertainty of the focal point column
    straight_px: float = 0.6      # |3 s mean vms yaw| per window below this: the camera is not turning (x0 estimation)
    lean: bool = True
    lean_hp_s: float = 30.0       # high-pass of the integrated roll (lean returns to zero within this time)
    max_lean_deg: float = 55.0
    n_bands: int = 3              # nested bands tried far-first; the first band with a valid fit is used


@dataclass
class Series:
    name: str
    f: float
    ta: np.ndarray
    tb: np.ndarray
    dth: np.ndarray            # rad per window, final (far where valid, vms fallback elsewhere)
    sig: np.ndarray            # rad
    src: np.ndarray            # 0 far, 1 vms fallback
    dth_cam: np.ndarray        # rad per window, camera yaw A/f only (NaN where invalid)
    dth_far: np.ndarray        # rad per window, final far estimate (world, lean-corrected if lean on), NaN where invalid
    vms: np.ndarray            # rad per window, vms yaw scaled to rad with g_vms (all windows)
    n_inl: np.ndarray
    lean: np.ndarray           # rad
    roll_inc: np.ndarray
    meta: dict = field(default_factory=dict)

    @property
    def tm(self):
        return 0.5 * (self.ta + self.tb)


def load_windows(name: str, tag: str = "base"):
    d = np.load(WORK / f"win_{name}_{tag}.npz")
    F = [str(x) for x in d["fields"]]
    return d, {k: d["data"][..., i] for i, k in enumerate(F)}, json.loads(str(d["meta"]))


def vms_window_sums(csv_path: str, idx: np.ndarray, k: int) -> np.ndarray:
    """vms yaw (px at 360 rows) summed over the pairs of window i (frames i k .. (i+1) k); missing pairs filled with the window's other pairs (scaled)."""
    csv = np.genfromtxt(csv_path, delimiter=",", names=True, filling_values=np.nan)
    fr = csv["frame"].astype(int); y = csv["yaw"]
    good = np.isfinite(y) & (csv["inliers"] >= 20)
    n = int(fr.max()) + 2
    Y = np.zeros(n); G = np.zeros(n)
    Y[fr] = np.where(good, y, 0.0); G[fr] = good
    CY, CG = np.cumsum(Y), np.cumsum(G)
    a, b = idx * k, (idx + 1) * k
    b = np.minimum(b, n - 1)
    s = CY[b] - CY[a]; c = CG[b] - CG[a]
    return np.where(c >= 0.5 * k, s * k / np.maximum(c, 1), np.nan)


def _fill(x):
    i = np.arange(len(x)); g = np.isfinite(x)
    return np.interp(i, i[g], x[g]) if g.any() else np.zeros_like(x)


def estimate_x0(A, eps, vms_px, p: SeriesParams, win: int = 11):
    """Focal-point column (px) from windows in which the camera does not turn: A_fit = -eps x0. Robust (IRLS) slope through the origin."""
    v = gaussian_filter1d(_fill(vms_px), win / 2.0)
    m = np.isfinite(A) & np.isfinite(eps) & (np.abs(v) < p.straight_px) & (np.abs(eps) > 0.01)
    if m.sum() < 100:
        return 0.0, int(m.sum())
    a, e = A[m], eps[m]
    x0 = 0.0
    for _ in range(30):
        r = a + e * x0
        s = 1.4826 * np.median(np.abs(r)) + 1e-9
        w = 1 / np.maximum(1, np.abs(r) / (1.5 * s))
        x0 = -float((w * e * a).sum() / (w * e * e).sum())
    return x0, int(m.sum())


def build(name: str, csv_path: str, tag: str = "base", p: SeriesParams | None = None, x0: float | None = None) -> Series:
    p = p or SeriesParams()
    d, F, meta = load_windows(name, tag)
    f, k, fps = meta["f"], meta["k"], meta["fps"]
    idx = d["idx"]
    ta, tb = d["ta"], d["tb"]
    nb = min(p.n_bands, d["ok"].shape[1])
    okb = d["ok"][:, :nb].astype(bool) & (d["n_inl"][:, :nb] >= p.min_inl) & (F["sA"][:, :nb] <= p.max_sA) & (np.abs(F["e"][:, :nb]) / f <= p.max_eps)
    band = np.where(okb.any(1), okb.argmax(1), -1)
    ok = band >= 0
    pick = lambda q: np.where(ok, np.take_along_axis(q[:, :nb], np.maximum(band, 0)[:, None], 1)[:, 0], np.nan)
    A, B, C, e, sA_f = (pick(F[q]) for q in ("A", "B", "C", "e", "sA"))
    n_inl_ = np.where(ok, pick(d["n_inl"]), 0)
    eps = e / f
    vms_px = vms_window_sums(csv_path, idx, k)
    x0_est, n_x0 = estimate_x0(A, eps, vms_px, p)
    if x0 is not None:
        x0_est = x0
    A_true = A + eps * x0_est if p.x0_correct else A
    sA = np.sqrt(sA_f ** 2 + (np.abs(eps) * p.sig_x0) ** 2)
    # roll -> lean (high-passed integral); invalid windows contribute no roll
    roll = np.where(ok, C / f, 0.0)
    Phi = np.cumsum(roll)
    hp = p.lean_hp_s / (k / fps)
    lean = Phi - gaussian_filter1d(Phi, hp, mode="nearest")
    lean = np.clip(lean, -np.radians(p.max_lean_deg), np.radians(p.max_lean_deg))
    cam = A_true / f
    if p.lean:
        world = (A_true * np.cos(lean) - np.where(np.isfinite(B), B, 0.0) * np.sin(lean)) / f
    else:
        world = cam
    # vms in rad: regression of the far yaw on the vms yaw (through the origin, robust), then used as the fallback and as a second measurement
    m = ok & np.isfinite(vms_px)
    g = 1.0
    w = np.ones(m.sum())
    for _ in range(30):
        g = float((w * vms_px[m] * world[m] * f).sum() / (w * vms_px[m] ** 2).sum())
        r = world[m] * f - g * vms_px[m]
        s = 1.4826 * np.median(np.abs(r)) + 1e-9
        w = 1 / np.maximum(1, np.abs(r) / (1.5 * s))
    vms = g * vms_px / f
    # local vms noise relative to the far yaw: rolling robust sd of the residual (60 s)
    res = np.where(m, vms - world, np.nan)
    sig_vms = _rolling_mad(res, int(60 / (k / fps)))
    sig_far = sA / f
    # inverse-variance fusion where both exist; vms alone where the far window is invalid
    w_f = np.where(ok, 1 / sig_far ** 2, 0.0)
    ok_v = np.isfinite(vms)
    w_v = np.where(ok_v, 1 / np.maximum(sig_vms, 1e-4) ** 2, 0.0)
    num = w_f * np.where(ok, world, 0.0) + w_v * np.where(ok_v, vms, 0.0)
    den = w_f + w_v
    dth = np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)
    sig = np.where(den > 0, 1 / np.sqrt(np.maximum(den, 1e-12)), 1.0)
    src = np.where(ok, 0, np.where(ok_v, 1, 2)).astype(int)
    meta2 = dict(meta, band_share=[float((band == b).mean()) for b in range(nb)], g_vms=g, x0=x0_est, n_x0=n_x0, params=p.__dict__, frac_far=float(ok.mean()), frac_vms=float((src == 1).mean()), frac_none=float((src == 2).mean()),
                 sig_vms_median=float(np.nanmedian(sig_vms)), sig_far_median=float(np.nanmedian(sig_far)), lean_abs_deg_p50_p95_max=[float(np.degrees(np.nanpercentile(np.abs(lean), q))) for q in (50, 95, 100)])
    return Series(name, f, ta, tb, dth, sig, src, np.where(ok, cam, np.nan), np.where(ok, world, np.nan), vms, n_inl_, lean, roll, meta2)


def _rolling_mad(x, w):
    out = np.full(len(x), np.nan)
    half = w // 2
    for i in range(0, len(x), max(1, half // 4)):
        seg = x[max(0, i - half):i + half]
        seg = seg[np.isfinite(seg)]
        if len(seg) >= 20:
            out[i:i + max(1, half // 4)] = 1.4826 * np.median(np.abs(seg - np.median(seg)))
    return np.where(np.isfinite(out), out, np.nanmedian(out) if np.isfinite(out).any() else 0.01)


def heading(S: Series, which: str = "dth") -> tuple[np.ndarray, np.ndarray]:
    """(time at the window ends, cumulative heading rad) of one of the series' increments"""
    x = getattr(S, which)
    return np.concatenate([[S.ta[0]], S.tb]), np.concatenate([[0.0], np.cumsum(np.where(np.isfinite(x), x, 0.0))])
