# SPDX-License-Identifier: AGPL-3.0-or-later
"""Dump the camera poses of every COLMAP model of a road-reconstruction route to JSON (needs pycolmap).

Run with the road-reconstruction venv (read-only on the route folder; nothing is re-run there):

    ../road-reconstruction/.venv/bin/python -m rsm.bench.colmap_export ../road-reconstruction/routes/gotthard-600 \
        -o work/odometry/colmap/gotthard-600.models.json

Per model (folder camera-poses/sparse/<k>): image names, video frame, video time (frames.json start + frame / fps), camera
centre (COLMAP units), world-from-camera rotation, and the per-image distance to a road plane fitted to the sparse points
just ahead (same recipe as backend/alignment.py `road_plane_sfm`, copied, with the same `up` estimate: trajectory plane,
sign from the camera up). The scale of a model is camera_height / median(distance), exactly as the kept model's
`scale_source=camera_height` alignment; that is the only scale the non-kept models get (they were never aligned).
Poses of different models are never joined.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pycolmap


def estimate_up(centers, rots):
    cam_up = -rots[:, 1, :]
    u0 = cam_up.mean(0)
    u0 /= np.linalg.norm(u0)
    steps = np.diff(centers, axis=0)
    n = np.linalg.norm(steps, axis=1)
    dirs = steps[n > 1e-9] / n[n > 1e-9, None]
    _, sv, vt = np.linalg.svd(dirs, full_matrices=False)
    normal = vt[-1] * np.sign(vt[-1] @ u0)
    cond = float(sv[1] / sv[0])
    if cond > 0.15:
        return normal, "trajectory plane", cond
    fwd = dirs.mean(0)
    fwd /= np.linalg.norm(fwd)
    up = u0 - (u0 @ fwd) * fwd
    return up / np.linalg.norm(up), "camera up, levelled along the heading", cond


def road_plane_dist(rec, ims, centers, up):
    cam = rec.cameras[ims[0].camera_id]
    w, h = cam.width, cam.height
    dist = np.full(len(ims), np.nan)
    for i, (im, c) in enumerate(zip(ims, centers)):
        pts = [rec.point3D(p.point3D_id).xyz for p in im.points2D
               if p.has_point3D() and 0.25 * w < p.xy[0] < 0.75 * w and p.xy[1] > 0.7 * h]
        if len(pts) < 8:
            continue
        P = np.array(pts)
        for _ in range(2):
            m = P.mean(0)
            n = np.linalg.svd(P - m, full_matrices=False)[2][-1]
            r = np.abs((P - m) @ n)
            if len(P) > 12:
                P = P[r <= np.percentile(r, 67)]
        n *= np.sign(n @ up)
        if n @ up < math.cos(math.radians(25)):
            continue
        dist[i] = (c - m) @ n
    return dist


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("route")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--camera-height", type=float, default=1.1)
    args = ap.parse_args(argv)
    root = Path(args.route)
    frames = json.loads((root / "metadata" / "frames.json").read_text())
    tracking = json.loads((root / "metadata" / "camera_tracking.json").read_text())
    fps, start = frames["fps"], frames["start"]
    out = {"route": root.name, "kept_model": tracking["kept_model"], "camera": tracking["camera"], "colmap_frame": [frames["width"], frames["height"]],
           "fps": fps, "start": start, "models": {}}
    for mdir in sorted((root / "camera-poses" / "sparse").iterdir()):
        rec = pycolmap.Reconstruction(mdir)
        ims = sorted((rec.image(i) for i in rec.reg_image_ids()), key=lambda im: im.name)
        if len(ims) < 3:
            continue
        centers = np.array([im.projection_center() for im in ims])
        rots = np.array([im.cam_from_world().rotation.matrix() for im in ims])
        up, method, cond = estimate_up(centers, rots)
        dist = road_plane_dist(rec, ims, centers, up)
        ok = np.isfinite(dist)
        h_med = float(np.nanmedian(dist)) if ok.sum() > 10 else None
        cam = rec.cameras[ims[0].camera_id]
        out["models"][mdir.name] = {
            "n_images": len(ims), "camera_params": [float(p) for p in cam.params], "camera_model": str(cam.model),
            "names": [im.name for im in ims], "frame": [int(Path(im.name).stem) for im in ims],
            "time": [start + int(Path(im.name).stem) / fps for im in ims],
            "centers": centers.tolist(), "cam_from_world": rots.tolist(),
            "up": up.tolist(), "up_method": method, "conditioning": cond,
            "plane_dist": [None if not np.isfinite(d) else float(d) for d in dist],
            "height_median": h_med, "height_iqr_rel": None if h_med is None else float(np.subtract(*np.nanpercentile(dist, [75, 25])) / h_med),
            "scale_camera_height": None if h_med is None else args.camera_height / h_med,
        }
        print(f"{root.name} model {mdir.name}: {len(ims)} images, t {out['models'][mdir.name]['time'][0]:.1f}..{out['models'][mdir.name]['time'][-1]:.1f}, "
              f"scale {out['models'][mdir.name]['scale_camera_height']}, {method}")
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
