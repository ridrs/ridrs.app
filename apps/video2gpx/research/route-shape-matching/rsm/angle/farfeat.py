# SPDX-License-Identifier: AGPL-3.0-or-later
"""Approach A: focal length (angle scale) from the rotation flow of far features, per video, without GPS.

Needs cv2 (run with the vms venv: `cd ../video-motion-speed && PYTHONPATH=<project root> .venv/bin/python -m rsm.angle.cli ...`).

1. Turning stretches are picked from the vms yaw series alone (largest |sum of yaw px| over `stretch_s`, non-overlapping).
2. In each stretch corners in the band above the vms horizon row (far scenery, sky, clouds) are tracked from frame i to frame i + k
   (pyramidal LK, forward-backward checked); pairs do not overlap.
3. Per pair the rotation+expansion model is fitted robustly over a grid of f (and optionally k1); the chi2 curves are summed.
"""
from __future__ import annotations

import json
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from . import rotflow

LK = dict(winSize=(21, 21), maxLevel=4)



def band_horizon(mj: dict, off_vms: float, off_old: float = -5.0) -> tuple[float, float]:
    """(row, band_off) the far bands hang from: the FOE horizon of vms (motion.json `horizon_vms`) with off_vms, else (old projects) the free road-plane
    horizon `horizon` with off_old"""
    hv = mj.get("horizon_vms")
    if hv is not None and np.isfinite(float(hv)):
        return float(hv), float(off_vms)
    return float(mj["horizon"]), float(off_old)

@dataclass
class Params:
    height: int = 360
    stretch_s: float = 5.0
    n_stretch: int = 40
    min_net_px: float = 60.0  # |sum of vms yaw px| over a stretch below this: not a turn
    dt_s: float = 0.25  # tracking interval; k = round(dt_s * fps)
    band_off: float = -5.0  # band lower edge = vms horizon row + band_off (px at 360 rows)
    band_min_rows: float = 70.0  # a band thinner than this (px at 360) is widened to it
    f_min: float = 200.0
    f_max: float = 1000.0
    n_f: int = 49
    k1_grid: tuple = (0.0,)
    max_corners: int = 400
    fb_err: float = 0.4  # px at 360 rows
    min_inl: int = 40
    min_xspread: float = 0.35  # inlier x std relative to uniform over the width; thinner pairs carry no curvature
    seed: int = 0
    first_s: float = 20.0  # no stretch before this video time (intros)


def f_grid(p: Params) -> np.ndarray:
    return np.exp(np.linspace(np.log(p.f_min), np.log(p.f_max), p.n_f))


# ---------------------------------------------------------------- video access (ffmpeg only)
def probe(path: str) -> dict:
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', path],
                         check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    s = j['streams'][0]
    n, d = s['r_frame_rate'].split('/')
    return dict(width=int(s['width']), height=int(s['height']), fps=float(n) / float(d), duration=float(j['format']['duration']))


def read_frames(path: str, info: dict, height: int, start: float, duration: float, hwaccel: bool = True):
    """Grey frames of `height` rows from `start` for `duration` s: yields (index from start, array)."""
    width = round(info['width'] * height / info['height'] / 2) * 2
    cmd = ['ffmpeg', '-v', 'error', '-nostdin']
    if hwaccel:
        cmd += ['-hwaccel', 'videotoolbox']
    cmd += ['-ss', f'{start:.3f}', '-i', path, '-t', f'{duration:.3f}', '-an', '-vf', f'scale={width}:{height}:flags=area,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    size = width * height
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=size * 8) as proc:
        i = 0
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield i, np.frombuffer(buf, np.uint8).reshape(height, width)
            i += 1
        proc.stdout.close()
        proc.wait()


# ---------------------------------------------------------------- stretch selection from the vms yaw only
def load_yaw(csv_path: str):
    """(time, yaw px per pair, usable) from a vms motion CSV."""
    d = np.genfromtxt(csv_path, delimiter=',', names=True, dtype=float, filling_values=np.nan)
    t, yaw, inl = d['time'], d['yaw'], d['inliers']
    ok = np.isfinite(yaw) & (inl >= 20)
    return t, np.where(ok, yaw, 0.0), ok


