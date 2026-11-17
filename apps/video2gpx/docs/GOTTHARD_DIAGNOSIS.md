# Gotthard Pass: why the start is on the wrong road, and a refinement step for "good middle, bad end" (2026-11-13)

Video: `videos/Gotthard Pass 4K.mp4` (1080p, 50 fps), app project `gotthard-pass-4k-hdr-famous-cobb-1794582288236` (no hint, vehicle auto, bbox 48 x 47 km).
Truth: from the video frames (no GPS). Scripts: `research/route-shape-matching/work/gotthard-diag/d*.py` (git-ignored; run with
`RSM_DATA_DIR=<app cache> PYTHONPATH=. .venv/bin/python <script> <project>/out ...`). No pipeline code was changed.

## 1. True route (from the frames)

| video time | where |
|---|---|
| 0:00-0:20 | intro (Google Earth overview), no motion |
| 0:20-0:35 | Andermatt station car park |
| 0:35-1:05 | Bahnhofstrasse eastwards |
| ~1:08 | right turn onto Gotthardstrasse (south) |
| ~1:45 | Oberalpstrasse junction |
| ~2:20 | sharp right turn at the Dorfbrücke into the old town (cobbles) |
| 2:25-3:35 | old town, Gotthardstrasse westwards |
| 3:35-4:10 | Gotthardstrasse (Andermatt) out of the village |
| ~4:12 | **left turn onto the Umfahrungsstrasse** (the junction of the maintainer's screenshot) |
| 4:15-6:15 | valley road to Hospental; then Gotthard pass road, Tremola from about 13:00 |

The decoded route (`route_points.json`) instead runs **down the Umfahrungsstrasse (bypass) from 0:20**, passes the screenshot junction at 2:48 (about
84 s early), stays up to about 600 m ahead on the valley road and joins the true position at about 5:30. From there on it is right.

## 2. Why: the chain of causes (measured)

1. **The route search was right.** Its Viterbi path (30 m steps, f_eff 299, kappa 2.00) goes station → Bahnhofstrasse → Gotthardstrasse → Dorfbrücke
   (2:27) → old town → junction (4:07-4:21) → valley road (`d2.py`).
2. **The local pass replaced it with the bypass.** Same calibration, 15 m steps, all streets in a 300 m corridor: the free local decode chooses the bypass;
   the local decode forced along the search route scores **35.5 nats lower** (`d4.py`). The status said "6 % of the route corrected (up to 317 m)".
3. **Inside the disputed stretch the true route is better.** Until 4:21 the forced (true) path is ahead by up to +8 nats (it explains the two strong
   right turns at 1:08 and 2:20, which the bypass leaves unexplained at about -6 to -8 nats each). It loses everything **after** the junction.
4. **Reason: the odometry fails on the valley road.** 4:22-5:36 (sun straight ahead, smooth asphalt, about 18 m/s): only 31-36 % of the vms pairs are
   usable, and the "good" ones give 0.2-0.5 m/s nominal (village 2.4-3.4, pass 6.4-8.0) (`d7.py`). The HMM gets about 0.7 km of distance where the car
   drove about 1.4 km. The bypass is about 650 m shorter than the loop through the village: it absorbs the missing distance, the true route has to stretch
   and pays for it until about 7:45 (`d4b.py`).
5. **The finer local model is stiffer than the search.** Gap steps get an independent relative error per step, so the total sd of a gap is
   rel x D / sqrt(n): halving the step (30 → 15 m) shrinks the slack of every gap by sqrt(2). The coarse search could absorb the deficit, the local pass
   could not. Gap distances are estimated from the neighbouring speeds; here the neighbour is the slow village.
6. **No acceptance test.** The local pass takes its route whenever its total score is higher; it does not ask whether the change is supported where the
   routes differ, or whether it leaves strong turns unexplained.

What fixes it, tested on this video (`d6.py`, `d8.py`, `d9.py`, `d11.py`, `d12.py`, `d13.py`):

| change (local pass) | true route minus bypass |
|---|---|
| as shipped | -35.5 nats |
| gap sd systematic (∝ gap length) | -11.5 |
| distance uncertainty x5 where usable < 0.6 + systematic gaps | -8.6 / -5.7 |
| odometry in 4:22-5:40 scaled to the real speed (x2 to x3), best timing of the village route | **-1.7 / -1.2 (a tie)** |
| a separate kappa for 0:20-5:30 only, with an anchor at 5:30 | bypass still best (single kappa cannot fit village and valley road) |
| per-segment scale profiled (EM / grid, quality prior) | bypass still best: the wrong odometry is self-consistent with the bypass |
| other f_eff (299, 360, 420, 460) | bypass in all cases |

Conclusion: once the distance deficit is removed, the local model cannot decide (tie); with the bad odometry it decides wrongly. What discriminates is
(a) the strong turns the bypass leaves unexplained and (b) the search route, which chose the village. A score margin alone is not enough.

## 3. Side findings

- **The video file is damaged:** only 964 of 2486 s decode ("Invalid NAL unit size" from 16:04). Everything after 16:04 is missing and no status says so.
- **Verdict `no_route` although the search route is right:** the posterior on the Viterbi path is 0.00 at every step of the route search; the mass sits in a
  dense residential mesh in Ulrichen (west edge of the bbox: Stattgartenweg, Birkenweg, edges of 15-19 m). Cause: the vehicle estimate said bike
  (smooth dashcam car, 0 of 4 motor votes), so the search map has residential streets; kappa 2.00 later says motor vehicle, but the map is not rebuilt.
  The refine posterior (corridor) is 0.89.
- f_eff 299 makes the village turns 1.3-1.5x larger than the map, but the whole video scores best with it, and other f_eff do not change the start.
  Not a cause here.

## 4. Concept: island refinement ("good middle, bad end")

Goal: a post step that keeps confidently recognised parts fixed and re-decides the parts next to them, without making a correct route worse.

### 4.0 Building blocks

- **Step anchors:** `dp.viterbi` / `forward_backward` take masks per step (`{step: allowed cells}`), not only start/end. 20 lines; the diagnosis uses it
  (`d2.vit`). User time anchors (backlog 3) use the same mechanism.
- **Turn landmarks:** steps with a large, well-measured heading change (|Δθ| ≥ 45° within ≤ 60 m, far-feature fit, usable ≥ 0.9, on-road before and after).
  A route "explains" a landmark if the road turns by a comparable angle (±35°, ±1 step). A car does not turn 90° without a road turn; exception: car
  parks at the start / end (off the graph).
- **Odometry quality per step:** usable share, inliers, plausibility (near-zero speed while far features move = failure, as at 4:22-5:36).

### 4.1 Islands

A stretch is an island only if **all** hold: search and local route agree (≤ 30 m); all landmarks in it are explained; local posterior ≥ 0.9; odometry
usable ≥ 0.8; at least two landmarks or 300 m of curved road. Posterior alone is not enough: the wrong bypass had posterior 1.00 at 2:45.
Optional: the island decoded on its own on the full map lands at the same place (self-localising).

### 4.2 Bridges and tails

- **Bridge** = between two islands (both ends anchored in space and time). **Tail** = between an island and the start or end of the video (one anchor,
  the far end free within the reach: nominal distance x kappa x 1.5 from the anchor; the start rule for cuts still applies).
- Hypotheses per bridge / tail: the search route, the local route, and up to k diverse alternatives (Viterbi on a reach-limited map with all road classes,
  repeated with the previous best forbidden). A tail must search the reach disc, not the 300 m corridor of the old route: if the old start is wrong by
  kilometres, the corridor does not contain the true road.
- Scoring: the same HMM with the anchors; distance uncertainty from the odometry quality (systematic for gaps, wide where the vms fails); a separate
  distance scale per bridge only, never a separate f_eff (short stretches cannot calibrate f; f and kappa trade off).
- Decision, in this order: (1) fewer unexplained landmarks; (2) higher score by ≥ 5 nats; (3) otherwise keep the search route and mark the stretch
  `uncertain` (lower confidence in the route points, status "start uncertain 0:20-5:30").

### 4.3 What it does on Gotthard

Island from about 5:30 on (both models agree, many landmarks). Tail 0:20-5:30 with the anchor at 5:30: hypotheses village (search) and bypass (local).
Landmarks: village explains both strong right turns, bypass none → village. Score test alone would not have chosen it (section 2).

## 5. Recommendation

1. **Now, cheap, fixes this video:** an acceptance test for the local pass. A stretch where the local route moves to another road for more than 30 s is
   accepted only if it leaves no more strong turns unexplained than the search route and wins by ≥ 5 nats; otherwise the search route stays there and the
   stretch is marked uncertain. Plus the landmark check as a status. (About 1 day; bench run on Roanne, Pontaix, Grimone, Amalfi, Madone, Bavaria with
   `scripts/heavy.sh`: the legitimate local corrections (town turns, parallel streets) must stay.)
2. **Odometry failure handling** (about 1 day): vms pairs with near-zero speed while far features move become a gap; gap sd proportional to the gap length,
   not per step; gap speed prior from both sides with a wide upper tail. This removes most of the distance pressure that makes shorter parallel roads win
   (here -35.5 → about -6 to -11 nats), and it also matters for Bavaria and Madone.
3. **Island refinement** (section 4) as the general version, behind a flag, after 1 and 2 are in and benched (about 3-5 days). It reuses step anchors,
   landmarks and the quality model, and gives the user time anchors (backlog 3) for free.
4. Side fixes: status for a truncated / damaged video; re-decide the vehicle after the calibration (kappa) and rebuild the search map, or compute the
   verdict posterior in the corridor, so a correct route is not reported as `no_route`.

## 6. Built: acceptance test of the local pass (recommendation 1)

- `rsm/hmm_cal/dp.py`: `viterbi` / `forward_backward` take `step_ok={step: cell mask}` (anchors inside the video).
- `rsm/pipeline/local.py`: `turn_landmarks`, `explains`, `acceptance`. Stretches of ≥ 30 s where the local route is > 30 m from the search route are tested;
  the local route stays only if it leaves no more landmarks unexplained than the search route and beats the local decode forced along the search route by
  ≥ 5 nats. Otherwise the final local decode is forced along the search route there (`step_ok`), and `local.kept_search` lists the stretch.
- `rsm/pipeline/steps_c.py`: confidence capped at 0.5 (`LOCAL_KEPT_CONF`) on kept stretches, status `route_disputed`, one log line per tested stretch;
  `src/features/gloss.ts`: German text for `route_disputed`. Config `LOCAL_ACCEPT_*`, `LM_*` in `config.py`; `frozen.json` regenerated.
- Tests: 2 new (step masks, landmarks / explains), full suite 428 passed, 8 skipped; `tsc --noEmit` clean.
- Gotthard (refine + gpx on a copy of the app project, `work/gotthard-diag/run`): stretch 0:20-1:54 tested, margin 34.1 nats for the bypass but 1 strong turn
  unexplained (search 0) → search route kept. Route points now: 0:30-1:00 Bahnhofstrasse, 1:40 Gotthardstrasse, 2:30 Dorfbrücke, 3:20 old town,
  4:00 Gotthardstrasse (Andermatt), 4:15 at the junction; confidence 0.5 in 0:20-1:54; status "route_disputed".
- Bench (`--code work --from-step refine`, tags `lpacc` vs `flatrc`, `lpaccb` vs `bf`): Roanne, Madone start, Amalfi, Pontaix, Grimone identical to the
  baseline (position difference 0.0 m); no case has a local change of ≥ 30 s, so the test never fired there. Not run: Rousset, CdP, Pennes, Lahntal, Madone
  without hint, Bavaria (no seeded runs). Not yet in an app build.

Not recommended: calibrating f_eff per island; using the posterior alone to pick islands; replacing the local pass by a higher margin only (the wrong route
won by 35 nats here).

## 7. Built: odometry failure handling, staged road classes / island refinement, side fixes (2026-11-14)

### 7.1 Odometry failure handling (recommendation 2), ON

- `rsm/pipeline/odofail.py`, the step builder of every route-side step (map info, route_search, plausibility, refine, local pass; `tracks.steps_of` is
  unchanged and still used by the rotation step). A stretch whose usable share of vms pairs (± `ODO_FAIL_WIN_S` 5 s) stays below `ODO_FAIL_USABLE` 0.5 for
  ≥ `ODO_FAIL_MIN_S` 10 s is a failure, not a slow car (a standstill fits well: usable 0.8-0.9 at the Madone / Amalfi stops). It is cut out of the tracks
  and becomes a gap: nominal distance from the mean of the good-pair speeds 30 s before and after (`ODO_NB_S`), total sd `ODO_GAP_REL` 0.6 of the gap
  (systematic), `ODO_GAP_UPPER` 2x more sub-steps (reach about 4.8x the prior: wide upper tail).
- Every other gap: total sd `GAP_SYS_REL` 0.3 x gap length for any step length (sub-step rel = 0.3 sqrt(n), no cap at 1). Unchanged for gaps of ≤ 11
  sub-steps; the 15 m local pass is no longer stiffer than the 30 m search (2.5).
- Emitting steps with usable < `ODO_LOW_USABLE` 0.6 (± 10 s): relative distance sd `ODO_LOW_REL` 1.0 (default 0.2).
- Status `odometry_gaps` (route_search) with the time ranges; German text in `src/features/gloss.ts`.
- Gotthard old file (`d6`/`d2` harness, local model, kappa 2.0, true route forced through the village at 120 / 178 / 230 s vs the bypass):
  village minus bypass **-65.7 nats as shipped → -3.8 nats** (d6 "systematic gaps" alone: -50.5 in this harness). Failure spans found: 4:24-5:39,
  6:55-7:27, 8:38-8:49, 10:15-10:29, 10:39-10:51. Gotthard HDR (full) run: 4:24-5:38, 6:55-7:14, 10:17-10:28, 10:40-10:51 (115 s).
- Bench (`odo1` vs `seed1`, 9 cases): identical routes everywhere (position difference 0.0 m, same road 100 %). None of the bench videos has a failure
  span or a step with usable < 0.6, and their 30 m steps are unchanged; the bench does not exercise the change (the clip bench's Lahntal 35m42 and
  Gotthard valley clips are the cases for it).

### 7.2 Staged road classes and island refinement (recommendation 3), built, OFF (`LOCAL_ISL_ON`)

Road classes per stage today: map / route_search / plausibility `steps_b.py:28-32` (bike: `CLASSES_BIKE` incl. residential, living_street, or
`CLASSES_BIKE_PATHS` with bike paths on / fallback; motorcycle and car: `CLASSES_MOTOR`, motorway..unclassified, config.py:35-47; the vehicle is
rotation/vehicle.json, `auto` never says car); the vehicle re-decided from kappa (`steps_b.py:774`) does not rebuild the map; local pass corridor
`local.py:47` vehicle classes + `LOCAL_EXTRA` (residential, living_street, road, unclassified) within 300 m, 15 nats/km on classes outside the search
classes (`local.py:37`), bike-path routes swap in `CLASSES_BIKE_PATHS` (`steps_c.py:241`); the local start stays within 300 m of the search start; gpx
uses the refine graph.

`rsm/pipeline/islands.py`, called at the end of the local pass (after the acceptance test of section 6):
- Islands: local = search (≤ 30 m), all landmarks explained by the local route, local posterior ≥ 0.9, usable ≥ `LOCAL_ISL_USABLE`, ≥ 2 landmarks or
  300 m of curved road. Usable is 0.5, not 0.8: the Gotthard HDR run has 0.5-0.6 on the whole valley road 7:20-11:00 at posterior 1.0; with 0.8 the first
  island is at 11:30.
- Open parts: bridges (both ends anchored at the island steps), tails (one anchor; free end in the reach disc nominal x kappa x 1.5, ≤ 6 km, plus the search
  and local starts). Graph with `ext_classes_for` (local classes + service, pedestrian; bike: + track, cycleway, path, footway), +15 nats/km on them.
- Hypotheses per part: search (forced, every second step within 60 m), local (forced), free decode, `LOCAL_ISL_K` 3 alternatives that may not use the roads of
  the routes found before during one 30 % window each, and a shape hypothesis (decoded with relative distance sd 1.0 on every step, then scored normally).
  Each scored on the sliced steps with the anchors and a distance scale profiled over 0.7-1.75 (log-normal prior sd 0.3); never a separate f_eff.
- Decision: fewer unexplained landmarks; then ≥ 5 nats; else search route, `uncertain` (goes to `local.kept_search`: confidence cap 0.5, status
  `route_disputed` with the range). Final route: one decode on the union grid with the islands and the chosen hypotheses as step anchors.
- Bench with it on (`isl1` vs `seed1`): same road 97.7-100 %, position difference median ≤ 0.5 m; on-road share up (Rousset 98.2 → 99.6 %, Grimone 97.9
  → 98.8, CdP 97.7 → 99.5 (start off-road 1-129 s → 1-22 s, now Route de la Gare), Pennes 98.6 → 99.6); along-track median Roanne 3.59 → 3.69 m, Pontaix
  11.07 → 12.02, Rousset 4.04 → 4.19, CdP 29.6 → 30.1; Grimone p90 32.3 → 21.0 m. Madone, Amalfi identical.
- Gotthard HDR copy (`work/gotthard-diag/run3` = route_search with 7.1; distance to the village reference route at 0:30-5:30, 21 times):
  app result median 344 m (max 739); 7.1 only (`run3b`) median 167 m (0:30-1:30 Gotthardstrasse north, 3:30-3:50 Umfahrungsstrasse); islands (`run7`)
  median 385 m: start tail 0:20-7:35 (first island at 7:35), the shape hypothesis wins with 1 unexplained landmark on Oberalpstrasse. **Not fixed.**
  Probe with the true village route as an extra hypothesis (`islands.EXTRA_HYP`, diagnostics only): 0 unexplained landmarks, 39.5 nats below the free
  decode (2 unexplained) → the decision rule picks it. The missing piece is the hypothesis generation: none of free / alternatives / shape finds the
  village loop (Bahnhofstrasse → Gotthardstrasse → Dorfbrücke → old town) with kappa 2.64 and the failed odometry.
- Why it stays off: Gotthard does not improve; the bench changes are small and mixed.

### 7.3 Side fixes (recommendation 4)

- Truncated / damaged video: the motion step compares the end of the decoded pairs with the larger of stream and container duration (own ffprobe call);
  ≥ max(10 s, 2 %) missing → `motion/summary.json` `truncated`, status `video_truncated` (problem), German text in gloss.ts. Not in the motion hash (a
  status only: no rerun of old projects). The old damaged file is no longer on disk; tested on the numbers (964 of 2486 s).
- Verdict `no_route` with the right route (`auto` estimated a bike, kappa says motor vehicle): the cheaper fix without a map rebuild,
  `steps_b.motor_posterior`: the motor classes are a subset of the bike map; decode once more on that subset at the same calibration; if ≥ 90 % of the
  route is the same (≤ 30 m), its posterior is used for the verdict (`conf_bikemap` keeps the old one). Route unchanged. `VERDICT_MOTOR_POST`, on.
  Gotthard old run (route_search on a copy, `work/gotthard-diag/runv`, with 7.1): bike-map posterior 0.00, motor roads 0.81, same route 98 % →
  verdict **no_route → uncertain**. (With 7.1 the calibration there moved from kappa 2.00 to 1.73.)
- The opposite case (HDR run, vehicle car): Bahnhofstrasse (living_street) is in the local corridor, but the local start must stay within 300 m of the
  search start, which lies about 400 m north on Gotthardstrasse; the island tail searches the reach disc but does not find the village (7.2). Adding
  living_street / residential to the car search map would make the 48 x 47 km search map several times larger; not done.

### 7.4 Resume hashes (which steps a value reruns)

- `ODO_*`, `GAP_SYS_REL`, `VERDICT_MOTOR_POST`, `KAPPA_MOTOR`, `VERDICT_MOTOR_SAME`: route_search and later (`cli.py` route_search part, only while the
  feature is on).
- `LOCAL_ISL_*`, `LOCAL_EXT_*`: refine and later, only while `LOCAL_ISL_ON`.
- `TRUNC_*`: none (status of the motion step). Motion, rotation and map hashes never change (test `tests/test_islands.py`).

## 8. Sun flash taken for a scene cut (2026-11-16)

App run of 16 Nov (HDR file, vehicle estimated bike, user anchor at 3:45 in the old town). Without the anchor (`work/gotthard-diag/run_noanchor`, same run
from route_search on) 0:20-3:10 is right (the village loop through Bahnhofstrasse, Gotthardstrasse, Dorfbrücke), but **3:12-4:25 runs on the
Umfahrungsstrasse**, 70-280 m from the true old-town street, and rejoins at the junction at 4:30.

- Cause: a "scene cut" at 192.17 s (frame-difference impulse 4.5 plus a failed road-flow fit). The frames show the same street with the same roadwork sign
  and flag before and after: a **sun flash**, not a cut. Since A13 a cut is a flat jump of up to 1.5 km, so the 70 s after it were placed on their own shape,
  and the bypass fits that shape better.
- Probes (no anchor): cut jump prior sd 400 m or 100 m instead of flat: max 15 m, the same as the anchored run. Not taken, because Bavaria needs the flat
  jump at real cuts (A13).
- Fix (A15): same-scene veto in `rsm/pipeline/cuts.py`. Before / after frames of the flash fit at 48 % (3:12) and 37 % (3:14, a candidate in older runs);
  the 19 known real cuts at <= 7 %; limit 20 %.
- Result (`work/gotthard-diag/run_noanchor_veto`, from rotation, no anchor): only the intro cut at 0:20 stays; distance to the village reference route in
  0:25-10:00 max 15 m, median 1.9 m (anchored app run 15 m / 2.4 m; before the fix 317 m / 2.9 m); verdict `confident` (was `uncertain`).
- Test: `tests/test_cuts.py::test_gotthard_sun_flashes_3m00_3m20_are_no_cut` (real video, `realdata`, skipped when the file is absent) and the counter-case
  `test_gotthard_intro_cut_at_0m20_stays_a_cut`.
