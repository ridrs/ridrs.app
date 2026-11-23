# SPDX-License-Identifier: AGPL-3.0-or-later
"""The motion step as interpretation of the extraction (docs/CONCEPT_extraction.md, phase 2).

Everything `vmsx.motion.analyse` does after tracking runs here on the stored points of `extract/` (vmsx.extract), without the video: the horizon
calibration (focus of expansion and free road-plane fit on 16 fixed stretches), the noise level, the running horizon, the road-flow fit of every
pair, the traffic candidates and their pick. motion.csv and motion.json keep their format.

What differs from the inline pass, by construction: the points are the extraction's grid points (USE_NPTS per cell, the strongest with a usable
track) instead of goodFeaturesToTrack in the road area; the destatic filter runs through the whole video instead of restarting per stretch; the
calibration stretches use the plain pairs the extraction stores (every RAW_EVERY-th pair) instead of every pair.
"""
from __future__ import annotations

import csv
import json
import multiprocessing as mp
import time
from pathlib import Path

import numpy as np

from rsm.farrot import model

from . import extract as EX, motion as vm

VERSION = "interpret1"
#: E4 (2026-11-20): the extraction stores 2 points per cell; the interpretation uses this many, the strongest with a usable track first. Phase 0:
#: 1 per cell was best against the verified Pontaix track.
USE_NPTS = 1


def params() -> dict:
    """everything of the interpretation that shapes motion.csv beyond vmsx.motion's settings (part of the motion step's hash)"""
    return dict(version=VERSION, use_npts=USE_NPTS)


