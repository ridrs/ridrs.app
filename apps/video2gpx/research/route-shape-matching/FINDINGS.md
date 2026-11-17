<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Findings

> **Overall goal (user, 2026-11-11):** for a video without GPS, produce a **GPX file whose timestamps match the video timestamps**. Its coordinates are **not** just the OSM route (centre line) with elevation, but the camera's actual position on the road: along-track exact, and eventually the lateral position (lane, road edge) too. Every result is judged by its time-aligned position error, not only by "right road". The final algorithm stays classical, without AI.

## Phase 1: trajectory model

Measured with the commands in the README on 2026-11-09. Python 3.14.6, numpy 2.5.4, scipy 1.18.1, shapely 2.2.0.

### GPX-free alignment (alignment stage only, `use_gpx=0 scale_source=camera_height`, 15 s per route)

| | Pennes (40 s, 314 poses) | Menglonnais (60 s, 340 poses) |
|---|---|---|
| `up_method`, original (GPX) | GPX elevation profile | vertical lines |
| `up_method`, GPX-free | **trajectory plane** | vertical lines |
| `scale_source` original / GPX-free | gpx / camera_height | gpx / camera_height |
| scale (route m per SfM unit) GPX / GPX-free | 19.755 / 23.660 | 42.769 / 50.965 |
| scale ratio GPX-free / GPX | 1.198 | 1.192 |
| XZ path length GPX-scaled / GPX-free | 279.7 m / 335.7 m | 543.7 m / 647.9 m |
| elevation change GPX-scaled / GPX-free | -20.99 m / -5.75 m | -8.42 m / -10.04 m |

The scale bias is the assumed mount height 1.1 m against the 0.92 m the GPX scale implies (`implied_camera_height_m` 0.918 / 0.923). Without the GPX, Pennes loses its gravity source: the trajectory-plane fallback gives an elevation change of -5.75 m against -20.99 m, so `z` from the GPX-free Pennes run is not usable as evidence (the adapter sets `z_reliable: false` and warns). Menglonnais keeps vertical-line gravity.

### Handedness against the GPX (`pytest -s -m realdata`)

(x, -z) of the GPX-free cameras against the GPX of the same video window (GPX time since its first point == video time; local equirectangular projection; GPX smoothed with sigma 4 s).

| | Pennes | Menglonnais |
|---|---|---|
| total turn, reconstruction | -214.8 deg | -104.4 deg |
| total turn, GPX | -121.4 deg | -104.8 deg |
| correlation of heading-change profiles (20 bins of arc length, both smoothed 5 m) | **+0.358** | **+0.896** |
| same, mirrored reconstruction | -0.358 | -0.896 |
| same, GPX windows shifted by +-120, 200, 300 s (mean / max) | -0.105 / +0.234 | +0.143 / +0.322 |

Both routes turn right in both sources: the projection (x, -z) has the correct handedness. Replacing the projection by (x, z) or (-x, -z) makes both handedness tests fail (checked by editing the adapter and restoring it).

Limits of this evidence:
- The mirrored correlation is exactly the negative of the unmirrored one, so the "mirrored" check adds nothing beyond the sign; the shifted-window control is the informative one.
- Pennes agrees only weakly in shape (0.358, a shifted window reaches 0.234). The GPX has 18 points (4 to 5 s apart, about 16 m) in the 280 m window, so the hairpins are under-sampled: raw GPX turn -148 deg, smoothed -121 deg, against -215 deg from the video. The turn magnitude therefore differs by a factor of 1.77. The earlier proposal figure of 211 deg was not reproduced from the GPX.
- Profile parameters (5 m, 20 bins, GPX sigma 4 s) were fixed before the thresholds but I looked at a small grid (sigma 5 and 10 m; 10, 20, 40 bins): Pennes 0.33 to 0.59, Menglonnais 0.88 to 0.92. The test thresholds (0.25, 0.7) are below those values. Two routes only.

### Scale bias (reported, not asserted)

Window length from the GPX (sigma 4 s): 278.2 m (Pennes), 541.3 m (Menglonnais). GPX-free length: 335.7 m and 647.9 m, i.e. **x1.207 and x1.197**. The matcher's scale prior 0.7 to 1.4 covers this; a constant 1.2 would not be a safe assumption for other mounts.

### Resampling and smoothing (synthetic, asserted in tests)

- Resampling at 0.5, 1 and 2 m changes the length by no more than the chord bound `4 (step^2 + gap^2) / (24 R^2)` (about 0.2 % for 2 m on a 9.5 m hairpin) and the Hausdorff distance stays within about `1.2 (step^2 + gap^2) / (8 R)` (0.05 m for 2 m on the hairpin). Resampling never lengthens the path.
- `smooth(sigma)`: interior radius ratio on circles equals `exp(-sigma^2 / 2R^2)` to 3 digits (0.995 for sigma 4 m, R 40 m; 0.916 for sigma 4 m, R 9.5 m); end points are pinned exactly; 0.3 m noise on a 60 m arc drops to under half its RMS with sigma 3 m.
- Total turning angle: analytic values reproduced within 0.01 rad for arc, hairpin (+-pi), full loop (2 pi), S-curve (0), with left positive.

### Known limitations

- The Phase 1 trajectory is the camera path; the road centre (`--source road-center`) is a loader only and has not been compared with OSM.
- Smoothing shrinks tight curves (8 % in radius for a 30 m hairpin at sigma 4 m): choose sigma below the smallest radius of interest.
- `heading`/`turning_angle` of unsmoothed noisy input is noise-dominated; smooth first.
- `junctions` and `u` (uncertainty) are carried and validated but unused; the adapter does not fill `u`.
- The `-nogpx` route folders are partial copies (alignment inputs only), git-ignored, and not reproducible without the original reconstruction.

## Phase 2: local geometry matcher (code complete; real-data evidence NOT produced)

Python 3.14.6, numpy 2.5.4, scipy 1.18.1, shapely 2.2.0, dtaidistance 2.5.1 (bench only, optional), scikit-image 0.26.0 (test oracle), 12-core M3 Pro.

### Status, in one paragraph

