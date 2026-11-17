<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Route shape matching: Phase 0 proposal (investigation, no implementation)

Hypothesis: a relative 2D trajectory from a cycling video holds enough geometric and topological information to identify its OpenStreetMap (OSM) road sequence without GPS. Local matching (search area known) first; global matching only as a future two-stage design.

Status of the evidence below: "verified" means I ran or read it in this session (probe environment in the scratchpad, never in the repository). "Unverified" means from memory or a search snippet and must be re-checked before it drives a decision.

## 1. Repository architecture (only what matters)

- `ridrs_app/` is a TypeScript pnpm monorepo (AGPL-3.0-or-later code, CC-BY-SA-4.0 docs, SPDX header in every file; `LICENSING.md`, `AGENTS.md`). It contains **no OSM, Overpass, Valhalla or map-matching code** (grep over `*.md`/`*.ts`: only an optional idea in `docs/ideas/world-and-lookahead.md` line 64, a runtime map-match of the rider to a known route). It reads GPX in `plugins/ui-world-video/client/library.ts` and `plugins/video-import-incyclist/`. Consequence: **a GPX file is already the integration seam**; the matcher never has to touch TypeScript.
- `LICENSING.md` section 6a, last bullets: content under ODbL "needs maintainer approval first" before it ships. Nothing in this work ships OSM data (caches stay git-ignored), but see section 11.
- `experiments/` holds standalone prototypes (own README, FINDINGS, pinned `requirements.txt`, `.gitignore` with `.venv/`, `run.sh`, SPDX headers; Python 3.14 in `road-reconstruction` and `video-motion-speed`). A new folder follows that pattern.

## 2. Where it lives: `experiments/route-shape-matching/` (Python, standalone)

For:
1. The needed ecosystem (OSMnx, Shapely/GEOS, SciPy, NetworkX) is Python; nothing equivalent exists in TS. Porting before the hypothesis holds is waste.
2. Precedent: both related experiments are standalone Python with file interchange.
3. The result is a GPX file, which ridrs already consumes. No TS integration is needed to prove or refute the hypothesis.
4. The ODbL question (section 11) stays contained in an ignored cache folder.

Against: duplicated GPX/geodesy helpers later. Mitigation: if the hypothesis holds, the core matcher (pure geometry, no I/O) is the only candidate for a port or a sidecar service; decide then with Phase 7 numbers. **Decision: standalone Python now, TS integration deferred.** Code is `AGPL-3.0-or-later`, docs `CC-BY-SA-4.0`, SPDX headers everywhere.

## 3. Reuse inventory

Verified by reading `alignment.py`, `road_reconstruction.py` outputs, `FINDINGS.md`, `route.json`, `road.json`, `alignment.json`.

| Item | Reuse? | How / why |
|---|---|---|
| `routes/<id>/route.json` `cameras[].position` (route frame: metres, Y up, -Z initial heading, X right) with `time` | **Yes, read the file** | The riding line. 2D trajectory = `(x, y) = (position[0], -position[2])` (Y up dropped; map convention x right, y forward, right-handed). Verified: 314 poses (Pennes), 340 (Menglonnais); XZ path length 279.7 m and 543.7 m, matching `alignment.json` 280.5 / 543.9 m. |
| `road.json` `stations[].center` (every 0.5 m, 564 / 1094 points) | Only as a cross-check | It is the **road centre**, not the riding line (the camera rides on the right; see FINDINGS "painted centre line"). OSM centrelines are closer to the road centre than to the riding line, so `center` may match OSM better than `cameras`; Phase 1 should be able to load either and compare. `confidence < 0.5` for 55 % of Pennes stations (4 % Menglonnais) with my threshold; FINDINGS reports 16 % low-confidence on Pennes with its own threshold. |
| Import `backend/*.py` | **No** | It pulls pycolmap, torch, open3d; `workspace.py` stage bookkeeping is pipeline-specific. Reading its JSON output is enough and keeps the matcher video-free. |
| `alignment.gpx_track` (regex GPX parser) | **No** | Ad-hoc regex (requires `<ele>` then `<time>` in one pattern); use gpxpy. |
| `alignment.gpx_distance` (Gaussian smoothing sigma 4 s) | Idea only | Same finding as `video-motion-speed` addendum / ADR 0062. Relevant to Phase 7 truth-track handling (smooth GPX before measuring length), not to the matcher. |
| `video-motion-speed` | Idea only | Confirms GPX-only smoothing is as good as the fusion; no code reuse. |
| ridrs_app TS | **Do not modify, do not import** | Reuse the GPX file format only. |

