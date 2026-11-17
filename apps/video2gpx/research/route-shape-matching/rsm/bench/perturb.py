# SPDX-License-Identifier: AGPL-3.0-or-later
"""Synthetic query generation: a cut of a reference track, perturbed like a video-derived trajectory.

The perturbations follow the error model (`ErrorModel`, measured by `rsm.bench.calibrate` or, when
no measurement exists, explicit ASSUMED values that are flagged as such everywhere they are used).

Order of operations on a cut of true length `ell` (true metres):
1. heading drift: the segment directions are rotated by a smooth random field. The field is a
   random walk in arc length (std `drift_deg_per_100m` per sqrt(100 m)) smoothed with a Gaussian
   (sigma `DRIFT_SMOOTH_M`), so segment lengths are preserved and the error grows with the path;
2. smooth lateral noise: a Gaussian-filtered white noise along the left normal, normalised to
   exactly `lateral_rms_m` (sample RMS), correlation length `lateral_corr_len_m`;
3. scale: the path is divided by the true scale `s` (the trajectory is `1/s` times too long
   when s < 1; s is in the matcher's prior), so trajectory length = ell / s;
4. mirror (optional), random rotation, random translation;
5. resampling at an irregular spacing (mean spacing drawn per query, per-step factor U(0.3, 1.7)).

`level` multiplies drift and lateral noise (1 = calibrated, 2 = the harder level). All random
numbers come from one `numpy.random.Generator` seeded by the caller, and the base random fields do
not depend on `level`, so level 1 and level 2 queries of the same seed differ only in amplitude.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

from ..core.trajectory import RelativeTrajectory, ScalePrior

DRIFT_SMOOTH_M = 20.0
GRID_M = 1.0


@dataclass(frozen=True)
class ErrorModel:
    scale_bias: float  # true metres per trajectory metre, centre of the draw (1 / 1.2 measured in Phase 1)
    scale_sigma: float  # log-normal sigma around scale_bias
    scale_clip: tuple[float, float]  # kept inside the matcher prior
    lateral_rms_m: float
    lateral_corr_len_m: float
    drift_deg_per_100m: float
    source: str  # "calibrated" | "assumed"
    notes: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        return {"scale_bias": self.scale_bias, "scale_sigma": self.scale_sigma, "scale_clip": list(self.scale_clip),
                "lateral_rms_m": self.lateral_rms_m, "lateral_corr_len_m": self.lateral_corr_len_m,
                "drift_deg_per_100m": self.drift_deg_per_100m, "source": self.source, "notes": list(self.notes)}


# Used only when work/error_model.json does not exist. NOT measured, except scale_bias, which is the Phase 1
# length ratio of GPX-free reconstruction to GPX (x1.207 and x1.197) inverted. Everything else is a guess in the
# range the proposal used (section 9: drift 2 to 5 %) and must be replaced by `python -m rsm calibrate`.
ASSUMED = ErrorModel(
    scale_bias=1 / 1.2, scale_sigma=0.08, scale_clip=(0.72, 1.35), lateral_rms_m=4.0, lateral_corr_len_m=40.0,
    drift_deg_per_100m=2.0, source="assumed",
    notes=("ASSUMED, not measured: lateral_rms_m, lateral_corr_len_m, drift_deg_per_100m, scale_sigma",
           "scale_bias from Phase 1 length ratios 1.207 / 1.197 (inverted)"))


def load_error_model(path: str | Path | None) -> ErrorModel:
    """The `recommended` block of `error_model.json` written by `rsm.bench.calibrate`; ASSUMED if the file is absent."""
    if path is None or not Path(path).exists():
        return ASSUMED
    r = json.loads(Path(path).read_text())["recommended"]
    return ErrorModel(r["scale_bias"], r["scale_sigma"], tuple(r["scale_clip"]), r["lateral_rms_m"],
                      r["lateral_corr_len_m"], r["drift_deg_per_100m"], "calibrated", tuple(r.get("notes", ())))


def _smooth_field(rng: np.random.Generator, n: int, sigma_samples: float) -> np.ndarray:
    return gaussian_filter1d(rng.standard_normal(n), sigma_samples, mode="nearest")


def make_query(path: np.ndarray, rng: np.random.Generator, model: ErrorModel, level: float = 1.0, mirror: bool = False,
               prior: ScalePrior = ScalePrior(), scale_true: float | None = None) -> tuple[RelativeTrajectory, dict]:
    """Perturb the true path `path` (N, 2), ordered, in true metres. Returns (trajectory, info).

    info: scale_true, rotation_rad, translation, mean_spacing_m, true_length_m, level. The random draws
    are made in a fixed order so that, for one seed, `level` and `mirror` do not change them.
    """
    path = np.asarray(path, dtype=np.float64)
    seg = np.diff(path, axis=0)
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*seg.T))])
    ell = float(s[-1])
    grid = np.arange(0.0, ell, GRID_M)
    grid = np.append(grid, ell)
    pts = np.column_stack([np.interp(grid, s, path[:, 0]), np.interp(grid, s, path[:, 1])])
    d = np.diff(pts, axis=0)
    n = len(d)

    # all random draws first, in a fixed order
    walk = rng.standard_normal(n)
    lat_field = _smooth_field(rng, len(pts), model.lateral_corr_len_m / GRID_M / 2.0)  # sigma = corr_len/2 (Gaussian-filtered noise)
    z_scale = rng.standard_normal()
    theta = rng.uniform(0, 2 * math.pi)
    shift = rng.uniform(-1000.0, 1000.0, 2)
    mean_spacing = float(np.exp(rng.uniform(np.log(0.8), np.log(3.0))))
    jitter = rng.uniform(0.3, 1.7, int(ell / (0.3 * mean_spacing)) + 10)

    # 1. heading drift
    inc = walk * math.radians(model.drift_deg_per_100m) * math.sqrt(GRID_M / 100.0) * level
    dh = gaussian_filter1d(np.cumsum(inc), DRIFT_SMOOTH_M / GRID_M, mode="nearest")
    c, sn = np.cos(dh), np.sin(dh)
    d2 = np.column_stack([d[:, 0] * c - d[:, 1] * sn, d[:, 0] * sn + d[:, 1] * c])
    p = np.vstack([pts[0], pts[0] + np.cumsum(d2, axis=0)])

    # 2. smooth lateral noise (sample RMS exactly lateral_rms_m * level)
    lat = lat_field - lat_field.mean()
    rms = float(np.sqrt(np.mean(lat ** 2)))
    lat = lat / rms * model.lateral_rms_m * level if rms > 0 else lat
    tang = np.gradient(p, axis=0)
    tang /= np.maximum(np.hypot(*tang.T), 1e-12)[:, None]
    p = p + lat[:, None] * np.column_stack([-tang[:, 1], tang[:, 0]])

    # 3. scale
    if scale_true is None:
        scale_true = float(np.clip(model.scale_bias * math.exp(model.scale_sigma * z_scale), *model.scale_clip))
    scale_true = float(np.clip(scale_true, prior.min, prior.max))
    p = p / scale_true

    # 4. mirror, rotate, translate
    if mirror:
        p = p * np.array([-1.0, 1.0])
    cr, sr = math.cos(theta), math.sin(theta)
    p = p @ np.array([[cr, -sr], [sr, cr]]).T + shift

    # 5. irregular resampling
    sp = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
    steps = mean_spacing * jitter
    pos = np.concatenate([[0.0], np.cumsum(steps)])
    pos = pos[pos < sp[-1] - 1e-9]
    pos = np.append(pos, sp[-1])
    q = np.column_stack([np.interp(pos, sp, p[:, 0]), np.interp(pos, sp, p[:, 1])])
    traj = RelativeTrajectory(q, scale=prior)
    info = {"scale_true": scale_true, "rotation_rad": theta, "translation": shift.tolist(), "mean_spacing_m": mean_spacing,
            "true_length_m": ell, "level": level, "mirror": mirror}
    return traj, info
