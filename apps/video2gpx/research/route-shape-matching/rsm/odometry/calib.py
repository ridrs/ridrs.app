# SPDX-License-Identifier: AGPL-3.0-or-later
"""Nominal focal lengths and the sign convention.

Focal length (px at the 360-row analysis resolution of vms) = COLMAP fx * 360 / COLMAP frame height. COLMAP's OPENCV
self-calibrations of the same camera differ (fx values of the reconstructions of that video: Gotthard 813.7 and 800.2 px at
1280x720, i.e. 406.9 and 400.1 at 360 rows; Cayolle 373.9, 374.8, 357.5 and 367.1 px at 640x360); the nominal value is the
median of the fx values, the spread is reported with it. `focal_prior` of the reconstructions is 0.55 * width (352 px at
360 rows) and is not used. fx, not fy: yaw flow is horizontal.

Sign: the camera yawing to the left (counter-clockwise seen from above) moves the scene to the right in the image, dx > 0, so
the fitted constant flow `a` (CSV column `yaw`) is positive for a left turn, and the left-positive heading change per frame
pair is omega = +yaw / f. This is checked against COLMAP camera rotations and against frames (RESULTS.md); `YAW_SIGN`
is the one place that holds the verified sign.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

YAW_SIGN = +1.0  # heading change (left positive) = YAW_SIGN * yaw / f360; verified against COLMAP, see RESULTS.md
CAMERA_HEIGHT_M = 1.1  # the COLMAP alignment's camera_height assumption (scale_source=camera_height)


@dataclass(frozen=True)
class Nominal:
    f360: float  # nominal focal length, px at 360 rows
    f_low: float  # lowest fx among the self-calibrations of that video
    f_high: float  # highest fx
    note: str


NOMINAL: dict[str, Nominal] = {
    "gotthard": Nominal(403.478, 400.093, 406.863, "median of fx 406.863 (gotthard-450) and 400.093 (gotthard-600), COLMAP 1280x720 x 0.5"),
    "cayolle": Nominal(370.513, 357.470, 374.761, "median of fx 373.933 (1630), 374.761 (2850), 357.469 (4000), 367.092 (4000-dense), COLMAP 640x360"),
}


@dataclass(frozen=True)
class Calibration:
    """Learned constants from GPS-referenced calibration (work/vangestel/calibration.json; DEV values, spreads are in the file's `spread`).
    Default-constructed values reproduce the uncalibrated behaviour except f360 (required)."""
    f360: float  # angle: heading = yaw / f360 (the effective focal length, includes the X^2 weighting of the road area, px at 360 rows)
    dist_scale: float = 1.0  # multiplies k = f360 * height (nominal -> true metres)
    horizon_offset_px: float = 0.0  # `vms motion --horizon-offset` the CSV must have been produced with (recorded; not applied here)
    c_delta_px: float = 0.0  # alternative: post-hoc first-order horizon correction yaw += c * delta (CSV column c), for CSVs made without the offset
    turn: dict = field(default_factory=dict)  # TurnParams overrides for the vms detector
    gate: dict = field(default_factory=dict)  # GateParams overrides
    meta: dict = field(default_factory=dict)


def load_calibration(path: str | Path) -> Calibration:
    d = json.loads(Path(path).read_text())
    c = d.get("constants", d)

    def val(k, default=None):
        v = c.get(k, default)
        return v["value"] if isinstance(v, dict) and "value" in v else v

    from dataclasses import fields

    from .gating import GateParams
    from .turns import TurnParams

    def pick(d, cls):  # only real parameters (notes and other documentation keys are ignored)
        names = {f.name for f in fields(cls)}
        return {k: (v["value"] if isinstance(v, dict) and "value" in v else v) for k, v in (d or {}).items() if k in names}

    turn = val("turn", {}) or {}
    gate = val("gate", {}) or {}
    return Calibration(f360=float(val("f360")), dist_scale=float(val("dist_scale", 1.0)), horizon_offset_px=float(val("horizon_offset_px", 0.0)),
                       c_delta_px=float(val("c_delta_px", 0.0)), turn=pick(turn, TurnParams),
                       gate=pick(gate, GateParams), meta=d.get("meta", {}))