### Extracting the relative trajectory without GPX leakage (verified in `alignment.py`)

Leakage in the existing outputs: `run()` reads `gpx_track(Path(cfg["video"]))` when `use_gpx` (default 1) and the GPX next to the video exists. It uses it for (a) metric scale (`scale_source` auto picks `gpx` when available), (b) gravity from GPX elevation when vertical-line consensus is weak (`min_vertical_lines` 300, `min_vertical_fraction` 0.22). On the existing routes: Pennes uses GPX for **both** (`up.method = "GPX elevation profile"`, vertical-line inlier fraction 0.188 < 0.22); Menglonnais uses vertical lines for gravity but the GPX for scale. So the existing `route.json` files are **tainted for evaluation** (scale = exact GPX length by construction).

Leak-free rerun (config keys exist in `alignment.py`; I did not run it, COLMAP outputs exist so it is cheap):
```
cp -R routes/pennes-9140 routes/pennes-9140-nogpx      # alignment overwrites camera-poses/aligned and metadata/cameras.json
.venv/bin/python -m backend reconstruct --route pennes-9140-nogpx --force alignment --only alignment \
    --set use_gpx=0 scale_source=camera_height camera_height=1.1
```
Caveats: `config.json` holds an absolute `video` path that has since moved to `~/Downloads/...` (alignment only reads it when `use_gpx`); `--force alignment` plus `--only alignment` should rerun just that stage, but later stages (road) read the old files, so use the copied folder and treat its `road.json` as stale. Then regenerate `route.json` via the `export` stage or read `metadata/cameras.json` (same `cameras[].position`). With `camera_height=1.1` the true mount height is 0.92 m (FINDINGS), so the **scale comes out about 1.2x too large** (`scale_agreement` 0.835 / 0.839: 23.66 vs 19.76 on Pennes, 50.96 vs 42.77 on Menglonnais). That bias is realistic for a GPX-free product and is exactly why the matcher must treat scale as a free parameter with a prior (e.g. 0.7 to 1.4), not a constant. Also: without GPX Pennes gravity falls to the trajectory-plane method; for a top-down XZ projection a few degrees of tilt matters little, but the Y-drop is only valid after gravity alignment, so record `up.method` in the trajectory provenance.

Stretch length is the other limit: 282 m and 546 m (107° total turn on Menglonnais: one gentle bend). See section 8.

## 4. Module boundaries and interchange

Package `rsm` (name open), `python -m rsm <command>`; one command per phase output file. Dependency direction is one-way; a plain unit test asserts that `rsm.core` imports neither osmnx, gpxpy nor pyproj.

```
rsm/core/        no I/O, no OSM, no GPX, no video: numpy, scipy, shapely only
  trajectory.py  RelativeTrajectory: points (N,2) metres, optional t, scale prior; resample by distance, dedup, smooth, length
  geometry.py    arc-length resampling, similarity estimate, heading/curvature signatures
  metrics.py     frechet, hausdorff, dtw, signature distance (thin wrappers, one signature: (a, b) -> float)
  matcher.py     match(trajectory, candidates: list[Polyline]) -> ranked results with per-component scores
rsm/network/     osmnx adapter: download/cache, graph build, candidate path generation (keeps way ids)
rsm/geo/         similarity -> lat/lon alignment (pyproj), optional Meili adapter
rsm/io/          trajectory reader, result writer (GeoJSON), GPX export (gpxpy), road-reconstruction adapter (reads route.json)
rsm/cli.py
```
`core.matcher` takes plain polylines in a local metric frame, so Phase 2 runs on synthetic data with no OSM and Phase 3 only adds a producer of candidates.

**Trajectory input**: `trajectory.json`, schema-versioned, human-readable, a few hundred points:
```json
{"schema": 1, "frame": {"x": "right", "y": "forward", "unit": "m", "georeferenced": false},
 "points": [{"x": 0.0, "y": 0.0, "t": 0.0}],
 "scale": {"known": false, "prior_min": 0.7, "prior_max": 1.4},
 "z_note": "optional per-point z (height, m, gravity-aligned) may be added to points: {x, y, z, t}",
 "junctions": [],
 "direction_known": true, "provenance": {"source": "road-reconstruction", "route": "...", "up_method": "...", "scale_source": "camera_height"}}
```
`z` (optional per point) is kept now so the video pipeline's height profile is not lost (Pennes: -21 m over 282 m, a strong discriminator). Using it needs a DEM because OSM has no heights (e.g. Copernicus GLO-30): a new dependency, **deferred**. Caveat: on Pennes gravity, hence z, came from the GPX elevation profile (leakage again); z from a GPX-free rerun is needed before it counts as evidence. `junctions` (optional, unused for now) is a list of arc-length positions (m) of observed side roads/intersections, a possible future upstream signal. Smallest additional information candidates, in order of expected value per effort: elevation profile (z), junction positions, absolute scale from speed.

