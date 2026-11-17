# SPDX-License-Identifier: AGPL-3.0-or-later
"""Whole-video tracking of far features and the rotation fit per window (needs cv2: run with the vms venv).

    cd ../video-motion-speed && PYTHONPATH=<project root> .venv/bin/python -m rsm.farrot.track <video> [--procs 4] [--range t0 t1]

The video is cut into windows of k frames (k / fps about 0.27 s) that tile the time axis: window i runs from frame i*k to frame (i+1)*k. Only these frames are decoded
into the pipe (ffmpeg select), at 360 rows, grey. In each window corners in the band above the vms horizon row are tracked from the first to the last frame (pyramidal LK,
forward-backward checked) and rotation + expansion is fitted robustly at a fixed focal length f. Output: work/farrot/win_<video>_<tag>.npz.
"""
from __future__ import annotations

import argparse
import json
import resource
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from rsm.angle import farfeat, videos
from rsm.pipeline.common import hwaccel_enabled

from . import model

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "farrot"
FIELDS = ["A", "B", "C", "e", "sA", "sB", "sC", "corrAC", "sigma", "xspread"]
WHY = ["", "few corners", "few inliers", "narrow"]


def ffmpeg_frames(path: str, info: dict, height: int, first_frame: int, n_frames: int, k: int, threads: int = 2, hwaccel: bool = True):
    """grey frames first_frame, first_frame + k, ... (n_frames of them) at `height` rows. Accurate seek; frame j has time (first_frame + j k) / fps."""
    width = round(info["width"] * height / info["height"] / 2) * 2
    ss = max(0.0, (first_frame - 0.5) / info["fps"])
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    cmd += ["-hwaccel", "videotoolbox"] if (hwaccel and hwaccel_enabled()) else ["-threads", str(threads)]
    cmd += ["-ss", f"{ss:.4f}", "-i", path, "-an", "-vf", f"select='not(mod(n\\,{k}))',scale={width}:{height}:flags=area,format=gray", "-fps_mode", "passthrough",
            "-frames:v", str(n_frames), "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    size = width * height
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=size * 4) as proc:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(height, width)
        proc.stdout.close()
        proc.wait()


_G: dict = {}


def band_ends(horizon: float, H: int, p, step: float, n_bands: int) -> list[float]:
    """nested bands (rows from the top): the horizon row + p.band_off (at least 70 rows), then `step` rows (at 360) deeper each time, at most 0.62 H"""
    sc = H / 360
    r1 = max(horizon + p.band_off * sc, p.band_min_rows * sc)
    return [float(min(r1 + i * step * sc, 0.62 * H)) for i in range(n_bands)]


def _chunk(args):
    import cv2
    cv2.setNumThreads(1)
    w0, w1 = args
    G = _G
    info, k, H, f, p = G["info"], G["k"], G["H"], G["f"], G["p"]
    W = round(info["width"] * H / info["height"] / 2) * 2
    ends = band_ends(G["horizon"], H, p, G["band_step"], G["n_bands"])
    masks = []
    for e in ends:
        m = np.zeros((H, W), np.uint8)
        mx = int(0.02 * W)
        m[:int(e), mx:W - mx] = 255
        masks.append(m)
    NB = len(masks)
    rng = np.random.default_rng(1000 + w0)
    out = np.full((w1 - w0, NB, len(FIELDS) + 4), np.nan)   # fields + [ok, n_pts, n_inl, why]
    out[:, :, len(FIELDS):] = [0, 0, 0, 1]
    prev = None
    n_dec = 0
    for j, fr in enumerate(ffmpeg_frames(G["video"], info, H, w0 * k, w1 - w0 + 1, k, G["threads"], G["hw"])):
        n_dec += 1
        if prev is not None:
            i = j - 1
            for b, mask in enumerate(masks):
                tr = farfeat.track_pair(cv2, mask, prev, fr, p, H / 360)
                if tr is None:
                    continue
                q0, fl = tr
                x, y = q0[:, 0] - W / 2, q0[:, 1] - H / 2
                wf = model.fit_window(x, y, fl, f, scale=H / 360, rng=rng, min_inl=G["min_inl"], min_xspread=0.0)
                out[i, b, :len(FIELDS)] = [getattr(wf, a) for a in FIELDS]
                out[i, b, len(FIELDS):] = [wf.ok, wf.n_pts, wf.n_inl, WHY.index(wf.why) if wf.why in WHY else 2]
        prev = fr
    return w0, out, n_dec