The similarity fit, the metrics, the matcher, the calibration code and the benchmark are written and tested (new tests). **The three `FR_*` GPX tracks disappeared from `~/Downloads` while I worked** (all three folders and all three zips; at the start of the session `pytest` ran the Phase 1 real-data tests and `ls ~/Downloads/FR_*` listed them, about 15 minutes later `ls` finds nothing; I deleted nothing; `find`, Spotlight, the repository and the other experiments hold no copy, and there are no Time Machine snapshots). Consequently **not run**: the error-model calibration (`work/error_model.json` does not exist), the benchmark on the Pennes / Menglonnais / Rousset tracks, the dev/test split as specified, and the real-video queries with truth. What did run is the complete benchmark on **stand-in tracks** (three real GPX routes from the repository's `incyclist` test fixtures: `FR_Source_Drome_Part_1.gpx` 22.1 km and `Triathlon_Woerrstadt_Loop.gpx` 36.6 km as development, `ES_Catalunya_Spain.gpx` 27.1 km as test) with an **ASSUMED** error model. Those numbers validate the harness and show the mechanisms; they are not evidence about the Pennes, Menglonnais or Rousset roads, and nothing below should be quoted as a Phase 2 result for them. Re-running is two commands: `python -m rsm calibrate` then `python -m rsm bench` (README).

### Components and what they are

- `rsm/core/similarity.py`: Umeyama 2D similarity, SVD with determinant correction (reflection disallowed), optional scale bounds (clamp, translation re-solved, `scale_clamped` reported), plus a batched complex-number form for the window search (same estimator, tested equal). Tests: exact recovery, agreement with `skimage.transform.SimilarityTransform` on noisy data (scale to 1e-9 relative, rotation and translation to 1e-9 / 1e-6), mirrored input fitted badly (residual > 20x the noise), collinear and identical points (collinear is fine; identical source or target points raise `DegenerateFit`).
- `rsm/core/metrics.py`: `shapely.frechet_distance` (no `densify`), `shapely.hausdorff_distance`, RMSE after arc-length resampling, heading-signature distance (std of the heading difference of arc-length-resampled curves = RMS heading difference after the best constant rotation; invariant to rotation, translation and scale). The module docstring tabulates unit, meaning and what each is (in)sensitive to.
- `rsm/core/matcher.py`: window start x scale search per candidate (and per direction), coarse grid then refinement, similarity fit on arc-length correspondences, all component scores kept, distinct list (non-maximum suppression through `origin_id`/`origin_offset_m`, overlap > 50 % of the shorter window), ambiguity block, status. Grid (defaults, reported in `MatchResult.grid`): one query point per 10 m clipped to 40..200 (measured 41 / 64 / 125 / 200 points for L = 300 / 500 / 1000 / 2000 m), 5 scales over the prior, window starts every 10 % of the window length (measured 31 / 26 / 22 / 20 coarse windows per candidate), then the 3 best coarse windows are each refined in 3 rounds of 9 starts x 7 scales (measured about 420 refinement windows per candidate; about 450 windows in total, forward direction only). Alignment is chosen by the relative residual `rms / (scale * length)` for every ranking score, so the ranking metrics are compared on identical alignments.
- Reverse: off by default; `allow_reverse` lets the reversed candidate compete (`reversed=True`, window offset reported in the candidate's own direction), `diagnose_reverse` only reports `reverse_scores`. Tested.
- **Finding during testing (fixed):** with only the single best coarse window refined, a noise-free synthetic pair gave scale 0.807 and 1.5 m cross-track residual for a true 0.83 / 0 m, because the relative residual is almost flat along smooth shapes and the coarse winner can sit two grid steps from the true window. Refining the best 3 coarse windows gives 0.8299 and 0.02 m. `refine_top=3` is the cost: about three times the refinement time.
- **DTW is not in `rsm.core`** (review fix). `rsm/bench/dtw.py` wraps `dtaidistance.dtw_ndim` (normalised: sqrt(sum of squared step costs over the warping path) / sqrt(N), verified against an O(NM) reference in `tests/test_dtw.py`; <= RMSE) and plugs into the matcher through the generic `MatchOptions.extra_metrics` hook. It is used only if `dtaidistance` is importable and its C code loads, else the benchmark prints a note and has no DTW row. Reason: on the stand-in benchmark DTW ties RMSE everywhere (within 0.5 pp top-1), and its macOS wheel needs libomp (pure-Python DTW: 31 ms vs 0.04 ms per 128-point pair, measured), which does not belong in a library. The core import test allows numpy, scipy and shapely only. After the change the stand-in benchmark was rerun with and without the DTW row: the `rmse_rel` tables (cells, hard negatives, by-turn, thresholds) are identical to the earlier run in both cases.

### Error model (calibration): not measured

`rsm/bench/calibrate.py` (`python -m rsm calibrate`) is written: GPX window over the video time span, extended by 15 % at both ends, as the single candidate of the matcher; after the best fit it measures cross-track residual RMS and maximum (and the correspondence RMS), heading drift per 100 m (linear trend of the heading difference against arc length), residual scale, the correlation length and wavelength-band variance fractions of the lateral residual, and a time-aligned control fit; it writes `work/error_model.json` with a `recommended` block that the benchmark reads. Its maths is tested on synthetic pairs with known parameters (scale 0.83 recovered to 1 %, residual 0.02 m for an exact copy, a 3 deg/100 m drift measured as 3.04 deg/100 m; a requested 3 m lateral noise measured as 2.2 m, the test accepts 1.5..4.5 m) and on the real pairs by `pytest -m realdata` once the files exist. **No real number has been produced.**

Therefore the benchmark ran with `perturb.ASSUMED`: scale bias 1/1.2 (the only measured quantity, Phase 1 length ratios 1.207 and 1.197 inverted), scale sigma 0.08, lateral noise 4 m RMS with 40 m correlation length, heading drift 2 deg per 100 m as a random walk in arc length (smoothed 20 m). These values are guesses in the range the proposal used (section 9: drift 2 to 5 %); level 2 doubles noise and drift. The limits that will apply to the real calibration, to be repeated with its numbers: two pairs only; the GPX is itself noisy (Pennes: 4 s spacing, 18 points in the 280 m window) so the residual is an upper bound mixing video and GPS error; a rigid fit absorbs part of the drift, so lateral residual and drift slope are not independent; and using the same two pairs later as test queries is circular.

### Benchmark on STAND-IN tracks with the ASSUMED error model (harness validation only)

`python -m rsm bench --standin --workers 10 -o work/bench-standin`: 788 query runs (20 queries per track and length at two noise levels, plus mirrored curvy, near-straight, duplicated-shape and excluded-track queries), seed 20261109, **95 s wall total on 10 workers (86 s matching)**; a second run reproduced the thresholds exactly. Tracks: dedup 1 m, Gaussian smoothing sigma 3 m, resampled every 2 m. Library: windows of 1.5 L + 100 m with stride L/2 along every track: 565 / 336 / 165 / 80 candidates for L = 300 / 500 / 1000 / 2000 m (all three tracks, 86 km). Correct = the top-ranked distinct entry's matched window overlaps the true source interval (same track) by >= 50 % of the true interval length; top-k and median rank count positions in the distinct list (non-maximum suppression; a query whose truth is in no distinct entry gets rank = list length + 1 and is counted as "not found").

Ranking score by the development rule (highest mean top-1 over dev length x level cells; ties within 0.5 pp to the lower median rank): **`rmse_rel`** (0.478 mean top-1; `dtw_rel` 0.475 tied; `combo` 0.472; `heading` 0.441; `hausdorff_rel` 0.388; `frechet_rel` 0.384). `rmse_rel` is the RMSE of the arc-length-paired points after the fit divided by the fitted trajectory length (dimensionless). **This choice is provisional**: it was made on stand-in dev tracks. It is `DEFAULT_RANK_BY`; `DEFAULT_STATUS` is deliberately empty and `match` raises without explicit `StatusThresholds`, so no uncalibrated threshold ships.

Dev-derived thresholds (rmse_rel; also provisional): `gap_ratio` 3.66 (smallest ratio at which <= 1 % of the dev answers declared confident were wrong, pooled over dev main, mirrored and excluded queries), `max_score` 0.0204 (99th percentile of the best score over dev queries with a correct top-1). `eps = gap_ratio - 1`; confident iff no other distinct candidate within that tolerance.

Top-1 % (top-20 %, median rank), ranking score rmse_rel; confident % and confident-and-wrong % at the dev thresholds:

| split | level | L m | n | top-1 | top-20 | median rank | confident | confident-wrong |
|---|---|---|---|---|---|---|---|---|
| dev | x1 | 300 | 40 | 18 | 45 | 23.5 | 5 | 0 |
| dev | x1 | 500 | 40 | 42 | 82 | 2.5 | 5 | 0 |
| dev | x1 | 1000 | 40 | 70 | 100 | 1 | 18 | 0 |
| dev | x1 | 2000 | 40 | 92 | 100 | 1 | 42 | 0 |
| dev | x2 | 300 | 40 | 12 | 28 | 62 | 0 | 0 |
| dev | x2 | 500 | 40 | 25 | 65 | 9 | 0 | 0 |
| dev | x2 | 1000 | 40 | 45 | 92 | 2 | 5 | 0 |
| dev | x2 | 2000 | 40 | 78 | 100 | 1 | 12 | 0 |
| test | x1 | 300 | 20 | 70 | 100 | 1 | 0 | 0 |
| test | x1 | 500 | 20 | 100 | 100 | 1 | 10 | 0 |
| test | x1 | 1000 | 20 | 100 | 100 | 1 | 60 | 0 |
| test | x1 | 2000 | 20 | 100 | 100 | 1 | 80 | 0 |
| test | x2 | 300 | 20 | 30 | 85 | 3.5 | 0 | 0 |
| test | x2 | 500 | 20 | 90 | 100 | 1 | 0 | 0 |
| test | x2 | 1000 | 20 | 100 | 100 | 1 | 10 | 0 |
| test | x2 | 2000 | 20 | 100 | 100 | 1 | 30 | 0 |

Ranking scores compared, top-1 % (RMSE / Frechet / Hausdorff / DTW / heading / sqrt(RMSE*heading)); n as above:

| split, level | L m | RMSE | Frechet | Hausdorff | DTW | heading | combo |
|---|---|---|---|---|---|---|---|
| dev x1 | 300 | 18 | 12 | 12 | 18 | 12 | 15 |
| dev x1 | 500 | 42 | 40 | 40 | 42 | 45 | 42 |
| dev x1 | 1000 | 70 | 55 | 55 | 70 | 65 | 70 |
| dev x1 | 2000 | 92 | 88 | 88 | 92 | 90 | 92 |
| dev x2 | 500 | 25 | 12 | 12 | 25 | 18 | 25 |
| dev x2 | 1000 | 45 | 28 | 30 | 45 | 32 | 40 |
| dev x2 | 2000 | 78 | 60 | 60 | 75 | 78 | 80 |
| test x2 | 500 | 90 | 50 | 50 | 90 | 70 | 85 |
| test x2 | 1000 | 100 | 85 | 80 | 100 | 95 | 100 |

The max statistics (Frechet, Hausdorff) lose to the L2 statistics under the harder noise; the heading signature alone is competitive at 500 m and 2 km but not at 1 km; DTW and RMSE are indistinguishable. Full per-metric tables (top-5, not-found, confident, time) are in `work/bench-standin/bench_tables.md` (git-ignored; regenerate with the command above). Time per query (serial, alignment search plus that score's components): 0.98 / 0.71 / 0.55 / 0.40 s for L = 300 / 500 / 1000 / 2000 m; the alignment search is 0.97 / 0.70 / 0.54 / 0.40 s of it, computing all five components for every candidate adds 0.07 to 0.09 s, so the ranking metric has no cost impact (at most +3 %).

Hard negatives (rmse_rel, dev thresholds; stand-in tracks):

| split | kind | n | confident | ambiguous | no_match | note |
|---|---|---|---|---|---|---|
| dev | mirrored curvy cuts (>= 90 deg turning) | 64 | 0 % | 86 % | 14 % | 0 % confident at the original location |
| test | mirrored curvy | 32 | 0 % | 53 % | 47 % | 0 % confident at the original location |
| dev | near-straight cuts (heading within 12 deg of its mean) | 42 | 0 % | 100 % | 0 % | top-1 correct only 12 % |
| test | near-straight | 2 | 0 % | 100 % | 0 % | n too small |
| dev / test | identical shape in two library entries | 48 / 24 | 0 % / 0 % | 100 % / 100 % | 0 % | the two copies tie (ratio < 1.01) |
| dev | query from a track excluded from the library | 64 | 0 % | 83 % | 17 % | |
| test | excluded track | 32 | 0 % | 28 % | 72 % | |

Tier-1 prefilter (heading signature of the coarse windows, keep the best 50 candidates): the truth survived in 11/17, 16/18, 18/18, 18/18 queries at L = 300 / 500 / 1000 / 2000 m while cutting the time to 0.19 / 0.24 / 0.36 / 0.65 of the full run. **It loses the true candidate at short lengths, so it is not enabled by default** (`prefilter_k=None`); the option exists and the recall is measured as above.

Where it fails (top-1 % at level x1 by the total absolute turning of the true cut, rmse_rel; n in brackets): dev, 0-45 deg: 4 % (23) at 300 m and 0 % (13) at 500 m; 45-90 deg: 11 / 33 / 27 % at 300 / 500 / 1000 m (9, 9, 15); 90-180 deg: 50 / 50 / 90 / 71 % (4, 8, 10, 7); more than 180 deg: 75 / 100 / 100 / 97 % (4, 10, 15, 32). Test (Catalunya stand-in) has almost only high-turning cuts (80 / 100 / 100 / 100 % for >180 deg). Confident answers occur almost only for > 180 deg of turning.

Real-video noise against unrelated roads (negative control, the only real video-derived runs that were possible): the two GPX-free trajectories (336 m and 648 m) against the stand-in library (504 and 259 candidates; their roads are not in it): both `ambiguous` under rmse_rel (gap ratio 1.32 and 1.003), best relative RMSE 1.55 % and 1.31 % with implied scales 1.17 and 0.80, none confident. For comparison, correct top-1 answers on the synthetic level-x1 queries have a median best score of 0.9 % (300 m) to 0.5 % (2 km). So unrelated real roads fit a 300 to 650 m video trajectory to about 1.3 to 1.6 % of its length, only about twice the score of a true match.

### Real-video queries with truth: not run

`rsm/bench/real_video.py` implements them (the two GPX-free trajectories against the library of all three GPX tracks; truth = the GPX arc interval between the video's first and last time; rank, scores, gap and status for every score; the runner is tested with a stubbed reconstruction) and is invoked by `python -m rsm bench`. It needs the FR_* tracks. When run it is circular: the error model is calibrated on these same two pairs.

### Known failure cases

1. **Short and gentle cuts.** Under the assumed noise, cuts with less than about 90 deg of total turning are mostly not found at 300 to 1000 m (top-1 0 to 33 %, near-straight 12 %), and never confident. Why: a gentle path is, within the noise, close to a segment of many other roads; the correct answer is not even better scored: on the stand-in benchmark the median best score of WRONG top-1 answers (0.5 % of length at 300 m) is lower than that of correct ones (0.9 %), so the absolute score cannot be used to accept a match, only the gap to the next distinct candidate can.
2. **Noise level.** Doubling lateral noise and drift roughly halves dev top-1 at 500 to 1000 m (42 to 25 %, 70 to 45 %).
3. **Duplicates and parallel roads.** Identical shapes tie by construction and are reported ambiguous, never resolved. Mirrored or reversed shapes are not matched by default but a reversed candidate still scores weakly rather than not at all (more than 5 times worse than the right direction in the unit test on synthetic roads).
4. **Search flatness.** The relative residual is nearly flat along smooth shapes: the fitted scale and window offset are only as precise as the refinement (about 1 % scale after `refine_top=3` on a noise-free pair); the "implied scale" of a match is an estimate, not a measurement. 1.25 % of the stand-in top-1 answers sit on a scale bound (flagged).
5. **Coverage.** At 300 m 8 % of the dev queries have the truth in no distinct entry (library windows or non-maximum suppression); the library, not the matcher, limits recall there.
6. **Prefilter** (above) drops the truth at 300 to 500 m.

### Is shape alone enough at length X? (preliminary, stand-in evidence only)

Not answerable for the Pennes, Menglonnais and Rousset roads from this phase. What the stand-in run supports, conditional on its assumed noise and on 86 km of library: the answer depends on how much the stretch turns more than on its length. Cuts with more than about 180 deg of total turning were found at top-1 >= 75 % from 300 m and >= 97 % from 500 m, and were the only ones with confident answers; cuts with less than 90 deg were not reliably found even at 1 km. Within a single 86 km library at 2 km the dev top-1 was 92 % (78 % at doubled noise) with 0 confident-and-wrong answers among 160 dev and 80 test main queries per noise level, which bounds that rate only to a few percent (rule of three: < 3.75 % at 95 % confidence for 80 queries). Library size matters (the dev score at 300 m with 565 candidates against the test score with the same library but a more distinctive track), and Phase 3's OSM candidate sets will be larger. Decide Phase 3 after the real calibration and real-road benchmark, not from these numbers.

### Deviations and things to know

- `tests/gpx_fixture.py` now re-exports `rsm.bench.gpx` (the GPX loader and `gpx_window` moved into the benchmark package; gpxpy stays out of `rsm.core`). `requirements.txt` gained `shapely`; `requirements-bench.txt` (gpxpy, dtaidistance) and `requirements-dev.txt` (pytest, scikit-image) are separate.
- With the GPX files gone, the six Phase 1 real-data tests that read them (and the two new Phase 2 ones) now skip; the Phase 1 handedness numbers in this file were measured earlier and are not re-verified here.
- The distinctness rule is the brief's (same `origin_id`, window overlap > 50 %), generalised by `origin_id`/`origin_offset_m` so overlapping library cuts of one road count as one place; without that every query would be "ambiguous" against its own neighbouring library entries (tested).
- Thresholds are derived on the dev split by `benchmark.tune` inside the same command that then applies them to the test split, so the freeze cannot be skipped; the stand-in dev/test split was fixed before running (roles in `tracks.ROLES`).

## Real data: sample videos (GPX-free relative trajectories, 2026-11-09)

Input: the three third-party videos in `experiments/road-reconstruction/sample_videos/` (never committed; `work/` and `routes/` are git-ignored). Pipeline: `backend reconstruct ... --only preprocess camera_tracking alignment --set use_gpx=0 scale_source=camera_height`, then `rsm trajectory --from-reconstruction`. No GPS, no GPX, no map was used; location hints below were read off the screen only and are **not** matcher input and **not** ground truth. Measured on an M3 Pro; up to three jobs ran concurrently, so wall times are inflated.

### Input problems found
- **Gotthard file is truncated.** `ffprobe` reports 41:27, but the bytes after about 603 MB (of 627 MB) are zeros; `ffmpeg` decodes cleanly only to 16:04 (964 s), then "Invalid NAL unit size". Only 0 to 964 s is usable. This cuts off the southern Tremola hairpins; the part that survives is the Andermatt town and the road up to the cobbled stretch near the top (cobbles from about 740 s).
- Gotthard and Cayolle both start with a Google Earth route-map intro (0 to 20 s); one scene cut at 20 s in each (scene > 0.3, 2 fps scan over the whole decodable file). Amalfi: no full-file cut scan (VP9 10-bit 1440p60 decodes at ~5x real time uncontended; two attempts were aborted for compute). Amalfi was scanned only in its chosen window: no cut in 780..960 s (the next cut is at 989 s). Chosen windows of Gotthard and Cayolle were scanned at full frame rate: no cuts.
- `preprocessing.py` normalises through ffmpeg (`fps=30, scale=min(1280,w)`), so 1080p50 and 1440p60 work. `.mkv` works. The Amalfi HDR (PQ, bt2020) is **not tonemapped** (frames look flat and dark); SIFT still works (977 of 977 keyframes registered). Cayolle 640x360 is decoded at native size.
- Camera: wide angle on all three (focal about 0.56 x width). Cayolle: handheld/bike-like shake. Gotthard: car/vehicle height.

### Stretches (turn = of the camera path, 1 m resample, 3 m smoothing; hairpin = disjoint 10 s windows with |heading change| >= 120 deg; "registered" = keyframes in the kept model)

| route | video, start, dur | registered | models | length | net / abs turn, hairpins | up_method (vertical-line inlier share) | verdict |
|---|---|---|---|---|---|---|---|
| amalfi-780 | Amalfi, 780 s, 180 s | 977/977 | 1 | 1096 m | +165 / 1295 deg, 1 | vertical lines (0.49) | **good**: one model, reproj 0.33 px, scale IQR 0.11, no gaps; best of the set |
| gotthard-600 | Gotthard, 600 s, 180 s | 587/587 (a 9-image duplicate fragment is a 2nd model) | 2 | 1391 m | -4.5 / 909 deg, 2 | trajectory plane (0.21) | usable shape; z unreliable; gaps up to 20 m / 2.4 s (7 gaps > 10 m: sparse keyframes at ~8 m/s on straights, not tracking loss); long and S-bend rich but net-straight |
| gotthard-450 | Gotthard, 450 s, 90 s | 201/277 | 2 | 499 m | -98 / 358 deg, 0 | trajectory plane (0.12) | **split**: kept model covers 450..503 s only (53 s); scale IQR 1.44, scale untrustworthy |
| cayolle-2850 | Cayolle, 2850 s, 150 s | 594/870 | 3 | 441 m | -67 / 691 deg, 2 | trajectory plane (0.21) | **split** (kept 2887..2980 s); superseded by the dense run |
| cayolle-2850-dense | same, `keyframe_flow=0.012 match_overlap=15` | 895/1194 | 2 | 575 m | -78 / 750 deg, 2 | trajectory plane (0.19) | split, kept 2887..3000 s (113 s of 150 s); best Cayolle result |
| cayolle-4000 | Cayolle, 4000 s, 90 s | 329/559 | 6 | 210 m | -127 / 400 deg, 1 | trajectory plane (0.33) | **split**, kept 50 s |
| cayolle-4000-ov25 | same, `match_overlap=25` | 329/559 | 7 | 213 m | -122 / 406 deg, 1 | trajectory plane (0.33) | no gain from overlap |
| cayolle-4000-dense | same, dense keyframes | 625/744 | 2 | 167 m | -344 / 559 deg, 2 | trajectory plane (0.24) | kept 4000..4075 s; **fx 367 vs fy 186 px** (degenerate refined intrinsics) and a small loop artefact at the end (~4070 s): shape matches the sparse run for 4000..4060 s, length does not (167 vs 210 m: camera-height scale, IQR 0.57) |
| cayolle-1630 | Cayolle, 1630 s, 90 s | 148/521 | 6 | 111 m | +186 / 191 deg | trajectory plane | **failed** (21 s kept) |
| cayolle-1630-dense | same, dense keyframes | 454/695 | 5 | 313 m | +141 / 529 deg, 1 | trajectory plane (0.26) | **split**, kept 1664..1720 s (56 s); fx 380 vs fy 434 px; weak |

Stretches that split into several models are **not** one trajectory; the table gives the largest model only, nothing was stitched. Recommended variants: Amalfi 780 (as is), Gotthard 600 (as is), Cayolle 2850 **dense** (denser keyframes registered 895 vs 594 images and covered 113 vs 93 s; the same turn events appear in both runs), Cayolle 4000 sparse or dense only for the first 60 s. Planned but not run (budget): `amalfi-70` (120 s) and `amalfi-1040` (70 s), cancelled after the first Amalfi run took 22 min of tracking. Per video, 2 stretches (Amalfi 1) were reconstructed instead of 2 to 3.

Compute (wall, contended): Amalfi-780 about 25 min (preprocess 107 s, tracking 1314 s, alignment 44 s); gotthard-600 19 min; gotthard-450 16 min; cayolle 2850 / 4000 / 1630 sparse: 9 / 3.5 / 4 min; dense reruns 4000: 11 min, 2850: 13 min. Survey (cut scans, contact sheets, yaw scan) was roughly another 40 min, of which two aborted Amalfi full scans were wasted.

### Handedness spot-checks (manual, frames compared with the trajectory turn sign; left positive)
- Gotthard 600: 654..662 s predicted left 131 deg, frames show a left bend (3 of 3 frames); 636..644 s predicted right 125 deg, frames show a right bend with a right-pointing chevron. Consistent.
- Gotthard 450: 469..477 s right (consistent), 484..492 s left (first two frames consistent, third frame curves right: mixed).
- Amalfi 780: 784..792 s left 95 deg (chevron signs point left: consistent); 832..840 s right 84 deg (consistent); 928..936 s left 88 deg (frames ambiguous, not confirmed).
- Cayolle 2850: 2947..2955 s left hairpin 175 deg, 2888..2896 s right 97-101 deg: frames are shaky and the check is weak (consistent but not conclusive); the dense and sparse runs agree on the sign of the same events.
The check is visual and small (about 10 events); it is not a statistical test.

### Total turn caveat
Net turn hides shape: gotthard-600 nets -4.5 deg over 1.39 km but has 909 deg of absolute turning and 2 hairpin-scale episodes; Amalfi-780 nets +165 deg with 1295 deg absolute. Use absolute turning and hairpin count together with net turn when choosing matcher queries.

### On-screen location hints (video time; hints only, unverified; the user must confirm before any use as truth)
- Gotthard: 0..20 s Google Earth route map (red line over an Alpine region); 60..170 s a town street scene: "POST Hotel & Residences" hoarding (~75 s), "Meyer's Sport" shop front and Swiss flags (~150 s); ~440 s a tunnel; from ~740 s cobbled road with wind turbines and snow patches (looks like the summit area). The video title (file metadata) names Gotthard Pass; the town is presumably Andermatt.
- Cayolle: 0..20 s Google Earth route map with a red line; 25 s village street with a "P" parking sign, 60 s village main road; 1500 s a village; the upper part (~2850..3050 s) has switchbacks with low stone walls; ~5700 s onward valley road and houses.
- Amalfi: 30 s "AMALFI" painted on the road; ~810 s a "3 km" zigzag (winding road) warning sign, a sign reading "ERCHIE" at ~792 s; chevron curve signs throughout; tunnels at about 1120 s, 56 min and 63 min; a cyclist and motorcycles appear around 20 to 25 min.
These were read from small frames; the "ERCHIE" and "P" readings are low resolution guesses.

### Limits
- Scale comes from the assumed camera height 1.1 m (`scale_source=camera_height`). Gotthard is probably a car (camera higher), Cayolle is probably a bike or hand-held, Amalfi unknown. Implied speeds: Amalfi 6.1 m/s, Gotthard-600 7.8 m/s, Cayolle 2850 about 4.9 m/s. The matcher's 0.7 to 1.4 prior has not been tested against these (no ground truth); scale IQR ranges 0.11 (Amalfi) to 1.44 (Gotthard-450).
- 4 of 5 chosen Cayolle/Gotthard stretches split in COLMAP; only Amalfi-780 and Gotthard-600 are whole. Gravity was observed only for Amalfi (vertical lines); everywhere else `z` is unreliable, `z_reliable: false`.
- The car vs bike difference means a car video's camera path follows the lane, not a cyclist's line.

## Odometry vs COLMAP (vms yaw and relative speed as a whole-video shape source, 2026-11-09)

Question: can the per-frame yaw and relative speed of `video-motion-speed` (vms) give a fast whole-video shape (heading, turns, a dead-reckoned path) and how does it compare with the slow COLMAP route? Data: Gotthard and Cayolle from `road-reconstruction/sample_videos/` only; no GPS. COLMAP reference: the existing reconstructions gotthard-450/600, cayolle-1630/2850/4000/4000-dense (not re-run), each model on its own. Code: `rsm/odometry/` (numpy/scipy only, does not import vms), `rsm/bench/{colmap_export,odo_colmap,odo_compare,odo_matcher}.py`, `tests/test_odometry.py` (11 synthetic tests; full suite 167 passed, 7 skipped = the FR_* tests). Commands in the README. All derived data, frames, tables and the overview figure are in git-ignored `work/odometry/` (`RESULTS.md` there has every table). Implemented by Sonnet, reviewed by Opus; the review changed two conclusions (marked **review**).

**Answer in one line:** vms gives the sign of every bend cheaply over almost the whole video (21/21 COLMAP-matched turns and 11/11 hand-checked bends agree in sign; 20 deg median angle error), but its heading drifts by 5 to 25 deg per 100 m and its distance scale is off by up to 2x, so the dead-reckoned path is **not** a usable shape for the matcher: the matcher never ranked the COLMAP twin first (0 of 58 queries confident).

### Runtime

vms motion, unchanged code, 360 rows, every frame; the two videos ran concurrently on an M3 Pro.

| | video analysed | wall | per video minute | note |
|---|---|---|---|---|
| Gotthard (1080p50 H.264) | 964.3 s (whole decodable video stream; see below) | 288.3 s | **17.9 s** | 48212 pairs; 1080p decoding plus 50 fps |
| Cayolle (360p25 H.264) | 5889.3 s | 723.4 s | **7.4 s** | 147231 pairs |
| odometry stage (`rsm odometry`) | | 0.4 / 0.9 s | | |
| COLMAP, for comparison (`work/logs`, up to three jobs concurrently) | 90 to 180 s windows | 212 to 1136 s | 141 to 637 s | covers a window, often split into several models |

vms is about 20 to 80 times faster per video minute and covers the whole video. The Gotthard file's video stream is 964.34 s long (`ffprobe` stream duration; the audio and the container run 2486.6 s), as found earlier; vms stopped there with "Invalid NAL unit size".

### Conversion and gating

- **Yaw:** omega = +yaw / f360 rad per frame pair, left positive. The sign was derived from the flow model and confirmed by COLMAP (heading increments correlate +0.70 to +0.98 in all 12 windows) and by frames (below).
- **Focal length (px at 360 rows), from COLMAP self-calibration of the same video:** Gotthard 403.5 (fx 400.1 and 406.9 from the two reconstructions, i.e. ±0.8 %); Cayolle 370.5 (fx 357.5 to 374.8, about -3.5 / +1.1 %). The fy values disagree with fx by up to 12 %, and cayolle-4000-dense has a broken fy of 185.5 px; fx is used because yaw flow is horizontal. The `focal_prior` (0.55 × width) is not used.
- **Gating:** vms's own criteria and constants are used: at least 20 inliers, rms at most 2.0 px, scene cut at 4x the 61-pair median frame difference and above 25 (±7 pairs), speed spike 0.35, no negative speed. The first 20 s (map intro) are excluded by hand. Any unusable run of 0.5 s or more, or any cut, splits the stream; shorter runs are bridged within a segment (13.9 % of Gotthard's and 9.0 % of Cayolle's usable time). Nothing is bridged across a split. Minimum segment length is 10 s.
- **Distance:** k = f360 × 1.1 m (COLMAP's camera-height assumption), so distances are nominal metres with scale prior 0.7 to 1.4. Turn angles do not depend on k; turn lengths and positions do.
- **Turn detector:** not tuned on COLMAP. It smooths with sigma 6 m, enters a turn at 0.6 deg/m and exits at 0.3 deg/m, merges turns less than 25 m apart, and keeps turns of at least 25 deg and 10 m. No parameter sweep was run.

### Coverage

| | strict (any bad pair splits) | used (gap ≥ 0.5 s splits) | segments (used) | segment length min / median / max | nominal path |
|---|---|---|---|---|---|
| Gotthard (944 s after the intro) | 47.4 % | **89.9 %** | 16 | 11 / 22 / 208 s | 4.1 km |
| Cayolle (5869 s after the intro) | 23.7 % | **87.1 %** | 131 | 10 / 26 / 275 s | 14.8 km |

The main reason for drops is fit rms above 2 px: Cayolle has 14 % of pairs above it (median rms 1.42 px at native 360p) against Gotthard's 10 % (median 0.39 px). There are no scene cuts after the intro. Gotthard's three cut flags (192.0, 193.8, 194.2 s) are false positives in a fast village turn, and they split a segment. Coverage is high, but the segments are short (median 22 to 26 s, about 100 to 200 nominal m). There is no way to register segments to each other, so the "whole-video path" is a chain of unregistered pieces.

### Accuracy against COLMAP (12 windows: 6 kept models plus 6 other models with at least 60 images and a camera-height scale)

| window | COLMAP length | heading RMS after offset (deg) | drift (deg/100 m) | vms / COLMAP length | turns C / vms / matched | sign | path RMS / length after similarity fit |
|---|---|---|---|---|---|---|---|
| gotthard-450 | 499 m | 11.3 | 21.5 | 0.52 | 5 / 3 / 3 | 3/3 | 4.9 to 6.7 % |
| gotthard-600 | 1391 m | 40.3 | 6.7 | 0.77 | 8 / 7 / 5 | 5/5 | 2.7 to **12.8 %** |
| cayolle-1630 | 111 m | 10.7 | -19.3 | 0.55 | 1 / 1 / 1 | 1/1 | 2.6 % |
| cayolle-2850 | 441 m | 21.0 | 5.3 | 0.69 | 4 / 4 / 4 | 4/4 | 2.5 to 5.7 % |
| cayolle-4000 | 210 m | 12.1 | 18.0 | 0.47 | 2 / 2 / 2 | 2/2 | 3.2 % |
| cayolle-4000-dense | 167 m | 9.8 | 17.8 | 0.84 | 2 / 3 / 2 | 2/2 | 1.8 to 2.7 % |
| 6 other models (41 to 105 m each) | | 2.9 to 14.5 | -24 to +100 | 0.49 to 1.27 | 7 / 4 / 4 | 4/4 | 1.2 to 3.4 % |

- **Heading:** COLMAP heading is the yaw of the camera's optical axis. The path-tangent heading gives similar or larger RMS: for example 16.8 and 41.7 deg on the two Gotthard models.
- **Turns:** COLMAP has 29 turns and vms 24; 21 are matched, 8 missed and 3 extra. All 21 matched turns agree in sign. The angle error (vms − COLMAP) has median absolute 20 deg and mean absolute 28.3 deg, with a mean signed relative error of −12 %. For the 12 turns of at least 60 deg, the median relative error is 15 %. One match (cayolle-1630/m1, 171 deg error) is an artefact of the greedy time-overlap matching, which paired one vms turn with one of two COLMAP turns.
- **Length:** vms nominal length / COLMAP length is 0.47 to 0.84 in 10 of 12 windows, so 8 of 12 are below the 0.7 floor of the prior. Both sources use the same 1.1 m height assumption, so this is a disagreement between the two methods, not an error against truth. Phase 1 found COLMAP's camera-height scale about 1.2x too long against GPX on other videos.
- **Independence:** the windows are not all independent. 4000 and 4000-dense overlap in time.

**Focal sensitivity:**
- Turn angles scale as 1/f. Within the COLMAP fx spread (Gotthard ±0.8 %, Cayolle −3.5 to +1.1 %), angles move by at most 3.6 %. That is much less than the 20 deg median error, so **the focal-length assumption is not what limits accuracy**. Rerunning at f_low and f_high changed gotthard-600's mean turn error from 17.4 to 17.5 deg.
- The best-fit f from regressing vms yaw on COLMAP rotation (2-s increments) is 433 and 472 on Gotthard (nominal 403) and 245 to 422 on Cayolle (median 354; nominal 370). The 95 % confidence intervals are 100 to 500 px wide, so they neither confirm nor refute the nominal f.
- The vms **horizon** matters far more. Cayolle's horizon calibration is poor: row 112 with IQR 86 px, against about 20 px in the vms FINDINGS and 35 px for Gotthard. Rerunning two Cayolle clips with the horizon at row 180 instead of 112 moved the length ratio from 0.47 to 0.79 and from 0.69 to 1.12, and the best-fit f from 354 to 447 and from 368 to 549. That is two clips of one video: it shows the dependence, not a setting.

### Hand check of the turn sign

The implementer extracted frames across 13 bends and looked at them; I re-viewed one Gotthard and one Cayolle peak strip. 11 bends were decided and all 11 agree with the vms sign. Two are undecided (Cayolle 1032 s village street, 3920 s). Frames are in `work/odometry/frames/`.

| video | bend (s) | vms angle (deg, left +) | visual |
|---|---|---|---|
| Gotthard | 57-75 | -98 | right |
| Gotthard | 130-153 | -125 | right |
| Gotthard | 483-492 | +95 | left |
| Gotthard | 575-591 | -164 | right |
| Gotthard | 728-744 | +96 | left (but see the failure case below) |
| Cayolle | 1725-1738 | +184 | left |
| Cayolle | 2568-2594 | +192 | left |
| Cayolle | 2756-2785 | -287 | right (hairpin) |
| Cayolle | 3018-3033 | -192 | right |
| Cayolle | 3657-3699 | -178 | right (moderate confidence) |
| Cayolle | 4819-4834 | -141 | right |
| Cayolle | 1032-1053 | +248 | undecided (village street) |
| Cayolle | 3920-3968 | +163 | undecided (change too small to see) |

### Matcher: is the vms path the same shape as the COLMAP path?

`rsm.core.matcher.match` was run with rank_by `rmse_rel` and the dev thresholds (gap ratio 3.66, max score 0.0204). The stand-in candidate library had 299 to 1464 candidates. Five windows had a vms piece of at least 150 m.

- **Test (i):** COLMAP path as the query, against the longer vms segment plus the stand-ins. The twin ranked 499, 146, 88, 141 and 43.
- **Test (ii):** vms path as the query, against COLMAP plus the stand-ins. The twin ranked 54, 41, 7, 12 and 24.
- **Wide prior:** widening the scale prior to 0.35 to 2.8 gave ranks of 3 to 138.
- **Scores:** the twin scores 0.7 to 7.6 % of length; the best unrelated stand-in window scores 0.15 to 1.7 %. All 20 (i)/(ii) queries were `ambiguous`; none was confident.
- **Control (iii):** 38 vms windows from other times ranked the COLMAP candidate 6 to 575, so there is no signal either way.

**The matcher does not treat the two sources as the same shape.** The measured odometry error (heading RMS 10 to 40 deg, drift 5 to 25 deg/100 m, length off by up to 2x) is far outside the stand-in benchmark's assumed error (2 deg/100 m), and unrelated real roads fit better than the true twin.

### Failure cases (observed)

- **Gotthard 663-756 s, close rock wall on the right** (the worst window: 12.8 % path residual, net turn vms +145 deg vs COLMAP +51 deg). **Review:** the implementer's note that "the hand check supports vms" there is wrong. My frames every 2 s show a left bend at 728-734 s, then a clear right bend at about 744-750 s. COLMAP has both (−24 deg over 730-756 s, with rotation and path-tangent heading agreeing to within 11 deg), while vms reads +19 deg. vms over-reads the left and misses the right. I tested the "wall points inside the road mask" hypothesis by rerunning vms on 660-760 s with the road trapezoid narrowed from 0.8 to 0.4 of the width. The vms code was unchanged; only its existing `road_width` parameter was set for the run. It did **not** help: net +230 deg, with 9 % of pairs now without a fit. The rerun with 0.8 reproduces the full run exactly. Cause unknown.
- **High fit rms at low resolution:** all 16 Cayolle gaps of 3 s or more are high-rms runs, for example 5054-5060 s with a rock wall filling the right half of the frame. Cayolle's median rms is 3.6x Gotthard's.
- **Fast turn read as scene cut:** Gotthard 192-194 s. The frame-difference criterion of vms fires on fast yaw.
- **Poor horizon calibration** (Cayolle, IQR 86 px): this drives the distance scale and probably the heading scale (see above).
- **Standstill:** one 3.6 s run in Cayolle (2490.9 s). Rotation while standing is integrated into heading.
- **Not observed:** lane changes, deliberate camera pans and tunnels were not identified. Nobody searched the whole videos for them, so their absence is not evidence. A car's lane change would show as a short S in the path-tangent heading but not in yaw.

### Recommendation

- **Whole-video shape:** use vms for the **turn sequence**, not for a dead-reckoned path. That means the sign of each bend, its approximate angle (±15 to 20 %), and its rough spacing in nominal metres within a segment. This is cheap (7 to 18 s per video minute), covers about 88 to 90 % of the video, and its sign has been right in every checked case. A turn-sequence comparison is the "topology" component the proposal already describes (§6). Do not feed vms paths into the shape matcher with the current error level.
- **Local detail:** use COLMAP where it registers, for metric shape over 100 m to 1.4 km windows. Its gaps and model splits are the price.
- **Before vms paths could be used as shapes:** fix the horizon calibration (per segment, or rejecting the 86 px IQR case), find the Gotthard 663-756 s bias, and register short segments to each other (they are unregistered today). Then re-measure drift against COLMAP. (When this section was written, Phase 3 and OSM work had not started; the OSM proof of concept below came later, at the user's request.)

## Proof of concept: vms turn sequences against OSM (no GPS, 2026-11-09)

The user asked for this PoC: find an area in OSM from the video name, derive turn sequences from the map, and test whether the vms turn sequences can be related to them. Code: `rsm/core/turnseq.py` (turn-sequence matcher), `rsm/network/` (area, graph, path enumeration), `rsm/bench/poc_join.py` and `poc_guide.py`. Outputs: `work/osm/`, `work/turnseq/`, `work/poc/RESULTS.md` (git-ignored). Map data: Geofabrik Switzerland (user-approved download) and a local PACA extract (read-only); © OpenStreetMap contributors, ODbL. Tests: 200 passed, 7 skipped.

**Verdict: no demonstrable link.** With the current vms turn quality, the video blocks cannot be placed on the map, and this run does not identify the true road.

### Setup

- **Area:** a Nominatim lookup of the video name, then a radius of 2 × the vms nominal length.
  - Gotthard: R 8.2 km and 136 km of road.
  - Cayolle: R 29.7 km and 1421 km of road. Residential and living_street ways were removed so that path enumeration stays feasible; this is an assumption.
- **Queries:** vms turn sequences in blocks of 1, 2 and 4 km (Gotthard) and 1, 2 and 5 km (Cayolle). Segments are never split.
- **Candidates:**
  - Complete path sets where feasible (Gotthard 10 km: 1.53 M paths).
  - Otherwise a tolerant guided enumeration (recall 83–100 % on synthetic queries at the measured error level, lower under stress).
- **Thresholds:** primary (5 nats gap, evidence 2); the (10, 4) setting is post hoc.

### Results

- **Offline matcher (stand-in library):** top-1 is 24 % at 1 km, 44 % at 2 km, 69 % at 5 km and 82 % at 10 km. It falls from 55 % to 40 % when the library grows 16 times.
- **Positive control** (synthetic truth in the real map, measured error model):
  - Cayolle top-1: 8/30 at 1 km, 7/30 at 2 km and 9/12 at 5 km (5/12 confident-correct, 0 confident-wrong).
  - Gotthard top-1: 3/30 at 1 km and 6/30 at 2 km.
  - Top-1 rises with the number of turns: 11/16 with 16 or more turns.
- **Model mismatch:** real vms shows about 13 observed turns per nominal km on Cayolle and 7 on Gotthard, while the generator gives 4–7. With a "dense" generator that matches the real density, Cayolle 5 km is found in 0/12 cases. The positive control is therefore optimistic.
- **Real queries:**
  - Cayolle: 0/23 blocks confident.
  - Gotthard: 1/6 blocks confident. This is segments 13–15, the last 314 s of the video, matched to Gotthardstrasse (ref 2) then Tremolastrasse south of Andermatt. That hit is fragile:
    - Its evidence of 2.8 equals the median of synthetic true routes and lies inside the range of the other video's blocks (max 9.9).
    - It becomes ambiguous when the area grows to 3R (post hoc).
    - No other block agrees with it.
- **Consistency of consecutive blocks:** consecutive top-1s land at connected places in 0/3 Gotthard links and 0/20 Cayolle links. Nesting is 2/7 vs 2/6 in the null (Gotthard) and 2/25 vs 1/151 (Cayolle). With 0 observed against a null near 0, this test has little power.
- **Negative controls:**
  - Mirrored queries: 0 confident. However, Cayolle mirrored blocks score as well as real ones (median evidence 3.1 vs 2.1), which means there is no signal.
  - The other video's blocks in each area: 0 confident.
- **Hint roads:** the share of top-1 places on the named road is at or below its base rate: Gotthard 2/6 vs 39–47 %, Cayolle 0/23 vs 8–11 %.

### Review notes

- The single confident Gotthard block rests only on its gap, not its evidence, so it is not counted as a success. It is listed for the user to confirm; it is not declared true.
- Every short block (1–2 km) is weak even under the positive control, so the negative real result for short blocks carries little information.
- The deciding problem is the extra-turn rate of vms: about twice the synthetic rate. Long blocks drown in extras.
- Open limits:
  - The Cayolle network restriction (no residential ways).
  - Small n in the controls.
  - Evidence is not calibrated to the real vms errors.
  - A single seed.

### What would change the outcome

1. Cut vms false turns (stricter turn detection, or confirming each turn with COLMAP where it registers), then re-measure the extra rate.
2. Calibrate the generator to the real turn density and re-run the positive control.
3. Get one ground-truth route, confirmed by the user or from a video with GPS, to calibrate evidence and thresholds.

## vms turn detection calibrated against GPS (Van Gestel videos, 2026-11-10)

The user provided three videos with matching GPS tracks: Grimone, Roanne and Rousset (CC BY-NC-SA 4.0, AV1 720p30, read in place). These are the FR_* tracks that vanished earlier. Outputs are in `work/vangestel/` (git-ignored): RESULTS.md, calibration.json, frozen_params.json, variants.jsonl (378 variants).

The ground truth is cut into **quanta** of turn, straight, turn from the GPS track. A quantum is **intact** when:
- both turns are found by vms with the right sign,
- both angles are within ±25 %, and
- no extra turn of 45° or more lies in between.

Grimone and Roanne were used for tuning (DEV). Rousset is the TEST video: everything was frozen first, then Rousset was run once.

**TEST, Rousset, 97 quanta at the 45° threshold** (reviewer recount from `results/col-de-rousset/quanta_*_45.csv`):

| config | intact, all 97 | intact, 77 covered by refined | extras/km | median angle error |
|---|---|---|---|---|
| vms unchanged, nominal f 403.5 | 22.7 % | 22.7 % | 1.08 | 23 % |
| vms unchanged, f 449 (fitted to GPS on DEV) | 45.4 % | 51.9 % | 0.76 | 11.5 % |
| refined (horizon row +24 px, road mask 0.5, f 449) | 46.4 % | 58.4 % | 0.48 | 13.5 % |

### Findings

- **The focal length is the main lever.** Fitting f to GPS doubles the share of intact quanta on TEST, from 23 % to 45 %.
  - f also differs per video: the GPS-fitted values are about 410 (Grimone), 485 (Roanne) and 500 (Rousset).
  - A fixed calibration therefore leaves 8–13 % angle error. Nothing in the vms output predicts the per-video f.
  - A runtime calibration with COLMAP on a few segments per video can measure this per-video f.
- **Cause of the drift.** The vms horizon row is about 24 px too high for the yaw estimate. The lateral flow term then leaks into yaw, and the bias scales with speed.
  - On a Roanne clip the bias was +0.78, +0.50 and −0.10 deg/s at horizon rows 145, 173 and 200.
  - With the offset, long-term drift is about halved: Rousset heading error at segment end fell from 27 to 12° per 100 s.
  - Over 5400–9600 s on Rousset the baseline drifts by several hundred degrees and the refined run follows GPS (`figs/heading_col-de-rousset.png`).
  - For quanta this matters little, because quanta are local: +1 point on all 97.
- **Walls beside the road swallow turns.** A narrower road mask fixes them but loses fits: refined usable time is 93.1 % against 99.9 %. On TEST, this coverage loss eats the gain.
- **Most extras are gentle bends read too strongly.** 51 of 67 extras are GPS bends of 25–45° that vms reads as 45° or more. The vms density of turns ≥ 45° is 1.0–1.3× the GPS density, not 2× as feared in the PoC.
- **Ceiling.** Removing the GPS-known low-frequency heading error from the baseline gives only 53–57 % intact on DEV. The rest is short-term noise plus the strict ±25 % criterion. With this vms, about half of all quanta will stay imperfect, so the matching must tolerate faulty quanta (voting, not exact lookup).
- **Distance scale.** The vms/GPS ratio differs per video (0.91 / 0.98 / 1.15 at fixed f). Absolute metres do not transfer between videos; ratios within a video do.
- **Caveats:**
  - GPX time is not exactly the video time; the lag was corrected per 300 s window (up to ±1.8 s).
  - GPS is erratic in the Grimone gorge.
  - The DEV numbers come after about 400 variants and are optimistic.
  - On the Gotthard and Cayolle COLMAP windows the refined setup has better angles (mean abs error 28 → 19°, misses 8 → 1), but Gotthard coverage fell from 90 % to 61 %, and the +24 px offset does not carry over to a different horizon.
- **Code:**
  - Two opt-in vms flags, `--horizon-offset` and `--road-width`; defaults are unchanged and the old output was reproduced on a clip.
  - `rsm odometry --calibration`.
  - Tests: 201 passed, 7 skipped.

### Next steps

1. Fall back to the wide road mask where the narrow one loses its fit, to get the coverage back.
2. Measure f per video at runtime from COLMAP segments, and re-run TEST with that.
3. Then test quanta matching with voting against OSM; a local Rhône-Alpes extract covers all three routes.

## Turn quanta against OSM with GPS truth (Van Gestel videos, 2026-11-10)

**Question.** Do windows of video turn quanta (turn, straight, turn; sign, angle, scale-free length ratios) find the true OSM road?
- The search area comes from the route name alone: Nominatim, then a square with half-width min(vms length, 20 km).
- Map: a local Rhône-Alpes extract, read-only, built into 0.46–0.77 M map quanta per area in 70–120 s.
- Matching: soft-binned hash, then a Viterbi chain over the window with skip states for faulty quanta.
- GPS is used for scoring only.
- Tuning on Grimone and Roanne (DEV); Rousset (TEST) run once on the frozen code (hash 43448aa7a7b2).
- Code in `rsm/quanta/`, outputs in `work/quanta/` (RESULTS.md, figures with OSM attribution). Tests: 206 passed, 7 skipped.

**TEST (Rousset, 45°).** Cells show top-1 correct / windows, then confident windows as (correct / wrong). Windows overlap.

| window (quanta) | vms refined | vms baseline f449 | GPS quanta (upper bound) |
|---|---|---|---|
| 3 | 14/98, 0 | 28/98, 0 | 58/98, (1/0) |
| 5 | 12/48, (1/0) | 17/48, (7/0) | 36/48, (10/0) |
| 10 | 6/19, (2/1) | 6/19, (5/0) | 17/18, (10/0) |
| 20 | 4/9, (2/0) | 3/9, (3/0) | 7/8, (4/0) |
| 40 | 1/4, (1/0) | 2/4, (2/0) | 3/3, (2/0) |

The baseline and GPS rows have slightly different window counts at some lengths (e.g. 125 baseline windows at L=3); the exact counts are in `work/quanta/RESULTS.md`.

**Findings**

- **First correct matches with OSM signatures without GPS input.** These need about 10–20 consecutive quanta.
  - Single quanta are useless: each matches a median of about 1000 map quanta within the vms error.
  - Both confident correct L=20 windows on Rousset lie on the hairpins of the Col de Rousset climb, the most distinctive part of the route (`figs/col-de-rousset_L20_thr45.png`).
- **The map side is not the bottleneck on TEST.** With GPS quanta, top-1 is 17/18 at L=10. The vms noise and the vms gaps are the limit.
  - On DEV the GPS upper bound is weaker (11/19 at L=10), because about 40 % of GPS quanta have no map counterpart: threshold flips, polyline detail, and straights over 2 km.
- **The decision rule does not transfer.** On TEST the controls produced confident windows:
  - one mirrored window at L=3;
  - 6 confident windows of Rousset quanta against the Grimone map, all wrong.

  All of these had many uncertain-length quanta (straights across vms gaps). A post-hoc filter (at most 30 % uncertain quanta) removes all but one, but it was found on TEST and needs new validation. **"Confident" is therefore not yet trustworthy.**
- **The refined vms (narrow road mask) is not better than the baseline with f 449 here.** It produces more gaps and therefore more uncertain quanta. The baseline gives more confident correct windows at L=5 and L=10.
- **How far until a fix.** From a random start, a confident match comes after a median of 8–13 quanta, and only 30–55 % of starts get there within 40 quanta.
- **Limits.** 4–19 windows per cell; DEV tuned; one TEST video; Roanne was centred on a landmark from the route notes, because the plain name geocodes 150 km away.

**Next steps**

1. Make the decision rule account for uncertain quanta and skips, and validate it on new data: more GPS videos, or a split by time.
2. Reduce vms gaps, or bridge them with rel_speed. Uncertain-length quanta are the main source of false confidence.
3. Then add tracking: once matched, follow the road. This is where the window results above would pay off.

## Weak candidates plus plausibility fit (user's two-stage idea, 2026-11-10)

The matching now has two stages.
- **Stage A** keeps the top K = 50 quanta chains per window as candidates, with a loose key match.
- **Stage B** fits the vms route (heading and distance, gaps kept explicit) onto each candidate map path with bounded corrections, then accepts or rejects the candidate. The corrections are: distance scale, angle scale, heading drift per vms segment, gap bridging and start offset.
  - The correction bounds come from the GPS calibration.
  - Acceptance: cost per sample at most the 95th percentile of true fits on DEV-A, plus a margin to the next accepted candidate on another road.

Tuning used the first halves of Grimone and Roanne (DEV-A, small: 10 and 54 windows). Tests:
- **TEST-B:** the second half of Grimone, fixed before any number existed. Roanne's second half has no windows. The vms calibration and prior ranges came from the whole DEV videos, so TEST-B is not fully fresh.
- **TEST:** Rousset, used as test for the second time.

Code: `rsm/plaus/`. Outputs: `work/plaus/` (RESULTS.md, figures with coloured quantum dots). Tests: 212 passed, 7 skipped.

**Decisions with the refined vms input and measured priors** (correct / wrong / no decision; windows overlap with a step of L/4):

| set | L=5 | L=10 | L=20 |
|---|---|---|---|
| TEST, Rousset | 25 / 0 / 71 | 16 / 0 / 30 | 5 / 0 / 12 |
| TEST-B, Grimone 2nd half | 12 / 0 / 32 | 7 / 0 / 12 | 2 / 0 / 4 |
| TEST with GPS quanta (upper bound) | 62 / 1 / 29 | 29 / 0 / 15 | 8 / 0 / 8 |

**Findings**

- **No wrong decision on any real window** of the refined input in either test set.
  - The fit rejected all 1366 wrong candidates on TEST and all 655 on TEST-B, and accepted 46/46 and 21/21 of the fit-able true candidates.
  - This replaces the earlier "confident" rule, which made 1 wrong decision out of 7 on Rousset and failed its controls.
- **The limit is now stage A, not the check.** About 30 % of windows get a decision. On TEST, the true chain is among the 50 candidates in 91 of 159 windows, but only 46 have at least 3 matched quanta, which a fit needs. A larger K does not help: the limit is the video quanta.
- **Controls are not fully clean.**
  - Wrong map: 0 accepted.
  - Mirrored: 3 decisions on TEST-B, none elsewhere.
  - Shuffled (the vms route of a different time span fitted onto the true road): 2 decisions on TEST and 2 on TEST-B with measured priors, and more with loose priors.
  - Likely cause (judgement call 8 in RESULTS.md): the heading offset after a vms gap is free with no penalty, so short pieces of route fit almost anything. Penalising it unless the gap is long enough to hide a turn is the obvious fix. The mirror decisions on TEST-B were not inspected yet.
- **Correction freedom.** Looser priors do not make wrong candidates fit on real windows (1 of 1365 accepted on TEST), but they do let more shuffled controls through. The measured priors are the right setting.
- **Per-video calibration falls out for free.** Robust medians of the accepted fits give the angle and distance scale per video from video alone: f 491 / 426 / 508 against the GPS fits 485 / 410 / about 500, and distance scale within a few percent. That is the per-video focal calibration ("calibration 2") without COLMAP. As a decision filter, cross-window consistency added nothing, because almost nothing was left to remove.
- **The baseline input (f 449) is badly calibrated here** (4–12 % of true candidates accepted), because its threshold came from 5 DEV-A windows. Post hoc, with the refined threshold, it reaches 29 / 0 / 94 at L=5 on TEST.
- **Runtime:** about 0.04 s per candidate fit, 1.3–1.7 s per window.
- **Limits:** three videos; tiny DEV-A; overlapping windows; Rousset used as test twice.

**Next steps**

1. Penalise heading jumps across vms gaps and recheck the mirror and shuffle controls.
2. Increase stage-A coverage, for example 30° quanta, or accepting 2-quantum chains when the stage-B fit is strong. Coverage is now the main limit.
3. Then track along the road between decided windows.

## Whole-video route tracking from speculative anchors (user's idea, 2026-11-10)

This tests the user's idea: the whole video must fit one continuous OSM route. From every anchor (accepted plaus decisions), a beam search tracks the video forward and backward over road positions.
- **Micro-corrections:** a Kalman state per hypothesis holds heading offset, drift, angle scale, distance scale and position snap.
- **Plausibility:** the summed corrections per km.
- **Gaps:** the route may only continue within a snap radius of 20–60 m (scaled with gap length). Long gaps, stops and off-map stretches are allowed at a penalty.
- **Decision:** clusters of anchors that converge to the same route; the decided route is the cheapest member of the best cluster.
- **Split:** Grimone and Roanne are DEV; Rousset is TEST (third use).
- **Code and tests:** `rsm/track/`, outputs in `work/track/`; 218 passed, 7 skipped.

**Results** (share of video time within 30 m of GPS; junction decisions correct / wrong / already off route):

| video | code | on road | junctions | whole route right? |
|---|---|---|---|---|
| Roanne (DEV, 44 min) | frozen v1 | 100 % | 15 / 2 / 2 | yes, whole video; all 13 anchors converge |
| Grimone (DEV, 81 min) | frozen v1 | 48 % | 6 / 1 / 76 | last ~2650 s only; the first half sits on a wrong road up to 5 km away |
| Rousset (TEST, 158 min) | frozen v1 | 54 % | 4 / 0 / 66 | right until 4932 s, then lost (unmodelled U-turn at a standstill) |
| Rousset | v2 with U-turns, post hoc | 66 % (73 % on the correct edges) | 8 / 0 / 72 | right until 6790 s, then 100–144 m behind on the correct road (distance-scale drift) |

**Findings**

- **The idea works where the video quality holds.**
  - Roanne is matched end to end without GPS.
  - On Rousset, 32 of 35 anchors converge to the same route, and the cluster still wins clearly when 93 wrong anchors are mixed in.
  - Wrong anchors almost never reach the true road (0–4 % of time).
- **Junction decisions are good while on the true road:** 6/7, 15/17 and 4/4 (8/8 in v2). Losses come from leaving the road, not from wrong turns.
- **Failure causes:**
  1. Stretches with bad vms heading. Grimone's first 3500 s: 32 of 77 one-minute windows have rms > 15° against GPS, and there are no anchors there.
  2. Manoeuvres not in the model: the U-turn on Rousset.
  3. Along-track scale drift: vms distance is too short above about 3 m/s.
  4. The tracker itself: fed GPS as if it were vms, it reaches only 59–88 % on road, so part of the loss is in the tracker.
- **The correction sum alone is not a reliable plausibility measure.**
  - It separates true from wrong anchors perfectly on DEV (AUC 1.00) but failed on the frozen TEST (AUC 0.38; 69 % of wrong routes cheaper than the true median).
  - With U-turns (post hoc) it separates again (AUC 1.00).
  - Two other signals worked on all three videos: the length of the continuous well-fitting stretch around the anchor (AUC 0.93–0.99, found post hoc) and cluster support.
- **Consensus does not reject a mirrored video anchored on the true road.** It forms clusters of up to 11. Cost and breakdown do reject it.
- **Complementary routes are not merged.** On Rousset the second-half anchors are right where the first-half route is wrong; stitching them gives 70 % (post hoc), but it collapses when wrong anchors are mixed in.
- **TEST is not blind.** Rousset's gap statistics shaped the gap handling before the freeze; v2 was written after inspecting Rousset's truth. There is no fresh GPS video. The no-GPS demo on Gotthard and Cayolle was not done.

**Next steps**

1. Model U-turns and stops in the frozen design, and correct the distance scale with speed.
2. Combine routes from several anchor clusters into one route per video, using each where it fits best.
3. Make the tracker better on its own (test with GPS as input), then test on a fresh GPS video.

### Street View check page (2026-11-10)

`rsm/bench/verify_page.py` writes one self-contained HTML page per decided route, at `work/verify/<video>/index.html`. It is video-derived, so it stays local and is never published.
- **Layout:** for each of N video times it shows the video frame next to an embedded Google Street View at the predicted position, looking along the predicted heading.
- **Verdicts:** "same", "different" or "unclear" per row, kept in the browser and exportable as JSON.

**Roanne check** (decided v2 route, 20 points):
- The predicted points lie 4–26 m from the GPS, with headings within ±23°.
- The user checked all 20: **all screenshots match**.

This validates the page itself, and it is the verification method for videos without GPS (Amalfi, Cayolle, Gotthard).

## Tracker v3: U-turns, stops, speed-dependent scale, straight stretching (2026-11-10)

The tracker was copied to `rsm/track2/` and extended. All three videos (Roanne, Grimone, Rousset) are development data now, so **none of these numbers is a blind test**. v3 is frozen in `work/track2/frozen.json` for a blind test on new videos. The new GPS videos were not opened. Tests: 224 passed, 7 skipped.

**Decided route: share of video time within 30 m of GPS, and on the correct edges**

| video | v2 | v3 |
|---|---|---|
| Roanne | 100 % / 100 % | 95 % / 100 % |
| Grimone | 48 % / 56 % | 49 % / 53 % |
| Rousset | 66 % / 73 % | 81 % / 97 % (junctions 43 correct / 5 wrong / 11 already off route) |

**Ablation (development data)**

- **Speed-dependent distance scale: the only clear gain.**
  - The slope is fitted without GPS: Rousset +0.031 per m/s above 3 m/s, Roanne and Grimone about 0.
  - It lifts Rousset from 66 to 84 % on v2.
  - Without it, v3 falls to 56 % and the cost no longer separates true from wrong routes.
- **Straight stretching as an evenly spread correction (user's idea): neutral to negative as built.**
  - v3 without it is better (Rousset 88 % against 81 %, Roanne 100 % against 95 %).
  - On v2 it lowers Rousset from 66 to 57 %.
  - The likely reason: the tracker already adjusts the distance scale gradually, so the extra stretch cost penalises true routes as well.
  - No better form was found.
- **U-turns and stops:** no measurable gain, and false U-turns appear on the noise-free path.
- **Combining routes from several anchor clusters:** helps v2 routes (Rousset 57 → 87 %), but not v3 routes. It is robust when wrong anchors are mixed in.
- **Tracker fed with GPS heading and distance:** 97 / 56 / 95 % (Roanne / Grimone / Rousset).
  - Rousset's earlier loss was therefore mostly vms.
  - Grimone is a tracker limit. After a turn there is a 25–30 m along-track error, and at a fork of two nearly parallel branches (about 3626 s) the wrong branch fits as cheaply as the right one. The beam never recovers, and a wider beam (1000) does not help.

**Unchanged problems**

- A mirrored video anchored on the true road still forms clusters (2–12 routes); cost and breakdown reject it, consensus does not.
- On Grimone, about the first 2200 s are on a wrong road in every variant.

**Next steps**

1. Keep the speed-dependent scale; drop or rework straight stretching.
2. Fix near-parallel forks: compare both branches over a longer stretch before pruning, and use lateral position rather than along-track position at forks.
3. Run the frozen version once on the new GPS videos and on the YouTube videos with Street View checks.

## Amalfi (YouTube, no GPS): first independent test, negative (2026-11-10)

The video is "Driving the Amalfi Coast": a **motorcycle** (user, 2026-11-10; first recorded here as a car), 7630 s, VP9 1440p60 HDR. Video evidence found a priori, before any route was examined:
- **Start:** mosaic lettering "Costa d'Amalfi / Vietri sul Mare" at 29–35 s, so the video starts at Vietri sul Mare.
- **Erchie:** a road sign "ERCHIE" at 788–790 s. Vietri, Cetara, Erchie and Maiori lie east to west, so the rider goes **westwards** on the SS163. The agent's report says "east"; that is wrong.
- **Tunnels:** 9 confirmed by eye (1116, 2500, 2602, 2648, 3268, 3433, 3636, 3778 and 3964 s).

**Setup**
- Map: Geofabrik `italy/sud` (user-approved download).
- Network: classified roads only. The area was capped at 20 km after the first full-network build crashed the Mac twice. Now 16,826 directed edges; the SS163 from Vietri to Positano is inside.
- Code: `rsm/nogps/`. Outputs: `work/amalfi/`. Every heavy step ran under `tools/memguard.py` (peak 3.0 GB).

**Result: no route found.**
- Stage B accepted 22 of 452 windows, all minimal (L = 5, 3 matched quanta). They give 9 anchors, and the tracker turns them into 9 singleton clusters (no consensus).
- Cost is 108–156 per km, against 21–38 for true routes on the GPS videos. The good-run statistic is 0 s.
- The formal "decided" route runs through the Salerno hills: 6–11 km from both signs, and through 0 of 9 tunnels.
- The refined vms flags and a post-hoc f = 310 did not help either.
- The controls (mirrored video, random anchors) behave like the real run: there is no signal anywhere.

**Cause (most likely): the angle calibration does not transfer to this camera.**
- The vms heading follows COLMAP well over 780–960 s (rate correlation 0.88–0.92).
- With f 449, however, it **underestimates turning by about 1.5×**. That lies far outside the angle-scale prior of 0.85–1.25, which came from one bike camera.
- With the angles scaled wrongly, the turn quanta of the video and of the map do not agree, and the plausibility fit cannot reach the right scale inside its bounds. Its fitted value (rho 1.01) therefore says nothing.

**Lessons**
1. The angle scale (focal length) must be estimated per video over a wide range (for example 0.5–2), or from the video itself (e.g. from COLMAP on a short window), not from a prior fitted to one camera.
2. The plausibility check needs a test for "the calibration is off": consensus failure plus high cost on every anchor is that signal, and should trigger a scan over the angle scale instead of a forced decision.
3. Amalfi is now seen. A fix designed on it must be tested blind on Cayolle and Gotthard (also YouTube, different cameras), with Street View checks.

## Per-video angle calibration for unknown cameras (2026-11-10)

`rsm/angle/`, outputs in `work/angle/` (RESULTS.md). All heavy jobs ran under memguard, at most 2.5 GB peak. Tests: 234 passed, 7 skipped.

The angle scale is f_eff, the focal length at 360 rows that turns vms yaw into degrees. Three approaches were compared:
- **A:** rotation-only self-calibration from distant features, using the x²/f term of rotational flow, times a vms gain g. No GPS, no map, no AI, and 6–40 s per video.
- **B:** a short COLMAP window as reference.
- **C:** an angle-scale scan inside the plausibility matcher.

| video | reference f_eff | A [CI] | A error | B (fresh 60 s COLMAP clip) | C (scan peak) |
|---|---|---|---|---|---|
| Grimone | 390 (GPS) | 401 [387, 413] | +2.6 % | +3.1 % | not run |
| Roanne | 486 (GPS) | 449 [422, 473] | −7.7 % | −1.8 % | 505 (+3.8 %) |
| Rousset | 494 (GPS) | 502 [481, 519] | +1.7 % | +18.6 % (unrepresentative window) | not run |
| Gotthard | 447 (COLMAP) | 462 [417, 531] | +3.4 % | – | reserved |
| Cayolle, held out | 358 (COLMAP) | 361 [339, 386] | +0.7 % | – | reserved |
| Amalfi, held out | 273 (COLMAP) | 325 [309, 346] | +19.1 % | – | no signal |

**Findings**

- **A works for five of six videos (within 8 %), without any reference.**
  - On Amalfi it is 19 % too high, still far better than the fixed 449 (+64 %).
  - Cayolle's +0.7 % is partly luck: f_A is 12 % too high there and the gain g compensates.
- **Amalfi diagnosis: vms itself undercounts rotation by 20–24 %** (far-feature gain g = 0.80, COLMAP 0.76).
  - **Not electronic stabilisation:** the vms/COLMAP ratio is flat over turn rates above 4°/s.
  - **Not a radial-distortion term:** no single k1 fits all videos. COLMAP's k1 is −0.025 on Amalfi but +0.05 on Cayolle, and the k1 that would fix Amalfi breaks Roanne by −27 %.
  - The cause is open; a cropping or masking effect in the vms road region is not excluded.
- **B:** one window needs about 60 s and at least 150° of net turning. Pooling 10–20 short windows (each with at least 60° of turning) gives ±3.5 %, but this is self-consistency, not independent truth. Cost: about 7–8 min and 2.5 GB per 60 s clip.
- **C:** on Roanne it finds the right scale (accepted windows only between f 431 and 591, 0 on the mirrored control), but it was tuned there. On Amalfi it finds no signal at any scale (269–691), and the mirrored video scores the same.
- **Consequence:**
  - The old matcher prior 0.85–1.25 around 449 excludes Cayolle and Amalfi.
  - Use A's per-video estimate, and treat a wide CI (Gotthard 417–531) as a warning.
  - The COLMAP references themselves carry ±12–17 % CIs, so "under 10 %" cannot be verified better than that on the YouTube videos.

## Fable step 1: decoy decision and speed against gradient (2026-11-10)

These are the outside review's two cheap experiments (`work/ideas/FRESH_IDEAS.md`, Ideas 2 and 5). Code is in `rsm/decoy/` and `rsm/grade/`, outputs in `work/fable1/`. Tests: 238 passed, 7 skipped. All 164 pipeline runs ran sequentially under memguard (42 min, 2.9 GB peak).

**Decoy decision**

Each video got 19 block-shuffled, 19 sign-flipped and 1 mirrored decoy, each sent through the identical stage A/B and tracker pipeline. The table gives the rank of the real run with p = rank / 20:

| video | cost per km, worst family | good-run statistic (all decoys) | cluster support (all decoys) |
|---|---|---|---|
| Roanne | rank 1, p 0.05 | rank 5 | rank 5 |
| Grimone | rank 1, p 0.05 | rank 1 | rank 1 |
| Rousset | rank 1, p 0.05 (near tie: 41.1 against best decoy 42.6) | rank 9 | rank 6 |
| Amalfi | rank 8, p 0.40 | rank 39 of 40 | rank 40 of 40 |

- **Cost per km against decoys separates as hoped.** The three GPS videos rank 1, and Amalfi is correctly not significant. This is the first decision rule that automatically says "no route" on Amalfi.
- **Good-run and cluster support fail as decision statistics,** because shuffled decoys keep 2–5 km blocks of true signal and the tracker follows the true road inside them. The decoys should break the signal at a finer scale, or use foreign maps.
- **Grimone halves:** in the first half the real run is no better than the median decoy (rank 20 of 40). That matches the known wrong first half: the decoy test exposes it.
- **Reversed-video consistency check:** Roanne 100 % overlap, Grimone 93–99 %, but Rousset only 35–48 %, with the reversed run cheaper. That is not investigated yet.

**Speed against gradient (bikes)**

Spearman r between log vms speed and the GPX gradient over 300 m:

| video | r (vms speed) | null 95 % \|r\| (shifts ≥ 2 km) |
|---|---|---|
| Roanne | −0.84 | 0.29 |
| Grimone | −0.74 | 0.35 |
| Rousset | −0.86 | 0.51 |

- **The vms speed carries the gradient strongly,** with a sharp peak at the true alignment on Roanne and Grimone. On Rousset, one long climb gives a broad peak.
- **Discrimination:** a 5 km stretch's gradient profile ranks first among 50 random profiles in 57–100 % of cases. At 1 km it is only 12–15 %.
- **Use:** this channel is independent of focal length, horizon and drift, so it is a second matching signal for bike videos. For unknown routes it needs a DEM (Copernicus or SRTM 30 m; the local DEM does not cover these areas). It does not apply to cars or motorcycles (Amalfi is a motorcycle), whose speed follows curvature and traffic.

**Correction (user, 2026-11-10): Amalfi is a motorcycle, not a car.** This gives a candidate explanation of the 20–24 % undercounted rotation that the angle study left open. On a motorcycle the camera leans with the bike in curves.
- With a lean angle φ, a turn about the world vertical at rate ω appears in the camera frame as yaw ω·cos φ plus pitch ω·sin φ.
- At typical leans of 30–40° that is cos φ = 0.77–0.87, i.e. 13–23 % less yaw.
- This is a hypothesis, untested. It would also explain why no single focal length or distortion term fits, and why it does not show on bikes (small lean at their speeds) or Gotthard and Cayolle.
- Test: correlate the vms roll with the yaw deficit per curve on Amalfi, and correct yaw as √(yaw² + pitch²) or by rotating with the measured roll.

## Fable step 2: unbounded camera scales plus vote (2026-11-11)

Code is in `rsm/vote/`, outputs in `work/fable2/`. Tests: 241 passed, 7 skipped. The run took 2 h 15 min under memguard with a 1.3 GB peak. All three GPS videos are development data; Amalfi is post hoc.

The stage-B fit runs without priors on the angle scale and the distance scale. A weighted ±5 % box vote over (f_eff, kappa) gives the calibration peak, which is compared against 19 shuffled and 19 sign-flipped decoys.

**Calibration from the vote works on bikes:**
- Peak f_eff: Roanne 494 against 486 from GPS (+1.6 %), Rousset 509 against 494 (+3 %), Grimone 417 against 390 (+7 %).
- The true candidates cluster tightly; wrong ones spread over more than ±30 %.
- The peak stays put when stage A runs at other scale hypotheses (Rousset 484–514 for F 359–561).

**As a decision statistic it fails:**
- The real peak is only 0.85–1.0× the highest decoy peak, ranking 2–9 of 39.
- The shuffled and flipped decoys keep 2–6 km blocks of true signal, so their peaks sit on the true cluster.
- Lesson for the decoy design: decoys must destroy the true signal at the scale the statistic integrates over. Foreign maps do that: on disjoint maps the real peak is 4–10× the foreign peak on the bikes.

**Decisions:**
- At the right scale, the vote-calibrated decisions equal the plaus decisions (Roanne 20/0, Grimone 21/0, Rousset 46/0 correct/wrong).
- Forcing the peak scale on windows whose stage A ran at a wrong scale creates 7–18 wrong decisions per video. The vote cannot tell which stage-A hypotheses to trust.

**Amalfi:**
- No signal: peak p 0.26 (F = 449) and 0.31 (pooled).
- The peak f_eff simply follows the stage-A hypothesis (359 / 461 / 557 / 654), so it is an artefact.
- The fit cloud is broad (P10–P90 418–1456). No tracking was done.

**Motorcycle lean check on Amalfi** (59 two-second increments in the COLMAP window 780–960 s):
- The COLMAP/vms yaw ratio has a median of 1.59, but it ranges 1.13–2.34 within this one window, so the angle scale is not even constant inside it.
- The lean model predicts only about a 2 % deficit here (median pitch/yaw 0.19).
- The ratio does not correlate significantly with |pitch/yaw| (r = 0.18) or |roll| (r = 0.07).
- The lean hypothesis is neither supported nor excluded by this single window. The Amalfi yaw deficit stays unexplained, and the large per-increment variation points to vms yaw quality on this video rather than a constant scale.

## Fable step 3: dense HMM over road positions (2026-11-11), the best result so far

Code is in `rsm/hmm/`, outputs in `work/fable3/`. Tests: 250 passed, 7 skipped. Every run was under memguard; the peak was 2.5 GB, or 4.1 GB for one foreign-map build.

The model replaces quanta, stage A/B and the beam tracker:
- **State:** (directed edge, 30 m cell). The step is 30 m of nominal vms distance.
- **Transition:** advance 0–3 cells, any out-edge at nodes, U-turn with a penalty.
- **Emission:** Student-t (ν = 3) on the vms heading increment against the map heading increment.
- **Solve:** exact Viterbi plus forward-backward. No anchors, no turn threshold, no pruning.
- **Scales:** the angle scale f_eff (270–600) and kappa ({0.88, 1.0, 1.13}) are scanned globally.

**GPS-fed go/no-go** (share of video time on the correct edges):

| video | HMM | beam tracker, same input |
|---|---|---|
| Grimone | 99.8 % | 56 % |
| Roanne | 99.3 % | 97 % |
| Rousset | 98.6 % | 94 % |

At the Grimone fork near 3626 s the HMM takes the right branch (posterior ≥ 0.94). The beam's failures were search failures.

**vms input** (no GPS; same areas as tracker v3; v3 in brackets):

| video | on correct edges | within 30 m | best f_eff (GPS reference) |
|---|---|---|---|
| Grimone | 99.9 % (53 %) | 96.7 % (49 %) | 380–395 (390) |
| Roanne | 99.5 % (100 %) | 90.8 % (95 %) | 425 (486) |
| Rousset | 93.0 % (97 %) | 81.7 % (81 %) | 458–478 (494) |

**Findings**

- **Grimone is solved end to end, including the first 2200 s.** Every earlier method had failed there, so the HMM fixes the main search problem.
- **Roanne:** the edges are right; the route slides 30–100 m along straights. The coarse kappa grid is the likely cause.
- **Rousset:** the last 940 s are wrong, and the posterior there is near 0.
- **The posterior is an honest confidence for road identity.** AUC against "on the correct edge" is 0.88 / 0.96 / 1.00. It does not flag along-track slides (AUC 0.57–0.78 against "within 30 m").
- **Scale scan:** the peak is interior but shallow (2–3 nats per km at ±25 %), and the accuracy against GPS is −12 % to +1 %, no better than a regression along the decoded route.
- **Decoys:** 3 foreign maps, 12 shuffles of 200–500 m blocks, 1 mirror and 3 foreign-plus-shuffle. The real run ranks 1 of 20 on all three videos (p = 0.05).
  - Margin over the best decoy: Grimone 13.1 nats per km, Roanne 14.5, Rousset only 2.5.
  - Fine-scale decoys and foreign maps fix the decoy problem of Fable steps 1 and 2.
- **Amalfi (motorcycle, post hoc): still no signal.**
  - Score −64 to −68 per km against −19 to −28 on the bikes.
  - The scale scan rises monotonically to the lowest f_eff (a degenerate fit that shuffles match).
  - Decoy rank 9 of 20, and 0 of 9 tunnels.
  - Amalfi's vms yaw is the problem, not the matcher.

**Caveats.**
- Not blind. The noise model (residual-calibrated, with a Jacobian term) was fixed after a failed first run, and Rousset was debugged on GPS corridors with the oracle f_eff.
- The final settings are fixed and per-video-free, but all three videos are development data.
- **Next: freeze this configuration and test it blind** on the reserved videos: the new GPS videos (same author), and Cayolle and Gotthard (YouTube) with Street View pages.

## Amalfi with a wide 2-D calibration scan: first plausible route for the YouTube video (2026-11-11, post hoc)

**Diagnosis first (reviewer).** In the COLMAP window 780–960 s, 13 turns compare COLMAP against vms at f 449:
- **The angles are off by a factor, not garbage.** All signs agree, the ratio is mostly 1.4–1.6 (range 0.93–2.28), and the 2 s increments correlate at r = 0.935 with slope 1.44, so f_eff ≈ 310.
- **The real problem was distance.** vms gives 4.1 m/s nominal (31.5 km in 2 h) for a motorcycle.
- Every earlier run allowed a distance scale of at most 1.13 (HMM) or 1.5 (plaus), and used a 20 km box that probably cut the route.

**Run** (`rsm/hmm_cal/`, outputs in `work/amalfi_cal/`; HMM peak 0.6 GB):
- Frozen dense HMM on an a-priori "Amalfi Coast" corridor (lon 14.30–14.80, lat 40.55–40.72, classified roads, 1,111 directed km).
- Scan: f_eff 250–400 × kappa 0.8–3.5.
- One technical fix: one nominal step = one cell of 30·kappa m, plus ln kappa per transition (density per metre).

**Results**
- **Clear interior peak at f_eff 302, kappa 1.86** (finer scan: kappa 1.95 ± 10 %). The decoded route is 58.8 km at 7.7 m/s, from Vietri west along the SS163 to about 14.395 E.
- **Mean posterior 0.965;** only 1.3 % of the time is below 0.5.
- **Independent evidence agrees:**
  - Vietri 86 m from the route at 30 s ± 30 s; the ERCHIE sign 199 m at 790 s ± 30 s.
  - **9 of 9 tunnels hit,** against 0.9 on average for time-shifted routes (p = 0.0005).
  - Correlation with COLMAP turn rate 0.87 (mirrored −0.13).
- **The decoy test is not passed:** rank 3 of 20, p = 0.15. Two foreign coast maps (Cilento, and Cilento plus shuffle) score marginally better per km.
  - The per-km likelihood is dominated by motorcycle yaw noise, so on a one-road coastal corridor the statistic cannot separate the true road from other winding coast roads.
  - The tunnel and sign evidence is the stronger test here.
- **Street View check page:** `work/verify/amalfi/index.html`, 24 points, for the user to judge.

**Lessons**
- The distance scale must be scanned widely (×0.8–3.5) together with the angle scale, especially for vehicles other than bikes.
- The area rule must follow the scanned distance.
- The decoy statistic needs event channels (tunnels, places) or a better per-km normalisation before it can decide cases like this.

**User Street View check of Amalfi (2026-11-11):**
- **The route is right.** Many of the 24 points are precise. Along straights there is an offset of about 20–40 m: an along-track slide, the same effect as on Roanne. Straights carry no heading information, and kappa is known only to about ±10 %.
- **The localisation was purely algorithmic:** vms optical flow, the OSM graph, the dense HMM and a likelihood scan over f_eff × kappa. Tunnels and signs were used only afterwards, as checks.
- **Human or AI choices outside the algorithm:**
  - the scan range (chosen after the COLMAP diagnosis);
  - the corridor box (derived from the name).

  A product needs fixed rules for both: always scan kappa widely, and size the area from the scanned distance.

## Refinement along the fixed route: anchors and per-segment distance factors (2026-11-11)

This is the user's design, made general. Code is in `rsm/refine/`, outputs in `work/refine/`. Tests: 264 passed, 7 skipped. Peak memory 1.9 GB. All data is development data or post hoc.
- **Anchor:** a common type (t, s, kind, quality, sig_t, sig_s).
- **Producers:** pluggable. So far there are curve apices (a 1-D heading alignment along the known path, ±200 m in 5 m steps) and tunnel portals.
- **Merge:** one step.
- **Segment correction:** one kind-agnostic step, k_i = L_map / L_vms between consecutive accepted anchors, applied in proportion to the vms distance.
- **Output:** a GPX export at one point per second, time = 2000-01-01T00:00:00Z plus video seconds (`work/refine/<video>.gpx`).

**Along-track error against GPS** on correct-road samples: mean absolute error in m, then the share within 10 / 20 / 30 m.

| video | HMM Viterbi | HMM posterior mean | anchors + global kappa | anchors + per-segment k_i |
|---|---|---|---|---|
| Grimone | 11.3; .50/.85/.97 | 8.7; .62/.93/.98 | 10.5; .66/.84/.92 | **7.1; .72/.92/.99** |
| Roanne | 13.1; .46/.82/.91 | 7.1; .70/.98/.99 | 45.6; .45/.58/.63 | **5.7; .84/.96/1.00** |
| Rousset | 21.4; .51/.80/.88 | **7.4; .75/.95/.98** | 20.4; .65/.79/.84 | 10.4; .75/.89/.93 |

**Findings**

- **Per-segment factors work on the bikes:** 2–3× smaller along-track error than the Viterbi path.
  - The factors vary by 6–11 % within a video (Grimone 0.85–1.04, Roanne 0.94–1.12, Rousset 1.07–1.47), so one global factor was wrong by that much.
  - Error grows with distance to the nearest anchor: about 5 m within 50 m, 6–9 m at 50–300 m, and up to 38 m beyond 300 m (Rousset's long anchor-free stretches, where vms distance is not proportional inside the segment).
- **The HMM posterior mean is a strong, anchor-free competitor** (7–9 m) and wins on Rousset.
- **Curve assignments barely changed:** 1–2 anchors per bike video moved to another map turn, with a median apex shift of 7–9 m.
- **Amalfi (motorcycle), with the 18 tunnel portals as truth** (portal times from luminance, fixed a priori):
  - The Viterbi baseline is 19 m mean (median 13 m); steps 2+3 give 32 m.
  - The refinement hurts here: noisy motorcycle yaw produces some wrong curve anchors (shifts over 100 m) that displace whole segments.
  - Tunnel portals as extra anchors (leave-one-out) change nothing next to curve anchors about 190 m apart.
  - Caveats: the merge rules were adjusted after first looks at the Amalfi tunnels, and one OSM tunnel length disagrees 4.4× with the vms distance.
- **Cross-track:** the camera rides about 2 m right of the OSM centre line (median absolute 2.0–2.9 m, p90 about 5.7 m; 75–82 % of the time on the right side). Not modelled yet; this is the lateral part of the GPX goal.

**Next steps**

1. **Fuse instead of overwrite.** Combine the posterior mean with the anchors, for example as a smoothed k(s) or a Kalman or RTS smoother over arc length, with anchors as weighted measurements and the per-segment factor as a slowly varying state. That keeps the anchors' gain on the bikes and the posterior's robustness on Rousset and Amalfi.
2. **Gate anchors by local yaw quality.** Amalfi's bad anchors come from noisy yaw.
3. **Lateral offset model.**

## Fusion of anchors, HMM posterior and vms distance (2026-11-11)

Code is in `rsm/fusion/`, outputs in `work/fusion/` (GPX per video and variant). Tests: 271 passed, 7 skipped. Peak memory 1.9 GB.

The method is an RTS smoother over the state [s, rho] along the fixed route:
- **Motion model:** vms distance increments, with rho a slowly varying distance factor.
- **Measurements:** the HMM posterior mean with its spread, and anchors of any kind through sig_s.
- **Updates:** Huber-robust.
- **Gate:** curve anchors are gated by vms-only quality features.

All data is development data or post hoc.

**Along-track error, mean absolute m** (bikes: correct-road samples against GPS; Amalfi: 18 tunnel portals):

| video | Viterbi | posterior mean | old per-segment | fusion, gated anchors |
|---|---|---|---|---|
| Grimone | 11.3 | 8.7 | 7.1 | 6.7 (ungated 6.3) |
| Roanne | 13.1 | 7.1 | 5.7 | 4.5 (88 % within 10 m, 100 % within 20 m) |
| Rousset | 21.4 | 7.4 | 10.4 | 6.3 (80 % within 10 m, 95 % within 20 m) |
| Amalfi (portals) | 19.4 | 20.0 | 31.6 | 23.7 (with tunnel anchors, leave-one-out: 23.3) |

**Findings**

- **On the bikes the fusion is the best method so far: 4.5–6.7 m along-track.**
  - On Rousset's long anchor-free stretches, the error beyond 300 m from an anchor drops from 37.6 to 10.5 m.
  - It is robust: 5 anchors shifted by ±100 m change the result by 0.0–0.3 m, against 1.1–4.2 m for the old per-segment method.
- **The gate does little on the bikes.** Its yaw-quality features do not predict the few gross anchor errors (it caught 2 of 10). The Huber fusion does the protecting.
- **On Amalfi, nothing beats the plain Viterbi or posterior mean at the portals** (about 19–24 m).
  - Amalfi's yaw noise is about 3× the bike level. The gate rejects 203 of 354 curve anchors.
  - Every variant shares a portal-exit bias of about −23 m, probably a luminance-timing effect of the truth itself (the exit brightens before the portal).
  - With 18 samples, differences of 3–5 m are within noise.
- **Cross-track** is unchanged at a median 2–3 m; there is still no lateral model.

## Rotation from far features as a whole-video yaw series (2026-11-11)

Code is in `rsm/farrot/`, outputs in `work/farrot/`. Tests: 275 passed, 7 skipped. Amalfi is post hoc; some window and band settings were fixed on smoke runs that include the Amalfi COLMAP window.

**Method**
- Corners in bands above the horizon are tracked over windows of about 0.27 s.
- Per window, yaw, pitch, roll and expansion are fitted at the f from approach A, with a translation-leak correction and roll taken as lean.
- The result is fused with vms yaw by inverse variance; where there is no valid fit, vms yaw is used (29 % of the time on Amalfi, 2–4 % on the bikes).
- **Runtime:** 1.6–2.0 s wall per video minute on the bikes and 7.5 s on Amalfi (VP9 1440p decode), with 4 processes. That is app-capable.

**Yaw quality**

| video | vms yaw | far-feature yaw |
|---|---|---|
| Amalfi vs COLMAP (780–960 s, 2 s increments) | r 0.940, rms 6.5°, per-turn ratio 1.24–2.26 | r 0.989, rms 2.7°, ratio 1.06–1.32 (r 0.998 where far features exist) |
| Grimone vs GPS (4 s) | r 0.823, drift 241° per 300 s | r 0.854, drift 77° per 300 s |
| Roanne vs GPS | r 0.951, drift 61° per 300 s | r 0.956, drift 44° per 300 s |
| Rousset vs GPS | r 0.899, drift 79° per 300 s | r 0.919, drift 51° per 300 s |

The lean correction made no measurable difference on Amalfi.

**Position:** no gain downstream.
- **Amalfi:** the curve-anchor gate rejects far fewer anchors (75 of 377 instead of 203 of 354). Yet the portal errors stay at 19–23 m, and nothing beats plain Viterbi (19.4 m). The remaining large portal errors are identical with both yaw series (e.g. tunnel 3 exit −109 m).
- **Bikes:** the along-track error is unchanged (6.7 / 4.6 / 6.5 m).
- **Conclusion:** the along-track position is no longer limited by yaw quality. On Amalfi the remaining error sits at the same portals regardless of yaw, which points to the portal truth itself (luminance timing, OSM tunnel geometry) or to the distance measurement.
- The better yaw should matter most where turns decide: in the HMM route decode and its decoy test (Amalfi p = 0.15). That is not tested yet.

## Amalfi HMM with the far-feature yaw: decoy test passed (2026-11-11, post hoc)

Code is in `rsm/hmm_far/`, outputs in `work/amalfi_far/`. Tests: 277 passed, 7 skipped. Peak memory 0.9 GB.

The setup is the same corridor, frozen HMM and decoys as `work/amalfi_cal`, but the heading comes from the fused far-feature yaw. The f axis is 250–440, so it covers the COLMAP scale.

**Calibration peak**
- f_eff 345 (parabolic fit 353) and kappa 1.86 (fine scan 1.95), at −56.35 per km.
- The vms run gave −67.81, so this is 11.5 nats per km better. The f ridge is flat over 319–406.

**Decoy test: rank 1 of 20, p = 0.05**
- Before it was rank 3 and p 0.15.
- The best decoy (Gargano) is now 12.2 nats per km worse than the real run; before, the best decoy was 0.46 better.

**Confidence**
- The mean posterior is 0.973, with 0.7 % of the time below 0.5.
- With the better yaw, the true road is now clearly distinguishable from other winding coast roads.

**Route and position barely change**
- 2.8 % of the time is on a different edge, at most 34 m apart geometrically.
- The evidence is identical: Vietri 86 m, ERCHIE 199 m, 9 of 9 tunnels.
- The tunnel-portal along-track error is 19.4 m (median 10.2 m), within the noise of the earlier variants.
- **Conclusion:** better yaw decides *which road* (identification, confidence, decoys), not *where along it*.

**Output**
- `work/amalfi_far/route_points.json`: one point per second with confidence and sd_m.
- `work/amalfi_far/Amalfi.gpx`.
- An interactive map check page (`rsm/bench/verify_map.py`): an OSM map with the route coloured by confidence; clicking the route shows the video frame at that time; each spot can be marked and the marks exported.

## Consolidated pipeline: one frozen command, video plus area to GPX (2026-11-11)

`python -m rsm.pipeline run --video V --bbox S,W,N,E --pbf P --out DIR [--vehicle …] [--offset-m …] [--start-time …] [--decoys N] [--resume]`
- **Documentation:** `PIPELINE_CLI.md`, which covers the JSON-lines progress protocol for the app, the files written, exit codes and packaging notes.
- **Frozen:** `rsm/pipeline/frozen.json` (code hash 56d32cc0a7b48d9b). Tests: 307 passed, 7 skipped.
- **One lean environment:** `requirements-pipeline.txt`; vms is vendored with a progress callback, and ffmpeg is taken from `RSM_FFMPEG`.
- **Writes** only to `--out` and `RSM_DATA_DIR`. Every heavy step runs under memguard. `--resume` works after SIGTERM and after kill -9.
- **Decoys are off by default** (user decision). The verdict without decoys uses calibration peak sharpness, posterior mean and share below 0.5, motion coverage and yaw noise. It is provisional and labelled "without decoy check".

**Validation on development videos** (decoys off):

| | Roanne (bike, 44 min) | Amalfi (motorcycle, 127 min) |
|---|---|---|
| total runtime | about 15 min | about 46 min |
| peak memory | 2.2 GB (map step) | 2.2 GB |
| verdict | confident | confident |
| calibration | f_eff 461, kappa 1.22 | f_eff 355, kappa 2.00 (research 345–353 / 1.86–1.95) |
| against GPS / evidence | 100 % on the correct road; along-track 4.6 m mean (research 4.5), 99.9 % within 20 m; cross-track median 2.9 m before and 2.3 m after the 1.5 m offset | Vietri 62 m, ERCHIE 201 m, 9 of 9 tunnels; route within a median 5 m of the research route |

The bike rides about 2.5 m right of the centre line, so a slightly larger default offset would fit better. The vehicle estimate has never seen a car.

## First blind test of the frozen pipeline: Pontaix–Chamaloc (2026-11-11)

One video only (user decision: beta first, more tests later). The setup was the frozen code (hash 56d32cc0a7b48d9b), the lean environment, decoys off, vehicle auto and the default offset. The bbox came only from the title, and the GPX was opened after the run.

**Bbox lesson:** the title "Rousset - 3 - Pontaix, Chamaloc" does not geocode as a whole, and "Rousset" geocodes to the wrong region. The rule was amended before the run: a hit counts only if the local pbf has road near it. With that, "Pontaix" gave a 60 × 60 km box.
- For the app this confirms the spec: the title only *suggests* the map section, and the user must be able to correct it.

**Result**

| | value |
|---|---|
| verdict (without decoy check) | confident: peak interior, +9.6 nats/km; mean posterior 0.966; motion 99.96 % usable |
| road | **100 % of the time on the correct road**; route 14.69 km (GPS 14.65 km) |
| along-track | mean 9.6–13.9 m, median 8.4–12.5 m, 92–100 % within 30 m (range by lag rule: the GPS clock jumps by about +6 s after 1800 s) |
| cross-track | median 3.9 m to the centre line, 2.5 m to the 1.5 m driving line |
| calibration and vehicle | f_eff 387, kappa 1.22; estimated as bike |
| runtime and memory | about 14 min for a 44 min video; peak 2.2 GB |

**Reading:** road identification held on unseen data. Along-track accuracy is about 2–3× worse than on the development video Roanne (4.6 m), still mostly within 30 m. One video says nothing about the false-confident rate. More blind tests come after the beta.

## Madone in the app (start frame at Peille): turn-by-turn check in Menton (2026-11-11)

**Run.** App run with a start frame of about 2 × 2 km around Peille. Verdict: confident, mean confidence 0.94, f_eff 424, kappa 2.64. Peille → Col de la Madone is correct. The end at Garavan is correct.

**Truth.** Taken from the video frames every 6 s, with landmarks geocoded through Nominatim.

**Comparison** (work/madone_menton/menton_zoom.png):
- 42:24: reaches the sea. The route takes the same junction about 25 s late.
- 42:36–45:06: Av. Félix Faure. The route follows the same direction, about 20 s late.
- 45:15: Rond-Point Saint-Roch, then right to the sea, then left onto the promenade. The route turns early through Rue Pasteur, up to 170 m off.
- From 45:30 the route is on the right road again, but late:

| Landmark | Delay | Distance to landmark |
|---|---|---|
| Cocteau museum | +13 s | 28 m |
| Bastion | +17 s | 26 m |
| Quai Bonaparte | +28 s | — |

**Causes:**
1. **Rond-Point Saint-Roch is a dead end in the search map.** Its exits are `residential`, which is not in the motorcycle road classes. The true path could not be represented.
2. **The step of 30 m × kappa is about 79 m.** In town, a right and a left turn within about 15 s fall into one step and cancel.
3. **Along-track lag of 15–30 s in town (100–250 m).** The cause is open: slow traffic, cars ahead in the road trapezoid, or the coarse steps.

**Quanta.** The current dense HMM already allows every exit of every junction, so "one quantum per way through a crossing" is implicit. Proposed next: a second local pass after the route is found. It would use a corridor of about 300 m with all road classes, including residential, and finer steps of about 10 m, and decode turn events against junction geometry.

**Bug.** The project.json `code_hash` in the bundled app is the hash of an empty input (e3b0c442…). `pipeline_hash` is correct.

## Local pass: all streets in a corridor, finer steps (2026-11-11)

**Approach.** New first phase of the refine step (`rsm/pipeline/local.py`). It decodes the search route again in a 300 m corridor around it. The corridor includes all drivable classes: the vehicle classes plus residential, living_street, road and unclassified, read once from the pbf and cached per route box. The steps are 15 m nominal instead of 30 m. f_eff and kappa are fixed from the search. If the corridor problem is infeasible, the search route is kept. The new status is `local_pass`.

**Step size.** 10 m fails on a synthetic irregular town (median 122 m off): a real turn spreads over 20–30 m of heading, while the map junction is a sharp kink. 15 m and 20 m decode the town exactly. On Madone, 10, 15 and 20 m all fix St-Roch. I chose 15 m.

**Madone (start frame).**

| Landmark | Before | Now |
|---|---|---|
| Rond-Point St-Roch | 94 m, +29 s | 27 m, +3 s |
| Cocteau museum | 28 m, +13 s | 28 m, +11 s |
| Bastion | 26 m, +17 s | 25 m, +16 s |
| Quai Bonaparte | +28 s | +28 s (unchanged) |

1 % of the route moved by more than 30 m, at most 66 m. The local pass takes 72 s with a cold pbf read, 1–2 s cached.

**Roanne (GPS).** Correct road 100 %. Along-track median 3.63 → 3.60 m, p90 9.41 → 8.76 m.

**Open.** The along-track lag of 10–30 s in Menton after St-Roch.

**Tests.** A synthetic test (search map without residential streets, right area but wrong streets): on the true street 56 % → 100 %. The suite passes: 323 passed, 8 skipped. Code hash ce932147653262c8.

**Also fixed.** The bundled app wrote the hash of an empty input as `code_hash`. It now uses the frozen hash.

## Timing in town: measured standstills and dense heading alignment (2026-11-11)

**Diagnosis** (Fable, work/fable_timing/). Four causes of along-track lateness of up to 21 s in Menton:
1. The town needs about 3.1–3.6 m/nominal m, against the global kappa of 2.64. The posterior pins rho back to 1 on straights.
2. Standstills are split off the tracks and filled with the mean speed. At the seafront stop this added up to 130 m that were never driven.
3. Junction kinks and roundabouts are invisible to 40 m steps, because `_edge_cells` smooths the heading per edge only. A hairpin split by a node is passed late and then taken in 3 s.
4. My "Quai Bonaparte +28 s" was a geocoding error.

**Fix 2 (tracks.gap_nominal, seq.make_steps gap_nom).** A gap whose pairs are at least 70 % well fitted gets the measured vms distance. Madone: 2541–2550 is 4.0 nominal m and 2585–2591 is 3.5 m; before, about 21 and 7 m were filled in. Used in the local pass (refine only; route_search is unchanged).

**Fix 1 (rsm/pipeline/align.py).** A monotone 1-D Viterbi of the 4 m video heading samples against the heading of the fixed path. The path heading is smoothed across nodes (18 m); the grid is 2 m; the advance prior is Normal(4 kappa, 40 %); measured gaps advance by Normal(kappa × measured, 30 % + 10 m), unmeasured ones by up to vmax × duration.

**Used only in turns.** Positions are used only where the path turns by at least 30° within ±20 m, as smoother measurements with sd 4 m, added to the posterior and the curve anchors. The DP alone was 7 m median against GPS on Roanne, because straights carry no heading information.

**Results.** Truth landmarks from the frames, positive = route late:

| Landmark | Before | Now |
|---|---|---|
| Hairpin La Maura | +4.0 s | +3.0 s |
| Roundabout 40:57 | +3.4 s | +0.8 s |
| Viaduct roundabout | +14.8 s | +5.6 s |
| Roundabout 41:56 | +21.0 s | +11.2 s |
| Seafront turn | +6.6 s | +2.7 s |
| St-Roch | +2.7 s | +2.0 s |
| Mean / max | 8.8 / 21.0 s | 3.5 / 10.2 s |

The before/now rows are the sd 8 m run; with sd 4 m the mean is 3.5 s and the max 10.2 s. Roanne GPS: along-track median 3.63 m, p90 9.07 m (before 3.60 / 8.76).

**Open.** Fable's fix 3: the rho/posterior pinning on long straights, which is why roundabout 41:56 is still +10 s. Roundabouts passed straight carry little heading information.

**Code hash** f109940ba15f1ee2. The sidecar and the app are rebuilt.

## Fix 3: posterior thinned on straights (2026-11-11)

**Change** (`steps_c.fuse`). Where the path turns less than 30° within ±20 m, the cell posterior is used only once per 200 m, with its sd ×2. In turns it is unchanged. The curve anchors and the alignment measurements are unchanged.

**Madone landmarks:** mean lateness 3.5 → 2.7 s, max 10.2 → 8.3 s.

| Landmark | Lateness |
|---|---|
| Hairpin | +2.0 s |
| Roundabout 40:57 | −0.6 s |
| Viaduct roundabout | +2.5 s |
| Roundabout 41:56 | +8.3 s |
| Seafront turn | +0.8 s |
| St-Roch | +2.1 s |

**Roanne GPS:** along-track median 3.63 → 3.59 m, p90 9.07 → 8.61 m.

**Rejected variant:** 400 m with sd ×4 left Madone the same but made Roanne worse (median 4.59 m, p90 10.6 m).

**Limits:** tuned on only two videos (Madone landmarks, Roanne GPS). Grimone and Rousset were not re-run.

**Code hash:** 2295d18afaa78942.

## Side street in Menton: road-class prior in the local pass (2026-11-11)

**User report.** In Menton the route ran on a side street parallel to the big boulevard. Check, 40:38–41:38:
- The route search had **Cours René Coty**, which is correct.
- The local pass (all streets) moved the route onto **Avenue Cernuschi**, a residential one-way street 15–40 m away, running the same direction.

On a straight both have the same heading. The local Viterbi preferred Cernuschi by only **7.5 nats** over about 1 km. Measured by excluding Cernuschi: −910.0 against −917.5.

**Fix.** `grid.build(edge_cost=…)` charges a cost per metre on edges whose class is not in the vehicle's search classes (residential, living_street, road for a motor vehicle). The local pass and refine's posterior grid use `LOCAL_MINOR_NATS_PER_KM` = 15.

**Scan on Madone:**

| Prior (nats/km) | 40:38–41:38 | St-Roch detour (Rue Adhémar de Lantagnac, true residential) |
|---|---|---|
| 0, 5 | Cernuschi | kept |
| 10 | mostly Cours | kept |
| 15 | Cours | kept |
| 25 | Cours | kept, via Rond-Point St-Roch |

**Results:**
- Final GPX 2440–2500: Cours René Coty, 59 of 60 s.
- Madone landmark lateness: mean 2.9 s, max 8.7 s. The landmark arcs come from the earlier path, so the points after 2440 are only approximate now that the path changed.
- Roanne GPS: unchanged (3.59 / 8.61 m).

**Risk.** In the synthetic test town the true drive is almost all residential, with parallel main roads, and the prior pulls the route onto them (median 210 m off). That test now runs with the prior off. A real route that stays on residential streets next to a parallel main road with the same turn pattern could be pulled onto the main road.

**Code hash** 9f98a14ea95a7d6b.

## Road width from the video: feasibility check, not feasible (2026-11-11)

**Setup.** A separate experiment, deleted afterwards. A classical bird's-eye view with width, lane-line and centre-line detection, on 10 s windows against OSM class, lanes and width.

**Results:**
- **Bikes, Marburg town:** main against residential AUC 0.49–0.58, which is chance level. Width against the OSM `width` tag gives ρ 0.52 (n = 19). Median width by class: 5.0 / 4.8 / 4.5 / 4.0 / 3.2 m for primary / secondary / tertiary / residential / unclassified, with a spread of about ±1.2 m.
- **Madone, Menton:** Cours René Coty measures 9.9–13 m; Félix Faure 4–13 m; Lantagnac about 7.8 m. AUC 0.77 on width and 0.80 on lines.

**It missed all three success criteria fixed in advance:** AUC ≥ 0.85, coverage ≥ 60 %, Coty clearly separated.

**Causes:**
- bikes ride on pavements and cycle paths;
- parked cars, pavements and squares have the same colour as the road;
- curvy mountain roads;
- camera roll and pitch;
- glare and shadows;
- the absolute scale differs per video.

**Decision.** Not integrated. Only a per-video-normalised "wide with markings vs narrow" score for motorised footage might be worth revisiting, probably with learned road segmentation, which this experiment excluded.

## Session close (2026-11-12)

- **Repository.** This package moved into `video2gpx/research/route-shape-matching` and is now tracked in the video2gpx git repository; `work/` and `.venv` are excluded. `../road-reconstruction` and `../video-motion-speed` are links to a local experiments folder. Tests (336) and the sidecar build pass from the new place, with the code hash unchanged at b5a5c92f5e2eeca7.
- **Incyclist import.** The dialog accepts GPX, EPM, RLV or XML, not ZIP. Pick the `gpx-import` XML next to the MP4 and GPX. Incyclist's parser (`services/src/routes/base/parsers/incyclist.ts`) resolves the GPX next to the XML and honours `start-frame`, and does not read `id` or `country`. RLV is not pursued: binary, no coordinates.
- **Elevation under bridges.** No spike under the Menton rail viaduct, and raw spikes in Menton stay at or below 3 m, so no extra correction is needed.
- **Map.** In dark mode the filter moved from the tile pane to the tiles, because WebKit painted the pane only in part.
- **Project documentation:** `video2gpx/docs/` (README, DECISIONS, HISTORY).
