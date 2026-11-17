<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

> **Location (since 2026-11-12):** this package lives in `apps/video2gpx/research/route-shape-matching` (moved from a separate experiments folder). Older absolute paths in FINDINGS.md refer to the old location. `../road-reconstruction` and `../video-motion-speed` are links to `Ridrs/experiments/`. Project docs: `../../docs/`.

# Experiment: route shape matching

Hypothesis: a relative 2D trajectory from a cycling video holds enough shape information to identify its OpenStreetMap road sequence without GPS. The plan, evidence and decisions are in [`PROPOSAL.md`](PROPOSAL.md); measurements are in [`FINDINGS.md`](FINDINGS.md).

Status: **Phase 2 code complete, Phase 2 real-data evidence missing** (see FINDINGS): trajectory model and I/O (Phase 1), the local geometry matcher, the metrics, the error-model calibration and the benchmark (Phase 2). The three `FR_*` GPX tracks vanished from `~/Downloads` during the Phase 2 session, so the calibration and the real-road benchmark have not run; the benchmark ran on stand-in tracks only. No OSM, no GPX export yet.

This folder does not change anything in `ridrs_app/` or in `experiments/road-reconstruction/`.

## Setup

```bash
cd experiments/route-shape-matching
python3.14 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt     # requirements.txt: the library (rsm.core); requirements-bench.txt adds gpxpy and dtaidistance for rsm.bench; -dev adds pytest and scikit-image (test oracle)
```

## Commands

```bash
# Phase 1
# trajectory.json from a road-reconstruction route folder (joins cameras[].position and the video time)
.venv/bin/python -m rsm trajectory --from-reconstruction ../road-reconstruction/routes/pennes-9140-nogpx \
    -o work/pennes-9140-nogpx.trajectory.json            # --source cameras (default) | road-center; --scale-min/--scale-max (default 0.7/1.4)
.venv/bin/python -m rsm trajectory-info work/pennes-9140-nogpx.trajectory.json
```

```bash
# Phase 2 (needs requirements-bench.txt; GPX files read in place from ~/Downloads, never copied)
.venv/bin/python -m rsm calibrate -o work/error_model.json         # the two real video/GPX pairs -> error model (needed before the benchmark)
.venv/bin/python -m rsm bench -o work/bench                         # the benchmark on the three FR_* tracks, ~2 min on an M3 Pro (stand-in: 95 s)
.venv/bin/python -m rsm bench --standin -o work/bench-standin      # harness validation on in-repository fixture GPX; NOT the brief's benchmark
```

`bench` options: `--lengths 300 500 1000 2000`, `--n-main 20` (queries per track and length, each at two noise levels), `--n-mirror/--n-straight/--n-excluded/--n-dup/--n-prefilter`, `--seed 20261109`, `--workers 8`, `--error-model work/error_model.json` (if absent the ASSUMED model is used and every table says so), `--no-real-video`. It writes `bench_results.json` (all tables, tuning, thresholds), `bench_records.json` (one record per query: scores and ranks, no coordinates) and `bench_tables.md` to the output folder. The protocol (dev tuning, then frozen on the test split) is in the docstring of `rsm/bench/benchmark.py` and in FINDINGS. `work/` is git-ignored; only the metric tables go into FINDINGS.

`rsm.core` needs only numpy, scipy and shapely; `rsm.odometry` only numpy and scipy (a test checks both). DTW is an optional benchmark metric in `rsm/bench/dtw.py` (`dtaidistance`, from `requirements-bench.txt`): used if importable and its C code loads, otherwise skipped with a printed note and no DTW row. The macOS wheel links `/usr/local/lib/libomp.dylib`; with Homebrew on Apple silicon export `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/opt/libomp/lib` before running the benchmark if you want the DTW row (pure-Python DTW is ~700 times slower, so it is not used). Nothing re-executes the process.