Why not GeoJSON: RFC 7946 mandates WGS84 coordinates; a relative frame is not geographic, and mislabelled coordinates would silently invite wrong projection. Why not NPZ/Parquet: binary, opaque for review, no benefit at this size.

**Result**: GeoJSON FeatureCollection, WGS84, one feature per ranked candidate (LineString) with properties `rank`, `score`, per-component scores, ordered `osm_way_ids`, `edge_ids`, `similarity` (scale, rotation, translation), `reversed`, plus a top-level `ambiguity` block (score gap, count within epsilon of best). Viewable in QGIS/geojson.io; GPX is a derived export (gpxpy), not the primary result. **Graph cache**: OSMnx GraphML or its own JSON cache, git-ignored. Parquet (pyarrow 26.0.1 installed fine) only if candidate sets outgrow JSON; defer, no dependency now.

## 5. Dependency proposal (all installed in one `pip install` on Python 3.14.6, arm64 macOS; verified)

Probe: `python3.14 -m venv v314 && v314/bin/pip install numpy scipy shapely networkx geopandas pyproj osmnx gpxpy similaritymeasures tslearn frechetdist dtaidistance fastdtw scikit-image pyarrow` finished without error (fastdtw built from sdist; everything else wheel). Python 3.13 fallback was not needed and not tested. Licenses are from installed package metadata; release dates from the PyPI JSON API; wheels column is what PyPI lists for the latest version.

| Package | Pinned (installed) | License | Latest release / wheels | Role | Decision / alternative |
|---|---|---|---|---|---|
| numpy | 2.5.4 | BSD-3-Clause (+ bundled permissive) | 2026-10-10; cp312-cp315 | arrays | core; same pin as other experiments |
| scipy | 1.18.1 | BSD | 2026-08-21; cp312-cp315 | `orthogonal_procrustes`, `cKDTree`, interpolation, smoothing | core; same pin |
| shapely | 2.2.0 | BSD-3-Clause | 2026-10-07; cp311-cp315 | `frechet_distance`, `hausdorff_distance`, geometry ops | core; avoids a separate Fréchet library |
| networkx | 3.7 | BSD-3-Clause | 2026-09-21; pure py | graph structure (OSMnx dependency) | core; custom bounded DFS, not `all_simple_paths` (cutoff counts edges, not metres) |
| osmnx | 2.1.1 | MIT | 2026-07-21; pure py | download, graph build, simplify | Phase 3 only |
| geopandas | 1.2.0 | BSD-3-Clause | 2026-09-28; pure py | pulled in by OSMnx | transitive; not used in `core` |
| pyproj | 3.8.0 | MIT | 2026-09-05; cp312-cp315 | local metric CRS <-> WGS84 | Phase 5 |
| gpxpy | 1.6.2 | Apache-2.0 | **2023-11-29**; pure py | GPX read (evaluation truth) and write | keep: stable, small; stale but no alternative worth a custom parser. Apache-2.0 into AGPL is compatible |
| dtaidistance | 2.5.1 | Apache-2.0 | 2026-09-11; cp311-cp314 | exact multi-dim DTW in C | optional, decided by Phase 2 benchmark |
| similaritymeasures | 1.5.0 | MIT | 2026-10-11; pure py | Fréchet, DTW, area between curves | **dev/test oracle only** (cross-check our metrics; slow) |
| scikit-image | 0.26.0 | BSD | 2025-12-20; cp311-cp314 | `SimilarityTransform` | **test oracle only**; production uses SciPy (below) to avoid pillow/imageio/tifffile |
| pyarrow | 26.0.1 | Apache-2.0 | n/a | Parquet | deferred |
| tslearn | 0.10.0 | BSD-2-Clause | 2026-10-22; pure py | DTW (numba) | **reject**: drags scikit-learn, numba, llvmlite, pandas; 1.8 s JIT on first call |
| frechetdist | 0.6 | Apache-2.0 | **2019-08-12** | pure-Python Fréchet | reject: unmaintained, 100x slower than GEOS here |
| fastdtw | 0.3.4 | MIT | **2019-10-07**, sdist only on 3.14 | approximate DTW | reject: unmaintained since 2019 and approximate by design |

