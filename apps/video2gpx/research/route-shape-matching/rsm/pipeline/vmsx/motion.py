# SPDX-License-Identifier: AGPL-3.0-or-later
"""
Stages A and B: the camera's speed, up to one factor per video, from the road in the frames.

A road point at row y below the horizon y_h lies at depth Z = f·h / (y − y_h) and, while the
camera moves forward at v, flows by

    dx = s·(x − x_0)·(y − y_h)        dy = s·(y − y_h)²        with s = v·dt / (f·h)

per frame. Rotation adds, for small angles, a constant flow (yaw a, pitch b) and a roll r about
the image centre. Per frame pair, the corners of the road area are tracked with pyramidal
Lucas-Kanade (forward and back), and s, x_0, a, b and r are fitted to them by least squares,
trimming outliers (vehicles, banks and walls beside the road, shadows that move) until the fit
holds. s / dt is the relative speed; f·h is the one factor per video.
"""

from __future__ import annotations

import csv
import hashlib
import io
import multiprocessing as mp
import os
import time
from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np

from .decode import frames, frames_from, probe, timing

#: Corners per frame pair; at 360 rows, 8 px apart.
MAX_CORNERS = 400
#: A pair whose fit keeps fewer road points tells no speed (20 until 2026-11-14; 10 recovers pairs on a narrow road strip with
#: the lower FOE horizon, clip bench: work/motion-exp/results.md).
MIN_INLIERS = 10
#: Forward-backward tracking error, px at 360 rows, above which a track is dropped.
MAX_FB_ERROR = 0.5
#: Smallest trimming threshold, px at 360 rows: below the tracking noise.
MIN_RESIDUAL = 0.35
#: The road area starts this share of the frame height below the horizon (points near it barely move). 0.06 until 2026-11-14,
#: when the horizon was the (too high) free road-plane fit; with the FOE horizon 0.02 keeps more road.
BELOW_HORIZON = 0.02
#: ...and ends this share above the bottom edge (motion blur, the largest flow).
ABOVE_BOTTOM = 0.03
#: The road area is a trapezoid around the image centre: this share of the frame width at the
#: bottom edge, narrowing towards the horizon. Verges, fields and banks beside it lie off the
#: road plane (a field 0.5 m below the road reads 30 % slow); `None` takes the full width.
ROAD_WIDTH = 0.8

#: "destatic" pre-filter of the frames the speed fit tracks (2026-11-14, work/prefilter/results.md): frame minus its running temporal mean over about
#: DESTATIC_TAU frames, x DESTATIC_GAIN around mid-grey. What stands still in the image cancels: the fixed grain pattern of a camera denoiser / encoder on
#: smooth asphalt, solid lane lines and guard-rail shadows on a straight (edges pointing at the focus of expansion, along which LK cannot measure), a
#: vehicle riding along. Those points have no flow and won the fit (Gotthard valley road: 28 % usable pairs, 0.2-3 m/s at about 18 m/s; with it 98 %,
#: steady). 0 switches it off. A pair whose filtered fit fails (a standstill leaves only noise) is fitted on the plain frames, as before.
DESTATIC_TAU = 2.0
DESTATIC_GAIN = 3.0

#: Passing traffic (2026-11-17, work/passing-cars/README.md). A vehicle that covers much of the road area wins the fit: the trimming threshold of
#: `_robust_lstsq` scales with the median residual, so with half the points on the vehicle nothing is trimmed (a blend, rms 1-3 px) or the road
#: points are the ones trimmed. Overtaking from behind reads slow (its flow points at the horizon), oncoming traffic fast. A pair whose fit rms is
#: above ALT_TRIGGER gets candidate road fits: ALT_HYP fits of ALT_SAMPLE random points (seeded by the frame number: the same in every chunk
#: layout), the ALT_POLISH with the most points within the FIXED distance ALT_THR whose point sets overlap less than ALT_OVERLAP (so the vehicle
#: cannot fill every slot) refitted twice on those points, de-duplicated (speeds within
#: ALT_DEDUP), the ALT_KEEP largest written to the column `alts`. Which candidate is the road is decided over time by `pick_alternatives`: the
#: speed of the road is continuous, a vehicle's is not. Amalfi clip bench: a candidate within 20 % of the road speed exists for 98 % of these pairs.
ALT_TRIGGER = 0.6
ALT_HYP = 150
ALT_SAMPLE = 3
ALT_OVERLAP = 0.5
ALT_POLISH = 20
ALT_THR = 0.6
ALT_DEDUP = 0.03
ALT_KEEP = 5
#: `pick_alternatives`: the reference is the median speed of the clean pairs (no candidates) in the ALT_REF_S before and after (at most ALT_REF_N on
#: each side, interpolated in time between the two); the closest candidate within ALT_TOL x max(|reference|, 0.1 x the video median) replaces the
#: fit, otherwise the row stays as it was (high rms: gating rejects and bridges it).
ALT_REF_S = 1.5
ALT_REF_N = 30
ALT_TOL = 0.3

