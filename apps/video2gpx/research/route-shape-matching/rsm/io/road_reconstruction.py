# SPDX-License-Identifier: AGPL-3.0-or-later
"""Adapter: a `road-reconstruction` route folder -> RelativeTrajectory.

Reads JSON only (no import of the road-reconstruction backend). Route frame there: metres, Y up,
-Z initial heading, X right. Projection: (x, y) = (X, -Z), z = Y.

Sources:
- "cameras": `metadata/cameras.json` (written by `alignment` together with `alignment.json`), else
  `route.json` (written by `export`), `cameras[].position`, with the video time of each camera. This is the riding line.
- "road-center": `road-mesh/road.json` `stations.center` (every 0.5 m), the road centre, without time.

`metadata/alignment.json` says how scale and gravity were obtained. GPX-derived scale
(`scale_source == "gpx"`) or gravity (`up.method` mentioning GPX) is reported in
`provenance.scale_source`, `provenance.up_method` and `provenance.warnings`, never hidden.
Such a trajectory is not valid evaluation input for the matcher.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ..core.trajectory import RelativeTrajectory, ScalePrior

SOURCES = ("cameras", "road-center")


def _load(path: Path):
    return json.loads(path.read_text())


def _check_fresh(root: Path, producer: str, rel: str) -> None:
    pipe = root / "metadata" / "pipeline.json"
    if not pipe.exists():
        raise ValueError(f"{root}: metadata/pipeline.json missing, cannot tell whether {rel} matches alignment.json")
    stages = _load(pipe).get("stages", {})
    for name in {producer, "alignment"}:
        if stages.get(name, {}).get("status") != "done":
            raise ValueError(f"{root}: stage {name!r} is not done in pipeline.json")
    if producer != "alignment":
        a = stages["alignment"]
        if stages[producer]["started"] < a["started"] + a["seconds"]:
            raise ValueError(f"{root}: {rel} is stale (stage {producer!r} ran before the last alignment finished); "
                             f"rerun {producer!r} or use the alignment output")


def load(route_dir: str | Path, source: str = "cameras", scale_min: float = 0.7, scale_max: float = 1.4) -> RelativeTrajectory:
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}, got {source!r}")
    root = Path(route_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"route folder not found: {root}")
    warnings: list[str] = []

    if source == "cameras":
        candidates = [(root / "metadata" / "cameras.json", "alignment"), (root / "route.json", "export")]
        src, producer = next(((c, st) for c, st in candidates if c.exists()), (None, None))
        if src is None:
            raise FileNotFoundError(f"neither metadata/cameras.json nor route.json in {root}")
        _check_fresh(root, producer, str(src.relative_to(root)))
        cams = _load(src)["cameras"]
        xyz = np.array([c["position"] for c in cams], dtype=np.float64)
        t = np.array([c["time"] for c in cams], dtype=np.float64)
    else:
        src = root / "road-mesh" / "road.json"
        if not src.exists():
            raise FileNotFoundError(f"{src} not found")
        _check_fresh(root, "road", "road-mesh/road.json")
        xyz = np.array(_load(src)["stations"]["center"], dtype=np.float64)
        t = None
        warnings.append("road-center source: road centre, not the riding line; no time channel")
    if xyz.ndim != 2 or xyz.shape[1] != 3:
        raise ValueError(f"{src}: positions must be (N, 3), got {xyz.shape}")

    up_method, scale_source, extra = "unknown", "unknown", {}
    align = root / "metadata" / "alignment.json"
    if align.exists():
        a = _load(align)
        up_method = a.get("up", {}).get("method", "unknown")
        scale_source = a.get("scale_source", "unknown")
        if "scale_agreement" in a:
            extra["scale_agreement"] = a["scale_agreement"]
        if "implied_camera_height_m" in a:
            extra["implied_camera_height_m"] = a["implied_camera_height_m"]
    else:
        warnings.append("metadata/alignment.json missing: scale_source and up_method unknown")
    if scale_source == "gpx":
        warnings.append("scale derived from the GPX track (scale_source=gpx): leaks ground truth, not valid evaluation input")
    if "gpx" in up_method.lower():
        warnings.append(f"gravity/up derived from the GPX elevation profile (up_method={up_method!r}): z and the Y drop are GPX-dependent")
    if scale_source == "unknown" or up_method == "unknown":
        warnings.append("scale_source or up_method is unknown: GPX leakage cannot be excluded")

    # alignment.py methods: "vertical lines" and "GPX elevation profile" observe gravity; the other two are fallbacks
    z_reliable = up_method in ("vertical lines", "GPX elevation profile")
    if up_method in ("trajectory plane", "camera up, levelled along the heading"):
        warnings.append(f"up_method is a fallback ({up_method!r}, gravity not observed): z/elevation is unreliable")
    gpx_free = "unknown" not in (up_method, scale_source) and scale_source != "gpx" and "gpx" not in up_method.lower()
    meta = {
        "source": "road-reconstruction",
        "source_kind": source,
        "route": root.name,
        "file": str(src.relative_to(root)),
        "up_method": up_method,
        "scale_source": scale_source,
        "gpx_free": gpx_free,
        "z_reliable": z_reliable,
        **extra,
        "warnings": warnings,
    }
    if t is not None:
        meta["t_unit"] = "s, video time"
    return RelativeTrajectory(
        points=np.column_stack([xyz[:, 0], -xyz[:, 2]]),
        z=xyz[:, 1],
        t=t,
        scale=ScalePrior(known=False, min=scale_min, max=scale_max),
        direction_known=True,
        metadata=meta,
    )
