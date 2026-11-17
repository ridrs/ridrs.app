# SPDX-License-Identifier: AGPL-3.0-or-later
"""COLMAP camera-pose windows for the odometry comparison (numpy only; the poses come from `rsm.bench.colmap_export` JSON
and, for the kept model of a route, from metadata/cameras.json). Poses of different models are never joined.

A `Window` holds one model: keyframe times (video s), positions in the rsm frame (x right, y forward, metres; for the
kept model the route frame (x, y) = (X, -Z); for the other models the best-fit plane of the camera centres with the plane
normal signed so that the camera up points up, and the scale of the model's own camera-height estimate), the heading of the
optical axis about the up axis (`psi_rot`, unwrapped, relative to the first keyframe, left positive) and the heading of the
smoothed path tangent (`psi_tan`).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d


@dataclass(frozen=True)
class Window:
    name: str
    route: str
    model: str
    kept: bool
    source: str
    t: np.ndarray
    xy: np.ndarray
    psi_rot: np.ndarray
    psi_tan: np.ndarray
    s: np.ndarray  # cumulative path length along the keyframe polyline, metres
    scale: float | None
    n_images: int
    colmap_fx360: float  # fx of that reconstruction at 360 rows
    colmap_fy360: float
    frame_height: int

    @property
    def length(self) -> float:
        return float(self.s[-1])


def _quat_to_matrix(q) -> np.ndarray:
    x, y, z, w = q
    n = x * x + y * y + z * z + w * w
    x, y, z, w = (c / np.sqrt(n) for c in (x, y, z, w))
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def tangent_heading(xy: np.ndarray, s: np.ndarray, sigma_m: float = 5.0, step: float = 1.0) -> np.ndarray:
    """Heading of the path tangent at the keyframes: the path resampled by arc length, Gaussian-smoothed (sigma_m), unwrapped."""
    su, iu = np.unique(s, return_index=True)
    sg = np.arange(su[0], su[-1], step)
    if len(sg) < 5:
        return np.zeros(len(s))
    x, y = np.interp(sg, su, xy[iu, 0]), np.interp(sg, su, xy[iu, 1])
    x, y = gaussian_filter1d(x, sigma_m / step, mode="nearest"), gaussian_filter1d(y, sigma_m / step, mode="nearest")
    h = np.unwrap(np.arctan2(np.gradient(y), np.gradient(x)))
    h = np.interp(s, sg, h)
    return h - h[0]


def _finish(name, route, model, kept, source, t, xy, fwd2, scale, n, fx360, fy360, frame_h) -> Window:
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
    psi = np.unwrap(np.arctan2(fwd2[:, 1], fwd2[:, 0]))
    return Window(name, route, model, kept, source, t, xy, psi - psi[0], tangent_heading(xy, s), s, scale, n, fx360, fy360, frame_h)


def load_route(route_dir: str | Path, models_json: str | Path, min_images: int = 60) -> list[Window]:
    route_dir, models_json = Path(route_dir), Path(models_json)
    m = json.loads(models_json.read_text())
    frame_h = m["colmap_frame"][1]
    fx360, fy360 = (m["camera"]["params"][i] * 360 / frame_h for i in (0, 1))
    out = []
    kept = str(m["kept_model"])
    cams = json.loads((route_dir / "metadata" / "cameras.json").read_text())["cameras"]
    t = np.array([c["time"] for c in cams])
    pos = np.array([c["position"] for c in cams])
    fwd = np.array([_quat_to_matrix(c["quaternion"]) @ np.array([0.0, 0.0, -1.0]) for c in cams])
    out.append(_finish(f"{route_dir.name}", route_dir.name, kept, True, "metadata/cameras.json", t, np.column_stack([pos[:, 0], -pos[:, 2]]),
                       np.column_stack([fwd[:, 0], -fwd[:, 2]]), None, len(cams), fx360, fy360, frame_h))
    for k, md in m["models"].items():
        if k == kept or md["n_images"] < min_images or md["scale_camera_height"] is None:
            continue
        c = np.array(md["centers"])
        rot = np.array(md["cam_from_world"])
        up = np.array(md["up"])
        head_n = max(2, min(len(c) - 1, int(len(c) * 0.05)))
        e1 = c[head_n] - c[0]
        e1 -= (e1 @ up) * up
        e1 /= np.linalg.norm(e1)
        right = np.cross(e1, up)
        sc = md["scale_camera_height"]
        xy = sc * np.column_stack([(c - c[0]) @ right, (c - c[0]) @ e1])
        f = np.einsum("nji,j->ni", rot, np.array([0.0, 0.0, 1.0]))  # R_cw^T (0,0,1): optical axis in the world
        f2 = np.column_stack([f @ right, f @ e1])
        out.append(_finish(f"{route_dir.name}/m{k}", route_dir.name, k, False, "pycolmap sparse model (own plane, own camera-height scale)",
                           np.array(md["time"]), xy, f2, sc, md["n_images"], fx360, fy360, frame_h))
    return out
