<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0063: A Plausible GPX Track Before the Video Time

## Context

ADR 0062 smooths the video time from the GPX track. Smoothing spreads a GPS error over a few seconds but cannot remove it. On the sample routes the remaining large errors are all GPS glitches, where the coordinates move in a way no rider can:

- **Jump:** at Rousset 47 s one 1-s segment covers 28 m at 101 km/h between segments at 10 km/h, and nothing makes up for it (the recorded speed stays at 9–10 km/h). The smoothed picture still runs at twice the camera's speed for several seconds: the worst speed error within ±10 s is 111 %.
- **Lag and catch-up:** at Rousset 6866–6872 s the fixes fall back (22, 16, 15 km/h) and catch up (68, 97 km/h) while the recorded speed stays at 44–46 km/h. Over the run the distance is right; in between it is up to 20 m behind.
- **Spike:** a single fix thrown sideways or backwards. The sample routes have none that survives the other rules, but it is the most common GPS error and it lengthens the path.

The routes are filmed from a bicycle or, for faster stretches, from a motorbike. On the sample routes the speed the GPS records itself (Doppler, `gte:gps speed`) never changes by more than 1.0 m/s² (p99.9; 3.4 at most), while the coordinates imply up to 25 m/s² along the path and 6.4 m/s² across it.

## Decision

- **Before the track is built, it is made plausible** (`plausibleTrack` in `plugins/ui-world-video/client/plausible-track.ts`). Position, elevation, gradient, the terrain windows and the video time then all come from that track. The plugin logs what was repaired.
- **The limits, `PLAUSIBLE`:**

  | Limit | Value | Why |
  |---|---|---|
  | Along the path | 4 m/s² (0.4 g) | harder than a bicycle brakes on a road; a camera motorbike filming a ride doesn't brake or speed up harder |
  | Across the path | 5 m/s² (0.5 g) | a bicycle leaning 27°, a motorbike in a brisk curve; the sample routes' hairpins need at most 3.8 |
  | Position noise | 1.5 m | how far a fix may lie off its neighbours by noise alone, from one fix to the next |
  | Speed noise | 1.5 m/s | how far a segment's speed may be off by noise alone |

  A point between two neighbours may lie off the steady path between them by `limit · t₁ · t₂ / 2 + 1.5 m`, the most a constant acceleration at the limit moves it, so a sparse track tolerates more than a dense one.
- **Four rules, in this order:**
  1. **Time:** a point whose time doesn't increase is dropped.
  2. **Spike:** a point thrown sideways off the chord between its neighbours (lateral limit), or backwards or forwards beyond them (longitudinal limit), is dropped.
  3. **Jump:** a single segment faster than both neighbours by more than the longitudinal limit allows, whose neighbours agree with each other, and which isn't made up for by slow segments within 5 s, counts with its neighbours' speed. The points stay where the GPS put them; only the distance along the path loses the jump.
  4. **Lag:** a point whose distance lies off the steady progress between its neighbours further than the longitudinal limit allows is dropped. A run that lags and catches up is bridged; the distance over the run stays right, because the points around it are right.
- **Rules 2 and 4 drop the fewest points that leave every remaining point plausible between its neighbours**, by dynamic programming over pairs of kept points (at most 11 in a row). Dropping the worst point first fails on a lag: the good point after the run looks worst, because its lagging neighbour pulls the steady path back. The first and the last point always stay.
- **σ = 4 s stays** (ADR 0062). With the glitches removed, σ = 2 or 3 s is still not more accurate (Menglonnais p95 speed error 7.8 / 7.3 % against 7.4 %; Rousset 11.7 / 10.4 % against 10.2 %), and it leaves jumps of 10–16 % at the GPS points.
- **No smoothing of the positions.** A Gaussian over the coordinates (σ = 1 s) shortens the 1-s tracks' jitter (the tracks are 1.3–1.4 % longer than the recorded speed rode) but improves the p95 speed error by only 0.3–0.5 points, and from σ = 2 s on it cuts corners.

### Libraries

The rules are ridrs domain logic: the limits of a ride, which glitch is which, and what to keep. The geometry (local metres from degrees, the haversine distance) and the dynamic programming are a few lines each. No package was found that filters a GPS track by kinematic limits; the GPS track libraries looked at (`@turf/*`, `gpx-parser-builder`, `simplify-js`) parse, measure and simplify lines.