#: Focal length in px at 360 rows for the second-order rotation terms of the flow model (config.F360).
F_ROT = 449.0

LK_PARAMS = dict(winSize=(21, 21), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))


@dataclass
class Fit:
    params: np.ndarray
    inliers: np.ndarray
    rms: float


def _robust_lstsq(a: np.ndarray, b: np.ndarray, n: int, min_residual: float) -> Fit | None:
    """Least squares over 2n rows (n dx rows, then n dy rows), trimming points, not rows."""
    keep = np.ones(n, bool)
    params = None
    for _ in range(5):
        rows = np.concatenate([keep, keep])
        if keep.sum() < MIN_INLIERS:
            return None
        params, *_ = np.linalg.lstsq(a[rows], b[rows], rcond=None)
        res = b - a @ params
        dist = np.hypot(res[:n], res[n:])
        threshold = max(min_residual, 2.5 * 1.4826 * float(np.median(dist[keep])))
        new = dist < threshold
        if np.array_equal(new, keep):
            break
        keep = new
    rows = np.concatenate([keep, keep])
    res = b[rows] - a[rows] @ params
    return Fit(params, keep, float(np.sqrt(np.mean(res**2) * 2)))


#: Fit the lean of the camera too: a horizon tilted by m makes U = y − y_h − m·X, which adds X·U
#: and X² terms to dy and X² to dx (the same columns as the second-order flow of a yaw rate).
LEAN_TERMS = False


def _flow_design(mid: np.ndarray, flow: np.ndarray, cx: float, cy: float, yh: float) -> tuple[np.ndarray, int]:
    """the 2n x k design matrix of `fit_fixed_horizon` (n dx rows, then n dy rows) and n"""
    p0, p1 = mid - flow / 2, mid + flow / 2
    x = mid[:, 0] - cx
    u = mid[:, 1] - yh
    yc = mid[:, 1] - cy
    x0, u0, u1 = p0[:, 0] - cx, p0[:, 1] - yh, p1[:, 1] - yh
    n = len(x)
    zero = np.zeros(n)
    f2 = (F_ROT * cy / 180.0) ** 2
    dx_cols = [x0 * u1, u1, 1 + x * x / f2, x * yc / f2, -yc]
    dy_cols = [u0 * u1, zero, x * yc / f2, 1 + yc * yc / f2, x]
    if LEAN_TERMS:
        dx_cols += [x * x, zero, zero]
        dy_cols += [zero, x * u, x * x]
    a = np.vstack([np.column_stack(dx_cols), np.column_stack(dy_cols)])
    return a, n


def fit_fixed_horizon(mid: np.ndarray, flow: np.ndarray, cx: float, cy: float, yh: float, min_residual: float) -> Fit | None:
    """Parameters [s, c, a, b, r, …], with U0 / U1 = rows below the horizon at the start / end of the pair, X0 the start column:
    dx = s·X0·U1 + c·U1 + a·(1 + X²/F²) + b·X·Yc/F² − r·Yc,  dy = s·U0·U1 + a·X·Yc/F² + b·(1 + Yc²/F²) + r·X  (+ lean terms).
    Exact for a forward step of the camera (1/U0 − 1/U1 = s) and second order in the rotation (yaw a, pitch b); until 2026-11-14 the model
    was first order at the midpoints (dx = s·X·U + c·U + a − r·Yc, dy = s·U² + b + r·X). Same parameters and units."""
    a, n = _flow_design(mid, flow, cx, cy, yh)
    return _robust_lstsq(a, np.concatenate([flow[:, 0], flow[:, 1]]), n, min_residual)


def candidates(mid: np.ndarray, flow: np.ndarray, cx: float, cy: float, yh: float, scale: float, seed: int) -> list[tuple[np.ndarray, int, float]]:
    """candidate road fits of one pair (see ALT_*): [(params, inliers, rms)], most inliers first"""
    a, n = _flow_design(mid, flow, cx, cy, yh)
    if n < max(MIN_INLIERS, ALT_SAMPLE + 1):
        return []
    b = np.concatenate([flow[:, 0], flow[:, 1]])
    ax, ay = a[:n], a[n:]
    thr = ALT_THR * scale
    rng = np.random.default_rng(seed)
    hyp = []
    for _ in range(ALT_HYP):
        i = rng.choice(n, ALT_SAMPLE, replace=False)
        p, *_ = np.linalg.lstsq(np.vstack([ax[i], ay[i]]), np.concatenate([b[i], b[n + i]]), rcond=None)
        hyp.append(p)
    P = np.array(hyp)
    dist = np.hypot(b[:n][None] - P @ ax.T, b[n:][None] - P @ ay.T)
    inl = dist < thr
    cnt = inl.sum(1)
    chosen = []
    for j in np.argsort(-cnt, kind="stable"):
        if cnt[j] < MIN_INLIERS or len(chosen) == ALT_POLISH:
            break
        if all((inl[j] & inl[k]).sum() < ALT_OVERLAP * min(cnt[j], cnt[k]) for k in chosen):
            chosen.append(j)
    out = []
    for j in chosen:
        keep = inl[j]
        p = P[j]
        for _ in range(2):
            if keep.sum() < MIN_INLIERS:
                break
            p, *_ = np.linalg.lstsq(np.vstack([ax[keep], ay[keep]]), np.concatenate([b[:n][keep], b[n:][keep]]), rcond=None)
            keep = np.hypot(b[:n] - ax @ p, b[n:] - ay @ p) < thr
        if keep.sum() < MIN_INLIERS:
            continue
        res = np.concatenate([b[:n][keep] - ax[keep] @ p, b[n:][keep] - ay[keep] @ p])
        out.append((p, int(keep.sum()), float(np.sqrt(np.mean(res ** 2) * 2))))
    out.sort(key=lambda x: -x[1])
    uniq = []
    for c in out:
        if all(abs(c[0][0] - u[0][0]) > ALT_DEDUP * max(abs(u[0][0]), 1e-6) for u in uniq):
            uniq.append(c)
        if len(uniq) == ALT_KEEP:
            break
    return uniq


