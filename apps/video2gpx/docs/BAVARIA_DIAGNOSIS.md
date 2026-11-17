# Bavaria / Mittenwald "5 Lakes": why the video is not localised (2026-11-13)

Video: `Cycling Bavaria's 5 Beautiful Lakes | Mittenwald Scenic Loop in 4K.webm` (AV1 3840x2160, 50 fps, 6872 s).
Truth (oracle only, never GPS): komoot plan `mittenwald-feedback/2025-05-26_2268290658_5 Lakes - komoot.gpx`, 970 points, closed loop,
40.56 km, has `<ele>` (849-1088 m, 451 m up), timestamps ignored. Scripts and outputs: `research/route-shape-matching/work/bavaria-diag/` (git-ignored, `q*.py`).
Reused data: rotation/motion of the old app project (`cycling-bavaria-s-5-beautiful-la-1794489136110`, tracks identical to `work/bikepaths/new`). No pipeline code was changed.

**Clip 2:00-20:00 (maintainer change).** `work/bavaria-diag/clip_0200_2000.webm` (stream copy, 3.2 GB). A stream copy starts at the keyframe
before 120 s: **clip time = original time - 117.68 s** (not - 120 s; keyframes at 117.68 / 123.68 s; clip duration 1082.34 s). The clip analysis did
not recompute motion/rotation: it uses the full-file tracks restricted to original 120-1200 s (same file, exact time base; 4 tracks, 7.47 km nominal,
1064 s of 1080 s usable, 250 HMM steps). Times below are original video times unless marked "clip".

## 1. What the video is (measured)

- **Ride:** first-person, wide-angle, low mount, real time (nominal speed median 5.3-8.9 m/s per 10-min block, no hyperlapse), same direction as komoot,
  whole loop. Intro: a Relive map animation for about the first 40 s (motion starts at 43 s); at 1:30 already riding in Mittenwald.
- **Landmarks agree with the oracle alignment** (Viterbi of the whole video on the komoot loop): Flößersteg (49 m bridge over the Isar reservoir,
  komoot km 9.25) at 20:30, Wallgau around 45 min, the railway path near Klais around 65 min (komoot km about 24-25), Ferchensee/Lautersee 92-105 min.
- **The video is edited.** 10 of the 16 vms gaps have 0 inliers and a frame-difference spike: at 615, 1525-1535, 2001, 2052-2058, 2856, 3413-3427,
  3787, 5421, 6118, 6608 s. Frames before/after each differ completely: these are **cuts**, several into inserted B-roll (a "RIVER ISAR" title shot at
  2002 s, a gentian close-up at 5424 s, a lake jetty at 6119 s). The pipeline treats every gap as continuous riding (gap filled with mean speed).
  The other 6 gaps (inliers > 140) are slow riding / flagged pairs, not cuts. Inside the clip: one cut at 614.4-615.4 s (clip 8:17).
- **Camera rotation is measured consistently:** vms yaw vs far-feature yaw per second, correlation per 2-min block 0.7-0.99 (exceptions 74-78 min:
  0.58/0.29/-0.07); far-feature fit 96 %, usable motion 98.5 %, heading noise 0.38x bike level.

## 2. Is the true route in the search map? (measured, map-matching komoot onto every OSM highway way, 5 m samples, p50/p90/p99 0.7/1.1/2.7 m)

Route km per class: track 21.3, unclassified 6.8, residential 4.6, path 3.1, service 1.7, cycleway 1.4, tertiary 0.9, footway 0.6.

| map rule | full loop covered | largest gaps | clip section (komoot km 3.2-9.1) |
|---|---|---|---|
| bike roads `CLASSES_BIKE` (**shipped**, bike paths off) | **30.7 %** | 8.5, 6.2, 4.4 km | **5.2 %** (gaps 3.4, 2.3 km) |
| bike paths, tiers <= 1 (what the 78 x 50 km fallback run kept under the 4 GB cap) | 53.2 % | 8.5, 4.4 km | 23.6 % |
| bike paths, all tiers | 94.5 % | 795, 560, 315 m (7 gaps > 100 m) | 92.9 % (315, 105 m) |
| any highway | 100 % | - | - |

Missing under all tiers: `service` without a bicycle tag (1.65 km, mostly `motor_vehicle=agricultural;forestry`, legal for bikes) and `footway` (0.6 km).
So with the shipped configuration the route **cannot** be found: 70 % of it is not in the graph.

## 3. Would the pipeline's own model find the route if it were in the map? (measured with the pipeline's HMM, `steps_b.scan_kappa`, same steps)

Scores are best-path nats/km incl. the ln kappa term (comparable across the grid).

**Whole video:**
- Graph = komoot loop only: best **-23.1** at f_eff 170, kappa 0.9 (scan edge: lower f is always better); at f 270 -26.1.
- A road-only graph of the 18 x 18 km around the loop (346 km, truth NOT in it): best -19.0 (f 148, k 1.5). The old full-area road run: surface best -13.9
  at f 161 / k 4.3. **Wrong routes beat the true route by 3-9 nats/km at every calibration.**