Not probed: pytest (assumed standard), any linter. Similarity transform without a new dependency: `scipy.linalg.orthogonal_procrustes` gives the rotation, scale = trace(S)/||A||^2 (Umeyama); `scipy.spatial.transform` in 1.18.1 exports `RigidTransform`, `Rotation`, `Slerp`, `RotationSpline` (rigid only, no scale). I verified `skimage.transform.SimilarityTransform().estimate(A, B)` recovers scale 1.301 / rotation 0.699 rad / translation (1000.0, -499.8) for a synthetic spiral transformed by true (1.3, 0.7, (1000, -500)) with 2 m noise; I did **not** run the SciPy-only route (Phase 2 task).

### Valhalla Meili (Phase 5 optional; mostly unverified)

- Verified (PyPI page fetch): `pyvalhalla` 3.9.1, released 2026-10-06, a single abi3 wheel built for CPython 3.12 (needs Python >= 3.12), platforms Windows x64, Linux x64/arm64 and `macosx_14_0_arm64`; license shown as MIT (an older search snippet claimed GPLv2 for earlier versions: conflicting, **unverified**; Valhalla core is MIT to my knowledge; verify the license in Phase 5). It needs routing tiles: `python -m valhalla valhalla_build_tiles -c valhalla.json <extract>.osm.pbf`, i.e. a PBF extract (ODbL), not the OSMnx graph.
- Unverified (docs fetch failed; from memory): Meili is `trace_route` / `trace_attributes` with `shape` = list of **lat/lon** points, `costing: bicycle`, `shape_match: map_snap`, `trace_options` (`gps_accuracy`, `search_radius`, `breakage_distance`, `turn_penalty_factor`); `trace_attributes` returns edges with `way_id`. It is an HMM for noisy GPS **in the right place**, so it only applies after our own similarity alignment (Phase 5), and its default accuracy assumptions (metres) are far tighter than our shape error. Docker image existence not checked. Recommendation: do not depend on it before Phase 5; use it there as a refinement, and in Phase 7 as the primary way-id ground truth for the real GPX tracks (section 8).

## 6. Algorithm notes (Phase 2 benchmarks decide; numbers are single unwarmed runs, not benchmarks)

Probe: synthetic spiral, n=100 resampled points, B = 1.3x scaled, rotated 0.7 rad, translated, 2 m noise; A pre-aligned with the estimated similarity transform.

| Metric | Implementation | n=100 | Caveats |
|---|---|---|---|
| Discrete Fréchet | `shapely.frechet_distance` (GEOS) | 5.334 m, 0.2 ms; n=1000: 9.8 ms | O(nm); order-aware, noise-sensitive (max statistic); **needs prior alignment**; agrees exactly with `similaritymeasures.frechet_dist` (5.334, 6.7 ms) and `frechetdist` (21 ms). The call with `densify=0.5` on n=1000 did not return within >3 min CPU in my probe (unexplained; avoid `densify` until investigated) |
| Hausdorff | `shapely.hausdorff_distance`; point-set `scipy.spatial.distance.directed_hausdorff` | 4.676 m (curve, densified internally) / 5.334 m (points, 0.3 ms) | ignores order and direction: weak shape discriminator, use as sanity bound, not as score |
| DTW | `dtaidistance.dtw_ndim.distance` (C) / `tslearn.metrics.dtw` | 26.589 both; 18.6 ms / 0.6 ms after 1.8 s JIT | tolerates timing differences (good for speed errors), but sensitive to sampling: resample by arc length first. `similaritymeasures.dtw` returns 241.3 (sum of Euclidean steps, a different definition: never compare numbers across libraries). `fastdtw` returned 304.7 (4.7 ms), a different cost definition again, so its approximation error was not measured; unmaintained |
| Heading / curvature signature | own, NumPy/SciPy (turning angle vs normalised arc length, smoothed) | n/a | invariant to translation and rotation; scale handled by normalising arc length; noise-sensitive in second derivative (curvature) so prefer heading change over a window; compare by cross-correlation/DTW; cheap enough to prefilter all candidates |