## Checking a library: `pnpm check:video-routes`

`scripts/check-video-routes.ts` checks every `.gpx` below a folder (default `RIDRS_VIDEO_DIR`, else `videos` next to the repository) with the plugin's own `parseGpx`, `plausibleTrack` and `buildVideoTime`. It prints per route:

- the spacing and the accelerations the fixes imply (noise included: on a 1-s track 1.5 m of noise alone looks like 3 m/s²);
- every repair, and where the track records its speed, the worst speed error within ±10 s of it: linear → smoothed without repairs → the pipeline;
- the targets of ADR 0062: largest rate change across a point ≤ 7 %, p95 speed change per second ≤ 5 %, the picture's acceleration ≤ 4 m/s², off the points median ≤ 2 m and p99 ≤ 5 m, p95 speed error below the linear mapping;
- with `--thin-like <gpx>`, the speed error of each 1-s track thinned to that track's spacing;
- with `--damage <seed>`, seeded GPS errors of 10–30 m thrown into every 1-s track with a recorded speed, in turn a spike, a jump and a lag of 3–6 s every 5 min. Every error that would need more than twice the limits must be found, and the p99 speed error must drop.

It exits with 1 when a route misses a target.

## Measurements

On the three sample routes (local only, CC BY-NC-SA 4.0, never committed):

| | Menglonnais | Rousset | Pennes |
|---|---|---|---|
| Repairs | none | 2 jumps (47 s, 7097 s), 5 lag points (6808–6809 s, 6868–6870 s) | none |
| Length | 11 979 m | 49 026 → 48 992 m | 46 117 m |
| Largest rate change across a point | 3.4 % | 6.3 % | 3.9 % |
| p95 speed change per second | 2.3 % | 3.0 % | 2.9 % |
| Largest acceleration of the picture | 0.44 m/s² | 0.65 m/s² | 0.35 m/s² |
| Off the points: median / p99 / largest | 0.35 / 2.5 / 4.7 m | 0.35 / 3.6 / 7.5 m (16.4 m before) | 0.48 / 3.4 / 6.1 m |
| Speed error p95 / p99 / p99.9 | 7.4 / 11.6 / 19.5 % | 10.2 / 17.8 / 43.1 % (10.3 / 18.6 / 81 % before) | n/a |
| Thinned to the Pennes spacing: speed error p95 | 7.6 % | 11.6 % | n/a |
| `plausibleTrack` on load | | 150 ms | 35 ms |

At each repair (Rousset, worst speed error within ±10 s, linear → ADR 0062 alone → with this ADR): 47 s jump of 25.1 m, 544 → 111 → 15 %; 6808 s lag, 54 → 7 → 5 %; 6868 s lag, 86 → 9 → 4 %; 7097 s jump of 9.0 m, 292 → 109 → 60 % (the recorded speed itself dips to 6.5 km/h for one second there).

With `--damage` and seeds 1–5 on Menglonnais and Rousset (180 errors), every error beyond the limits was found; 2 repairs fell elsewhere. The misses are lags of 10–17 m spread over 5–7 s: at their peak they need 2.1–4.5 m/s², within or at the longitudinal limit, and look like riding. The p99 speed error of the damaged tracks fell from 35–43 % to 13–14 % (Menglonnais, undamaged 11.6 %) and from 63–74 % to 22–26 % (Rousset, undamaged 17.8 %).

## Consequences

- A GPS glitch no rider could ride no longer shows as a surge of the picture, and the track's length and the route notes no longer include it (Rousset: 34 m shorter).
- At a repaired jump the elevation still steps where the GPS stepped: the gradient over 20 m around it changes by up to 3 % for a few metres (0.6 m at Rousset 47 s). Positions stay where the GPS put them.
- A lag that stays within the limits is not found. Only the recorded speed or the video's own motion could tell it from riding (ADR 0062, "Why the video-motion sidecar is left for later").
- The plausibility of a new library is checked by running the tool, not by watching it.
- Tested headless with synthetic rides (`tests/features/world/plausible-track.feature`) and with Vitest (`plausible-track.test.ts`).