def fit_free_horizon(mid: np.ndarray, flow: np.ndarray, cx: float, cy: float, min_residual: float) -> tuple[float, float] | None:
    """(s, horizon row) without a known horizon: dx = s·X·Y + e·X + g·Y + a, dy = s·Y² + p·Y + q + r·X."""
    x = mid[:, 0] - cx
    y = mid[:, 1] - cy
    n = len(x)
    zero, one = np.zeros(n), np.ones(n)
    a = np.vstack([
        np.column_stack([x * y, x, y, one, zero, zero, zero]),
        np.column_stack([y * y, zero, zero, zero, y, one, x]),
    ])
    fit = _robust_lstsq(a, np.concatenate([flow[:, 0], flow[:, 1]]), n, min_residual)
    if fit is None:
        return None
    s, e, _, _, p, _, _ = fit.params
    if s <= 0:
        return None
    # Two estimates of the horizon (relative to the centre row): from dx (e = −s·Y_h) and dy (p = −2s·Y_h).
    return float(s), float(cy + 0.5 * (-e / s + -p / (2 * s)))


class Tracker:
    """Corners of the road area in one frame, tracked into the next."""

    def __init__(self, height: int, width: int, top: int, bottom: int, horizon: float | None = None, road_width: float | None = ROAD_WIDTH):
        self.scale = height / 360
        self.mask = np.zeros((height, width), np.uint8)
        if horizon is None or road_width is None:
            self.mask[top:bottom, :] = 255
        else:
            # Lines from the vanishing point through ±road_width/2 at the bottom edge, plus a margin.
            half = road_width * width / 2
            vp = (width / 2, horizon)
            margin = 0.04 * width
            tl = (vp[0] - half * (top - horizon) / (height - horizon) - margin, top)
            tr = (vp[0] + half * (top - horizon) / (height - horizon) + margin, top)
            poly = np.array([tl, tr, (width / 2 + half, height), (width / 2 - half, height)], np.int32)
            cv2.fillPoly(self.mask, [poly], 255)
            self.mask[:top, :] = 0
            self.mask[bottom:, :] = 0
        self.min_distance = max(4, round(8 * self.scale))

    def track(self, prev: np.ndarray, cur: np.ndarray) -> tuple[int, np.ndarray, np.ndarray]:
        """(corners found, midpoints, flow) of the tracks that agree forward and back."""
        p0 = cv2.goodFeaturesToTrack(prev, MAX_CORNERS, 0.005, self.min_distance, mask=self.mask, blockSize=7)
        if p0 is None:
            return 0, np.empty((0, 2)), np.empty((0, 2))
        p1, st1, _ = cv2.calcOpticalFlowPyrLK(prev, cur, p0, None, **LK_PARAMS)
        back, st2, _ = cv2.calcOpticalFlowPyrLK(cur, prev, p1, None, **LK_PARAMS)
        fb = np.linalg.norm((back - p0).reshape(-1, 2), axis=1)
        good = (st1.ravel() == 1) & (st2.ravel() == 1) & (fb < MAX_FB_ERROR * self.scale)
        a = p0.reshape(-1, 2)[good].astype(np.float64)
        b = p1.reshape(-1, 2)[good].astype(np.float64)
        return len(p0), (a + b) / 2, b - a


def focus_of_expansion(mid: np.ndarray, flow: np.ndarray, min_flow: float) -> tuple[float, float] | None:
    """(x, y) of the focus of expansion of one frame pair: the robust least-squares intersection of the flow lines of all tracked points.
    For a camera moving along the road it lies on the road's horizon; points at any depth count (house fronts too), only their direction."""
    mag = np.hypot(flow[:, 0], flow[:, 1])
    k = mag > min_flow
    if k.sum() < MIN_INLIERS * 2:
        return None
    p, d = mid[k], flow[k]
    a = np.column_stack([d[:, 1], -d[:, 0]])
    b = d[:, 1] * p[:, 0] - d[:, 0] * p[:, 1]
    w = np.ones(len(b))
    for _ in range(5):
        sol, *_ = np.linalg.lstsq(a * w[:, None], b * w, rcond=None)
        r = np.abs(a @ sol - b) / mag[k]                 # distance of the focus from each flow line, px
        w = 1 / np.maximum(r, 2.0)
    return float(sol[0]), float(sol[1])