def pick_stretches(csv_path: str, p: Params, ranges=None) -> list[dict]:
    t, yaw, ok = load_yaw(csv_path)
    T = int(t[-1]) + 1
    sec = np.floor(t).astype(int)
    ysum = np.bincount(sec, weights=yaw, minlength=T + 1)
    cnt = np.bincount(sec, weights=ok.astype(float), minlength=T + 1)
    tot = np.bincount(sec, minlength=T + 1)
    good = cnt >= 0.9 * np.maximum(tot, 1)
    W = int(round(p.stretch_s))
    cs = np.concatenate([[0], np.cumsum(ysum)])
    cg = np.concatenate([[0], np.cumsum(good)])
    starts = np.arange(int(p.first_s), T - W)
    net = cs[starts + W] - cs[starts]
    full = (cg[starts + W] - cg[starts]) == W
    score = np.where(full, np.abs(net), 0.0)
    if ranges is not None:  # only stretches fully inside one of the (t0, t1) ranges
        inside = np.zeros(len(starts), bool)
        for r0, r1 in ranges:
            inside |= (starts >= r0) & (starts + W <= r1)
        score = np.where(inside, score, 0.0)
    out, taken = [], np.zeros(T + 2, bool)
    for s in np.argsort(-score):
        if score[s] < p.min_net_px or len(out) >= p.n_stretch:
            break
        a = int(starts[s])
        if taken[max(0, a - 1):a + W + 1].any():
            continue
        taken[a:a + W] = True
        out.append(dict(t0=float(a), t1=float(a + W), net_px=float(net[s])))
    return sorted(out, key=lambda r: r['t0'])


# ---------------------------------------------------------------- tracking and per-stretch fit
def track_pair(cv2, mask, a, b, p: Params, scale: float):
    p0 = cv2.goodFeaturesToTrack(a, p.max_corners, 0.005, max(4, round(8 * scale)), mask=mask, blockSize=7)
    if p0 is None or len(p0) < p.min_inl:
        return None
    p1, s1, _ = cv2.calcOpticalFlowPyrLK(a, b, p0, None, **LK)
    bk, s2, _ = cv2.calcOpticalFlowPyrLK(b, a, p1, None, **LK)
    fb = np.linalg.norm((bk - p0).reshape(-1, 2), axis=1)
    good = (s1.ravel() == 1) & (s2.ravel() == 1) & (fb < p.fb_err * scale)
    q0 = p0.reshape(-1, 2)[good].astype(np.float64)
    q1 = p1.reshape(-1, 2)[good].astype(np.float64)
    return q0, q1 - q0


def make_mask(cv2, height: int, width: int, horizon: float, p: Params):
    scale = height / 360
    end = horizon + p.band_off * scale
    end = max(end, p.band_min_rows * scale)
    end = min(end, 0.6 * height)
    m = np.zeros((height, width), np.uint8)
    mx = int(0.02 * width)
    m[:int(end), mx:width - mx] = 255
    return m, float(end)


def process_stretch(video: str, info: dict, csv_t: np.ndarray, csv_yaw: np.ndarray, csv_ok: np.ndarray, st: dict, horizon: float, p: Params, hwaccel=True):
    import cv2
    cv2.setNumThreads(1)
    H = p.height
    W = round(info['width'] * H / info['height'] / 2) * 2
    scale = H / 360
    k = max(2, int(round(p.dt_s * info['fps'])))
    mask, band_end = make_mask(cv2, H, W, horizon, p)
    fg, kg = f_grid(p), np.array(p.k1_grid)
    rng = np.random.default_rng(p.seed + int(st['t0']))
    frames = []
    for i, fr in read_frames(video, info, H, st['t0'], st['t1'] - st['t0'], hwaccel):
        frames.append(fr)
    pairs = []
    chi_sum = np.zeros((len(fg), len(kg)))
    n_try = 0
    for i in range(0, len(frames) - k, k):
        n_try += 1
        tr = track_pair(cv2, mask, frames[i], frames[i + k], p, scale)
        if tr is None:
            continue
        q0, fl = tr
        x, y = q0[:, 0] - W / 2, q0[:, 1] - H / 2
        fit = rotflow.fit_pair(x, y, fl, fg, kg, 449.0 * scale, scale=scale, rng=rng, min_inl=p.min_inl)
        if fit is None or fit.xspread < p.min_xspread:
            continue
        ta, tb = st['t0'] + i / info['fps'], st['t0'] + (i + k) / info['fps']
        sel = (csv_t > ta) & (csv_t < tb)
        okv = bool(sel.sum() >= k - 1 and csv_ok[sel].all())
        yv = float(csv_yaw[sel].sum() * (k / max(sel.sum(), 1))) if okv else np.nan
        pairs.append(dict(i=i, ta=ta, tb=tb, n_pts=len(x), n_inl=fit.n_inl, sigma=fit.sigma, xspread=fit.xspread, vms_yaw=yv, A=fit.A.astype(np.float32), chi2=fit.chi2.astype(np.float32)))
        chi_sum += fit.chi2
    return dict(t0=st['t0'], t1=st['t1'], net_px=st['net_px'], k=k, band_end=band_end, n_try=n_try, pairs=pairs, chi2=chi_sum)


_G: dict = {}


def _work(a):
    st = a
    return process_stretch(_G['video'], _G['info'], _G['t'], _G['yaw'], _G['ok'], st, _G['horizon'], _G['p'], _G['hw'])


