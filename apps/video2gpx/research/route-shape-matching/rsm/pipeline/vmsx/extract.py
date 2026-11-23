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
import os
import time
import zipfile
from collections import deque
from pathlib import Path

import cv2
import numpy as np

from .. import config as C
from . import _metal, motion as vm
from .decode import frames, frames_from, probe

VERSION = "extract1"
CELL = 16
NPTS = 1
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
#: vertical frame-fraction bounds for the des (lower portion) and rot (upper portion) streams; aligned to CELL rows so retained points are bit-identical
DES_Y_MIN = 0.40
ROT_Y_MAX = 0.62
STREAMS = ("des", "raw", "rot")
#: speed (2026-11-20; neither shapes the data): chunks of CHUNK_S s keep every worker busy to the end (with 120 s, 10 min were 5 chunks on 4
#: workers: two rounds), and THREADS OpenCV threads per worker parallelise the LK tracking (85 % of the time). Pontaix 10 min, 4 workers:
#: 120 s chunks / 1 thread 261-341 s, 30 s / 1 thread 180 s, 30 s / 2 threads 127 s; 3 workers x 3 threads 153 s, 6 x 2 129 s; data identical.
CHUNK_S = 30.0
THREADS = 2
COLS = ("x", "y", "dx", "dy", "fb", "q")
ZIP_LEVEL = 1       # zlib level for chunk_*.npz (6.2x faster than default 6, +4% size; readable by np.load)
METAL_BATCH = 8     # pairs dispatched per Metal command buffer (~12 LK calls + pyramid downsamples per GPU sync)


def tracker_name() -> str:
    """name of the active LK backend recorded in extract.json"""
    return "metal" if _metal.available(vm.LK_PARAMS) else "opencv"


def params(k: int | None = None) -> dict:
    """everything that shapes the stored data (extract.json `params`, part of the key)"""
    return dict(cell=CELL, npts=NPTS, min_d=MIN_D, thr=dict(THR), eig_block=EIG_BLOCK, eig_ksize=EIG_KSIZE, q_xy=Q_XY, q_flow=Q_FLOW, q_fb=Q_FB,
                q_strength=Q_STRENGTH, eig0=EIG0, fb_max=FB_MAX, raw_every=RAW_EVERY, raw_low_min=RAW_LOW_MIN, des_y_min=DES_Y_MIN, rot_y_max=ROT_Y_MAX,
                k_s=C.FAR["k_s"], k=k, destatic_tau=vm.DESTATIC_TAU, destatic_gain=vm.DESTATIC_GAIN,
                lk=dict(win=list(vm.LK_PARAMS["winSize"]), levels=vm.LK_PARAMS["maxLevel"]), tracker=tracker_name())


def eig_map(frame: np.ndarray) -> np.ndarray:
    return cv2.cornerMinEigenVal(frame, EIG_BLOCK, EIG_KSIZE)


def _eig_slice(frame: np.ndarray, y0: int, y1: int) -> tuple[np.ndarray, int]:
    """cornerMinEigenVal over rows [y0, y1) with enough margin that every row in [y0, y1) is bit-identical to full-frame eig_map; -> (sub_eig, top_offset)"""
    H = frame.shape[0]
    pad = EIG_BLOCK + EIG_KSIZE
    a = max(0, y0 - pad)
    b = min(H, y1 + pad)
    return eig_map(frame[a:b, :]), a


def strength_code(v: np.ndarray) -> np.ndarray:
    return np.clip(np.round(Q_STRENGTH * np.log2(np.maximum(v, EIG0) / EIG0)), 0, 255).astype(np.uint8)


def strength_value(q: np.ndarray) -> np.ndarray:
    return EIG0 * 2.0 ** (np.asarray(q, np.float64) / Q_STRENGTH)


