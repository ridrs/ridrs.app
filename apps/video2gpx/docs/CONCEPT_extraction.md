# Concept: extraction and interpretation on the image side (2026-11-20)

Goal: the video is read **once** per source into assumption-free motion data (`extract/`); everything that interprets it (horizon, road area, fits,
gates, traffic candidates, rotation bands, odometry) runs from these stored data, without the video. An interpretation change then reruns in minutes
instead of a T4 of 5-6 h (docs/CONCEPT_test_strategy.md). Builds on the test strategy (T0-T4, stages) and replaces neither.

## 1. Why

The image steps decode and interpret in one pass: the road trapezoid and the rotation bands hang from the calibrated horizon, the fits run inline,
only per-pair results are stored. Every interpretation change (A21-A24 on 2026-11-19/20: relative gate, traffic trigger and tolerance, running
horizon) made every frozen stage stale and asked for a T4.

## 2. Layers

| layer | content | reads the video | rebuilt when |
|---|---|---|---|
| **E extraction** (`extract/`) | whole frame in a fixed grid, per cell the 2 strongest corners (per-cell maximum of the min-eigenvalue, absolute threshold), tracked with the LK forward-backward tracker of today; per point start, flow, FB error, corner strength. Streams: adjacent pairs on the destatic frames (`des`), adjacent pairs on the raw frames (`raw`, reduced), frames k apart once per rotation window (`rot`); the frame difference per pair | yes | the decode, the destatic filter, the grid or the tracker change (rare) |
| **I interpretation** | horizon calibration and running horizon, road area, road-flow fit, gate, traffic candidates and pick, noise, rotation band fits, series, tracks; writes `motion/` and `rotation/` as today | no | any interpretation change, in minutes |
| pixel probes | same-scene veto (two frames around a cut) and the standstill test (short windows around candidates) | short windows | as today |
| **R route** | unchanged (`map` .. `gpx`) | no | as today |

No assumption in E: no horizon, no trapezoid, no bands, no fit. The interpretation may need only what E stores; pixel values (overlay images, the
veto, the standstill test) stay with the video.

## 3. Decisions (maintainer, 2026-11-20; memory "extraction-layer-decisions")