def select(x: np.ndarray, y: np.ndarray, fb: np.ndarray, fb_max: float, cell: int = EX.CELL) -> np.ndarray:
    """indices of the points used: forward-backward error below fb_max, then the first USE_NPTS of each cell (stored strongest first)"""
    k = np.flatnonzero(fb < fb_max)
    if len(k) == 0:
        return k
    c = (y[k] // cell).astype(np.int64) * 100_000 + (x[k] // cell).astype(np.int64)
    # extracted points are stored cell-by-cell in row-major order (non-decreasing c), so we can skip argsort in the common case
    if len(c) == 1 or bool((c[1:] >= c[:-1]).all()):
        first = np.r_[True, c[1:] != c[:-1]]
        if USE_NPTS == 1:
            return k[first]
        start = np.maximum.accumulate(np.where(first, np.arange(len(c)), 0))
        return k[(np.arange(len(c)) - start) < USE_NPTS]
    o = np.argsort(c, kind="stable")
    cs = c[o]
    first = np.r_[True, cs[1:] != cs[:-1]]
    start = np.maximum.accumulate(np.where(first, np.arange(len(cs)), 0))
    rank = np.arange(len(cs)) - start
    return k[np.sort(o[rank < USE_NPTS])]


class Points:
    """the stored points of one extraction, per pair (des, raw) or window (rot)"""

    def __init__(self, d, around: int | None = None, streams=None):
        """`around`: a pair's frame j, only the chunk holding it is loaded (the overlay of one pair); `streams`: only these streams"""
        self.dir = Path(d)
        self.meta = json.loads((self.dir / "extract.json").read_text())
        self.z = EX.load(self.dir, around, streams)
        m = self.meta
        self.fps, self.width, self.height = float(m["fps"]), int(m["width"]), int(m["height"])
        self.duration = float(m.get("duration") or (m["pairs"] + 1) / self.fps)
        self.cell = int(m["params"]["cell"])
        self.idx = self.z["idx"]
        self.diff = self.z["diff"]
        self.pos = {int(j): i for i, j in enumerate(self.idx)}
        self.rpos = {int(j): i for i, j in enumerate(self.z["raw_idx"])}
        self.off = {s: np.concatenate([[0], np.cumsum(self.z[f"{s}_count"])]) for s in EX.STREAMS if f"{s}_count" in self.z}
        self.wpos = {int(w): i for i, w in enumerate(self.z["rot_w"])}

    def get(self, s: str, i: int, mask: np.ndarray | None, fb_max: float) -> tuple[int, np.ndarray, np.ndarray]:
        """(stored points in the mask, midpoints, flow) of entry i of stream s: the points used (`select`) within the mask"""
        n, p0, fl = self.starts(s, i, mask, fb_max)
        return n, p0 + fl / 2, fl

    def starts(self, s: str, i: int, mask: np.ndarray | None, fb_max: float) -> tuple[int, np.ndarray, np.ndarray]:
        """(stored points in the mask, start points, flow) of entry i of stream s: the points used (`select`) within the mask"""
        a, b = self.off[s][i], self.off[s][i + 1]
        x, y, dx, dy, fb = EX.dequantise(*(self.z[f"{s}_{c}"][a:b] for c in ("x", "y", "dx", "dy", "fb")))
        if mask is not None:
            H, W = mask.shape
            inm = mask[np.clip(np.round(y).astype(int), 0, H - 1), np.clip(np.round(x).astype(int), 0, W - 1)]
            x, y, dx, dy, fb = x[inm], y[inm], dx[inm], dy[inm], fb[inm]
        n = len(x)
        k = select(x, y, fb, fb_max, self.cell)
        return n, np.column_stack([x[k], y[k]]), np.column_stack([dx[k], dy[k]])

    def stretch(self, start: float, window: float) -> list[int]:
        """the pair frames j of the stretch [start, start + window) as `vmsx.decode.frames(start, window)` decodes it: pairs within its frames"""
        f0 = int(np.ceil(start * self.fps - 1e-6))
        f1 = int(np.ceil((start + window) * self.fps - 1e-6))
        return [j for j in range(f0 + 1, f1) if j in self.pos]

    def rect(self, top: int, bottom: int) -> np.ndarray:
        m = np.zeros((self.height, self.width), bool)
        m[top:bottom, :] = True
        return m


def _scale(P: Points) -> float:
    return P.height / 360


def _foes(P: Points, js, whole: np.ndarray) -> list[float]:
    """focus-of-expansion rows of the plain pairs at the FOE cadence (every RAW_EVERY-th frame) among js, all points of the frame"""
    sc, out = _scale(P), []
    for j in js:
        if j % EX.RAW_EVERY or j not in P.rpos:
            continue
        _, mid, flow = P.get("raw", P.rpos[j], whole, vm.MAX_FB_ERROR * sc)
        fo = vm.focus_of_expansion(mid, flow, 0.3 * sc)
        if fo is not None and -P.height < fo[1] < 2 * P.height:
            out.append(fo[1])
    return out


def _stretches(P: Points, samples: int = 16, window: float = 3.0):
    return [P.stretch(P.duration * (k + 0.5) / samples, window) for k in range(samples)]


def calibrate_horizon(P: Points, samples: int = 16, window: float = 3.0) -> dict:
    """`vmsx.motion.calibrate_horizon` on the stored plain pairs: `horizon` the median focus of expansion, `horizon_free` the median free
    road-plane fit (the far-feature bands hang from it)"""
    H, sc = P.height, _scale(P)
    bottom = H - round(vm.ABOVE_BOTTOM * H)
    lower, whole = P.rect(H // 2, bottom), P.rect(round(0.1 * H), bottom)
    est, foes = [], []
    for js in _stretches(P, samples, window):
        for j in js:
            if j % EX.RAW_EVERY or j not in P.rpos:
                continue
            _, mid, flow = P.get("raw", P.rpos[j], lower, vm.MAX_FB_ERROR * sc)
            if len(mid) >= vm.MIN_INLIERS:
                e = vm.fit_free_horizon(mid, flow, P.width / 2, H / 2, vm.MIN_RESIDUAL * sc)
                if e is not None and e[0] * (H / 2) ** 2 > 2 * sc:
                    est.append(e[1])
        foes += _foes(P, js, whole)
    if len(est) < 20 or len(foes) < 20:
        raise RuntimeError(f"horizon: only {len(est)} / {len(foes)} usable frame pairs in the extraction")
    arr, fa = np.array(est), np.array(foes)
    q25, q50, q75 = np.percentile(arr, [25, 50, 75])
    f25, f50, f75 = np.percentile(fa, [25, 50, 75])
    return {"horizon": float(f50), "iqr": float(f75 - f25), "frames": len(fa), "height": H,
            "horizon_free": float(q50), "iqr_free": float(q75 - q25), "frames_free": len(arr)}


def road_mask(P: Points, horizon: float, top: int, bottom: int, road_width) -> np.ndarray:
    return vm.Tracker(P.height, P.width, top, bottom, horizon, road_width).mask > 0


def calibrate_noise(P: Points, horizon: float, top: int, bottom: int, road_width=vm.ROAD_WIDTH, samples: int = 16, window: float = 3.0) -> dict:
    """`vmsx.motion.calibrate_noise` on the stored points: the median plain-fit rms of the pairs of the 16 fixed stretches"""
    H, sc = P.height, _scale(P)
    mask = road_mask(P, horizon, top, bottom, road_width)
    fbm, mr = vm.MAX_FB_ERROR * sc, vm.MIN_RESIDUAL * sc
    out = []
    for js in _stretches(P, samples, window):
        for j in js[vm.NOISE_WARM:]:
            fit = None
            for s, i in (("des", P.pos[j]), ("raw", P.rpos.get(j))):
                if i is None:
                    continue
                _, mid, flow = P.get(s, i, mask, fbm)
                mid, flow = vm.below_horizon(mid, flow, horizon, H)
                fit = vm.fit_fixed_horizon(mid, flow, P.width / 2, H / 2, horizon, mr) if len(mid) >= vm.MIN_INLIERS else None
                if fit is not None:
                    break
            if fit is not None:
                out.append(fit.rms)
    r = np.array(out)
    return dict(rms_median=float(np.median(r)) if len(r) else float("nan"), rms_pairs=int(len(r)))


def horizon_track(P: Points, horizon: float) -> dict:
    """`vmsx.motion.horizon_track` of the whole extraction: the focus-of-expansion row every HZ_EVERY s (HZ_WINDOW s each), in the extraction's seconds;
    gated by vmsx.motion.gate_track (A29), not by the calibrated `horizon`"""
    H = P.height
    whole = P.rect(round(0.1 * H), H - round(vm.ABOVE_BOTTOM * H))
    starts, foes = [], []
    k = 0
    while k * vm.HZ_EVERY + vm.HZ_WINDOW <= P.duration + 1e-9:
        s = k * vm.HZ_EVERY
        k += 1
        starts.append(s)
        foes.append(_foes(P, P.stretch(s, vm.HZ_WINDOW), whole))
    return vm.track_of(starts, foes, H)


_M: dict = {}       # read-only context of analyse(), inherited by forked workers


def _fit_slice(args) -> tuple[int, list]:
    i0, i1 = args
    M = _M
    P, mask, fbm, mr, dt, W, H, sc, seed0, alt_thr, times, yh = (
        M["P"], M["mask"], M["fbm"], M["mr"], M["dt"], M["W"], M["H"], M["sc"], M["seed0"], M["alt_thr"], M["times"], M["yh"]
    )
    rows = []
    for i in range(i0, i1):
        j = int(P.idx[i])
        ri = P.rpos.get(j)
        first = lambda i=i: P.get("des", i, mask, fbm)
        fallback = (lambda ri=ri: P.get("raw", ri, mask, fbm)) if ri is not None else None
        rows.append(vm.fit_row(j, float(times[i]), float(P.diff[i]), first, fallback, float(yh[i]), mr, dt, W, H, sc, seed0=seed0, alt_thr=alt_thr))
    return i0, rows


def analyse(ex_dir, out_csv: str, calibration: dict | None = None, seed0: int = 0, road_width=vm.ROAD_WIDTH, on_progress=None, running: bool = True,
            spread_iqr: float | None = None, workers: int = 1) -> dict:
    """motion.csv of the extraction in ex_dir and the run statistics of `vmsx.motion.analyse_parallel`. `calibration`, `seed0`: as there (a clip
    of a source passes the source's calibration with its track in source seconds and the index of its first source frame). running=False: every pair
    is fitted with the calibrated row (no running horizon, A24 off; the calibration's track is None). `spread_iqr` (with running=False): when the
    calibration's focus-of-expansion rows spread more than this (iqr), no fixed row fits the video and the running horizon is used after all (A27);
    the result says so in `horizon_spread`."""
    t0 = time.perf_counter()
    if on_progress is not None:
        on_progress(0, 1, "horizon")
    P = Points(ex_dir, streams=("des", "raw"))
    H, W, fps, sc = P.height, P.width, P.fps, _scale(P)
    cal = dict(calibration) if calibration is not None else calibrate_horizon(P)
    spread = None
    if not running and spread_iqr is not None:
        spread = dict(iqr=float(cal["iqr"]), limit=float(spread_iqr), running=bool(float(cal["iqr"]) > spread_iqr))
        running = spread["running"]
    horizon = float(cal["horizon"])
    top = int(max(H * 0.45, horizon + vm.BELOW_HORIZON * H))
    bottom = H - round(vm.ABOVE_BOTTOM * H)
    if "rms_median" not in cal:
        cal.update(calibrate_noise(P, horizon, top, bottom, road_width))
    alt_thr = vm.alt_threshold(cal["rms_median"], sc)
    t_src = seed0 / fps
    if not running:
        cal["track"] = None
    elif "track" not in cal:
        cal["track"] = vm.shift_track(horizon_track(P, horizon), t_src)
    t_cal = time.perf_counter() - t0
    mask = road_mask(P, horizon, top, bottom, road_width)
    fbm, mr, dt = vm.MAX_FB_ERROR * sc, vm.MIN_RESIDUAL * sc, 1 / fps
    times = (P.idx - 0.5) / fps
    yh = vm.running_horizon(cal["track"], times + t_src, horizon)
    n = len(P.idx)
    slice_n = 1200
    slices = [(s, min(s + slice_n, n)) for s in range(0, n, slice_n)]
    if workers > 1 and len(slices) > 1:
        _M.clear()
        _M.update(P=P, mask=mask, fbm=fbm, mr=mr, dt=dt, W=W, H=H, sc=sc, seed0=seed0, alt_thr=alt_thr, times=times, yh=yh)
        parts, done = [], 0
        try:
            with mp.get_context("fork").Pool(min(workers, len(slices)), initializer=EX._worker_init) as pool:
                for i0, rows in pool.imap_unordered(_fit_slice, slices, chunksize=1):
                    parts.append((i0, rows))
                    done += len(rows)
                    if on_progress is not None:
                        on_progress(done, n, "pairs")
                pool.close()
                pool.join()
        finally:
            _M.clear()
        parts.sort(key=lambda x: x[0])
        with open(out_csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(vm.COLUMNS)
            for _, rows in parts:
                w.writerows(rows)
    else:
        last_cb = 0.0
        with open(out_csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(vm.COLUMNS)
            for i in range(n):
                j = int(P.idx[i])
                ri = P.rpos.get(j)
                first = lambda i=i: P.get("des", i, mask, fbm)
                fallback = (lambda ri=ri: P.get("raw", ri, mask, fbm)) if ri is not None else None
                w.writerow(vm.fit_row(j, float(times[i]), float(P.diff[i]), first, fallback, float(yh[i]), mr, dt, W, H, sc, seed0=seed0, alt_thr=alt_thr))
                if on_progress is not None and i % 600 == 0:
                    now = time.perf_counter()
                    if now - last_cb >= 1.0:
                        last_cb = now
                        on_progress(i, n, "pairs")
    traffic = vm.pick_alternatives(out_csv, sc) if vm.ALT_TRIGGER > 0 else {}
    elapsed = time.perf_counter() - t0
    if on_progress is not None:
        on_progress(n, n, "pairs")
    m = P.meta
    return {
        "video": m.get("video"), "height": H, "width": W, "step": 1, "fps": fps, "start": 0.0, "duration": P.duration,
        "horizon": cal["horizon_free"], "horizon_vms": horizon, "destatic_tau": m["params"]["destatic_tau"], "horizon_offset": 0.0, "road_width": road_width,
        "horizon_calibration": cal, "horizon_mode": "running" if running else "fixed", "roi": [top, bottom], "alt_thr": alt_thr, "track_t0": t_src, "pairs": n, "traffic": traffic,
        "seconds": elapsed, "calibration_seconds": t_cal, "seconds_per_video_hour": elapsed / (P.duration / 3600),
        "extract": dict(version=m["version"], key=m.get("key"), seconds=m.get("seconds")), "interpret": params(),
        **({"horizon_spread": spread} if spread is not None else {}),
    }


# ------------------------------------------------------------------ rotation (phase 3)
def band_masks(P: Points, ends) -> list[np.ndarray]:
    """the far bands of steps_a._chunk: rows above each band end, the width less 2 % on each side"""
    out = []
    mx = int(0.02 * P.width)
    for e in ends:
        m = np.zeros((P.height, P.width), bool)
        m[:int(e), mx:P.width - mx] = True
        out.append(m)
    return out


_R: dict = {}       # the context of rotation_windows, inherited by the forked workers


def _windows(args) -> tuple[int, np.ndarray]:
    """the band fits of windows w0 .. w1 - 1 as steps_a._chunk makes them from the decoded frames: one generator per chunk, seeded 1000 + w0, a
    band fitted when at least p.min_inl stored points lie in it (else 'few corners', no draw)"""
    w0, w1 = args
    R = _R
    P, masks, p, f, min_inl, NF, why = R["P"], R["masks"], R["p"], R["f"], R["min_inl"], len(R["fields"]), R["why"]
    sc = _scale(P)
    rng = np.random.default_rng(1000 + w0)
    out = np.full((w1 - w0, len(masks), NF + 4), np.nan)
    out[:, :, NF:] = [0, 0, 0, 1]
    for wi in range(w0, w1):
        i = P.wpos.get(wi)
        if i is None:
            continue
        for b, m in enumerate(masks):
            n, q0, fl = P.starts("rot", i, m, p.fb_err * sc)
            if n < p.min_inl:
                continue
            x, y = q0[:, 0] - P.width / 2, q0[:, 1] - P.height / 2
            wf = model.fit_window(x, y, fl, f, scale=sc, rng=rng, min_inl=min_inl, min_xspread=0.0)
            out[wi - w0, b, :NF] = [getattr(wf, a) for a in R["fields"]]
            out[wi - w0, b, NF:] = [wf.ok, wf.n_pts, wf.n_inl, why.index(wf.why) if wf.why in why else 2]
    return w0, out


def rotation_windows(P: Points, ends, p, f: float, min_inl: int, n_win: int, chunk_w: int, fields, why, workers: int = 1, on_progress=None) -> np.ndarray:
    """(n_win, bands, len(fields) + 4) band fits of the rotation windows from the stored `rot` stream, in the layout of steps_a._chunk (fields, then
    ok, n_pts, n_inl, why index); chunks of chunk_w windows, in `workers` processes (the same fits for any number)"""
    _R.clear()
    _R.update(P=P, masks=band_masks(P, ends), p=p, f=f, min_inl=min_inl, fields=list(fields), why=list(why))
    chunks = [(s, min(s + chunk_w, n_win)) for s in range(0, n_win, chunk_w)]
    res = []
    if workers > 1 and len(chunks) > 1:
        with mp.get_context("fork").Pool(min(workers, len(chunks)), initializer=EX._worker_init) as pool:
            for r in pool.imap_unordered(_windows, chunks, chunksize=1):
                res.append(r)
                if on_progress is not None:
                    on_progress(len(res), len(chunks), "bands")
            pool.close()
            pool.join()
    else:
        for c in chunks:
            res.append(_windows(c))
            if on_progress is not None:
                on_progress(len(res), len(chunks), "bands")
    res.sort(key=lambda r: r[0])
    _R.clear()
    if not res:
        return np.zeros((0, len(ends), len(fields) + 4))
    return np.concatenate([r[1] for r in res])


def ensure_extract(video: str, d, key, height: int = 360, workers: int = 4, hwaccel: bool = True, log=None, on_progress=None) -> tuple[dict, bool]:
    """(meta, reused): the extraction in d when it was made with `key` (video and settings) and is complete, else a new one"""
    d = Path(d)
    f = d / "extract.json"
    if f.exists():
        try:
            m = json.loads(f.read_text())
        except ValueError:
            m = {}
        if m.get("key") == key and m.get("version") == EX.VERSION and all((d / c[2]).exists() for c in m.get("chunks", [])):
            return m, True
    return EX.extract(video, d, height=height, workers=workers, hwaccel=hwaccel, log=log, key=key, on_progress=on_progress), False
