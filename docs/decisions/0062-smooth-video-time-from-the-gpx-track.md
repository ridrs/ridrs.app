<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0062: Smooth Video Time from the GPX Track

## Context

The render clock shows the video frame at the video time of the presented distance (ADR 0061). That time was `placeAt(track, distance).time`: linear between two GPX points. The camera speed it implies is constant between two points and steps at every point, so a rider at a steady speed sees the picture surge and brake. Measured on the three sample routes (relative change of the picture's speed across a GPX point, rider at constant speed): largest 61 % (Le petit Menglonnais, 1-s track), 754 % (Rousset, 1-s track), 111 % (Col de Pennes, 1–15 s between points); p95 16–33 %.

The spike `experiments/video-motion-speed` compared ways to get a smooth camera speed: monotone cubic interpolation, a smoothing spline, and a fusion of the GPX with the speed measured from the video's own motion. Its addendum (`FINDINGS.md`) found a simpler method that beats them all on these routes, including the fusion.

## Decision

- **The video time comes from the track's distance over time, smoothed.** Once per route, when the track is built, `buildVideoTime` (`plugins/ui-world-video/client/playback.ts`) samples the track's distance every 0.5 s of track time, linearly as `placeAt` does, up to the last point; extends both ends by 4σ = 16 s with the average slope of their first and last 16 s, so the speed doesn't fall towards zero at the start and the end; convolves with a Gaussian kernel of **σ = 4 s**, truncated at ±4σ and normalised; and drops the extensions. The result is a table of distances at `i · 0.5` s.
- **`videoTimeAt(table, distance, offset)`** finds the distance by binary search and interpolates linearly between two samples, plus the start-frame offset. Before the first sample it holds at time 0, beyond the last at the last sample's time. Where several samples share a distance (the camera stood still), it is the last of them: the ride goes on where the video moves again, as `segmentAt` does for the track.
- **Monotone by construction:** a non-decreasing curve convolved with a positive kernel stays non-decreasing, and so do the extensions (their slopes are averages of a non-decreasing curve). The video can't run backwards; nothing else enforces it.
- **σ = 4 s**, one parameter in seconds of video, the same for dense and sparse tracks. 3 s still leaves jumps of 10 % on Rousset; 5 s moves the curve further from the points without being smoother in a way anyone would notice. Between two 0.5-s samples the speed changes by a fraction of a percent, so linear interpolation is enough; no spline is needed.
- **Position, elevation, gradient, the terrain windows, the FIT export and the recording are unchanged:** they still come from `placeAt`. Only the choice of the frame moves. Rendering only reads (rule 10).

### Libraries

- **Gaussian smoothing:** no package fits. Looked at: `smoothish` 1.0.0 (EPL-2.0, weakly copyleft and incompatible with the GPL family `LICENSING.md` builds on; last published 2022), `array-smooth` 1.0.0 (a moving average, last published 2022), `fili` 2.0.3 (IIR/FIR filter design, MIT, last published 2022; far more than a convolution and with no say over the ends), `ml-savitzky-golay` 5.0.0 (a different filter, which does not keep a curve monotone), the `@stdlib` packages (a normal density, but no smoothing of an array short of the large `ndarray` stack) and the image blurs of `jimp`. The convolution is about twenty lines of own code, unit-tested; the brief approved that as domain logic, because the end extension and the monotonicity guarantee are specific to this use.
- **Binary search:** the workspace has no library that provides one; the few lines follow `segmentAt` in `track.ts`.

## Measurements

Measured with a one-off script on the local sample routes (`Ridrs/videos/`, CC BY-NC-SA 4.0, never committed, nor any fixture derived from them) using the shipped `buildVideoTime`, with the spike's metric definitions (`experiments/video-motion-speed/vms/evaluate.py`: rate change across a GPX point at ±1/60 s, 1-s speed changes over the whole route, mean speed over ±0.5 s against the recorded `gte:gps speed`; speeds below 5 km/h left out). "Thinned" is the track thinned to the Pennes spacing (1–15 s, median 4 s): 358 points for Menglonnais, 2141 for Rousset. Today's linear mapping in brackets.

| σ = 4 s | Menglonnais | Rousset | Pennes | Target |
|---|---|---|---|---|
| Largest rate change across a GPX point, own track | 3.4 % (61.0 %) | 6.3 % (754 %) | 3.9 % (110.6 %) | ≤ 7 % |
| p95 rate change across a GPX point, own track | 1.1 % (16.2 %) | 1.5 % (32.6 %) | 1.5 % (30.0 %) | |
| p95 speed change per second, own track | 2.3 % (16.2 %) | 3.0 % (32.9 %) | 2.9 % (14.9 %) | ≤ 5 % |
| p95 speed error against the recorded speed, own track | 7.4 % (10.9 %) | 10.3 % (17.9 %) | n/a | below linear |
| Same, thinned | 7.6 % (10.3 %) | 11.6 % (16.2 %) | n/a | below linear |
| Distance off the GPX points, median / p99 / largest | 0.35 / 2.5 / 4.7 m | 0.36 / 3.8 / 16.4 m | 0.48 / 3.4 / 6.1 m | median ≤ 2 m, p99 ≤ 5 m |
| Same, thinned: median / largest | 0.42 / 6.1 m | 0.37 / 12.1 m | | |
| Building the table | 3 ms | 14 ms | 8 ms (20 709 samples) | |

The numbers agree with the spike's addendum within rounding.

Every point more than 10 m off (Rousset only) is at a GPS glitch, where the coordinates jump while the recorded speed stays steady; there the smoothing is right and the point is wrong:

| Track time | Off | GPS speed of the segments around it | Recorded speed |
|---|---|---|---|
| 46 s | 12.5 m | 10, 10, 101, 12 km/h | 9.3–10.7 km/h |
| 47 s | 10.1 m | same glitch as at 46 s | 10.4 km/h |
| 6808 s | 10.0 m | 40, 23, 19, 44, 82 km/h | 42–44 km/h |
| 6869 s | 16.4 m | 22, 16, 15, 68, 97 km/h | 44–46 km/h |
| 6870 s | 10.2 m | same glitch as at 6869 s | 45.2 km/h |

Distances are measured in metres along the track because position, elevation and gradient are defined in metres (`GRADIENT_BASE` 20 m, a position every 5 m); seconds would depend on the speed, and GPS itself is only good to 3–5 m. At 10 m the felt gradient still lies half in the right 20-m window.

## Why the video-motion sidecar is left for later

The spike's fusion with the speed measured from the video's motion (step 2 of its recommendation, a `<route>.speed.json` sidecar) has no measurable advantage on these three routes: it is about as good on Menglonnais (p95 speed error 6.3 % against 7.5 %), worse on Rousset (13.3 % against 10.4 %, where its motion measure fails on the descent) and less smooth than this method on both. It would need a preprocessing step per route. It would only be worth it for routes whose GPX track is much worse than these, for example far sparser than Pennes or with the timestamps out of step with the video (`FINDINGS.md`, "Addendum"). The spike's tool stays for that case.

## Consequences

- The picture moves smoothly on dense and sparse tracks alike, and still exactly as far as the physics moved: the presented distance alone chooses the frame.
- The picture can show a place up to a few metres off the position, elevation and gradient of the same distance (median under 0.5 m); at GPS glitches up to 16 m, where the GPX point itself is wrong.
- A standstill shorter than 2 · 4σ = 32 s is no longer skipped as a jump: the smoothed curve passes it quickly instead. A longer one is skipped from 16 s after it begins to 16 s before it ends.
- Tested headless with synthetic tracks (`tests/features/world/video-time.feature`) and with Vitest (`playback.test.ts`).