| id | decision |
|---|---|
| E1 | Gates against the verified Pontaix track (heading error in sliding 30/60/120 s windows, distance ratio, the route's along error; no worse than today); other sources by route outcome (verdict, same road, checkpoints). Never parity with today's per-step sums. |
| E2 | A25: the far-band heading takes the focus-of-expansion column x0 from the road fit (median −c/s of clean pairs) instead of `farrot.series.estimate_x0`. Delivered with the one re-baseline T4. |
| E3 | Simple storage: `np.savez_compressed` per chunk, no own encoding; about 13-20 GB for the 12 test sources in `test-data/`; app projects keep their extraction. |
| E4 | E stores **2 points per 16 px cell and each point's strength**; how many the interpretation uses (1 or 2, density by row) is decided later, without the video. |

## 4. Phase 0 (scratch, 2026-11-20): the measurements behind the decisions

10 min Gotthard 480p (car, pass) and 10 min Pontaix (bike, verified track); stored grid points re-interpreted with today's logic, then the whole
route side run on them (T3 with the motion and band fits injected).

- Speed and distance from stored points: ratio 1.00, per-second correlation 0.97-0.999; gate share and fit rms equal; FOE calibration ±1 row;
  running horizon, traffic candidates and the destatic fallback reproduce. Re-interpretation 25-50 s per 10 min.
- Heading: today's pipeline already removes the translation leak of the far bands (`farrot/series.py`, x0 from straight windows) and fuses far and
  road yaw by variance, but its x0 is too small (Pontaix 13.8 px, on grid points 8-10 px; the road fit says 17.2 px). Pipeline heading against the
  verified track, error over 120 s: today 14.0°, today with x0 from the road fit 13.0°, grid 16x1 with it 11.8°.
- Route: Pontaix along median / p90 today 11.5 / 26.9 m, today + road x0 11.0 / 26.7, grid 16x1 + road x0 11.7 / 29.3, grid 16x1 with today's x0
  16.8 / 36.4; Gotthard checkpoints today 10/10 (max 46 m), grid 16x1 10/10 (max 60 m), 16x2 9/10. One run each: a gap this small is not yet told
  apart from the sensitivity of the scale scan (Gotthard kappa 1.86 vs 1.73).
- Storage (16x1, FB ≥ 1 px dropped, `raw` every 3rd pair): 49-86 MB per 10 min. 16x2 about twice that.
- The grid puts fewer points on the road (Gotthard 46 vs 72 per pair; pairs under 20 inliers 20 % vs 12 %); per-pair speed noise is the same.

## 5. Phases

1. **Extraction** (`rsm.pipeline.vmsx.extract`): grid detection, tracking, quantisation, the three streams, chunks in parallel with the seam check
   of `analyse_parallel`, `extract/extract.json` + `extract/chunk_<first frame>.npz`. T0 tests on the synthetic road video. Not yet a pipeline step.
2. **Motion as interpretation** (built 2026-11-20, `rsm.pipeline.vmsx.interpret`): calibration, noise, running horizon, fits, candidates and pick
   from `extract/`; `motion.csv` and `motion.json` unchanged in format (`motion.json` adds `extract` and `interpret`); the analysis overlay takes
   the pair's stored points and decodes nothing (`points_from`). Deviation from the first plan: `extract` is **not** a step of its own in the app's
   step list; the motion step keeps `run/extract/` (outside `run/motion/`, so a rerun of the step keeps it) and reuses it while its key holds
   (video file, `extract.VERSION` and `params()`, height, OpenCV version), else extracts first. Same effect (an interpretation change reruns
   the step in about a minute), no change to the app, the Rust side or the mocks. `config.MOTION_FROM_EXTRACT` (default on) switches back to
   the inline pass. The interpretation uses 1 point per cell (`interpret.USE_NPTS`, E4), the strongest with a usable track.
   Calibration differs by construction: the stretches use the stored plain pairs (every 3rd pair) and the points of the whole frame grid; on the
   synthetic straight road it finds the horizon (150.4 for 150), where the inline pass finds no focus of expansion at all.
   First measurement, Pontaix 10 min from the phase 1 extraction: interpretation 12 s; speed per second against the stage of today ratio
   1.02, correlation 0.998; usable share 100 %; own calibration 197.0 rows against 194.2 of the stage (whole source).
3. **Rotation as interpretation** (built 2026-11-20, DECISIONS A25 / A26): band fits from `rot` (`interpret.rotation_windows`, the chunk layout and
   generator seeding of `steps_a._chunk`, same fits for any number of workers), x0 from the road fit (A25, `steps_a.road_x0`); series, tracks,
   cuts and vehicle unchanged; the pixel probes (same-scene veto, standstill test) stay with the video. The far-window overlay reads the stored
   points. Measured (whole pipeline from the video, cache off): Pontaix heading error 30 / 60 / 120 s today 7.2 / 9.9 / 15.6°, now 6.8 / 8.8 /
   12.0°; Pontaix along median / p90 today 18.4 / 34.0 m, now 18.3 / 37.6 m; Gotthard 10/10 checkpoints, max 55 m today, 33 m now. The p90 of
   Pontaix is 3.6 m worse (the scale scan lands on kappa 0.988 instead of 1.062: Phase 0 already showed this sensitivity); open.
4. **Test strategy** (built 2026-11-20): a stage holds `extract/` next to `motion/` and `rotation/`, and `stage.json` names it (`extract`: source
   sha256, `extract.VERSION`, `params()`, height, OpenCV, a hash of `vmsx/extract.py` and `vmsx/decode.py`). `rsm.bench.stages check` reports
   a fourth status, **reinterpret**: the step keys differ but the stored extraction is current, so `rsm.bench.stages reinterp [--only ids]`
   rebuilds `motion/` and `rotation/` from it (no full decode; the pixel probes read short windows of the source, which must be present) and
   freezes again; only `stale` asks for T4 (`make`, which now also freezes the extraction). T2 names the fast way for a reinterpretable stage.
   The bench's step cache and `copy_step` keep `extract/` with the motion step (otherwise a cached motion step sends the rotation step back to
   the video, with other band fits for the same keys; the rotation step warns when that happens). Clips and the long videos extract themselves
   in their run. The stages of today hold no extraction yet: the one re-baseline T4 of phase 5 makes them.
