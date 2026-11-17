# SPDX-License-Identifier: AGPL-3.0-or-later
"""Grey frames from a video through the system ffmpeg: nothing is written to disk."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Iterator

from ..common import ffmpeg_bin, ffprobe_bin, hwaccel_enabled

import numpy as np


@dataclass(frozen=True)
class VideoInfo:
    codec: str
    width: int
    height: int
    fps: float
    duration: float


def probe(path: str) -> VideoInfo:
    out = subprocess.run(
        [
            ffprobe_bin(), '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,width,height,r_frame_rate,duration:format=duration',
            '-of', 'json', path,
        ],
        check=True, capture_output=True, text=True,
    ).stdout
    j = json.loads(out)
    stream = j['streams'][0]
    num, den = stream['r_frame_rate'].split('/')
    return VideoInfo(
        codec=stream['codec_name'],
        width=int(stream['width']),
        height=int(stream['height']),
        fps=float(num) / float(den),
        duration=float(stream.get('duration') or j['format']['duration']),   # mkv carries the duration in the container only
    )


def frames(
    path: str,
    height: int,
    start: float = 0.0,
    duration: float | None = None,
    step: int = 1,
    hwaccel: bool = True,
) -> Iterator[tuple[int, np.ndarray]]:
    """(source frame index from `start`, grey frame of `height` rows), every `step`-th frame."""
    info = probe(path)
    width = round(info.width * height / info.height / 2) * 2
    filters = ([f'framestep={step}'] if step > 1 else []) + [f'scale={width}:{height}:flags=area', 'format=gray']
    cmd = [ffmpeg_bin(), '-v', 'error', '-nostdin']
    if hwaccel and hwaccel_enabled():
        cmd += ['-hwaccel', 'videotoolbox']
    if start > 0:
        cmd += ['-ss', f'{start:.3f}']
    cmd += ['-i', path]
    if duration is not None:
        cmd += ['-t', f'{duration:.3f}']
    cmd += ['-an', '-vf', ','.join(filters), '-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    size = width * height
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=size * 8) as proc:
        assert proc.stdout is not None
        i = 0
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield i * step, np.frombuffer(buf, np.uint8).reshape(height, width)
            i += 1
        proc.stdout.close()
        proc.wait()


def frames_from(path: str, info: VideoInfo, height: int, first_frame: int, n_frames: int | None = None, threads: int = 2, hwaccel: bool = True) -> Iterator[np.ndarray]:
    """Every grey frame from source frame `first_frame` on: `n_frames` of them, or all to the end of the file.

    The seek (half a frame before the wanted one) and the scaling are those of the rotation chunks; the frames come as decoded (`-fps_mode passthrough`).
    """
    width = round(info.width * height / info.height / 2) * 2
    ss = max(0.0, (first_frame - 0.5) / info.fps)
    cmd = [ffmpeg_bin(), '-v', 'error', '-nostdin']
    cmd += ['-hwaccel', 'videotoolbox'] if (hwaccel and hwaccel_enabled()) else ['-threads', str(threads)]
    cmd += ['-ss', f'{ss:.4f}', '-i', path, '-an', '-vf', f'scale={width}:{height}:flags=area,format=gray', '-fps_mode', 'passthrough']
    if n_frames is not None:
        cmd += ['-frames:v', str(n_frames)]
    cmd += ['-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    size = width * height
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=size * 4) as proc:
        assert proc.stdout is not None
        try:
            while True:
                buf = proc.stdout.read(size)
                if len(buf) < size:
                    break
                yield np.frombuffer(buf, np.uint8).reshape(height, width)
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
            proc.wait()


def _rate(s: str) -> float:
    try:
        num, den = s.split('/')
        return float(num) / float(den) if float(den) else 0.0
    except (ValueError, AttributeError):
        return 0.0


def timing(path: str) -> dict:
    """Timestamps of the video stream, read without decoding: {packets, max_dev, start, r_fps, avg_fps, discard}.

    `max_dev` is the largest distance, in frames, of a packet's time from an even grid (i-th frame at i / fps after the start of the file), for the stream's
    r_frame_rate and its avg_frame_rate. It tells whether ffmpeg's constant-rate output (which `frames` uses) repeats or drops frames.
    """
    out = subprocess.run([ffprobe_bin(), '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time,r_frame_rate,avg_frame_rate:format=start_time', '-of', 'json', path],
                         check=True, capture_output=True, text=True).stdout
    j = json.loads(out)
    st = j['streams'][0]
    r_fps, avg_fps = _rate(st.get('r_frame_rate', '')), _rate(st.get('avg_frame_rate', ''))
    try:
        fmt_start = float(j.get('format', {}).get('start_time') or 0.0)
    except ValueError:
        fmt_start = 0.0
    out = subprocess.run([ffprobe_bin(), '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path],
                         check=True, capture_output=True, text=True).stdout
    pts, discard = [], 0
    for line in out.splitlines():
        a = line.split(',')
        if len(a) > 1 and 'D' in a[1]:
            discard += 1
        try:
            pts.append(float(a[0]))
        except ValueError:
            pts.append(np.nan)
    t = np.sort(np.array(pts, float))
    dev = np.inf
    if len(t) and np.isfinite(t).all() and r_fps > 0:
        i = np.arange(len(t))
        dev = max(float(np.abs((t - fmt_start) * f - i).max()) for f in ({r_fps, avg_fps} - {0.0}))
    return dict(packets=len(pts), max_dev=dev, start=float(t[0] - fmt_start) if len(t) and np.isfinite(t[0]) else None, r_fps=r_fps, avg_fps=avg_fps, discard=discard)