```bash
# Odometry from video motion (heading and distance from the vms motion CSV; no GPS; derived files stay under work/)
.venv/bin/python -m rsm odometry work/odometry/vms/cayolle.csv --video-id cayolle --exclude-before 20 -o work/odometry/cayolle/
#   -> segments.json (gating, coverage, per-segment turn lists) + seg_NNN.trajectory.json (one per usable, cut-free, gap-free segment)
#   --focal F360 (px at 360 rows; default: nominal value of the video id, rsm/odometry/calib.py)  --max-gap 0.5  --min-segment 10  --height 1.1
# comparison with COLMAP, matcher test, tables (see work/odometry/RESULTS.md; needs the road-reconstruction routes, pycolmap only for the export):
../road-reconstruction/.venv/bin/python -m rsm.bench.colmap_export ../road-reconstruction/routes/<route> -o work/odometry/colmap/<route>.models.json
.venv/bin/python -m rsm.bench.odo_compare --routes ../road-reconstruction/routes --colmap work/odometry/colmap --vms work/odometry/vms -o work/odometry/compare
.venv/bin/python -m rsm.bench.odo_matcher --routes ../road-reconstruction/routes --colmap work/odometry/colmap --vms work/odometry/vms -o work/odometry/compare/matcher.json
```

`vms motion` (../video-motion-speed) writes the CSV the odometry reads; `rsm.odometry` does not import vms. Distances of the odometry are nominal metres (k = f360 x 1.1 m x s), the trajectories carry `scale.known=false`, prior 0.7 to 1.4.

Library use:

```python
from rsm.core.matcher import Candidate, MatchOptions, StatusThresholds, match
res = match(trajectory, [Candidate("road-1", pts_xy_metres), ...],
            MatchOptions(rank_by="rmse_rel", thresholds=StatusThresholds(gap_ratio=..., max_score=...)))
res.distinct[0].scores, res.distinct[0].scale, res.ambiguity.status        # components, implied scale, confident|ambiguous|no_match
```

`trajectory-info` prints length, points, spacing, total turn, provenance and warnings. Warnings are also printed to stderr by `trajectory`. Derived files in `work/` are git-ignored (the footage is CC BY-NC-SA 4.0).

## Tests

```bash
.venv/bin/python -m pytest -q                       # everything; real-data tests skip with a reason if the files are absent
.venv/bin/python -m pytest -q -m "not realdata"     # synthetic only, no files outside the repository
.venv/bin/python -m pytest -q -s -m realdata        # real data, with the measured numbers printed
```

Real-data tests need the GPX-free routes below and `~/Downloads/FR_*/*.gpx` (they skip with a reason when absent). The GPX is a test fixture and benchmark input; `rsm.core` never reads GPX (a test checks that it imports no GPX, OSM or pyproj module and only numpy, scipy and shapely).

## GPX-free routes

The existing `routes/pennes-9140` and `routes/menglonnais-240` used the GPX track for the metric scale (and, on Pennes, for gravity), so their `route.json` is not valid evaluation input. Rerun only the alignment stage on a copy, without the GPX (about 15 s each; needs the `road-reconstruction` venv):

```bash
cd experiments/road-reconstruction/routes
for p in pennes-9140 menglonnais-240; do
  mkdir -p $p-nogpx/camera-poses/undistorted
  cp -R $p/metadata $p-nogpx/
  cp -R $p/camera-poses/undistorted/sparse $p/camera-poses/undistorted/images $p-nogpx/camera-poses/undistorted/
done
cd ..
for p in pennes-9140 menglonnais-240; do
  .venv/bin/python -m backend reconstruct --route $p-nogpx --force alignment --only alignment \
      --set use_gpx=0 scale_source=camera_height
done
```