5. **Re-baseline**: one T4, T1-T3, Pontaix against the verified track (E1), the maintainer's check in the app. The inline image pass is removed
   after one release (rule 8).
   **Run 2026-11-20/21 (branch `feat/v2g-extraction` at 0fa1547):** T4 made all 12 stages with their extraction (`fresh`, 21 GB together; Pontaix
   750 s, Amalfi 6806 s partly on battery). T2 (tag `p5t2`, 104 min cold) passes its checks; against `t2base` (2026-11-19):
   - Pontaix along median / p90 2.21 / 5.4 m → **3.60 / 16.8 m**, ≤ 10 m 100 % → 76 %; kappa 1.06 → 0.99. The scale regression of phase 3
     shows on the route of the one verified truth. **Open, blocks the merge.**
   - Better: madone-town landmarks mean / max 89 / 150 s → 4.4 / 8.0 s (f_eff 230 → 298); gotthard-start checkpoints max 62 → 31 m, median
     18 → 12 m; madone-start and madone-nohint uncertain → confident.
   - About equal: roanne, rousset, grimone, pennes, pennes-descent, rousset-end, amalfi. cdp place 99.7 % → 97.6 %, p90 5.0 → 5.4 m.
     lahntal-marburg and marburg-lahntal stay no_route (known).
   T3 runs and its parity holds (speed corr 0.9999 / 0.9996, yaw corr 0.999 / 0.993, no unmatched cut). It compares with T2 tag `t2base`, which
   only the main checkout holds; against `p5t2` both cases pass (same road 100 %).
   T1: 20 of 21 clips pass. `grimone-traffic-47m30` fails `vs_full_v_corr` 0.89 (min 0.96). The extracted points are the same; the traffic
   pick differs. Its trigger follows the median plain rms of the run (`ALT_TRIGGER_REL`, A20-A24 on main, 2026-11-20). In the 30 s clip that
   median is above `ALT_TRIGGER` and keeps 403 plain fits. In the whole video it is not, and the stage replaces them. Without the window's own
   trigger the clip gives corr 0.999. So the gap comes from A20-A24, not from the extraction. The last T1 on main (2026-11-19 20:20) is older
   than that commit. Open.

   **Cause of the Pontaix regression and its fix (2026-11-21).** It is A24, not the extraction: the running horizon (`horizon_track`) follows the
   noise of a bike's horizon. On the climb at 28-43 min it drops from about 194 to 186 rows, the speed reads 5-7 % low, and the global kappa
   lands at 0.99 instead of 1.06. Re-interpreted with a fixed horizon, the same extraction gives the speed of `t2base` again. A study of the
   balance between curves and distance (`docs/STUDY_curve_distance_balance.md`) tried A24 off (A), A24 for motor
   vehicles only (B), A24 damped (C), route-side weights (D) and combinations, screened on the two verified tracks:
   - A and B: Pontaix 1.7 / 5.3 m, ≤ 10 m 100 %; Sa Calobra unchanged (2.09 / 6.0 m).
   - A breaks Gotthard (checkpoint max 84 m, parity speed ratio 0.954): a motor vehicle on a steep pass needs A24.
   - No route-side weight improves both verified tracks.

   Built: **B** (config `HZ_RUNNING_VEHICLES = ("motorcycle", "car")`, `calib.horizon_mode`). The vehicle is known only after the route search
   (kappa), so a run interprets with the running horizon first. When `vehicle_final.json` says bike, motion to route_search run once more from
   the stored extraction with the fixed horizon (no second decode), then refine and gpx. An explicit `--vehicle` picks its horizon at once.
   Stages hold both image sides (`fixed/` and `code_fixed`); the route tests take the same second pass.
   Exception (A27, 2026-11-22): a bike whose horizon calibration spreads more than `HZ_SPREAD_IQR` (50 rows) keeps the running horizon
   (Lahntal: 67 rows, no fixed row fits it).

   Measured with B (2026-11-21; all stages re-interpreted with both sides in 81 min, Sa Calobra adopted again; T2 tag `b2`, `--code work`,
   against `p5t2`; 8 cases got the second pass):
   - Pontaix along median / p90 3.60 / 16.8 m → **1.72 / 5.3 m**, ≤ 10 m 76 % → 100 %, kappa 0.99 → 1.06. The verdict is uncertain: the share of
     seconds with a posterior below 0.5 is just above the 5 % of the confident verdict (the study: 5.04 %). Open, the maintainer decides.
   - Sa Calobra unchanged (2.09 / 6.0 m, ≤ 10 m 96 %). Gotthard checkpoints 10/10, max 31 m.
   - The other bike cases keep place and road (same road 97.7-100 %). rousset-end and pennes-descent move along the road against `p5t2`
     (position difference median 41 m and 175 m) at the same distance to their coarse GPS line; their GPS cannot tell along errors.
   - T3 with `--t2 b2`: both long videos pass. pontaix-10m along 7.2 / 29.4 m (was 18.3 / 37.6 m), parity speed corr 0.999, ratio 1.00;
     gotthard-start 10/10, max 33 m.