Design points:
- **Correspondences first**: similarity estimation needs paired points. Resample both curves to N (64 to 128) points by arc length; for a candidate longer than the trajectory (partial match) slide a window over the candidate and treat window start and scale as search parameters (coarse scale grid 0.7 to 1.4 given the observed 1.2x bias, then refine).
- **Two-tier scoring**: tier 1 rotation- and translation-invariant heading signature for all candidates (vectorised); tier 2 Procrustes alignment then Fréchet / DTW / RMSE on the top K. Report each component separately; no hidden weighted blend (Phase 4 requirement). **Honest definition of "topology"**: a bare 2D trajectory carries no intersection information, so from the trajectory alone the topology component reduces to the turn sequence (number, order, sign and size of turns) compared with the path's turns; it is a view of the shape, not independent evidence. Real topological evidence needs the optional `junctions` field.
- **Direction and reversal**: direction of travel is known, so candidates are scored forward; the reversed candidate is evaluated as a diagnostic (a strong reversed score signals a flipped handedness or ambiguity, never a silent fallback). Reflection (mirror) is not enabled in the transform; a test makes sure a mirrored synthetic input is **not** matched well.
- **Scale**: free scale with explicit bounds; also report the implied scale and its deviation from 1 as a score component (length consistency).
- **Partial matches**: trajectory covers part of a way (start/end mid-edge): candidates are polylines cut at arbitrary offsets, not whole edges; way ids are kept per segment so the output lists the first and last way as partial.

### Error-model calibration (Phase 1/2 step)

The perturbation numbers used elsewhere in this document (drift 2 to 5 %, scale 0.8 to 1.25) are guesses. Calibrate from the two real pairs: the GPX-free reconstruction vs the GPX segment over the same video time window. After a best similarity fit, measure residual RMS, maximum deviation, heading drift per 100 m and residual scale. Synthetic perturbations in the Phase 2 benchmark and Phase 7 cuts are drawn from the measured values with margin. The GPX is used here **only to calibrate the error model, never as matcher input**; only two pairs exist, so the model is a rough envelope and is reported as such.

## 7. Candidate generation (Phase 3) and the global index

Graph: `osmnx.graph_from_bbox(bbox, network_type="bike", simplify=False)` then `simplify_graph(G, edge_attrs_differ=["osmid"])`. **Verified on the Pennes bbox**: default `simplify_graph` merges ways (210 of 2044 edges carry a *list* of osmids, e.g. `[922589628, 4290253, 1162136886]` for one 3 km edge), which loses way boundaries. With `edge_attrs_differ=["osmid"]` the result has 0 merged edges (1034 nodes / 2348 edges), every edge has a single `osmid`, and geometry is preserved on the edges that need it. Unsimplified edges keep `osmid, highway, name, ref, oneway, reversed, length`.

Enumeration without combinatorial explosion (state-based search, not `all_simple_paths`):
1. Length budget in metres: `[L * s_min - slack, L * s_max + slack]` from the trajectory length L and scale prior; start paths at nodes and trim both ends to the length window (the partial first/last way is cut afterwards), rather than enumerating every edge with a free offset.
2. Bounded DFS or beam on states `(edge, length bucket)`; keep the best K per state (a Viterbi/HMM-like merge), so paths that join the same edge at the same length are not expanded twice.
3. **Heading-profile pruning**: after each edge compare the cumulative turning angle with the trajectory's turning profile at the same normalised arc length, within a tolerance that grows with scale uncertainty; no U-turn unless the trajectory has one; respect `oneway`.
4. Hard caps (paths, expansions) that **raise or report**, never truncate silently; log generated / pruned / kept counts per run. Dense urban grids (branching about 3, 12+ edges) are the stress case; a private suburban GPX in Phase 7 is the test.
5. Rough size, not measured: Pennes bbox has 613 km of bike network in 2348 directed edges; a 1 km path covers 1 to 10 simplified edges in the mountains, many more in a grid.

Global (future, not built): stage 1 retrieval by a rotation- and translation-invariant descriptor (heading-change sequence over fixed arc-length windows) computed for path fragments of all roads of a region, indexed in a KD-tree/ANN, returns K candidate regions; stage 2 is this local matcher on each region. Prerequisites to measure first: descriptor collision rate on the local benchmark (how often distinct places have the same signature), index size per 1000 km of network. Offline PBF extracts, not Overpass, would be required.

## 8. Evaluation plan for Phase 7

**Routes** (GPX is hidden ground truth only; the matcher never reads it):