Only what alignment reads is copied (a full copy is 1 to 3 GB). Alignment writes `metadata/cameras.json` and `metadata/alignment.json` in the copy; the adapter reads `metadata/cameras.json`, else `route.json`. `route.json` and `road.json` are not rewritten by an in-place alignment rerun, so the adapter checks `metadata/pipeline.json` (producing stage done and started after `alignment` finished) and **raises** if a file is stale or `pipeline.json` is missing. The stale absolute `video` path in `config.json` is only read when `use_gpx=1`, so it needs no fix. The other metadata files in the copy (road, dense, ...) are stale; do not use them.

## Conventions

- Frame: x right, y forward, metres, right-handed (as on a map). From the route frame (X right, Y up, -Z initial heading): `(x, y) = (X, -Z)`, `z = Y`.
- Heading: `atan2(dy, dx)`, radians, counter-clockwise from +x; travelling along +y is pi/2.
- **Turning angle: left turn positive**, right negative; unwrapped heading minus the start heading. Mirroring a trajectory flips the sign.
- `normalized()`: start to the origin, the direction to the point 5 m along the path (not the first segment) rotated to +y, optionally scaled to unit length; the returned `Transform` inverts it.
- Everything is immutable and pure; operations return new trajectories. Invalid input raises `ValueError`; nothing is silently fixed.
- `smooth(sigma_m)`: resample, Gaussian filter in arc length with odd reflection at the ends (straight lines stay exact, end points are pinned). On a circle of radius R the radius shrinks by about `exp(-sigma^2 / 2R^2)`: 0.5 % for sigma 4 m and R 40 m, 8.4 % for sigma 4 m and R 9.5 m (a 30 m hairpin; the length shrinks 6.8 %).
- `resample_by_distance(step)`: end points kept; the last interval is the remainder (the last regular sample is dropped if the remainder is under step/4).

## `trajectory.json` (schema 1)

```json
{"schema": 1,
 "frame": {"x": "right", "y": "forward", "unit": "m", "georeferenced": false},
 "points": [{"x": 0.0, "y": 0.0, "t": 9140.0, "z": 0.0, "u": 0.3}],
 "scale": {"known": false, "prior_min": 0.7, "prior_max": 1.4},
 "junctions": [],
 "direction_known": true,
 "provenance": {"source": "road-reconstruction", "route": "...", "up_method": "...", "scale_source": "...",
                "gpx_free": true, "warnings": []}}
```

`t` (seconds), `z` (metres) and `u` (position uncertainty, metres) are optional but present on all points or none. Floats round-trip exactly. The reader rejects unknown schema versions, missing or unknown fields, a wrong frame and non-finite numbers. `provenance.warnings` lists GPX-derived scale or gravity; `gpx_free: false` means the trajectory must not be used as evaluation input. `z_reliable: false` (with a warning) when gravity came from a fallback (`trajectory plane`, `camera up, levelled along the heading`), e.g. GPX-free Pennes.

## Layout

```
rsm/core/trajectory.py          RelativeTrajectory, ScalePrior, Transform (numpy, scipy only)
rsm/core/geometry.py            array-level resampling / headings helpers
rsm/core/similarity.py          Umeyama 2D similarity (no reflection, optional scale bounds), single and batched
rsm/core/metrics.py             Frechet, Hausdorff, RMSE, heading-signature distance (units and sensitivities in the docstring)
rsm/core/matcher.py             match(trajectory, candidates, options) -> MatchResult (ranking, components, ambiguity block)
rsm/bench/                      gpx.py, tracks.py (reference tracks, library), perturb.py (error model, queries), calibrate.py,
                                benchmark.py, real_video.py, report.py, dtw.py (optional)   (gpxpy, dtaidistance and file access live here, not in core)
rsm/odometry/                   vms CSV -> gating and segments, heading over distance, turn detector, dead reckoning, pipeline (numpy, scipy, stdlib)
rsm/bench/odo_*.py, colmap_export.py   odometry vs COLMAP comparison, matcher test, COLMAP pose export (pycolmap, other venv)
rsm/io/trajectory_json.py       strict reader / writer
rsm/io/road_reconstruction.py   route folder adapter
rsm/cli.py
tests/
```