## 6. Format of `extract/` (phase 1)

`extract.json`: `version`, `params` (cell, points per cell, thresholds, min distance, quantisation, k, the raw cadence), `fps`, `width`, `height`,
`pairs`, `windows`, `chunks` [[first frame, last frame, file]], the OpenCV version, `seconds`.

Per chunk (`chunk_<a>.npz`): `idx` (int32, frame j of pair (j−1, j)), `diff` (float32, the frame difference of `pair_row`), and per stream `s` in
`des`, `raw`, `rot`: `s_x`, `s_y` (uint16, start position in 1/32 px), `s_dx`, `s_dy` (int16, flow in 1/64 px), `s_fb` (uint8, FB error in 1/128 px),
`s_q` (uint8, strength: 16 × log2(min eigenvalue / 1e-5)), `s_count` (int32 per pair or window); `raw_idx` (the pairs that have a raw stream),
`rot_w` (window indices). Points whose LK failed or whose FB error is ≥ 1 px are not stored. The raw stream is stored for every 3rd pair (the FOE
cadence) and for every pair whose destatic stream has fewer than 40 points in the lower half of the frame (where the road-fit fallback needs it).

## 7. Risks

- **Speed (solved 2026-11-20, HISTORY.md):** the first real run took 341 s for 10 min of Pontaix with 4 workers. With 30 s chunks and 2 OpenCV
  threads per spawned worker (`extract.CHUNK_S`, `extract.THREADS`) it takes 143 s with bit-identical data: about 4 h of extraction for a T4
  over the test sources.
- Bit parity across machines: LK and `cornerMinEigenVal` may differ in the last bits between OpenCV builds; the OpenCV version is part of
  `extract.json` and of the key.
- Memory: a 40 min video holds about 60 M points; chunks keep a worker under 1 GB.
- The interpretation must not reach for pixels; a guard test checks that the motion and rotation interpretation import no decoder.