- Graph = all path tiers within 300 m of komoot (479 km): best -17.5 at f 148 / k 1.5, decode within 30 m of komoot only **5 %**; at fixed f 230 / k 0.92: 18 %.
- Why: heading-change correlation (150 m windows) video vs aligned truth per 10-min block: 0.42, -0.20, 0.88, 0.23, 0.37, -0.12, 0.09, 0.81, 0.97, 0.97,
  0.87, 0.79. Minutes 70-120 fit very well; most of minutes 0-70 do not, even with a free local alignment (10-20 min: -0.01; 30-70 min: 0.43; 70-110 min: 0.92).
  Segments between cuts aligned on their own land at the right komoot place for 7 of 10 long segments.

**Clip 2:00-20:00** (located by signature: komoot km **3.21 -> 9.13**, forward, consistent with the Flößersteg at 9.25 km right after the clip end):
- Graph = komoot loop: best -21.3 at f 200, **kappa 0.8 (lower scan edge)**: 5.9 komoot km for 7.47 nominal km, i.e. kappa about 0.79.
  Per 3-min block (clip time) correlation 0.71, 0.00, 0.23, 0.95, -0.40, 0.63: the clip contains the poorly fitting part (orig 5-8 and 14-17 min).
- **Corridor (all path tiers within 300 m of the section, 109 km): the model finds the truth.** Best plausible cell f 230 / k 0.80 (-18.65), decode
  **64 % within 30 m, median 2 m, posterior 0.97**; at k 0.75: 83 % within 30 m. At k 0.92 (a "normal" kappa) only 9 %.
- Small area, section +- 3 km, roads only (200 km): best f 148 / k 1.5, 0 % within 30 m (truth not in the map).
- Small area, section +- 3 km, all path tiers (886 km): global best is the corner **f 148 / k 2.0 (-12.75)**, 0 % within 30 m; the local peak f 230 / k 0.8
  (-18.68) decodes **50 % within 30 m** (median 34 m). k 2.0 means v99 = 26 m/s (94 km/h) on a bike; `CAL_VMAX` (45 m/s, all vehicles) lets it through.

## 4. Ranked diagnosis

1. **(B) Route not in the map, certain, alone sufficient for the shipped config.** Bike paths are off: the bike road map holds 30.7 % of the loop
   (5.2 % of the clip section). With the paths fallback the 78 x 50 km area forced tier pruning to 53 %. Even all tiers leave 7 gaps > 100 m (service/footway).
2. **(A + D) The heading signal fits the true route only in parts, and the video is cut.** Measured: 10 cuts with B-roll inserts; poor heading correlation
   for most of minutes 0-70 while the two yaw estimators agree. Inferred (not separable without GPS): the misfit is either camera-vs-path heading
   (mount, looking around) or local route variants against the komoot plan, made worse by the cuts (the model forces continuity across them).
   Consequence: over the whole video the true route scores below wrong routes even in a 300 m corridor.
3. **(C) Calibration runaway, a symptom with two concrete parts.** (a) The surface always rises towards f_eff 148 (broader emission scale when headings
   misfit) and towards high kappa in dense graphs; for a bike, k 1.5-2.0 means 70-94 km/h at v99, but the plausibility check uses one 45 m/s limit for
   every vehicle. (b) The true kappa is about 0.75-0.8, at or below the base grid's lower edge 0.8; the right decode needs k 0.75-0.8 (k 0.92: 9 %).
   The search area (78 x 50 km, 6306 km directed) multiplies the wrong candidates; a clip-sized area with paths is not enough on its own either.
4. **(D) Wrong start/direction/other route: excluded** at the km level (direction, start, landmarks, independent segment alignments agree).

## 5. Proposed fixes (none implemented)

| # | fix | expected effect (evidence) | effort / risk |
|---|---|---|---|
| F1 | Bike paths for an explicit bike **with a hint or a small area**: `--bike-paths` flag / app toggle (WP2 of the RC plan) | clip in a 300 m corridor: 64-83 % within 30 m, median 2 m. Without paths: 0 %. | small (flag exists in config); only for opted-in runs, no change to default runs |
| F2 | Vehicle-aware speed limit in `calib.plausible` (e.g. v99 <= 20 m/s for an estimated/explicit bike) | clip +-3 km with paths: rejects the k 2.0 corner, the next candidate decodes 50 % within 30 m | small code, but changes candidate choice of every bike case: needs the full regress bench (Roanne, Pontaix, Grimone, Rousset, cdp, pennes) |
| F3 | `way_ok`: admit `service` without bicycle tag unless access/vehicle closed (agricultural/forestry ways are bike-legal) | closes 1.65 km of the 7 gaps on the loop (all-tier coverage 94.5 % -> about 98.6 %) | small; affects only path maps (off by default); bump `BIKE_PATH_RULES` |
| F4 | Cut detection: a gap with 0 inliers + diff spike becomes a "jump" (free re-entry within a radius) instead of continuous riding | removes the forced continuity at 10 cuts; size of gain not measured | medium (steps/HMM gap model), needs tests |
| F5 | Allow kappa 0.65-0.8 in the base scan for bikes (today only via the edge extension under the memory rule) | true kappa here 0.75-0.8 | small, scan cost + memory at low kappa; bench needed |