def _horizon_sample(args) -> tuple[list, list]:
    """(free road-plane horizon estimates, focus-of-expansion rows) of one calibration stretch; args = (path, height, start, window, hwaccel)."""
    path, height, start, window, hwaccel = args
    info = probe(path)
    width = round(info.width * height / info.height / 2) * 2
    tracker = Tracker(height, width, top=height // 2, bottom=height - round(ABOVE_BOTTOM * height))
    whole = Tracker(height, width, top=round(0.1 * height), bottom=height - round(ABOVE_BOTTOM * height))
    estimates, foes = [], []
    prev = None
    for i, (_, frame) in enumerate(frames(path, height, start=start, duration=window, hwaccel=hwaccel)):
        if prev is not None:
            _, mid, flow = tracker.track(prev, frame)
            if len(mid) >= MIN_INLIERS:
                est = fit_free_horizon(mid, flow, width / 2, height / 2, MIN_RESIDUAL * tracker.scale)
                # Only frames with real forward motion say where the horizon is.
                if est is not None and est[0] * (height / 2) ** 2 > 2 * tracker.scale:
                    estimates.append(est[1])
            if i % 3 == 0:
                _, mid_w, flow_w = whole.track(prev, frame)
                fo = focus_of_expansion(mid_w, flow_w, 0.3 * whole.scale)
                if fo is not None and -height < fo[1] < 2 * height:
                    foes.append(fo[1])
        prev = frame
    return estimates, foes


def calibrate_horizon(path: str, height: int, samples: int = 16, window: float = 3.0, hwaccel: bool = True, pool=None) -> dict:
    """The horizon rows of a video from `samples` short stretches (with `pool`: the stretches side by side, same result).

    `horizon`: the median focus of expansion (every 3rd frame pair, all points of the frame), the road area of the speed fit hangs below it.
    `horizon_free`: the median of free road-plane fits (the horizon until 2026-11-14). It is 20-110 rows too high on many videos (house fronts
    and verges in its area pull it up; Lahntal: 148 instead of 260 at 360 rows), but the far-feature rotation bands were tuned on it and keep it."""
    info = probe(path)
    jobs = [(path, height, info.duration * (k + 0.5) / samples, window, hwaccel) for k in range(samples)]
    parts = pool.map(_horizon_sample, jobs, chunksize=1) if pool is not None else [_horizon_sample(j) for j in jobs]
    estimates = [e for p in parts for e in p[0]]
    foes = [f for p in parts for f in p[1]]
    if len(estimates) < 20 or len(foes) < 20:
        raise RuntimeError(f'horizon: only {len(estimates)} / {len(foes)} usable frames')
    arr, fa = np.array(estimates), np.array(foes)
    q25, q50, q75 = np.percentile(arr, [25, 50, 75])
    f25, f50, f75 = np.percentile(fa, [25, 50, 75])
    return {'horizon': float(f50), 'iqr': float(f75 - f25), 'frames': len(fa), 'height': height,
            'horizon_free': float(q50), 'iqr_free': float(q75 - q25), 'frames_free': len(arr)}


#: `alts`: the candidate road fits of a pair with a bad fit (ALT_*), ';'-separated 's c yaw pitch roll inliers rms', the first one the plain fit;
#: `pick` (written by `pick_alternatives`): '' no candidates, 0 the plain fit kept, k the k-th candidate replaced it, -1 none fits the road speed.
COLUMNS = ['frame', 'time', 'corners', 'tracked', 'inliers', 'rms_px', 's', 'c', 'yaw', 'pitch', 'roll', 'diff', 'rel_speed', 'alts', 'pick']


def _alt_text(p, inl: int, rms: float) -> str:
    return f'{p[0]:.4e} {p[1]:.4e} {p[2]:.4f} {p[3]:.4f} {p[4]:.3e} {inl} {rms:.4f}'


def parse_alts(text: str) -> list[tuple[np.ndarray, int, float]]:
    """the column `alts` back as [(params s c a b r, inliers, rms)]: the plain fit first, then the candidates (`pick` indexes this list)"""
    out = []
    for x in (text or '').split(';'):
        f = x.split()
        if len(f) == 7:
            out.append((np.array([float(v) for v in f[:5]]), int(f[5]), float(f[6])))
    return out


def near_fit(mid: np.ndarray, flow: np.ndarray, cx: float, cy: float, yh: float, p: np.ndarray, thr: float) -> np.ndarray:
    """bool per point: its flow is within the fixed distance thr of the model flow of the parameters p (s c a b r, as in `alts`)"""
    if len(mid) == 0:
        return np.zeros(0, bool)
    a, n = _flow_design(mid, flow, cx, cy, yh)
    q = np.zeros(a.shape[1])
    q[:5] = p[:5]
    f = a @ q
    return np.hypot(flow[:, 0] - f[:n], flow[:, 1] - f[n:]) < thr


class Destatic:
    """the DESTATIC pre-filter, stateful over consecutive frames: 128 + gain x (frame - exponential running mean over ~tau frames)"""

    def __init__(self, tau: float = DESTATIC_TAU, gain: float = DESTATIC_GAIN):
        self.tau, self.gain, self.m = float(tau), float(gain), None

    def __call__(self, g: np.ndarray) -> np.ndarray:
        x = g.astype(np.float32)
        self.m = x.copy() if self.m is None else self.m + (x - self.m) / self.tau
        return np.clip(128.0 + self.gain * (x - self.m), 0, 255).astype(np.uint8)


def pair_row(tracker: Tracker, prev: np.ndarray, frame: np.ndarray, idx: int, t: float, horizon: float, min_res: float, dt: float, width: int, height: int,
             raw: tuple[np.ndarray, np.ndarray] | None = None, seed0: int = 0) -> list:
    """The csv row (COLUMNS) of one frame pair. `seed0` + `idx` seeds the candidate fits: a clip of a video passes the index of its first frame in
    the video, so a pair gets the candidates it gets in the whole video. `prev` / `frame` are the frames the fit tracks (destatic-filtered in `analyse`); `raw` = the plain pair:
    the frame difference (`diff`, scene cuts) comes from it, and the fit falls back to it when the filtered pair gives none."""
    ra, rb = raw if raw is not None else (prev, frame)
    small_a = ra[::4, ::4].astype(np.int16)
    small_b = rb[::4, ::4].astype(np.int16)
    diff = float(np.mean(np.abs(small_b - small_a)))
    corners, mid, flow = tracker.track(prev, frame)
    fit = fit_fixed_horizon(mid, flow, width / 2, height / 2, horizon, min_res) if len(mid) >= MIN_INLIERS else None
    if fit is None and raw is not None:
        corners, mid, flow = tracker.track(ra, rb)
        fit = fit_fixed_horizon(mid, flow, width / 2, height / 2, horizon, min_res) if len(mid) >= MIN_INLIERS else None
    if fit is None:
        return [idx, f'{t:.4f}', corners, len(mid), 0, '', '', '', '', '', '', f'{diff:.3f}', '', '', '']
    s, c, a, b, r = fit.params[:5]
    alts = ''
    if ALT_TRIGGER > 0 and fit.rms > ALT_TRIGGER * tracker.scale:
        cands = candidates(mid, flow, width / 2, height / 2, horizon, tracker.scale, seed=int(idx) + int(seed0))
        if cands:
            alts = ';'.join([_alt_text(fit.params, int(fit.inliers.sum()), fit.rms)] + [_alt_text(p, k, e) for p, k, e in cands])
    return [
        idx, f'{t:.4f}', corners, len(mid), int(fit.inliers.sum()), f'{fit.rms:.4f}',
        f'{s:.4e}', f'{c:.4e}', f'{a:.4f}', f'{b:.4f}', f'{r:.3e}', f'{diff:.3f}', f'{s / dt:.6e}', alts, '',
    ]


def pick_alternatives(csv_path: str) -> dict:
    """rewrite `csv_path` in place: every pair with candidates (column `alts`) gets the candidate closest to the road speed around it (see ALT_REF_*),
    or keeps its plain fit (`pick` 0 / -1). A csv without the column is left as it is. -> counts"""
    with open(csv_path, newline='') as fh:
        rd = csv.reader(fh)
        head = next(rd)
        rows = list(rd)
    if 'alts' not in head:
        return dict(candidates=0)
    ia, ip, it, iv, idt = head.index('alts'), head.index('pick'), head.index('time'), head.index('rel_speed'), head.index('s')
    n = len(rows)
    t = np.array([float(r[it]) for r in rows])
    v = np.array([float(r[iv]) if r[iv] != '' else np.nan for r in rows])
    has = np.array([r[ia] != '' for r in rows])
    clean = ~has & np.isfinite(v)
    tc, vc = t[clean], v[clean]
    vmed = float(np.median(vc[vc > 0])) if (vc > 0).any() else 0.0
    sp = np.array([float(r[idt]) if r[idt] != '' else np.nan for r in rows])
    ok = np.isfinite(sp) & np.isfinite(v) & (np.abs(v) > 0) & (np.abs(sp) > 0)
    dt_pair = float(np.median(sp[ok] / v[ok])) if ok.any() else (float(np.median(np.diff(t))) if n > 1 else 1.0)   # the pair interval of the rows
    out = dict(candidates=int(has.sum()), replaced=0, kept=0, none=0)
    for k in np.flatnonzero(has):
        j = int(np.searchsorted(tc, t[k]))
        bi = np.arange(max(0, j - ALT_REF_N), j)
        bi = bi[tc[bi] >= t[k] - ALT_REF_S]
        ai = np.arange(j, min(len(tc), j + ALT_REF_N))
        ai = ai[tc[ai] <= t[k] + ALT_REF_S]
        r = rows[k]
        if len(bi) < 5 and len(ai) < 5:
            r[ip] = '-1'
            out['none'] += 1
            continue
        if len(bi) >= 5 and len(ai) >= 5:
            tb, ta = float(np.median(tc[bi])), float(np.median(tc[ai]))
            vb, va = float(np.median(vc[bi])), float(np.median(vc[ai]))
            ref = vb + (va - vb) * (t[k] - tb) / (ta - tb) if ta > tb else 0.5 * (va + vb)
        else:
            ref = float(np.median(vc[bi if len(bi) >= 5 else ai]))
        al = [x.split() for x in r[ia].split(';')]
        s_rel = np.array([float(x[0]) for x in al]) / dt_pair
        err = np.abs(s_rel - ref)
        best = int(np.argmin(err))
        if err[best] > ALT_TOL * max(abs(ref), 0.1 * vmed):
            r[ip] = '-1'
            out['none'] += 1
        elif best == 0:
            r[ip] = '0'
            out['kept'] += 1
        else:
            x = al[best]
            r[head.index('inliers')], r[head.index('rms_px')] = x[5], x[6]
            r[idt], r[head.index('c')], r[head.index('yaw')], r[head.index('pitch')], r[head.index('roll')] = x[0], x[1], x[2], x[3], x[4]
            r[iv] = f'{float(x[0]) / dt_pair:.6e}'
            r[ip] = str(best)
            out['replaced'] += 1
    tmp = csv_path + '.pick'
    with open(tmp, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(head)
        w.writerows(rows)
    os.replace(tmp, csv_path)
    return out


def analyse(
    path: str,
    out_csv: str,
    height: int = 360,
    step: int = 1,
    start: float = 0.0,
    duration: float | None = None,
    horizon: float | None = None,
    hwaccel: bool = True,
    progress: bool = True,
    horizon_offset: float = 0.0,
    road_width: float | None = ROAD_WIDTH,
    on_progress=None,
    calibration: dict | None = None,
    seed0: int = 0,
) -> dict:
    """Write one row per analysed frame pair to `out_csv`; return run statistics. `calibration`: a result of `calibrate_horizon` for this video and
    height, used instead of calibrating again (with `horizon` None). `seed0`: see `pair_row` (0 for a whole video)."""
    info = probe(path)
    width = round(info.width * height / info.height / 2) * 2
    t0 = time.perf_counter()
    cal = None
    if on_progress is not None:
        progress = False
        on_progress(0, 1, 'horizon')
    horizon_rot = horizon
    if horizon is None:
        cal = calibration if calibration is not None else calibrate_horizon(path, height, hwaccel=hwaccel)
        horizon = cal['horizon'] + horizon_offset * height / 360  # opt-in: horizon_offset px at 360 rows added to the calibrated row (default 0: unchanged)
        horizon_rot = cal['horizon_free']
    t_cal = time.perf_counter() - t0
    top = int(max(height * 0.45, horizon + BELOW_HORIZON * height))
    bottom = height - round(ABOVE_BOTTOM * height)
    tracker = Tracker(height, width, top, bottom, horizon, road_width)  # road_width: opt-in (default ROAD_WIDTH: unchanged)
    min_res = MIN_RESIDUAL * tracker.scale
    dt = step / info.fps
    total = (duration if duration is not None else info.duration - start) * info.fps / step
    n = 0
    last_cb = 0.0
    with open(out_csv, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(COLUMNS)
        prev = prev_f = None
        filt = Destatic() if DESTATIC_TAU > 0 else None
        for idx, frame in frames(path, height, start=start, duration=duration, step=step, hwaccel=hwaccel):
            frame_f = filt(frame) if filt is not None else frame
            if prev is not None:
                # Time of the pair: the middle between its two frames, s into the video.
                t = start + (idx - step / 2) / info.fps
                w.writerow(pair_row(tracker, prev_f, frame_f, idx, t, horizon, min_res, dt, width, height, raw=(prev, frame) if filt is not None else None, seed0=seed0))
                n += 1
                if on_progress is not None and n % 60 == 0:
                    now = time.perf_counter()
                    if now - last_cb >= 1.0:
                        last_cb = now
                        on_progress(n, total, 'pairs')
                if progress and n % 3000 == 0:
                    el = time.perf_counter() - t0
                    print(f'  {n}/{total:.0f} pairs, {n / (el - t_cal):.0f} pairs/s', flush=True)
            prev, prev_f = frame, frame_f
    traffic = pick_alternatives(out_csv) if ALT_TRIGGER > 0 else {}
    elapsed = time.perf_counter() - t0
    if on_progress is not None:
        on_progress(n, max(total, n), 'pairs')
    return {
        'video': path, 'height': height, 'width': width, 'step': step, 'fps': info.fps,
        'start': start, 'duration': duration if duration is not None else info.duration - start,
        # `horizon` is the row the far-feature rotation bands hang from (the free road-plane fit, unchanged); `horizon_vms` the row of this fit
        'horizon': horizon_rot, 'horizon_vms': horizon, 'destatic_tau': DESTATIC_TAU, 'horizon_offset': horizon_offset, 'road_width': road_width, 'horizon_calibration': cal, 'roi': [top, bottom],
        'pairs': n, 'seconds': elapsed, 'calibration_seconds': t_cal, 'traffic': traffic,
        'seconds_per_video_hour': elapsed / ((duration if duration is not None else info.duration - start) / 3600),
    }


# ------------------------------------------------------------------ parallel analysis (2026-11-16)
#: `analyse_parallel` cuts the video into chunks of this many seconds; each worker decodes its chunk with its own `ffmpeg -ss`.
CHUNK_S = 120.0
#: A chunk decodes this many frames before its first pair: the destatic running mean forgets its start (weight 0.5 per frame at tau 2), and the
#: hashes of these frames must equal the last frames of the chunk before (proof that the seek landed on the same frames as the sequential decode).
WARM_FRAMES = 32

def timing_problem(path: str, fps: float) -> str | None:
    """Why seeking chunks may not give the frames of the sequential decode (None: constant frame rate from time 0, nothing to fear)."""
    tm = timing(path)
    if tm['discard']:
        return f"{tm['discard']} packets flagged discard"
    if not tm['max_dev'] < 0.5:
        return f"packet times off the constant-rate grid by up to {tm['max_dev']:.2f} frames"
    if tm['start'] is None or abs(tm['start']) * fps > 0.5:
        return f"video stream starts at {tm['start']} s"
    return None


def _sha(frame: np.ndarray) -> str:
    return hashlib.sha1(np.ascontiguousarray(frame).data).hexdigest()


#: set when a seam does not match: the running chunks stop early (a shared event, inherited through fork; never Pool.terminate mid-run, which can fork a
#: replacement worker during the shutdown that then deadlocks)
_STOP = None


def _worker_init():
    """one OpenCV thread per worker: a forked child cannot use the thread pool of a parent that already ran OpenCV (it hangs; the results are the same)"""
    cv2.setNumThreads(1)


def _par_chunk(job: tuple[dict, int, int | None]) -> dict:
    """csv text of the pairs (j - 1, j), a < j <= b (b None: to the end of the video), and the hashes of the first / last WARM_FRAMES + 1 decoded frames.
    job = (context of `analyse_parallel`, a, b); the context travels with the job because the pool forks before the horizon is known."""
    X, a, b = job
    stop = _STOP
    if stop is not None and stop.is_set():
        return dict(a=a, b=b, stopped=True, pairs=0)
    info, height, width, hw = X['info'], X['height'], X['width'], X['hwaccel']
    tracker = Tracker(height, width, X['top'], X['bottom'], X['horizon'], X['road_width'])
    s = max(0, a - WARM_FRAMES)
    if s == 0:   # the first chunk reads exactly like `analyse` (no seek); the later chunks are checked against it
        src = (f for _, f in frames(X['path'], height, hwaccel=hw))
    else:
        src = frames_from(X['path'], info, height, s, None if b is None else b - s + 1, hwaccel=hw)
    filt = Destatic() if DESTATIC_TAU > 0 else None
    buf = io.StringIO()
    w = csv.writer(buf)
    head, tail = [], deque(maxlen=WARM_FRAMES + 1)
    prev = prev_f = None
    j, n = s - 1, 0
    try:
        for frame in src:
            j += 1
            if len(head) <= WARM_FRAMES:
                head.append(_sha(frame))
            tail.append(frame)
            frame_f = filt(frame) if filt is not None else frame
            if prev is not None and j > a:
                t = (j - 0.5) / info.fps          # = start + (idx - step / 2) / fps of `analyse` with start 0, step 1
                w.writerow(pair_row(tracker, prev_f, frame_f, j, t, X['horizon'], X['min_res'], X['dt'], width, height, raw=(prev, frame) if filt is not None else None,
                                    seed0=X['seed0']))
                n += 1
            prev, prev_f = frame, frame_f
            if b is not None and j >= b:
                break
            if stop is not None and j % 250 == 0 and stop.is_set():
                return dict(a=a, b=b, stopped=True, pairs=0)
    finally:
        src.close()
    return dict(a=a, b=b, last=j, text=buf.getvalue(), pairs=n, head=head, tail=[_sha(f) for f in tail])


def analyse_parallel(path: str, out_csv: str, height: int = 360, workers: int = 4, chunk_s: float = CHUNK_S, hwaccel: bool = True,
                     on_progress=None, log=None, calibration: dict | None = None, seed0: int = 0) -> dict:
    """`analyse` of the whole video (step 1, start 0, calibrated horizon) with the pairs spread over `workers` processes. The csv is byte-identical:
    each chunk is checked against its neighbour (WARM_FRAMES + 1 overlap frames by hash, last frame index). If the stream timing is irregular or a
    check fails, the sequential `analyse` runs instead (same calibration) and `parallel.fallback` says why. `calibration`, `seed0`: as in `analyse`."""
    log = log or (lambda level, msg: None)
    info = probe(path)
    width = round(info.width * height / info.height / 2) * 2
    t0 = time.perf_counter()
    if on_progress is not None:
        on_progress(0, 1, 'horizon')
    cf = max(4 * WARM_FRAMES, int(round(chunk_s * info.fps)))
    n_est = int(info.duration * info.fps)
    starts = [k * cf for k in range(max(1, n_est // cf))]          # the last chunk runs to the end of the file: 1-2 chunk lengths
    jobs = [(a, starts[i + 1] if i + 1 < len(starts) else None) for i, a in enumerate(starts)]
    why = timing_problem(path, info.fps) if len(jobs) > 1 else 'shorter than two chunks'
    global _STOP
    mpc = mp.get_context('fork')
    _STOP = mpc.Event()
    with mpc.Pool(max(1, workers), initializer=_worker_init) as pool:
        cal = calibration if calibration is not None else calibrate_horizon(path, height, hwaccel=hwaccel, pool=pool)
        t_cal = time.perf_counter() - t0
        horizon = cal['horizon']
        top = int(max(height * 0.45, horizon + BELOW_HORIZON * height))
        bottom = height - round(ABOVE_BOTTOM * height)
        if why is None:
            ctx = dict(path=path, info=info, height=height, width=width, hwaccel=hwaccel, top=top, bottom=bottom, horizon=horizon, road_width=ROAD_WIDTH,
                        min_res=MIN_RESIDUAL * height / 360, dt=1 / info.fps, seed0=int(seed0))
            done: dict[int, dict] = {}
            nxt, pairs, last_cb = 0, 0, 0.0
            tmp = out_csv + '.part'
            with open(tmp, 'w', newline='') as fh:
                csv.writer(fh).writerow(COLUMNS)
                for r in pool.imap_unordered(_par_chunk, [(ctx, a, b) for a, b in jobs], chunksize=1):
                    if why is not None:                                       # stopped: drain the chunks still running (they return at once)
                        continue
                    done[r['a']] = r
                    pairs += r['pairs']
                    while nxt < len(jobs) and jobs[nxt][0] in done:          # write in order; check each chunk against the one before
                        cur = done[jobs[nxt][0]]
                        if nxt > 0:
                            before = done[jobs[nxt - 1][0]]
                            if before['last'] != before['b'] or before['tail'] != cur['head']:
                                why = (f"chunk at frame {cur['a']}: the seek did not land on the frames of the sequential decode "
                                       f"(chunk before ended at frame {before['last']} of {before['b']}, overlap {'equal' if before['tail'] == cur['head'] else 'different'})")
                                _STOP.set()
                                break
                            before['text'] = ''
                        fh.write(cur['text'])
                        nxt += 1
                    if why is not None:
                        continue
                    now = time.perf_counter()
                    if on_progress is not None and now - last_cb >= 1.0:
                        last_cb = now
                        on_progress(pairs, max(n_est - 1, pairs), 'pairs')
            if why is None:
                os.replace(tmp, out_csv)
                traffic = pick_alternatives(out_csv) if ALT_TRIGGER > 0 else {}
            else:
                os.remove(tmp)
        pool.close()                     # a clean end: every worker idle and joined before the context manager's terminate()
        pool.join()
    _STOP = None
    if why is not None:
        log('warn', f'motion: parallel analysis not used ({why}); sequential analysis')
        st = analyse(path, out_csv, height=height, step=1, hwaccel=hwaccel, on_progress=on_progress, calibration=cal, seed0=seed0)
        st['calibration_seconds'] = t_cal
        st['seconds'] += t_cal
        st['parallel'] = dict(workers=1, fallback=why)
        return st
    elapsed = time.perf_counter() - t0
    if on_progress is not None:
        on_progress(pairs, pairs, 'pairs')
    return {
        'video': path, 'height': height, 'width': width, 'step': 1, 'fps': info.fps, 'start': 0.0, 'duration': info.duration,
        'horizon': cal['horizon_free'], 'horizon_vms': horizon, 'destatic_tau': DESTATIC_TAU, 'horizon_offset': 0.0, 'road_width': ROAD_WIDTH, 'horizon_calibration': cal,
        'roi': [top, bottom], 'pairs': pairs, 'traffic': traffic, 'seconds': elapsed, 'calibration_seconds': t_cal, 'seconds_per_video_hour': elapsed / (info.duration / 3600),
        'parallel': dict(workers=int(workers), chunks=len(jobs), chunk_s=float(chunk_s), warm_frames=WARM_FRAMES),
    }
