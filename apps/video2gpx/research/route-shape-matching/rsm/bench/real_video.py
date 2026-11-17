# SPDX-License-Identifier: AGPL-3.0-or-later
"""The only real video-derived queries of Phase 2: the two GPX-free reconstructions against the library of all tracks.

Truth = the arc-length interval of the GPX track between the video's first and last time (GPX time since its
first point == video time). The GPX enters only here, as truth and as part of the library, never as matcher input
for the query. The error model was calibrated on these same two pairs, so this is circular for the error
model (the perturbation parameters were measured on exactly these trajectories) and is a consistency check,
not an independent test.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ..core.matcher import MatchOptions, StatusThresholds, match
from ..io import road_reconstruction
from . import dtw as dtwmod
from . import tracks as T

ROUTES = Path(__file__).resolve().parents[3] / "road-reconstruction" / "routes"
PAIRS = {"pennes-9140-nogpx": "pennes", "menglonnais-240-nogpx": "menglonnais"}


def run(tracks: list[T.Track], keys: tuple[str, ...], thresholds: dict[str, StatusThresholds], chosen: str,
        routes_dir: Path = ROUTES) -> dict:
    """For each GPX-free route: if its reference track is in `tracks` (with a time channel) a normal query with truth;
    if the track is NOT in the set, a negative control (real video noise against unrelated roads: no truth exists,
    any confident answer is wrong)."""
    by_name = {t.name: t for t in tracks}
    out = {"circular": "error model calibrated on these same two pairs", "queries": [], "not_run": []}
    for route, tname in PAIRS.items():
        tr = by_name.get(tname)
        if tr is not None and tr.t is None:
            out["not_run"].append(f"{route}: track {tname!r} has no usable time channel")
            continue
        try:
            traj = road_reconstruction.load(routes_dir / route)
        except (FileNotFoundError, ValueError) as e:
            out["not_run"].append(f"{route}: {e}")
            continue
        truth = None
        if tr is not None:
            truth = (tname, tr.arc_at_time(float(traj.t[0])), tr.arc_at_time(float(traj.t[-1])))
        lib = T.build_library(tracks, traj.length)
        res = match(traj, lib, MatchOptions(rank_by=chosen, thresholds=thresholds[chosen], extra_metrics=dtwmod.extra_metrics()))
        entry = {"route": route, "mode": "truth" if truth else "negative_control", "query_length_m": traj.length,
                 "truth": None if truth is None else {"track": tname, "start_m": truth[1], "end_m": truth[2], "length_m": truth[2] - truth[1]},
                 "library_size": len(lib), "per_key": {}}
        for key in keys:
            r = res if key == chosen else res.rerank(key, thresholds[key])
            d = r.distinct
            ok = [truth is not None and T.overlap_with_truth(m.origin_id, m.origin_start_m, m.origin_end_m, truth) >= T.CORRECT_OVERLAP for m in d]
            rank = next((i + 1 for i, c in enumerate(ok) if c), None)
            a = r.ambiguity
            entry["per_key"][key] = {
                "truth_rank": rank, "n_distinct": len(d), "best_score": a.best_score, "second_score": a.second_score, "gap_ratio": a.gap_ratio,
                "status": a.status, "truth_score": None if rank is None else d[rank - 1].score,
                "best_scale": d[0].scale, "best_scale_clamped": d[0].scale_clamped,
                "best_overlap_with_truth": None if truth is None else T.overlap_with_truth(d[0].origin_id, d[0].origin_start_m, d[0].origin_end_m, truth),
                "best_where": [d[0].origin_id, d[0].origin_start_m, d[0].origin_end_m],
                "truth_scale": None if rank is None else d[rank - 1].scale}
        out["queries"].append(entry)
    return out