| Route | Environment | Source | Note |
|---|---|---|---|
| Col de Pennes | mountain, hairpins | `~/Downloads/FR_Col_de_Pennes/` (2485 pts, 46.2 km, bbox lat 44.620 to 44.674, lon 5.300 to 5.420, 4 s median spacing) | real video-derived stretch (282 m) exists; strong shape |
| Le petit Menglonnais | rural plain, gentle bends | `~/Downloads/FR_Le_petit_Menglonnais/` (1783 pts, 1 s) | real video-derived stretch (546 m); weak shape: stress test |
| Col de Rousset | mountain descent/climb | `~/Downloads/FR_Col_de_Rousset...` (9472 pts, 1 s) | video exists, not reconstructed |
| one private suburban GPX | suburban / dense grid | read in place, not named here | candidate-explosion test; **private**, see below |
| optional Taunus | hilly, mixed | the Eschborn-Frankfurt GPX | |

GPX header survey (verified, counts of `<trkpt>`/`<time>`): the three `FR_*` files are creator "GPS Track Editor" with synthetic timestamps from 1999-12-31 (video-synchronous, probably derived from recorded rides). The Komoot files have `<time>`, but five of them start at the **same point to six decimals**, which suggests planned/exported tours rather than raw recordings; I cannot prove which are recorded. StravaGPX/AllTrails/BRouter files have no `<time>` (route exports, not recorded rides). `Zwift_*` are fictional worlds and are excluded. Planned routes follow OSM geometry exactly (optimistic, no GPS noise); recorded ones are noisy. Use both kinds and label them in the report.

**Stretch lengths**: 0.3 to 0.6 km is probably not enough as the only test, and the two real video stretches are exactly that long. Information is in the turns: Pennes has 211° total turn in 282 m (distinctive), Menglonnais has 107° in 546 m, essentially one bend, which any gentle bend in the area will resemble. Hypothesis to test, not assume: shape identifiability needs about 3 or more significant turns. Cut synthetic stretches of **0.5 / 1 / 2 / 5 km** at many random positions from each real GPX (hundreds of cuts per length) with controlled perturbations (smoothing, 2 to 5 % drift growth, scale 0.8 to 1.25, random rotation), and use the two real video-derived stretches (GPX-free scale!) as the only end-to-end check. Reconstructing longer real video stretches costs about 9 min per 60 s of video (FINDINGS), so about 30 min for 2 km at Menglonnais speeds; do this only if synthetic results justify it.

**Ground truth way sequence**: Meili is the primary way-id truth (a legitimate use: real GPS in the right place); no own HMM (scope creep, a second matcher to debug). Run once offline, store as `truth.json`. **Way-id criterion**: length-weighted overlap of directed way ids between the candidate path and the truth stretch >= 90 % and first/last way within one way of the truth. **Geometric criterion, reported separately**: discrete Fréchet of the placed candidate vs the truth GPX <= a stated threshold (set before the test routes are run). If Meili is unavailable, report only the geometric metric and label it so; never substitute one criterion for the other silently. A geometric threshold can accept a parallel road, which is why the way-id metric matters. **Search-area size is a reported variable**: top-k depends on bbox area and network density, so every result is given as a function of search radius (1 / 3 / 10 km around a randomised offset) together with the network km and candidate count for each; without that, "local matching works" is unfalsifiable. Metrics: top-1 / top-5 / top-20, mean and max distance between the aligned reconstructed track and the GPX, length error, direction correctness, time, peak memory, ambiguity (score gap, number of candidates within epsilon).

**Leakage prevention**: (1) trajectories for evaluation come from GPX-free alignment (section 3) or from perturbed cuts; (2) the OSM bbox is larger than the stretch and the stretch position inside it is randomised, so the bbox does not encode the answer (a bbox fitted tightly to the GPX, as in my probe, would leak); (3) scoring weights and thresholds are tuned on development routes (e.g. Menglonnais/Rousset cuts) and frozen before the test routes (Pennes, a suburban ride); (4) the truth file is written by a separate command and only read by `evaluate`; (5) the matcher CLI has no GPX argument.