def detect(eig: np.ndarray, thr: float, y0: int = 0, y1: int | None = None, eig_top: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """(points (n, 2) float32 x, y; strength codes (n,) uint8): per CELL cell in rows [y0, y1) (y0 aligned to CELL) the strongest local maximum of
    `eig` at or above `thr`, then the next strongest at least MIN_D px from it; cell by cell (row-major), the strongest first.
    `eig_top`: frame row index of eig[0] (0 when `eig` is a full-frame map)."""
    H_sub, W = eig.shape
    H = eig_top + H_sub
    y1 = H if y1 is None else min(H, int(y1))
    y0 = max(eig_top, int(y0))
    if y1 <= y0:
        return np.zeros((0, 2), np.float32), np.zeros(0, np.uint8)
    # 3x3 dilate needs 1 row of context above/below [y0, y1) when available so boundary maxima match full-frame cv2.dilate
    da = max(0, y0 - eig_top - 1)
    db = min(H_sub, y1 - eig_top + 1)
    sub = eig[da:db, :]
    dil = cv2.dilate(sub, None)
    off = (y0 - eig_top) - da
    rows = y1 - y0
    e_roi = sub[off:off + rows, :]
    d_roi = dil[off:off + rows, :]
    v = np.where((e_roi == d_roi) & (e_roi >= thr), e_roi, 0).astype(np.float32)
    gy, gx = -(-rows // CELL), -(-W // CELL)
    if rows == gy * CELL and W == gx * CELL:
        pad = v
    else:
        pad = np.zeros((gy * CELL, gx * CELL), np.float32)
        pad[:rows, :W] = v
    blocks = pad.reshape(gy, CELL, gx, CELL).transpose(0, 2, 1, 3).reshape(gy * gx, CELL * CELL)
    if NPTS == 1:
        # np.argmax returns the first index on ties -> bit-identical to lexsort((top, -tv))
        idx = np.argmax(blocks, axis=1)
        vals = blocks[np.arange(gy * gx), idx]
        active = np.flatnonzero(vals > 0)
        if len(active) == 0:
            return np.zeros((0, 2), np.float32), np.zeros(0, np.uint8)
        by, bx = np.divmod(active, gx)
        ty, tx = np.divmod(idx[active], CELL)
        xs = bx * CELL + tx
        ys = y0 + by * CELL + ty
        pts = np.column_stack([xs, ys]).astype(np.float32)
        return pts, strength_code(vals[active])
    active = np.flatnonzero(blocks.max(axis=1) > 0)
    if len(active) == 0:
        return np.zeros((0, 2), np.float32), np.zeros(0, np.uint8)
    ab = blocks[active]
    by, bx = np.divmod(active, gx)
    K = min(8, CELL * CELL - 1)
    top = np.argpartition(-ab, K, axis=1)[:, :K]
    tv = np.take_along_axis(ab, top, 1)
    o = np.lexsort((top, -tv), axis=1)                    # strongest first, ties by position: deterministic
    top, tv = np.take_along_axis(top, o, 1), np.take_along_axis(tv, o, 1)
    ty, tx = top // CELL, top % CELL
    pick = [np.zeros(len(active), np.int64)]              # every active cell has tv[:, 0] > 0
    if NPTS >= 2:
        sec = np.full(len(active), -1, np.int64)
        for j in range(K - 1, 0, -1):                     # the strongest candidate far enough from the best one
            ok = (tv[:, j] > 0) & (np.hypot(ty[:, j] - ty[:, 0], tx[:, j] - tx[:, 0]) >= MIN_D)
            sec = np.where(ok, j, sec)
        pick.append(sec)
    P = np.stack(pick, 1)                                 # (active_cells, NPTS) candidate index or -1
    cells, rank = np.nonzero(P >= 0)
    j = P[cells, rank]
    xs = bx[cells] * CELL + tx[cells, j]
    ys_local = by[cells] * CELL + ty[cells, j]
    ys = y0 + ys_local
    pts = np.column_stack([xs, ys]).astype(np.float32)
    return pts, strength_code(e_roi[ys_local, xs])


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

    def add_tracked(self, pts, q, flow, fb, ok):
        keep = ok & (np.round(fb * Q_FB) < FB_MAX * Q_FB)          # as stored: a quantised error of 1 px is not kept
        for c, arr in zip(COLS, (*quantise(pts[keep], flow[keep], fb[keep]), q[keep])):
            self.cols[c].append(arr)
        self.count.append(int(keep.sum()))
        return pts[keep]

    def add(self, pts, q, a, b):
        flow, fb, ok = track(a, b, pts)
        return self.add_tracked(pts, q, flow, fb, ok)

    def arrays(self, s):
        dt = dict(x=np.uint16, y=np.uint16, dx=np.int16, dy=np.int16, fb=np.uint8, q=np.uint8)
        out = {f"{s}_{c}": (np.concatenate(v) if v else np.zeros(0, dt[c])) for c, v in self.cols.items()}
        out[f"{s}_count"] = np.array(self.count, np.int32)
        return out


def _worker_init():
    """one OpenCV thread (the forked rotation workers of vmsx.interpret)"""
    cv2.setNumThreads(1)


def _extract_init(threads: int):
    """THREADS OpenCV threads in a spawned extraction worker"""
    cv2.setNumThreads(int(threads))


def _write_npz(dst: Path, data: dict) -> None:
    """write a standard .npz archive readable by np.load using fast zlib level ZIP_LEVEL (6x faster than np.savez_compressed)"""
    with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=ZIP_LEVEL) as zf:
        for k, arr in data.items():
            buf = io.BytesIO()
            np.save(buf, arr, allow_pickle=False)
            zf.writestr(f"{k}.npy", buf.getvalue())


def _range(job) -> dict:
    """the data of the pairs (j - 1, j), a < j <= b (b None: to the end), the windows ending in that range, and the hashes of the first / last
    WARM_FRAMES + 1 decoded frames (seam check as in vmsx.motion._par_chunk). When X['out_dir'] is set, the chunk archive is written inside the
    worker as chunk_<a>.npz.tmp so large arrays never cross the IPC pipe or sit in parent memory."""
    X, a, b = job
    info, H, hw, k, n_win = X["info"], X["height"], X["hwaccel"], X["k"], X["n_win"]
    des_y0 = (int(H * DES_Y_MIN) // CELL) * CELL
    rot_y1 = min(H, ((int(H * ROT_Y_MAX) + CELL - 1) // CELL) * CELL)
    s = max(0, a - vm.WARM_FRAMES)
    if s == 0:
        src = (f for _, f in frames(X["path"], H, hwaccel=hw))
    else:
        src = frames_from(X["path"], info, H, s, None if b is None else b - s + 1, hwaccel=hw)
    filt = vm.Destatic()
    st = {x: _Stream() for x in STREAMS}
    idx, diff, raw_idx, rot_w = [], [], [], []
    head, tail = [], deque(maxlen=vm.WARM_FRAMES + 1)
    prev = prev_f = prev_ef = key = None
    prev_ef_top = 0
    key_j = -1
    use_metal = _metal.available(vm.LK_PARAMS)
    sess = None
    batch = []

    def _flush_metal():
        if not batch:
            return
        gpu_pairs = []
        tags = []  # (item_idx, kind)
        for bi, it in enumerate(batch):
            jj, p_fr, c_fr, p_ff, c_ff, pd, qd, sraw, srot = it
            gpu_pairs.append((("des", jj - 1), p_ff, ("des", jj), c_ff, pd))
            tags.append((bi, "des"))
            if sraw is not None:
                gpu_pairs.append((("raw", jj - 1), p_fr, ("raw", jj), c_fr, sraw[0]))
                tags.append((bi, "raw"))
            if srot is not None:
                _, k_jj, k_fr, prt, _ = srot
                gpu_pairs.append((("raw", k_jj), k_fr, ("raw", jj), c_fr, prt))
                tags.append((bi, "rot"))
        res_list = sess.run_batch(gpu_pairs)
        res_des = [None] * len(batch)
        res_raw = [None] * len(batch)
        res_rot = [None] * len(batch)
        for (bi, kind), r in zip(tags, res_list):
            if kind == "des":
                res_des[bi] = r
            elif kind == "raw":
                res_raw[bi] = r
            else:
                res_rot[bi] = r
        # Pass 1: commit des stream and detect rare RAW_LOW_MIN fallback pairs
        fb_reqs = []
        for bi, it in enumerate(batch):
            jj, p_fr, c_fr, _, _, pd, qd, sraw, _ = it
            kept = st["des"].add_tracked(pd, qd, *res_des[bi])
            if sraw is None and int((kept[:, 1] >= H / 2).sum()) < RAW_LOW_MIN:
                pr, qr = detect(eig_map(p_fr), THR["raw"])
                fb_reqs.append((bi, jj, p_fr, c_fr, pr, qr))
        fb_by_bi = {}
        if fb_reqs:
            fb_res = sess.run_batch([(("raw", jj - 1), p_fr, ("raw", jj), c_fr, pr) for _, jj, p_fr, c_fr, pr, _ in fb_reqs])
            for (bi, _, _, _, pr, qr), r in zip(fb_reqs, fb_res):
                fb_by_bi[bi] = (pr, qr, r)
        # Pass 2: commit raw and rot streams in strictly increasing frame order
        for bi, it in enumerate(batch):
            jj, _, _, _, _, _, _, sraw, srot = it
            if sraw is not None:
                st["raw"].add_tracked(sraw[0], sraw[1], *res_raw[bi])
                raw_idx.append(jj)
            elif bi in fb_by_bi:
                pr, qr, r = fb_by_bi[bi]
                st["raw"].add_tracked(pr, qr, *r)
                raw_idx.append(jj)
            if srot is not None:
                w, _, _, prt, qrt = srot
                st["rot"].add_tracked(prt, qrt, *res_rot[bi])
                rot_w.append(w)
        batch.clear()

    j = s - 1
    try:
        for fr in src:
            j += 1
            if use_metal and sess is None:
                sess = _metal.MetalLKSession(fr.shape[1], fr.shape[0], vm.LK_PARAMS, n_slots=max(48, 4 * METAL_BATCH + 16))
            if len(head) <= vm.WARM_FRAMES:
                head.append(vm._sha(fr))
            tail.append(fr)
            ff = filt(fr)
            if prev is not None and j > a:
                idx.append(j)
                diff.append(float(np.mean(np.abs(fr[::4, ::4].astype(np.int16) - prev[::4, ::4].astype(np.int16)))))
                p, q = detect(prev_ef, THR["des"], y0=des_y0, y1=H, eig_top=prev_ef_top)
                if use_metal:
                    sraw = detect(eig_map(prev), THR["raw"]) if j % RAW_EVERY == 0 else None
                    w = j // k - 1
                    if j % k == 0 and key is not None and 0 <= w < n_win:
                        ke, ke_top = _eig_slice(key, 0, rot_y1)
                        prt, qrt = detect(ke, THR["raw"], y0=0, y1=rot_y1, eig_top=ke_top)
                        srot = (w, key_j, key, prt, qrt)
                    else:
                        srot = None
                    batch.append((j, prev, fr, prev_f, ff, p, q, sraw, srot))
                    if len(batch) >= METAL_BATCH:
                        _flush_metal()
                else:
                    kept = st["des"].add(p, q, prev_f, ff)
                    if j % RAW_EVERY == 0 or int((kept[:, 1] >= H / 2).sum()) < RAW_LOW_MIN:
                        p, q = detect(eig_map(prev), THR["raw"])
                        st["raw"].add(p, q, prev, fr)
                        raw_idx.append(j)
                    w = j // k - 1
                    if j % k == 0 and key is not None and 0 <= w < n_win:
                        ke, ke_top = _eig_slice(key, 0, rot_y1)
                        p, q = detect(ke, THR["raw"], y0=0, y1=rot_y1, eig_top=ke_top)
                        st["rot"].add(p, q, key, fr)
                        rot_w.append(w)
            if j % k == 0:
                key = fr
                key_j = j
            if j >= a and (b is None or j < b):
                prev_ef, prev_ef_top = _eig_slice(ff, des_y0, H)
            else:
                prev_ef = None
            prev, prev_f = fr, ff
            if b is not None and j >= b:
                break
        if use_metal:
            _flush_metal()
    finally:
        if sess is not None:
            sess.close()
        src.close()
    out = dict(idx=np.array(idx, np.int32), diff=np.array(diff, np.float32), raw_idx=np.array(raw_idx, np.int32), rot_w=np.array(rot_w, np.int32))
    for x in STREAMS:
        out.update(st[x].arrays(x))
    res = dict(a=a, b=b, last=j, pairs=len(idx), windows=len(rot_w), head=head, tail=[vm._sha(f) for f in tail])
    out_dir = X.get("out_dir")
    if out_dir is not None:
        tmp = f"chunk_{a:08d}.npz.tmp"
        _write_npz(Path(out_dir) / tmp, out)
        res["tmp"] = tmp
    else:
        res["data"] = out
    return res


def _write(d: Path, r: dict) -> str:
    name = f"chunk_{r['a']:08d}.npz"
    if "tmp" in r:
        os.replace(d / r["tmp"], d / name)
        return name
    _write_npz(d / name, r["data"])
    return name


def extract(path: str, out_dir, height: int = 360, workers: int = 4, chunk_s: float = CHUNK_S, hwaccel: bool = True, log=None, key=None, on_progress=None) -> dict:
    """extract the video into out_dir (extract.json + chunk_<first frame>.npz); returns the meta (`key`: the caller's key of video and settings, stored as is). workers 1 (or a video shorter than two chunks, or
    irregular stream timing, or a seam that does not match): one sequential pass, same data."""
    log = log or (lambda level, msg: None)
    d = Path(out_dir)
    d.mkdir(parents=True, exist_ok=True)
    for pat in ("chunk_*.npz", "chunk_*.npz.tmp"):
        for f in d.glob(pat):
            f.unlink()
    t0 = time.perf_counter()
    info = probe(path)
    width = round(info.width * height / info.height / 2) * 2
    k = max(2, int(round(C.FAR["k_s"] * info.fps)))
    if k > vm.WARM_FRAMES:
        raise ValueError(f"rotation window of {k} frames is longer than the chunk overlap of {vm.WARM_FRAMES}")
    n_win = int(info.duration * info.fps / k) - 1
    X = dict(path=path, info=info, height=height, hwaccel=hwaccel, k=k, n_win=n_win, out_dir=str(d))
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
        with mp.get_context("spawn").Pool(min(workers, len(jobs)), initializer=_extract_init, initargs=(THREADS,)) as pool:
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
                pairs += r["pairs"]; windows += r["windows"]
        else:
            for r in res:
                if "tmp" in r:
                    (d / r["tmp"]).unlink(missing_ok=True)
            log("warn", f"extract: parallel extraction not used ({why}); sequential extraction")
    fallback = why if workers > 1 else None
    if not chunks:
        if on_progress is not None:
            on_progress(0, 1, "extract")
        r = _range((X, 0, None))
        chunks.append([0, r["last"], _write(d, r)])
        pairs, windows = r["pairs"], r["windows"]
    pr = params(k)
    meta = dict(version=VERSION, key=key, params=pr, video=str(path), fps=float(info.fps), duration=float(info.duration), width=int(width), height=int(height), pairs=int(pairs), windows=int(windows),
                n_win=int(n_win), k=int(k), chunks=chunks, opencv=cv2.__version__, seconds=round(time.perf_counter() - t0, 2),
                parallel=dict(workers=int(workers), chunks=len(chunks), chunk_s=float(chunk_s), threads=THREADS, start="spawn", fallback=fallback))
    (d / "extract.json").write_text(json.dumps(meta, indent=1))
    return meta


def load(d, around: int | None = None, streams=None) -> dict:
    """all chunks of an extraction concatenated (counts stay aligned with idx / raw_idx / rot_w); `around` = a pair's frame j: only its chunk;
    `streams`: only the arrays of these streams (plus idx, diff, raw_idx, rot_w)"""
    d = Path(d)
    meta = json.loads((d / "extract.json").read_text())
    chunks = meta["chunks"]
    if around is not None:
        chunks = [c for c in chunks if c[0] < around <= c[1]] or chunks[:1]
    want = None if streams is None else lambda key: key.split("_")[0] not in STREAMS or key in ("raw_idx", "rot_w") or key.split("_")[0] in streams
    parts = []
    for _, _, name in chunks:
        with np.load(d / name) as f:
            parts.append({key: f[key] for key in f.files if want is None or want(key)})
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
