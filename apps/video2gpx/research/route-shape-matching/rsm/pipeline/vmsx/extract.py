# SPDX-License-Identifier: AGPL-3.0-or-later
"""Extraction of the image side (docs/CONCEPT_extraction.md, phase 1): the video read once into assumption-free motion data.

The whole frame is cut into a fixed grid of CELL px cells; per cell the NPTS strongest corners (local maxima of the minimum eigenvalue, absolute
threshold THR, the second at least MIN_D px from the first) are tracked into the next frame with the forward-backward LK tracker of the motion step.
Nothing here knows a horizon, a road area or a rotation band: the interpretation selects from the stored points later, without the video.

Streams (per pair or window, every point: start x, y; flow dx, dy; forward-backward error; corner strength):
  des  pairs (j-1, j) on the destatic-filtered frames (vmsx.motion.Destatic), every pair
  raw  pairs (j-1, j) on the plain frames: every RAW_EVERY-th pair (frame j) and every pair whose des stream has fewer than RAW_LOW_MIN points in
       the lower half of the frame (the road fit falls back to the plain pair there)
  rot  frames (w k, (w + 1) k) on the plain frames, once per rotation window w (k = C.FAR k_s x fps, as steps_a.rotation)
plus the frame difference of every pair (`diff` of vmsx.motion.pair_row, scene cuts). Points whose track failed or whose forward-backward error is
FB_MAX px or more are not stored.

Chunks run in parallel like vmsx.motion.analyse_parallel (WARM_FRAMES of overlap, checked by hash); the data equal those of one sequential pass.
"""
from __future__ import annotations

import io
import json
import multiprocessing as mp
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np

from .. import config as C
from . import motion as vm
from .decode import frames, frames_from, probe

VERSION = "extract1"
CELL = 16
NPTS = 2
MIN_D = 8
#: absolute minimum of cv2.cornerMinEigenVal (blockSize EIG_BLOCK, ksize EIG_KSIZE) on the plain and on the destatic frame (gain 3: more contrast)
THR = {"raw": 1.0e-4, "des": 2.5e-4}
EIG_BLOCK = 7
EIG_KSIZE = 3
Q_XY = 32           # start position in 1/32 px (uint16)
Q_FLOW = 64         # flow in 1/64 px (int16)
Q_FB = 128          # forward-backward error in 1/128 px (uint8)
Q_STRENGTH = 16     # strength: Q_STRENGTH x log2(eigenvalue / EIG0) (uint8)
EIG0 = 1.0e-5
FB_MAX = 1.0
RAW_EVERY = 3
RAW_LOW_MIN = 40
STREAMS = ("des", "raw", "rot")
COLS = ("x", "y", "dx", "dy", "fb", "q")


def params(k: int | None = None) -> dict:
    """everything that shapes the stored data (extract.json `params`, part of the key)"""
    return dict(cell=CELL, npts=NPTS, min_d=MIN_D, thr=dict(THR), eig_block=EIG_BLOCK, eig_ksize=EIG_KSIZE, q_xy=Q_XY, q_flow=Q_FLOW, q_fb=Q_FB,
                q_strength=Q_STRENGTH, eig0=EIG0, fb_max=FB_MAX, raw_every=RAW_EVERY, raw_low_min=RAW_LOW_MIN, k_s=C.FAR["k_s"], k=k,
                destatic_tau=vm.DESTATIC_TAU, destatic_gain=vm.DESTATIC_GAIN, lk=dict(win=list(vm.LK_PARAMS["winSize"]), levels=vm.LK_PARAMS["maxLevel"]))


def eig_map(frame: np.ndarray) -> np.ndarray:
    return cv2.cornerMinEigenVal(frame, EIG_BLOCK, EIG_KSIZE)


def strength_code(v: np.ndarray) -> np.ndarray:
    return np.clip(np.round(Q_STRENGTH * np.log2(np.maximum(v, EIG0) / EIG0)), 0, 255).astype(np.uint8)


def strength_value(q: np.ndarray) -> np.ndarray:
    return EIG0 * 2.0 ** (np.asarray(q, np.float64) / Q_STRENGTH)