def run_video(video: str, csv_path: str, horizon: float, p: Params, procs: int = 4, hwaccel=True, log=print, stretches=None, ranges=None) -> dict:
    import multiprocessing as mp
    info = probe(video)
    t, yaw, ok = load_yaw(csv_path)
    sts = stretches if stretches is not None else pick_stretches(csv_path, p, ranges)
    _G.update(video=video, info=info, t=t, yaw=yaw, ok=ok, horizon=horizon, p=p, hw=hwaccel)
    t0 = time.time()
    log(f'  {len(sts)} stretches of {p.stretch_s:g} s, k = {max(2, int(round(p.dt_s * info["fps"])))} frames, horizon {horizon:.0f}')
    if procs > 1:
        with mp.get_context('fork').Pool(procs) as pool:
            res = pool.map(_work, sts, chunksize=1)
    else:
        res = [_work(s) for s in sts]
    log(f'  tracked in {time.time() - t0:.0f} s')
    return dict(video=video, csv=csv_path, horizon=horizon, params=asdict(p), info=info, stretches=res, seconds=time.time() - t0)


# ---------------------------------------------------------------- pooling
def pool_f(res: dict, stretch_idx=None, fix_k: int | None = None, min_pairs: int = 3):
    """Summed chi2 over (selected) stretches -> (f, k1)."""
    p = Params(**{**res['params'], 'k1_grid': tuple(res['params']['k1_grid'])})
    fg, kg = f_grid(p), np.array(p.k1_grid)
    sts = res['stretches'] if stretch_idx is None else [res['stretches'][i] for i in stretch_idx]
    tot = sum(s['chi2'] for s in sts if len(s['pairs']) >= min_pairs) if sts else np.zeros((len(fg), len(kg)))
    if np.isscalar(tot):
        return None
    f, k1, i, j = rotflow.pooled_argmin(tot, fg, kg, fix_k)
    return dict(f=f, k1=k1, i=i, j=j, chi2=tot)


def bootstrap_f(res: dict, n_boot: int = 300, seed: int = 1, fix_k=None, min_pairs: int = 3):
    p = Params(**{**res['params'], 'k1_grid': tuple(res['params']['k1_grid'])})
    fg, kg = f_grid(p), np.array(p.k1_grid)
    S = [s for s in res['stretches'] if len(s['pairs']) >= min_pairs]
    if len(S) < 3:
        return None
    C = np.stack([s['chi2'] for s in S])
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(S), len(S))
        out.append(rotflow.pooled_argmin(C[pick].sum(0), fg, kg, fix_k)[0])
    out = np.array(out)
    return dict(lo=float(np.percentile(out, 2.5)), hi=float(np.percentile(out, 97.5)), sd=float(np.std(out)), n_stretch=len(S), samples=out)


def transfer_ratio(res: dict, f_hat: float, k1: float = 0.0, n_boot: int = 300, seed: int = 2, min_pairs: int = 3):
    """vms yaw px against the far-feature yaw px A (refit at f_hat): g = sum(vms * A) / sum(A^2) over pairs with a vms value, plus block bootstrap over stretches.
    Returns the pairs' arrays too (per stretch), for the GPS / COLMAP checks."""
    p = Params(**{**res['params'], 'k1_grid': tuple(res['params']['k1_grid'])})
    fg, kg = f_grid(p), np.array(p.k1_grid)
    i = int(np.argmin(np.abs(np.log(fg) - np.log(f_hat))))
    j = int(np.argmin(np.abs(kg - k1)))
    rows = []
    for si, s in enumerate(res['stretches']):
        if len(s['pairs']) < min_pairs:
            continue
        a = np.array([q['A'][i, j] for q in s['pairs']], float)
        y = np.array([q['vms_yaw'] for q in s['pairs']], float)
        w = np.array([1.0 / q['sigma'] ** 2 for q in s['pairs']], float)
        ta = np.array([q['ta'] for q in s['pairs']]); tb = np.array([q['tb'] for q in s['pairs']])
        rows.append(dict(si=si, A=a, vms=y, w=w, ta=ta, tb=tb))
    if not rows:
        return None

    def g_of(rs):
        num = sum(float(np.nansum(r['vms'] * r['A'])) for r in rs)
        den = sum(float(np.nansum(np.where(np.isfinite(r['vms']), r['A'] ** 2, 0.0))) for r in rs)
        return num / den if den > 0 else np.nan

    g = g_of(rows)
    rng = np.random.default_rng(seed)
    bs = np.array([g_of([rows[j_] for j_ in rng.integers(0, len(rows), len(rows))]) for _ in range(n_boot)])
    return dict(g=g, lo=float(np.nanpercentile(bs, 2.5)), hi=float(np.nanpercentile(bs, 97.5)), rows=rows, boot=bs)