def run_video(name: str, f: float | None = None, k_s: float = 0.267, procs: int = 4, hw: bool = True, rng_s=None, chunk_s: float = 120.0, tag: str = "base",
              horizon: float | None = None, min_inl: int = 30, band_step: float = 35.0, n_bands: int = 3, log=print) -> dict:
    v = videos.VIDEOS[name]
    info = farfeat.probe(str(v["video"]))
    if f is None:
        import pickle
        f = farfeat.pool_f(pickle.load(open(videos.WORK / f"a_{name}_final.pkl", "rb")))["f"]
    band_off = farfeat.Params.band_off
    if horizon is None:                      # as the pipeline: FOE horizon of vms with ROT_BAND_OFF_VMS, old vms jsons the free road-plane horizon - 5
        from rsm.pipeline import config as PC
        horizon, band_off = farfeat.band_horizon(json.loads(Path(str(v["csv"])[:-4] + ".json").read_text()), PC.ROT_BAND_OFF_VMS, band_off)
    k = max(2, int(round(k_s * info["fps"])))
    n_win = int(info["duration"] * info["fps"] / k) - 1
    a, b = (0, n_win) if rng_s is None else (int(rng_s[0] * info["fps"] / k), min(n_win, int(rng_s[1] * info["fps"] / k)))
    cw = max(10, int(round(chunk_s * info["fps"] / k)))
    chunks = [(s, min(s + cw, b)) for s in range(a, b, cw)]
    p = farfeat.Params(min_inl=min_inl, band_off=band_off)
    _G.update(video=str(v["video"]), info=info, k=k, H=360, f=float(f), p=p, horizon=horizon, threads=2, hw=hw, min_inl=min_inl, band_step=band_step, n_bands=n_bands)
    log(f"{name}: {info['width']}x{info['height']} {info['fps']:.3f} fps, k = {k} frames ({k / info['fps']:.3f} s), f = {f:.1f}, horizon {horizon:.0f}, windows {a}..{b}, {len(chunks)} chunks, {procs} procs")
    t0 = time.time(); r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    import multiprocessing as mp
    if procs > 1:
        with mp.get_context("fork").Pool(procs) as pool:
            res = list(pool.imap_unordered(_chunk, chunks, chunksize=1))
    else:
        res = [_chunk(c) for c in chunks]
    wall = time.time() - t0; r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = (r1.ru_utime + r1.ru_stime) - (r0.ru_utime + r0.ru_stime)
    res.sort(key=lambda x: x[0])
    arr = np.concatenate([x[1] for x in res])
    idx = np.arange(a, b)
    NF = len(FIELDS)
    video_s = (b - a) * k / info["fps"]
    ends = band_ends(horizon, 360, p, band_step, n_bands)
    meta = dict(video=name, band_ends=ends, f=float(f), k=k, fps=info["fps"], horizon=horizon, w_first=a, w_last=b, video_seconds=video_s, wall_s=wall, cpu_s=cpu, wall_per_video_min=wall / video_s * 60, cpu_per_video_min=cpu / video_s * 60,
                procs=procs, hw=hw, peak_rss_gb_parent=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**30, peak_rss_gb_child_max=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 2**30,
                decoded_frames=int(sum(x[2] for x in res)), n_windows=int(b - a), n_ok=int(np.nansum(arr[:, 0, NF])))
    WORK.mkdir(parents=True, exist_ok=True)
    np.savez(WORK / f"win_{name}_{tag}.npz", idx=idx, ta=idx * k / info["fps"], tb=(idx + 1) * k / info["fps"], fields=np.array(FIELDS), data=arr[:, :, :NF], ok=arr[:, :, NF].astype(bool),
             n_pts=arr[:, :, NF + 1], n_inl=arr[:, :, NF + 2], why=arr[:, :, NF + 3], meta=json.dumps(meta))
    log(f"{name}: {meta['n_ok']}/{meta['n_windows']} windows fitted in band 1 ({n_bands} nested bands, ends {[round(e) for e in ends]}); wall {wall:.0f} s = {meta['wall_per_video_min']:.1f} s per video minute, cpu {cpu:.0f} s = {meta['cpu_per_video_min']:.1f} s per video minute")
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--f", type=float, default=None)
    ap.add_argument("--k-s", type=float, default=0.267)
    ap.add_argument("--procs", type=int, default=4)
    ap.add_argument("--no-hwaccel", action="store_true")
    ap.add_argument("--range", type=float, nargs=2, default=None)
    ap.add_argument("--chunk-s", type=float, default=120.0)
    ap.add_argument("--tag", default="base")
    ap.add_argument("--min-inl", type=int, default=30)
    ap.add_argument("--band-step", type=float, default=35.0)
    ap.add_argument("--n-bands", type=int, default=3)
    a = ap.parse_args(argv)
    assert a.procs <= 4, "at most 4 workers"
    run_video(a.video, a.f, a.k_s, a.procs, not a.no_hwaccel, a.range, a.chunk_s, a.tag, min_inl=a.min_inl, band_step=a.band_step, n_bands=a.n_bands)


if __name__ == "__main__":
    sys.exit(main())