def detect(eig: np.ndarray, thr: float) -> tuple[np.ndarray, np.ndarray]:
    """(points (n, 2) float32 x, y; strength codes (n,) uint8): per CELL cell the strongest local maximum of `eig` at or above `thr`, then the next
    strongest at least MIN_D px from it; cell by cell (row-major), the strongest first"""
    H, W = eig.shape
    v = np.where((eig == cv2.dilate(eig, None)) & (eig >= thr), eig, 0).astype(np.float32)
    gy, gx = -(-H // CELL), -(-W // CELL)
    pad = np.zeros((gy * CELL, gx * CELL), np.float32)
    pad[:H, :W] = v
    blocks = pad.reshape(gy, CELL, gx, CELL).transpose(0, 2, 1, 3).reshape(gy * gx, CELL * CELL)
    by, bx = np.divmod(np.arange(gy * gx), gx)
    K = min(8, CELL * CELL - 1)
    top = np.argpartition(-blocks, K, axis=1)[:, :K]
    tv = np.take_along_axis(blocks, top, 1)
    o = np.lexsort((top, -tv), axis=1)                    # strongest first, ties by position: deterministic
    top, tv = np.take_along_axis(top, o, 1), np.take_along_axis(tv, o, 1)
    ty, tx = top // CELL, top % CELL
    pick = [np.where(tv[:, 0] > 0, 0, -1)]
    if NPTS >= 2:
        sec = np.full(len(top), -1)
        for j in range(K - 1, 0, -1):                     # the strongest candidate far enough from the best one
            ok = (tv[:, j] > 0) & (np.hypot(ty[:, j] - ty[:, 0], tx[:, j] - tx[:, 0]) >= MIN_D)
            sec = np.where(ok, j, sec)
        pick.append(np.where(pick[0] >= 0, sec, -1))
    P = np.stack(pick, 1)                                 # (cells, NPTS) candidate index or -1
    cells, rank = np.nonzero(P >= 0)
    j = P[cells, rank]
    xs = bx[cells] * CELL + tx[cells, j]
    ys = by[cells] * CELL + ty[cells, j]
    pts = np.column_stack([xs, ys]).astype(np.float32)
    return pts, strength_code(eig[ys, xs])


def track(a: np.ndarray, b: np.ndarray, p0: np.ndarray):
    """(flow (n, 2), forward-backward error (n,), ok (n,)) of the points p0 from frame a into frame b (the LK of vmsx.motion.Tracker)"""
    if len(p0) == 0:
        return np.zeros((0, 2)), np.zeros(0), np.zeros(0, bool)
    q0 = p0.reshape(-1, 1, 2)
    p1, s1, _ = cv2.calcOpticalFlowPyrLK(a, b, q0, None, **vm.LK_PARAMS)
    bk, s2, _ = cv2.calcOpticalFlowPyrLK(b, a, p1, None, **vm.LK_PARAMS)
    fb = np.linalg.norm((bk - q0).reshape(-1, 2), axis=1)
    ok = (s1.ravel() == 1) & (s2.ravel() == 1)
    return (p1 - q0).reshape(-1, 2).astype(np.float64), fb, ok


def quantise(p0, flow, fb):
    x = np.clip(np.round(np.asarray(p0)[:, 0] * Q_XY), 0, 65535).astype(np.uint16)
    y = np.clip(np.round(np.asarray(p0)[:, 1] * Q_XY), 0, 65535).astype(np.uint16)
    dx = np.clip(np.round(np.asarray(flow)[:, 0] * Q_FLOW), -32768, 32767).astype(np.int16)
    dy = np.clip(np.round(np.asarray(flow)[:, 1] * Q_FLOW), -32768, 32767).astype(np.int16)
    f = np.clip(np.round(np.asarray(fb) * Q_FB), 0, 255).astype(np.uint8)
    return x, y, dx, dy, f


def dequantise(x, y, dx, dy, fb):
    return (x.astype(np.float64) / Q_XY, y.astype(np.float64) / Q_XY, dx.astype(np.float64) / Q_FLOW, dy.astype(np.float64) / Q_FLOW,
            fb.astype(np.float64) / Q_FB)


class _Stream:
    def __init__(self):
        self.cols = {c: [] for c in COLS}
        self.count = []

    def add(self, pts, q, a, b):
        flow, fb, ok = track(a, b, pts)
        keep = ok & (np.round(fb * Q_FB) < FB_MAX * Q_FB)          # as stored: a quantised error of 1 px is not kept
        for c, arr in zip(COLS, (*quantise(pts[keep], flow[keep], fb[keep]), q[keep])):
            self.cols[c].append(arr)
        self.count.append(int(keep.sum()))
        return pts[keep]

    def arrays(self, s):
        dt = dict(x=np.uint16, y=np.uint16, dx=np.int16, dy=np.int16, fb=np.uint8, q=np.uint8)
        out = {f"{s}_{c}": (np.concatenate(v) if v else np.zeros(0, dt[c])) for c, v in self.cols.items()}
        out[f"{s}_count"] = np.array(self.count, np.int32)
        return out


def _worker_init():
    cv2.setNumThreads(1)


def _range(job) -> dict:
    """the data of the pairs (j - 1, j), a < j <= b (b None: to the end), the windows ending in that range, and the hashes of the first / last
    WARM_FRAMES + 1 decoded frames (seam check as in vmsx.motion._par_chunk)"""
    X, a, b = job
    info, H, hw, k, n_win = X["info"], X["height"], X["hwaccel"], X["k"], X["n_win"]
    s = max(0, a - vm.WARM_FRAMES)
    if s == 0:
        src = (f for _, f in frames(X["path"], H, hwaccel=hw))
    else:
        src = frames_from(X["path"], info, H, s, None if b is None else b - s + 1, hwaccel=hw)
    filt = vm.Destatic()
    st = {x: _Stream() for x in STREAMS}
    idx, diff, raw_idx, rot_w = [], [], [], []
    head, tail = [], deque(maxlen=vm.WARM_FRAMES + 1)
    prev = prev_f = prev_e = prev_ef = key = key_e = None
    j = s - 1
    try:
        for fr in src:
            j += 1
            if len(head) <= vm.WARM_FRAMES:
                head.append(vm._sha(fr))
            tail.append(fr)
            ff = filt(fr)
            e = ef = None
            if j > a or j % k == 0 or j == a:
                e, ef = eig_map(fr), eig_map(ff)
            if prev is not None and j > a:
                idx.append(j)
                diff.append(float(np.mean(np.abs(fr[::4, ::4].astype(np.int16) - prev[::4, ::4].astype(np.int16)))))
                p, q = detect(prev_ef, THR["des"])
                kept = st["des"].add(p, q, prev_f, ff)
                if j % RAW_EVERY == 0 or int((kept[:, 1] >= H / 2).sum()) < RAW_LOW_MIN:
                    p, q = detect(prev_e, THR["raw"])
                    st["raw"].add(p, q, prev, fr)
                    raw_idx.append(j)
                w = j // k - 1
                if j % k == 0 and key is not None and 0 <= w < n_win:
                    p, q = detect(key_e, THR["raw"])
                    st["rot"].add(p, q, key, fr)
                    rot_w.append(w)
            if j % k == 0:
                key, key_e = fr, e
            prev, prev_f, prev_e, prev_ef = fr, ff, e, ef
            if b is not None and j >= b:
                break
    finally:
        src.close()
    out = dict(idx=np.array(idx, np.int32), diff=np.array(diff, np.float32), raw_idx=np.array(raw_idx, np.int32), rot_w=np.array(rot_w, np.int32))
    for x in STREAMS:
        out.update(st[x].arrays(x))
    return dict(a=a, b=b, last=j, data=out, head=head, tail=[vm._sha(f) for f in tail])


def _write(d: Path, r: dict) -> str:
    name = f"chunk_{r['a']:08d}.npz"
    buf = io.BytesIO()
    np.savez_compressed(buf, **r["data"])
    (d / name).write_bytes(buf.getvalue())
    return name


def extract(path: str, out_dir, height: int = 360, workers: int = 4, chunk_s: float = vm.CHUNK_S, hwaccel: bool = True, log=None, key=None, on_progress=None) -> dict:
    """extract the video into out_dir (extract.json + chunk_<first frame>.npz); returns the meta (`key`: the caller's key of video and settings, stored as is). workers 1 (or a video shorter than two chunks, or
    irregular stream timing, or a seam that does not match): one sequential pass, same data."""
    log = log or (lambda level, msg: None)
    d = Path(out_dir)
    d.mkdir(parents=True, exist_ok=True)
    for f in d.glob("chunk_*.npz"):
        f.unlink()
    t0 = time.perf_counter()
    info = probe(path)
    width = round(info.width * height / info.height / 2) * 2
    k = max(2, int(round(C.FAR["k_s"] * info.fps)))
    if k > vm.WARM_FRAMES:
        raise ValueError(f"rotation window of {k} frames is longer than the chunk overlap of {vm.WARM_FRAMES}")
    n_win = int(info.duration * info.fps / k) - 1
    X = dict(path=path, info=info, height=height, hwaccel=hwaccel, k=k, n_win=n_win)
    cf = max(4 * vm.WARM_FRAMES, int(round(chunk_s * info.fps)))
    n_est = int(info.duration * info.fps)
    starts = [i * cf for i in range(max(1, n_est // cf))]
    jobs = [(a, starts[i + 1] if i + 1 < len(starts) else None) for i, a in enumerate(starts)]
    why = None
    if workers <= 1:
        why, jobs = "one worker", [(0, None)]
    elif len(jobs) < 2:
        why = "shorter than two chunks"
    else:
        why = vm.timing_problem(path, info.fps)
    chunks, pairs, windows = [], 0, 0
    if why is None:
        with mp.get_context("fork").Pool(min(workers, len(jobs)), initializer=_worker_init) as pool:
            res = []
            for r in pool.imap_unordered(_range, [(X, a, b) for a, b in jobs], chunksize=1):
                res.append(r)
                if on_progress is not None:
                    on_progress(len(res), len(jobs), "extract")
            res.sort(key=lambda r: r["a"])
            pool.close()
            pool.join()
        for i in range(1, len(res)):
            if res[i - 1]["last"] != res[i - 1]["b"] or res[i - 1]["tail"] != res[i]["head"]:
                why = f"chunk at frame {res[i]['a']}: the seek did not land on the frames of the sequential decode"
                break
        if why is None:
            for r in res:
                chunks.append([r["a"], r["last"], _write(d, r)])
                pairs += len(r["data"]["idx"]); windows += len(r["data"]["rot_w"])
        else:
            log("warn", f"extract: parallel extraction not used ({why}); sequential extraction")
    fallback = why if workers > 1 else None
    if not chunks:
        if on_progress is not None:
            on_progress(0, 1, "extract")
        r = _range((X, 0, None))
        chunks.append([0, r["last"], _write(d, r)])
        pairs, windows = len(r["data"]["idx"]), len(r["data"]["rot_w"])
    pr = params(k)
    meta = dict(version=VERSION, key=key, params=pr, video=str(path), fps=float(info.fps), duration=float(info.duration), width=int(width), height=int(height), pairs=int(pairs), windows=int(windows),
                n_win=int(n_win), k=int(k), chunks=chunks, opencv=cv2.__version__, seconds=round(time.perf_counter() - t0, 2),
                parallel=dict(workers=int(workers), chunks=len(chunks), fallback=fallback))
    (d / "extract.json").write_text(json.dumps(meta, indent=1))
    return meta


def load(d, around: int | None = None) -> dict:
    """all chunks of an extraction concatenated (counts stay aligned with idx / raw_idx / rot_w); `around` = a pair's frame j: only its chunk"""
    d = Path(d)
    meta = json.loads((d / "extract.json").read_text())
    chunks = meta["chunks"]
    if around is not None:
        chunks = [c for c in chunks if c[0] < around <= c[1]] or chunks[:1]
    parts = [dict(np.load(d / name)) for _, _, name in chunks]
    return {key: np.concatenate([p[key] for p in parts]) for key in parts[0]}


def iter_stream(z: dict, s: str):
    """per pair (des, raw) or window (rot): (x, y, dx, dy, fb) in px"""
    off = np.concatenate([[0], np.cumsum(z[f"{s}_count"])])
    for i in range(len(z[f"{s}_count"])):
        a, b = off[i], off[i + 1]
        yield dequantise(*(z[f"{s}_{c}"][a:b] for c in ("x", "y", "dx", "dy", "fb")))


if __name__ == "__main__":
    import sys
    m = extract(sys.argv[1], sys.argv[2], workers=int(sys.argv[3]) if len(sys.argv) > 3 else 4)
    print(json.dumps({k_: v for k_, v in m.items() if k_ != "chunks"}, indent=1))
