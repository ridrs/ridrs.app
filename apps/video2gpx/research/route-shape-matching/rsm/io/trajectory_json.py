# SPDX-License-Identifier: AGPL-3.0-or-later
"""Read and write `trajectory.json` (schema 1). The reader is strict.

    {"schema": 1, "frame": {"x": "right", "y": "forward", "unit": "m", "georeferenced": false},
     "points": [{"x": 0.0, "y": 0.0, "t": 0.0, "z": 0.0, "u": 0.3}],
     "scale": {"known": false, "prior_min": 0.7, "prior_max": 1.4},
     "junctions": [], "direction_known": true, "provenance": {...}}

Point keys: x and y are required; t (seconds), z (metres) and u (position uncertainty, metres) are
optional but must be present on all points or none. Floats are written with repr (JSON), which
round-trips float64 exactly. Provenance may hold a "warnings" list of strings.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from ..core.trajectory import RelativeTrajectory, ScalePrior

SCHEMA_VERSION = 1
FRAME = {"x": "right", "y": "forward", "unit": "m", "georeferenced": False}
_TOP = {"schema", "frame", "points", "scale", "junctions", "direction_known", "provenance"}
_POINT_OPTIONAL = {"t": "t", "z": "z", "u": "uncertainty"}


class SchemaError(ValueError):
    pass


def to_dict(traj: RelativeTrajectory) -> dict[str, Any]:
    pts = []
    for i in range(len(traj)):
        p: dict[str, float] = {"x": float(traj.points[i, 0]), "y": float(traj.points[i, 1])}
        for key, attr in _POINT_OPTIONAL.items():
            a = getattr(traj, attr)
            if a is not None:
                p[key] = float(a[i])
        pts.append(p)
    return {
        "schema": SCHEMA_VERSION,
        "frame": dict(FRAME),
        "points": pts,
        "scale": {"known": traj.scale.known, "prior_min": traj.scale.min, "prior_max": traj.scale.max},
        "junctions": list(traj.junctions),
        "direction_known": traj.direction_known,
        "provenance": traj.metadata,
    }


def write(traj: RelativeTrajectory, path: str | Path) -> None:
    text = json.dumps(to_dict(traj), indent=1, allow_nan=False)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n")


def _need(d: dict, keys: set[str], where: str) -> None:
    missing = keys - d.keys()
    if missing:
        raise SchemaError(f"{where}: missing required field(s) {sorted(missing)}")
    extra = d.keys() - keys
    if extra:
        raise SchemaError(f"{where}: unknown field(s) {sorted(extra)}")


def from_dict(d: Any) -> RelativeTrajectory:
    if not isinstance(d, dict):
        raise SchemaError("top level must be an object")
    if "schema" not in d:
        raise SchemaError("missing required field 'schema'")
    if type(d["schema"]) is not int or d["schema"] != SCHEMA_VERSION:
        raise SchemaError(f"unsupported schema version {d['schema']!r}; this reader supports {SCHEMA_VERSION}")
    _need(d, _TOP, "top level")
    if d["frame"] != FRAME:
        raise SchemaError(f"frame must be {FRAME}, got {d['frame']!r}")
    sc = d["scale"]
    if not isinstance(sc, dict):
        raise SchemaError("scale must be an object")
    _need(sc, {"known", "prior_min", "prior_max"}, "scale")
    if not isinstance(d["points"], list) or not d["points"]:
        raise SchemaError("points must be a non-empty list")
    if not all(isinstance(p, dict) for p in d["points"]):
        raise SchemaError("every point must be an object")
    keys = set(d["points"][0])
    if not {"x", "y"} <= keys or not keys <= {"x", "y", *_POINT_OPTIONAL}:
        raise SchemaError(f"point keys must be x, y and optionally t, z, u; got {sorted(keys)}")
    for i, p in enumerate(d["points"]):
        if set(p) != keys:
            raise SchemaError(f"point {i} has keys {sorted(p)}, expected {sorted(keys)} like point 0")
        for k, v in p.items():
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise SchemaError(f"point {i} field {k!r} is not a number: {v!r}")
    if not isinstance(d["junctions"], list) or any(isinstance(j, bool) or not isinstance(j, (int, float)) for j in d["junctions"]):
        raise SchemaError("junctions must be a list of numbers")
    if not isinstance(d["provenance"], dict):
        raise SchemaError("provenance must be an object")
    for name in ("prior_min", "prior_max"):
        if isinstance(sc[name], bool) or not isinstance(sc[name], (int, float)):
            raise SchemaError(f"scale.{name} must be a number")
    arr = lambda k: np.array([p[k] for p in d["points"]], dtype=np.float64)
    try:
        return RelativeTrajectory(
            points=np.column_stack([arr("x"), arr("y")]),
            **{attr: arr(k) for k, attr in _POINT_OPTIONAL.items() if k in keys},
            scale=ScalePrior(sc["known"], sc["prior_min"], sc["prior_max"]),
            direction_known=d["direction_known"],
            junctions=tuple(d["junctions"]),
            metadata=d["provenance"],
        )
    except ValueError as e:
        raise SchemaError(f"invalid trajectory: {e}") from e


def read(path: str | Path) -> RelativeTrajectory:
    def no_const(c):
        raise SchemaError(f"non-finite number {c} in JSON")

    try:
        d = json.loads(Path(path).read_text(), parse_constant=no_const)
    except json.JSONDecodeError as e:
        raise SchemaError(f"not valid JSON: {e}") from e
    return from_dict(d)
