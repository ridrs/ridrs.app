# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reference tracks (real roads from GPX, no OSM) and the candidate library cut from them.

Preprocessing of a GPX track, identical for all tracks (parameters recorded in the results):
local equirectangular metres (`rsm.bench.gpx`), `dedup(DEDUP_M)` to drop stationary jitter, Gaussian
smoothing in arc length with sigma `SMOOTH_SIGMA_M` (`RelativeTrajectory.smooth`; shrinks a 10 m
radius curve by about 4 %), resampling every `STEP_M`. The result is "the road": truth is defined on its arc length.

The GPX data is third-party (the FR_* tracks are CC BY-NC-SA 4.0): nothing derived from it is written
to a committed file; only aggregated metrics are.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..core.matcher import Candidate
from ..core.trajectory import RelativeTrajectory
from .gpx import GPX_FILES, load_gpx_local

DEDUP_M = 1.0
SMOOTH_SIGMA_M = 3.0
STEP_M = 2.0
LIB_LENGTH_FACTOR = 1.5  # candidate length = factor * query length + margin
LIB_MARGIN_M = 100.0
LIB_STRIDE_FRAC = 0.5  # stride = frac * query length

_REPO_FIXTURES = Path(__file__).resolve().parents[4] / "incyclist" / "services" / "__tests__" / "data" / "rlv"
# Stand-in tracks (real GPX routes that live in this repository's test fixtures), used ONLY when the FR_* files
# are unavailable: harness validation, not the benchmark the brief asks for. role: dev | test.
STANDIN_FILES = {
    "drome_standin": _REPO_FIXTURES / "FR_Source_Drome_Part_1.gpx",
    "woerrstadt_standin": _REPO_FIXTURES / "Triathlon_Woerrstadt_Loop.gpx",
    "catalunya_standin": _REPO_FIXTURES / "ES_Catalunya_Spain.gpx",
}
ROLES = {"menglonnais": "dev", "rousset": "dev", "pennes": "test",
         "woerrstadt_standin": "dev", "drome_standin": "dev", "catalunya_standin": "test"}


@dataclass(frozen=True)
class Track:
    name: str
    role: str  # dev | test
    points: np.ndarray  # (N, 2) smoothed, STEP_M spacing
    s: np.ndarray  # cumulative arc length
    t: np.ndarray | None  # seconds since the first GPX point at each point, or None

    @property
    def length(self) -> float:
        return float(self.s[-1])

    def cut(self, a: float, b: float, step: float = STEP_M) -> np.ndarray:
        """Points of the track between arc lengths a and b (the end points exact), spacing about `step`."""
        a, b = max(a, 0.0), min(b, self.length)
        ss = np.append(np.arange(a, b, step), b)
        return np.column_stack([np.interp(ss, self.s, self.points[:, 0]), np.interp(ss, self.s, self.points[:, 1])])

    def arc_at_time(self, t: float) -> float:
        if self.t is None or np.isnan(self.t).any():
            raise ValueError(f"track {self.name} has no time channel")
        return float(np.interp(t, self.t, self.s))


def preprocess(name: str, role: str, g: np.ndarray) -> Track:
    """g: (t, x, y) as returned by `load_gpx_local`."""
    timed = not np.isnan(g[:, 0]).any() and bool(np.all(np.diff(g[:, 0]) >= 0))  # a time channel only if usable
    tr = RelativeTrajectory(g[:, 1:], t=g[:, 0] if timed else None).dedup(DEDUP_M).smooth(SMOOTH_SIGMA_M).resample_by_distance(STEP_M)
    return Track(name, role, np.asarray(tr.points), np.asarray(tr.cumulative_distance), None if tr.t is None else np.asarray(tr.t))


def available_tracks(standin: bool = False) -> list[Track]:
    files = STANDIN_FILES if standin else GPX_FILES
    missing = [f"{n}: {p}" for n, p in files.items() if not Path(p).exists()]
    if missing:
        raise FileNotFoundError("reference GPX files missing:\n  " + "\n  ".join(missing)
                                + ("" if standin else "\n(run with --standin to use the in-repository fixture tracks instead; that is NOT the brief's benchmark)"))
    return [preprocess(n, ROLES[n], load_gpx_local(p, require_time=False)) for n, p in files.items()]


def library_params(length_m: float) -> tuple[float, float]:
    """(candidate length, stride) for a nominal query length."""
    return LIB_LENGTH_FACTOR * length_m + LIB_MARGIN_M, LIB_STRIDE_FRAC * length_m


def build_library(tracks: list[Track], length_m: float) -> list[Candidate]:
    """Overlapping windows along every track: length 1.5 L + 100 m, stride L/2, plus a last window ending at the track end."""
    lc, stride = library_params(length_m)
    out = []
    for tr in tracks:
        if tr.length < lc:
            continue
        starts = np.append(np.arange(0.0, tr.length - lc, stride), tr.length - lc)
        for a in starts:
            out.append(Candidate(f"{tr.name}:{a:.0f}", tr.cut(a, a + lc), origin_id=tr.name, origin_offset_m=float(a)))
    return out


def overlap_with_truth(origin_id: str, start: float, end: float, truth: tuple[str, float, float]) -> float:
    """Overlap of a matched window with the truth interval (same track), as a fraction of the truth length."""
    tname, a, b = truth
    if origin_id != tname or b <= a:
        return 0.0
    return max(0.0, min(end, b) - max(start, a)) / (b - a)


CORRECT_OVERLAP = 0.5  # the definition of "correct" used for top-1/5/20: overlap >= 50 % of the true source interval