**Privacy and licensing**: personal GPX are never committed, copied into the repository or uploaded; the evaluation reads them in place from `~/Downloads` by path, and only aggregate metrics are committed (no coordinates, no start/finish; the Komoot files start at the user's home area). The `FR_*` footage and tracks are CC BY-NC-SA 4.0 third-party content: any derived artifact stays git-ignored like `routes/` in `road-reconstruction`. OSM caches are git-ignored (section 11).

## 9. Risks, ranked (with early detection)

1. **Shape ambiguity on short or straight stretches.** Detect in Phase 2/4 with the synthetic benchmark: top-1 vs length curve and the score gap; report ambiguity instead of a single answer. Exit criterion per length is measured, not assumed.
2. **Scale uncertainty.** Observed 1.2x bias without GPX (section 3). Detect: Phase 2 sweeps scale 0.7 to 1.4; check how top-1 degrades vs a known scale.
3. **Drift and distortion in video-derived trajectories.** Monocular SfM drift is not small over km. Detect: Phase 2 injects drift (growing heading bias, scale drift) and the two real stretches test it; a rigid similarity may be too strict, so keep a local-heading signature tier.
4. **OSM centreline vs riding line / lane offset, missing paths, outdated roads.** Detect: Phase 7 distance between truth GPX and OSM centreline; trajectory source comparison (`cameras` vs `road.json center`).
5. **Candidate explosion in dense urban grids.** Detect: Phase 3 counters on a dense suburban bbox; caps that raise.
6. **Overpass rate limits and latency.** Verified cost: the Pennes bbox (about 13 x 8 km) took **102 s** for the first download (12952 nodes, 26121 edges unsimplified), 0.8 s from the OSMnx cache. Public policy (search snippet from the OSM wiki, unverified in detail): roughly 10,000 queries/day and under 1 GB/day per IP, concurrent slots, HTTP 429 when exceeded, `/api/status` shows slots. Detect: cache every download keyed by bbox, one request at a time, log failures; OSMnx `graph_from_xml` reads OSM XML, not PBF, so a Geofabrik PBF would need conversion (osmium-tool) or another reader: an extra tool. Recommendation: Overpass with the OSMnx cache for Phases 3 to 7 (bounded areas); revisit PBF only for Valhalla tiles or global work.
7. **Python 3.14 wheel availability.** Verified OK today for the proposed set; risk is the future (e.g. `fastdtw` already has no 3.14 wheel, `pyvalhalla` ships only an abi3 cp312 wheel). Detect: pinned `requirements.txt` plus an install check in `run.sh`.
8. **GPX leakage into the trajectory or the matcher.** Verified present in current reconstruction outputs. Detect: Phase 7 checklist in section 8; provenance fields `scale_source` / `up_method` must be `camera_height` / not GPX for any evaluation input.
9. **OSM graph simplification losing way ids.** Verified; mitigated by `edge_attrs_differ=["osmid"]`.
10. **Combined effect: sub-metre shape differences between parallel roads** (two roads 50 m apart with the same shape). Detect: ambiguity report; geographic tie-breakers are out of scope.

## 10. Phased plan

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | this proposal | reviewed; open questions answered |
| 1 trajectory model | `RelativeTrajectory`, JSON I/O, resampling by distance, dedup, smoothing, length; adapter for `route.json` (and a GPX-free rerun script documented, not changed in road-reconstruction); `requirements.txt`, README, tests | exit criteria: JSON round-trip tests; resampling invariance (resample at 0.5 / 1 / 2 m: length and shape change below a stated tolerance); **handedness test** on real data: signs of turns of the (x, -z) projection agree with the GPX turn signs over the same video window (GPX only as a test fixture, never matcher input; a mirrored projection would pass every synthetic test); deterministic. Length vs `alignment.json` (0.5 %) is only an internal consistency check, since that number is GPX-derived |
| 2 local geometry matcher (synthetic) | similarity estimation (SciPy, tested against scikit-image), metrics module, benchmark: Fréchet, DTW, Hausdorff, heading/curvature signature; noise, drift, scale, rotation, reversal, mirror-negative test. **Perturbations are drawn from the calibrated error model (Phase 1/2 step below), with margin. Distractors are real road shapes** (cuts from other parts of the real GPX tracks, later OSM paths), never random curves, which make the benchmark trivially easy; GPX cuts keep Phase 2 OSM-free | table of top-1 vs distractor count and noise per metric; choice of tier-1/tier-2 recorded in FINDINGS |
| 3 OSM network and candidates | OSMnx download with cache, simplify with way ids, bounded-DFS candidate generator, counters | candidate count per query bounded and reported on Pennes and a dense suburban bbox; way ids retained; runtime per query |
| 4 matching with transparent score | shape/turn-sequence/length components, ambiguity report; results reported per search radius (1 / 3 / 10 km) with network km and candidate count | on cuts from a development route, ground truth in top-20 at >= x % (x set from Phase 2/3, not guessed here); every score decomposed |
| 5 geographic alignment | similarity -> lat/lon via pyproj; optional Meili refinement | aligned track within a stated distance of truth on the cuts; Meili only if it improves |
| 6 GPX export | gpxpy writer with metadata and `OSM contributors` credit | valid GPX opens in the existing ridrs import path (manual check, no TS changes) |
| 7 real evaluation | >= 3 routes, section 8 metrics and leakage rules | FINDINGS answers the hypothesis per stretch length: confirmed, refuted, or conditional |

Each phase is one small increment with its own README/FINDINGS update and a Phase-gate check before the next starts.

## 11. OSM data licensing (ODbL) and handling

- OSM data is ODbL 1.0, attribution "(c) OpenStreetMap contributors". A local cache of downloaded data is a database held for internal research, which ODbL permits; share-alike obligations arise when a **derived database** is **publicly** shared. A GPX/GeoJSON route that only references roads is likely a Produced Work (OSMF Produced Work guideline: usually images/printed maps; database dumps are not Produced Works), but a candidate table of many OSM-derived paths is closer to a database. I am not a lawyer; the OSMF guideline page does not cover attribution, caching or GPX specifically.
- Policy for this experiment: caches and candidate tables are git-ignored; only metrics are committed; result files carry the attribution line; no OSM-derived data in `ridrs_app`. `LICENSING.md` section 6a requires maintainer approval before ODbL content *ships*; shipping nothing avoids that gate, but it applies if the matcher is ever integrated.
- Overpass: see risk 6. Respect the public instance policy; no parallel scripts.

## 12. Open questions for the user

1. **Scale in the product scenario.** Will the video pipeline have a trustworthy absolute scale (e.g. speed from `video-motion-speed`, or the known mount height) or must the matcher treat scale as unknown within about 0.7 to 1.4? This changes the benchmark design and the expected accuracy.
2. **Which personal GPX may be used in Phase 7** (privacy: read in place, only aggregate metrics committed). Is one private suburban ride acceptable as the urban case, or should urban data be public/third-party only?
3. **OSM source**: recommendation is Overpass with the OSMnx cache for Phases 3 to 7 (bounded areas), PBF only later (Valhalla tiles, global work; needs osmium-tool or another reader since `graph_from_xml` reads XML). Please confirm.
4. **ODbL approval path.** Is experiment-internal, git-ignored use enough for now, and who decides if the matcher is later integrated into ridrs?
5. **Success threshold.** What top-k/accuracy and minimum stretch length would count as "hypothesis proven" for the product (e.g. top-5 at >= 2 km)? Without it Phase 7 can only report numbers.

## 13. Decisions (user, 2026-11-09)

- **Real-world data**: use `experiments/road-reconstruction/sample_videos/` (`Gotthard Pass 4K.mp4`, 41 min 1080p50; `Cayolle Pass.mp4`, 98 min 360p25; YouTube downloads, third-party copyright, never committed: `*.mp4` is git-ignored). They have **no GPX and no embedded GPS**: they are the target scenario. Their ground truth cannot come from a GPS track; it is established from the known pass road in OSM and must be confirmed by the user before it is used as truth. Together with the three `FR_*` routes (video + GPX, CC BY-NC-SA 4.0) this gives five real routes. **No personal GPX from `~/Downloads` is used** (answers Q2).
- Q1 scale: unknown, prior 0.7 to 1.4. Q3: Overpass with the OSMnx cache. Q4: OSM data git-ignored, experiment-internal. Q5: success threshold set after Phase 2 from measured numbers.
- This supersedes the private-GPX mentions in sections 7 to 10: the dense-grid stress test (Phase 3) uses an **OSM-only** urban bbox (no personal track needed: synthetic cuts are taken from OSM paths there).

### Update 2026-11-09 (user): FR_* data removed

The user removed the three `FR_*` video/GPX folders. They are no longer a data source; the Phase 1/2 tests that need them skip. Real data is now `experiments/road-reconstruction/sample_videos/` (Gotthard, Cayolle, Amalfi Coast; no GPS) and, once filled, `~/Library/Application Support/org.ridrs.app/media` (empty on 2026-11-09). Phase 2's benchmark runs on stand-in real tracks (incyclist test fixtures) with an **assumed** error model, labelled as such; the error model is re-measured once a video with independent ground truth exists.
