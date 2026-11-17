# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shape distances between two polylines already in a common metric frame.

Every function takes two (N, 2) / (M, 2) arrays and returns a float >= 0. All of them except
`heading_signature_distance` need the curves to be **aligned first** (see `similarity`); that
one is invariant to rotation and translation by construction.

| function | unit | what it is | sensitive to | insensitive to |
|---|---|---|---|---|
| `frechet` | metres | discrete Frechet distance on the vertices (`shapely.frechet_distance`): the shortest leash for two walkers who may not go back | the single worst deviation (max statistic), vertex spacing (discrete), order and direction | timing differences along the path (only order matters) |
| `hausdorff` | metres | GEOS Hausdorff distance of the two line strings (`shapely.hausdorff_distance`, vertex-based, no densify) | the single worst deviation of either curve from the other | **order and direction**: a reversed or shuffled path scores 0 if the point sets coincide; weak shape discriminator |
| `rmse` | metres | root-mean-square distance of index-paired points after resampling both to `n` points equally spaced in arc length | all deviations, equally; correspondence errors from length differences | nothing about order beyond the pairing; **not** invariant to a start offset along the path |
| `heading_signature_distance` | radians | turning-angle signature: heading (unwrapped) of both curves resampled to `n` points equally spaced in arc length; the distance is the standard deviation of the heading difference, i.e. the RMS heading difference after removing the best constant rotation | the sequence of turns (number, sign, size), heading drift | **translation, rotation, scale** (arc length is normalised); positional offsets; absolute length |

Mirroring flips the sign of every turn, so `heading_signature_distance` of a mirrored curve is
large for a curvy path and (correctly) near zero for a straight one.
"""
from __future__ import annotations

import numpy as np
import shapely

from .geometry import as_points, headings, resample_arclength


def frechet(a, b) -> float:
    """Discrete Frechet distance (metres). No `densify`: it hung in Phase 0 (see PROPOSAL section 6)."""
    a, b = as_points(a, "a"), as_points(b, "b")
    return float(shapely.frechet_distance(shapely.linestrings(a), shapely.linestrings(b)))


def hausdorff(a, b) -> float:
    """Hausdorff distance between the two line strings (metres); ignores order. See the module table."""
    a, b = as_points(a, "a"), as_points(b, "b")
    return float(shapely.hausdorff_distance(shapely.linestrings(a), shapely.linestrings(b)))


def rmse(a, b, n: int | None = None) -> float:
    """RMS distance (metres) of index-paired points. With `n`, both curves are first resampled to
    `n` points equally spaced in arc length; without it they must have equal length."""
    a, b = as_points(a, "a"), as_points(b, "b")
    if n is not None:
        a, b = resample_arclength(a, n), resample_arclength(b, n)
    elif len(a) != len(b):
        raise ValueError(f"rmse without n needs equal lengths, got {len(a)} and {len(b)}")
    return float(np.sqrt(np.mean(np.sum((a - b) ** 2, axis=1))))


def heading_signature(p, n: int = 64) -> np.ndarray:
    """Unwrapped headings (radians) of the `n - 1` segments of `p` resampled to `n` points equally spaced in arc length."""
    return headings(resample_arclength(as_points(p), n))


def heading_signature_distance(a, b, n: int = 64) -> float:
    """Std of the heading difference of the arc-length-resampled curves (radians); see the module table."""
    d = heading_signature(a, n) - heading_signature(b, n)
    return float(np.std(d))
