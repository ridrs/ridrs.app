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
2. **Motion as interpretation**: calibration, noise, running horizon, fits, candidates and pick from `extract/`; `motion.csv` unchanged in format;
   the analysis overlay shows the stored points. `extract` becomes the first pipeline step (step hashes, app step list).
3. **Rotation as interpretation**: band fits from `rot`, x0 from the road fit (A25); series, tracks, cuts and vehicle unchanged; the pixel probes stay.
4. **Test strategy**: stages hold `extract/`; T4 = extraction only; an interpretation change re-interprets the stages; clips extract themselves.
5. **Re-baseline**: one T4, T1-T3, Pontaix against the verified track (E1), the maintainer's check in the app. The inline image pass is removed
   after one release (rule 8).

## 6. Format of `extract/` (phase 1)

`extract.json`: `version`, `params` (cell, points per cell, thresholds, min distance, quantisation, k, the raw cadence), `fps`, `width`, `height`,
`pairs`, `windows`, `chunks` [[first frame, last frame, file]], the OpenCV version, `seconds`.

Per chunk (`chunk_<a>.npz`): `idx` (int32, frame j of pair (j−1, j)), `diff` (float32, the frame difference of `pair_row`), and per stream `s` in
`des`, `raw`, `rot`: `s_x`, `s_y` (uint16, start position in 1/32 px), `s_dx`, `s_dy` (int16, flow in 1/64 px), `s_fb` (uint8, FB error in 1/128 px),
`s_q` (uint8, strength: 16 × log2(min eigenvalue / 1e-5)), `s_count` (int32 per pair or window); `raw_idx` (the pairs that have a raw stream),
`rot_w` (window indices). Points whose LK failed or whose FB error is ≥ 1 px are not stored. The raw stream is stored for every 3rd pair (the FOE
cadence) and for every pair whose destatic stream has fewer than 40 points in the lower half of the frame (where the road-fit fallback needs it).

## 7. Risks

- Bit parity across machines: LK and `cornerMinEigenVal` may differ in the last bits between OpenCV builds; the OpenCV version is part of
  `extract.json` and of the key.
- Memory: a 40 min video holds about 60 M points; chunks keep a worker under 1 GB.
- The interpretation must not reach for pixels; a guard test checks that the motion and rotation interpretation import no decoder.