Not implemented because none is both clearly effective on the default path and verifiable without the heavy regress bench: F1 only matters with
paths on (default off by maintainer rule A10), F2/F5 change every bike case, F3 only path maps, F4 is a model change. Recommended order: F1 + F3
(opt-in, no default change), then F2 with the bench, then F4.

Not verified: a real pipeline run on the clip (`rsm.pipeline run --hint`), because the shipped hint corridor uses the vehicle classes (paths off) and
config changes are not possible in a subprocess run without editing `config.py`; the corridor tests above use the same HMM functions directly.
Variants not finished (stopped for the clip change): relaxed/all-class corridors and all-tier bbox scans of the whole video.

## 6. Fixes (2026-11-13, F1 F2 F3 F5; F4 cut detection is separate work)

Setup: clip 2:00-20:00, motion/rotation from the full-file tracks cut to clip time (original - 117.68 s), `--vehicle bike`, steps map..gpx with the real
pipeline workers (`rsm.bench.regress.run_case`, code snapshots `work/regress/_code/bf_*`), outputs `work/bavaria-fix/` (git-ignored, `results.jsonl`).
Area A: komoot section +- 3 km (6.6 x 10.2 km), no start frame, no hint. Variant C: same area + coarse hint (25 points of the section), 300 m corridor.
Truth: komoot km 3.21-9.13; metric = decoded seconds within 30 m of the section, median distance, share of the section covered within 30 m.

| run | verdict | f_eff / kappa | within 30 m | median | covered |
|---|---|---|---|---|---|
| A / C old code (roads, bike) | uncertain | 148 / 0.99 | 0 % | 1624 m | 0 % |
| A `--bike-paths on` (all fixes on) | uncertain | 229 / 0.80 | 46 % | 62 m | 52 % |
| A `--bike-paths fallback` | uncertain (paths chosen) | 229 / 0.80 | 46 % | 62 m | 52 % |
| C `--bike-paths on` (all fixes on) | uncertain, full-frame fallback chosen | 229 / 0.80 | 46 % | 62 m | 52 % |
| C `on`, F3 off | **confident** (corridor) | 210 / 0.80 | **50 %** | **38 m** | 52 % |
| C `--bike-paths fallback` | uncertain, road corridor chosen | 148 / 0.65 | 3 % | 436 m | 1 % |
| A / C `on`, F2 off or F5 off | same as with them | 229 / 0.80 | 46 % | 62 m | 52 % |

Regress bench with F1-F5 all switched on (`bf`, from route_search, seeded from `loc`, against `bike2`): roanne, pontaix, grimone, amalfi all
confident, same road 100 %, position difference median 0.0 m, along-track 3.59 / 11.07 / 6.41 m unchanged (the extra kappa column never held the peak).

Go / no-go:
- **F1 go (opt-in, default off):** 0 % -> 46-50 % within 30 m, median 1.6 km -> 38-62 m. `run --bike-paths off|on|fallback`, app control
  "Rad- und Waldwege einbeziehen" (Aus / Automatisch / Ein). Hint corridors are fitted to the memory cap on their own; an area too large even for tier 0
  searches the roads with a `bike_paths` problem status. Still `uncertain`: the clip's heading misfit (section 3) remains.
- **F3 no-go (off, `BIKE_SERVICE_UNTAGGED = False`):** coverage of the loop 94.5 -> 98.3 %, of the clip section 92.9 -> 100 %, but the corridor run drops from
  confident (50 %, 38 m) to uncertain and falls back to the full frame (46 %, 62 m); area run unchanged.
- **F2 no-go (off, `CAL_VMAX_BIKE = CAL_VMAX`; tested 20 m/s):** it rejects the corner (f 148 / k 1.73, 20.1 m/s at v99), but the candidate choice already
  picked 229 / 0.80 without it: no change on the clip. No regression on the bench.
- **F5 no-go (off, `K_GRID_BIKE = K_GRID`; tested k 0.65 column):** no change in the runs with paths; in the C fallback run the road corridor peak moved to
  k 0.65 (wrong, 3 %). No regression on the bench.
- Found, not fixed: with a hint and `fallback`, the "better" rule (verdict rank, then nats/km) compares maps of very different size and kept the road
  corridor (C fallback). Use `on` with a hint.
