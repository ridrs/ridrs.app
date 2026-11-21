# Concept: test strategy with clips and frozen image-analysis results (2026-11-19)

Goal: the image analysis of the video (steps `motion` and `rotation`) is tested on **short clips only**. Route detection (from `map` on) is tested on the
**stored results of the image analysis**, never on a video. At most **two videos of about 10 minutes** run the whole pipeline end to end. Everything
else is a clip. The test cycles get shorter and the test data smaller.

This concept builds on [CONCEPT_fast_testing.md](CONCEPT_fast_testing.md) (step cache, scan memo, probes, clip bench, all built 2026-11-13) and
reuses those tools; it does not rebuild them.

Maintainer requirements (2026-11-19), in this order before anything else:

1. **Tests whose video is missing are removed.**
2. **All videos move into `test-data/`.**
3. **At most 1-2 videos of about 10 minutes; everything else is a clip.**

## 1. Where we are (measured 2026-11-19)

| level | what | data | time |
|---|---|---|---|
| unit (`pytest tests/` in `research/route-shape-matching`) | 559 tests, synthetic or small data | none | 50 s (1 fails: `test_frozen_json_matches_config`, open working-tree changes) |
| real-video tests (`tests/test_cuts.py`, 4 tests) | scene cuts in windows of 11-20 s | read the **whole** video from `~/rsm-data/videos/` | skipped: the videos are not there |
| Rust e2e (`src-tauri/tests/e2e.rs`, 6 tests) | app paths, pipeline, cancel/resume, Incyclist, DEM | Roanne video 1.6 GB, `runs/vallee-de-roanne` | all `#[ignore]`, run by hand |
| regress bench (`rsm.bench.regress`, 12 cases) | whole pipeline, whole videos | 25 GB Van Gestel + own videos | 4.4 h for motion + rotation alone, route_search 40-120 min |
| clip bench (`rsm.bench.clips`, 44 clips of 75 s) | motion + rotation | 6.3 GB | about 25 min first run |

- The bench caches `work/regress/`, `work/clips/` and `work/vangestel/` (GPS alignments) are **no longer on this machine**. The only finished run in
  `test-data/` is `runs/vallee-de-roanne`.
- The image analysis results are about **100x smaller** than the video: Roanne (44 min, 1.6 GB) has `motion/` 13 MB and `rotation/` 3.6 MB.
- The split is almost clean already: `motion` and `rotation` read the video (scene cuts and their same-scene veto included, `steps_a.py`); `map`,
  `plausibility`, `refine` and `gpx` do not. **One leak:** `route_search` decodes frames again for the standstill detection
  (`steps_b.py:646`, `standstill.detect(d, P["video"])`, `STILL_ON = True`). `insight.frame()` also reads the video, but only for the app's analysis
  view, not for the route.

### Videos on this machine

| video | where today | length | size | truth | used by |
|---|---|---|---|---|---|
| 9 Van Gestel rides | `test-data/vangestel/<route>/` | 15-170 min | 24.6 GB | GPS (`track.gpx`) | e2e, regress, clips, angle |
| Gotthard 480p | app project `neues-projekt-1795092416245/import/WBai5dLao38_480p.mp4` (2 identical copies) | 41 min | 298 MB | checkpoints (GOTTHARD_DIAGNOSIS) | regress `gotthard-start` and clips expect `$RSM_VIDEOS/gotthard.mp4` |
| Cayolle 480p | app project `neues-projekt-1795095414688/import/PCI25WijGrE_480p.mp4` | 98 min | 767 MB | none | `test_cuts.py` and clips expect `cayolle-1080p.mp4` / `cayolle.mkv` |
| Madone 4K | `~/Projects/Privat/Ridrs/videos/…[rhV8i8dyMZU].webm` and `~/FR_Col_de_la_Madone/FR_Col_de_la_Madone.mp4` | 51 min | 8.7 + 8.6 GB | landmarks | regress, clips expect `$RSM_VIDEOS/madone.webm` |
| Amalfi 4K / 720p | `~/Projects/Privat/Ridrs/videos/` | 127 min | 26.3 / 3.2 GB | Strava GPX, offset unknown | regress, clips expect `$RSM_VIDEOS/amalfi.mkv` |
| Bavaria 4K | `~/Projects/Privat/Ridrs/videos/` | 115 min | 19.6 GB | komoot plan (no time) | clips expect `$RSM_VIDEOS/bavaria.webm` |
| Nice-Monaco 720p | `~/Projects/Privat/Ridrs/videos/` | 75 min | 1.9 GB | a GPX lies next to it (not checked) | nothing yet |
| Verdon 1080p (2 videos, one of them twice) | `~/Projects/Privat/Ridrs/videos/` | 44 / 50 min | 1.7 / 2.1 GB | none | nothing |
| Switzerland valley 720p | `~/Projects/Privat/Ridrs/videos/` | 55 min | 1.4 GB | none | nothing |
| Clue du Pérouré | **not found** | | | | `test_cuts.py`, clips |
| Gotthard / Cayolle HDR 1080p (`SAMPLES`) | **not found** (`research/road-reconstruction/sample_videos/`) | | | | `rsm/angle/videos.py` |

The short clips in `~/Projects/Privat/Ridrs/experiments/road-reconstruction/routes/*/source/clip.mp4` (12 clips, 23-55 MB) belong to the old road
reconstruction experiment and are not used by video2gpx tests.

## 2. Target picture

### Test levels

| level | what | input | when | budget |
|---|---|---|---|---|
| **T0** unit | domain logic, synthetic data | none | every edit | < 1 min |
| **T1** image analysis | real `motion`, `rotation`, scene cuts and standstill on clips, scored against GPS or events | `test-data/clips/` | every change to the image side | < 10 min, cached per step key |
| **T2** route | `map` to `gpx` on frozen image results: short route cases (2-10 min windows) and the full cases | `test-data/stages/`, `osm/`, `dem/` | every change to the route side | 5-15 min (decode-only changes: minutes; HMM changes: scan) |
| **T3** end to end | the whole pipeline on the two long videos, app e2e (Rust) | `test-data/long/` | before merging a pipeline change, nightly | 15-25 min |
| **T4** regeneration | rebuild `stages/` from the full sources | `test-data/sources/` | only after a change to `motion` / `rotation` code, deliberate, overnight | 5-6 h |

T4 is not a test: it produces the inputs of T2. It is the only place that still reads whole videos.

Since the extraction (2026-11-20, docs/CONCEPT_extraction.md phase 4) a stage also holds `extract/`, the stored points of the whole source. After
a change to the interpretation of the image side (the horizon, the fits, the gate, traffic, the far bands, A21-A25 and the like) its status is
`reinterpret`, and `rsm.bench.stages reinterp` rebuilds `motion/` and `rotation/` of every such stage from the stored points in minutes instead of
the 5-6 h of T4. T4 is left for a change of the extraction itself (decode, destatic filter, grid, tracker, OpenCV).

### Layout of `test-data/` (git-ignored, never committed)

```
test-data/
  sources/<id>/video.<ext>          full videos, moved here (requirement 2); read only by the cutter and by T4
  sources/vangestel/<route>/        the Van Gestel rides (video.mp4, track.gpx)
  sources/<id>/source.json          origin, licence, sha256, duration, truth files
  long/<id>/video.mp4               the two ~10 min videos (requirement 3), cut from sources/
  long/<id>/case.json               window in the source, bbox, pbf, truth (track.gpx cut to the window, or checkpoints)
  clips/<id>/clip.mp4               short clips, 20-75 s
  clips/<id>/clip.json              source id, t0, duration, class (secured / open), what it tests, expected values
  stages/<case>/motion/ rotation/   frozen image results of the full sources (standstills in rotation/)
  stages/<case>/extract/            the stored points of the full source (docs/CONCEPT_extraction.md; reinterp rebuilds motion/ rotation/ from it)
  stages/<case>/stage.json          code hash of the image side, sha256 of the source, parameters, horizon, GPS alignment
  truth/vangestel/<route>/          the truth files of the sources (track.gpx, the verified Pontaix track), copied by `rsm.bench.stages truth`
  osm/ dem/                         as today; later cut per case
  runs/                             finished runs for the app e2e (as today)
```

`vangestel/` moved to `sources/vangestel/`. The tests read `clips/`, `long/`, `stages/` and `truth/` only.

### Truth: verified and coarse (maintainer, 2026-11-19)

| truth | where | good for | not good for |
|---|---|---|---|
| **verified** | Pontaix: `sources/vangestel/pontaix-chamaloc/manually_verified_video2gpx.gpx`, a video2gpx result checked by the maintainer, 5 points per second, `<time>` = video time | fine-tuning: speed, heading, turn timing, position along the road against video time; no clock alignment needed | the lateral position (the driving line is the OSM centre line plus a fixed offset, a model, not a measurement) |
| **coarse** | the other 7 Van Gestel `track.gpx` | coarse localisation: is the route on the right road, where is the camera within about 10-20 m | anything timed to seconds: speed, heading rate, turn timing, the clock-aligned position error |
| checkpoints / landmarks | Gotthard (10 checkpoints), Madone (landmarks) | the route at given video seconds, with a tolerance | fine-tuning between the points |

Measured on Pontaix: the Van Gestel GPS lies 3.1 m (p50) / 5.1 m (p90) / 10.2 m (max) from the verified track, but its clock against the video drifts
between about -2 and +2 s over the first 30 minutes and jumps by about 6 s at 31-33 min. Recorded in `clip_sources.json` (`gps_quality`, `verified`)
and in `sources/vangestel/source.json`.

Consequences:
- **T1 (clips):** fine metrics (`v_err_med`, `v_fail`, `rot_rms_deg`, `turn_err`) are scored only on Pontaix clips against the verified track.
  Clips of the other rides are scored on events (cuts, standstills, odometry failure), on parity with the full run (`vs_full_*`) and, if at all,
  on the GPS speed only as a coarse check with wide tolerances (a scale error such as Lahntal's 3x stays visible).
- **T2 (route):** coarse GPS cases are scored on the place only: share of time on the same road as the GPS, distance to the GPS track without
  time (nearest point), with tolerances of 20 m or more; no score that compares positions at the same second. Pontaix is the only case with a
  timed position score.
- **No tuning on coarse truth.** A parameter or threshold is tuned on Pontaix (and checked on the coarse cases for regressions), never on the
  coarse cases alone.
- The circularity of the verified track: it is a video2gpx result. It is the reference for regressions and for timing, checked by eye; a change
  that makes the pipeline better than it will look like a regression and needs the maintainer's look.

### Direction: a rolling set of verified videos (maintainer, 2026-11-21)

The set of test videos will move toward more cases with a precise, verified GPX, taken from different videos.
- **No sources are kept.** A video's source is discarded after its video analysis. The case keeps its extraction (`extract/`), its stages and the
  verified GPX.
- **The set rolls forward** with the most recently verified videos.
- **An extraction change retires cases.** A change to the extraction (the first step, status `stale`) does not lead to a T4 over old sources.
  It retires the data of those cases, and testing continues with the next verified videos.
- **Interpretation changes stay cheap.** They keep using `reinterp` on the stored extraction.

**Built (2026-11-21): source-free stages and inexact ranges.** Sa Calobra (YouTube 4NgYtX5PiVo) is the first case.
- **Adopting a stage.** `rsm.bench.stages adopt --id <id> --run <project>/out --video <source> [--scenic <id>.scenic.json]` takes the extraction
  of an app run and rebuilds `motion/` and `rotation/` from it with the current code. The source is needed this one time, for the pixel
  probes. Then it freezes the stage with `source.discarded` (file name and sha256 only). `--scenic` writes the atlas result checked by the
  maintainer as the verified track (`truth/scenic/<video id>/verified.gpx`, `<time>` = video time).
- **Status of a source-free stage** (`SOURCE_FREE_IDS`):
  - `fresh`;
  - `frozen` after an interpretation change: there is no `reinterp`, because the pixel probes need the source. T2 keeps running the route
    side on the frozen image side and says so in its log;
  - `retire` after an extraction change: T2 stops the case.
- **Inexact ranges.** A verified source may list ranges of the track that are not to be checked against future runs: `inexact`
  [[t0, t1, why]] in video seconds in `clip_sources.json`. The timed score (`regress._score_verified`) leaves those seconds out and reports
  them as `n_inexact`. Sa Calobra: 1010-1040 s (frames 30264-31179 viewed by the maintainer), the cut at 1032 s at the turn at the bottom.

First T2 (tag `sacal1`, 2026-11-21, branch `feat/v2g-extraction`; adopt 132 s, route side 8 min), scored with 1010-1040 s inexact:
- verdict confident, kappa 1.51 (motorcycle scale);
- right road 98.5 %; along median 2.1 m, p90 6.0 m; ≤ 10 m 96 %.

Off the road: 164-168 s, 1000-1009 s and 1041-1058 s.
- 164-168 s is the cut at 166.5 s that video2gpx misses. The track chosen as truth (`scenic.json` without the hand-added cut) does not have it
  either.
- The other two are right before and after the cut at the turn, where the maintainer found the track good: errors of the pipeline.

**Screening, then the full set (maintainer, 2026-11-21).** Studies of variants run in two rounds:
1. **Screening.** Every variant runs T2 on the verified cases only (today Pontaix and Sa Calobra, `--only pontaix,sacalobra`): about
   15-20 min instead of about 1 h 45 min for all 16 cases.
2. **Full set.** Only the best two or three run T2 on all cases and T3, to show their side effects.

The reinterpretation from the stages is cheap (about 13 min for all stages); the route search on the map is the expensive part and runs one
case at a time (peak about 7 GB).

Still open:
- T1 clips and T3 still need sources;
- a `frozen` stage does not follow image-side changes, which needs reinterp without the pixel probes' source (short stored windows, or probes
  that read the extraction).

## 3. Building blocks

### A. The contract between image analysis and route (built 2026-11-19, step 1)

- The image side (`motion`, `rotation`) writes `motion/` and `rotation/`; the sure standstills are part of it now (`rotation/standstill.json`).
  The route side (`map`, `route_search`, `plausibility`, `refine`, `gpx`) reads only these plus the map and the DEM. That is the contract and
  the content of `stages/`.
- **Standstill detection moved to the image side:** `steps_a.standstill` runs at the end of the rotation step (after `far_heading.npz`, which
  its candidates need) and writes `rotation/standstill.json`; `route_search` no longer decodes frames. The `STILL_*` parameters moved from the
  route_search key to the rotation key (`cli.py`), so an existing project reruns rotation once on resume. The status `standstill` now comes with
  the rotation step.
- **Guards (T0, `tests/test_pipeline.py`):** `test_route_search_runs_without_the_video` runs route_search with a finished image side, a video path
  that does not exist and every decoder patched to fail; `test_route_side_modules_call_no_decoder` checks that `steps_b`, `steps_c`, `steps_d`
  and `odofail` call no decoder; `test_standstill_is_part_of_the_rotation_step`. All three fail on the code before step 1.
  `gpx_step` still uses `P["video"]` for the name of the result (the file stem), which reads no frame.
- **Same results (checked 2026-11-19):** the app project of Gotthard 480p (3 sure standstills) rerun from `rotation` with the code before and after
  step 1: all 42 result files equal except timings, step hashes, the pipeline hash in `route.gpx`, and the `standstill` status, which now sits on
  the rotation step. `route_search` took 8.8 s instead of 17.0 s; the detection moved into rotation (76 s instead of 70 s).

**Format of a frozen stage** (`test-data/stages/<case>/`, written by T4 in step 2):

```
stages/<case>/
  motion/    motion.csv  motion.json  summary.json  cuts.json
  rotation/  win_video_base.npz  tracks.pkl  far_heading.npz  cuts.json  vehicle.json  summary.json  standstill.json
  stage.json
```

`stage.json`:

| field | content |
|---|---|
| `version` | 1 |
| `case` | case id, as in `regress_cases.json` |
| `source` | `{"id", "path"}` relative to `test-data/sources/`, `"sha256"` of the video file, `"duration_s"`, `"fps"` |
| `window` | `[t0, t1]` video seconds the stage covers (whole video: `[0, duration]`) |
| `params` | the case params the image side reads (`vehicle`, `intro_end`, bbox for the area status) |
| `code` | `{"motion": key, "rotation": key}`: the step-cache keys of `stepcache.step_keys`, computed with the video signature replaced by the source sha256, so a moved source keeps its keys |
| `frozen` | `code_hash` and `version` of `frozen.json` at the time |
| `horizon` | the horizon of `motion.json` (for clips, B) |
| `gps_align` | for GPS cases: the clock offset per window (what `work/vangestel/align_<name>.json` held), else null |
| `extract` | the stored extraction (`extract/`, 2026-11-20): source sha256, `extract.VERSION`, `params()`, height, OpenCV version, hash of the extraction code; null for a stage without one |
| `made` | date, machine, seconds per step; `extracted` and `reinterpreted` after `reinterp` |

T2 recomputes `code` for the current code. A difference marks the case **stale** (failed, with the hint "run T4"), never passed.

### B. Clips for the image analysis (T1)

- **Cut by stream copy from a keyframe** (`ffmpeg -ss <keyframe> -c copy`), not re-encoded: the clip has the source's own pixels and codec, so the
  decode is the same as in the full video. Today's clip bench re-encodes to 640x360 grey crf 8 (about 100 MB per 75 s); a stream copy of a 1080p
  Van Gestel clip of 30 s is about 18 MB, of a 4K clip about 85 MB.
- **Horizon and calibration from the full run:** a clip calibrates the horizon on its own few seconds; on `grimone-typical-39m45` this moved the
  far-feature band and the yaw correlation with the full run fell to 0.55. New pipeline option: take the horizon (and further calibration values)
  from `stage.json`. Clip tests run with it; one clip test per source runs without it, so the horizon calibration stays tested.
- **About 20 clips, 20-75 s each, total ≤ 2 GB**, chosen from the clip bench results by what they test:

  | kind | count | example |
  |---|---|---|
  | typical straight / curves, verified truth | 4 | Pontaix (fine metrics) |
  | typical straight / curves, coarse GPS | 3 | Roanne, Rousset, Pennes (events and parity only) |
  | sharp turns | 3 | Pontaix (verified), hairpins Rousset, Grimone (parity only) |
  | known odometry failure | 2 | `lahntal-uniform-35m42` (vms speed about 3x too low), Gotthard valley road 3:50-5:50 |
  | scene cuts and false cuts | 3-4 | Gotthard sun flash 3:00-3:20 and intro cut 0:20, Cayolle intro cut 0:49 (only if they pass on the 480p source, see section 4) |
  | standstill | 2 | a stop and a slow crawl in traffic, chosen from the full runs |
  | traffic / occlusion | 1-2 | passing traffic, Amalfi or Nice-Monaco |

- **Scoring:** Pontaix clips against the verified track with the existing fine metrics (`v_fail`, `v_err_med`, `rot_rms_deg`, `turn_err`); event clips
  with plain assertions (a cut at t, no cut in [a, b], standstill from a to b); every clip also against its own window in the full run
  (`vs_full_*` correlation ≥ 0.95 as a parity check). Expected values and tolerances live in `clip.json`.
- The GPS alignments (`work/vangestel/align_<name>.json`) are lost; T4 computes them again once and stores them in `stage.json`. For the coarse
  rides they only place a clip window; Pontaix needs none (the verified track is in video time).

### C. Route tests on frozen stages (T2)

- `regress.py` gets a mode `--stages`: the case starts at `map` with `motion/` and `rotation/` copied (or cloned with `cp -c`) from
  `stages/<case>/`. Step cache and scan memo work as before.
- **Short route cases** cut from the frozen stages (window t0-t1 of the track series, no video): the hard spots, with checkpoints or the GPS as
  truth (coarse GPS: on the right road, within tolerance), 1-3 min each. Start list: Gotthard start 0:00-9:48 (odometry failure, village vs. bypass; 10 checkpoints exist), Rousset end (last 940 s
  wrong), Madone town, Bavaria start, Pennes descent.
- **Full cases** on frozen stages: the 8 Van Gestel rides, Madone, Amalfi, Gotthard, Bavaria. With the scan memo a change after the scan reruns in
  minutes; a change to the HMM reruns the scan (40-120 min for all, as it must).
- Probes (`rsm.bench.probe`) stay the fastest check of one changed function on all cases.

### D. Two long videos (T3)

| id | window | why | truth |
|---|---|---|---|
| `pontaix-10m` | Pontaix-Chamaloc 0:00-10:00 | the one ride with verified truth: timed scores of the whole pipeline (D6) | the verified track, cut to the window (video time) |
| `gotthard-start` | Gotthard 480p 0:00-9:48 | the only case with an odometry failure, a disputed start and scene cuts; exercises `odofail.py`, the local pass, islands and the verdict | 10 checkpoints (`regress_landmarks.json`) |

- `e2e.rs` reads `long/pontaix-10m/` instead of the full Roanne video (`RSM_E2E_VIDEO`); `runs/` gets the finished run of the 10 minutes.
- Both run the whole pipeline (motion to gpx) and are the only check that the two halves still fit together. The frozen stages of both are
  compared with what T3 produced (parity of the contract).
- `gotthard-start` was cut from the HDR 1080p version before; the checkpoints are times and stay valid, but the expected verdict must be confirmed
  once on the 480p source.

## 4. Order of work

### Step 0: the maintainer requirements (done 2026-11-19)

**0a. Tests whose video is missing are removed.**

| test / case | video it needed | done |
|---|---|---|
| `tests/test_cuts.py::test_gotthard_sun_flashes_3m00_3m20_are_no_cut` | `~/rsm-data/videos/gotthard.mp4` (HDR 1080p) | removed |
| `tests/test_cuts.py::test_gotthard_intro_cut_at_0m20_stays_a_cut` | same | removed |
| `tests/test_cuts.py::test_cayolle_intro_cut_at_0m49_is_a_cut` | `~/rsm-data/videos/cayolle-1080p.mp4` | removed |
| `tests/test_cuts.py::test_clue_du_peroure_intro_cut_at_0m50_is_a_cut` | `~/rsm-data/videos/clue.mp4` | removed |
| `clip_sources.json`: `clue` | not found anywhere | removed |
| `clip_sources.json`: `gotthard`, `cayolle`, `madone`, `amalfi`, `bavaria` | `$RSM_VIDEOS/…` | repointed to `sources/<id>/` |
| `regress_cases.json`: `gotthard-start` (source video), `madone-*`, `amalfi` | `$RSM_VIDEOS/…` | repointed to `sources/<id>/` |

`rsm/angle/videos.py` (`gotthard`, `cayolle`, `amalfi` in `research/road-reconstruction/sample_videos/`, not found) is a finished study, not a
test; its entries are kept as a record and fail only when that study is run again. Its `VAN` path still names `test-data/vangestel/`:
`rsm.angle.videos` is part of the code hash of the shipped pipeline (`frozen.json`), so step 0 leaves it alone; it is repointed with the next freeze.

The Gotthard and Cayolle cut tests come back in step 3 as clip tests, cut from the 480p sources, **only if they pass there with the current
thresholds** (the frame difference of a 480p source differs from 1080p). Thresholds are not tuned to make them pass. Clue is lost until the video
is found again.

**0b. All videos are in `test-data/sources/`** (89 GB; same volume, so renames, no copies). Each folder has a `source.json` with the original path,
the YouTube link, the licence note and the truth that exists.

| folder | from |
|---|---|
| `sources/vangestel/<route>/` (9 rides, unchanged inside) | `test-data/vangestel/` |
| `sources/gotthard/video.mp4` (480p) | app project `neues-projekt-1795092416245/import/` |
| `sources/cayolle/video.mp4` (480p) | app project `neues-projekt-1795095414688/import/` |
| `sources/madone/video.webm` (4K) | `~/Projects/Privat/Ridrs/videos/` |
| `sources/amalfi/video.mp4` (4K), `small-720p.mp4` | `~/Projects/Privat/Ridrs/videos/` |
| `sources/bavaria/video.webm` | same |
| `sources/nice-monaco/video.mp4`, `track.gpx` | same |
| `sources/verdon-palud/`, `sources/verdon-scenic/`, `sources/switzerland-valley/` | same |

- The byte-identical `videos/verdon.mp4` went to the Trash.
- Not moved: `~/FR_Col_de_la_Madone/` is an Incyclist package made by video2gpx (its video is a copy of the Madone source), not test material;
  the second identical Gotthard 480p copy stays in the import folder of app project `neues-projekt-1795094025222`.
- `amalfi.mkv` of the bench was neither of the two Amalfi files by name; the cases now use the 4K original. Results may differ from old Amalfi runs.
- `$RSM_VIDEOS` defaults to `test-data/sources/` (`clips.py`, `regress.py`, `bench_pipeline.py`); `~/rsm-data/videos` is no longer a default.
- `runs/vallee-de-roanne` points at the moved video. Its step hashes contain the old video path (`file_sig`), so it is rebuilt in step 5 anyway.
- **Side effect (D2):** app projects that referenced `~/Projects/Privat/Ridrs/videos/…` or the two moved imports have no video until they are
  relinked.

**0c. Paths repointed:** `gps_truth.py`, `quanta/gps.py`, `tools/bench_pipeline.py`, `regress_cases.json`, `clip_sources.json`,
`src-tauri/tests/e2e.rs` (default `sources/vangestel/vallee-de-roanne/video.mp4` until step 5), `docs/README.md`.

### Steps 1-6

1. **Contract (A):** standstill to the image side, guard tests, `stage.json` format; route results identical to before (done 2026-11-19).
2. **T4 once:** frozen stages for all sources with truth (8 Van Gestel, Madone, Amalfi, Gotthard, Bavaria; about 5-6 h in the background through
   `scripts/heavy.sh`) and the GPS alignments again. Built 2026-11-19: `rsm.bench.stages` (`make [--only ids]` runs motion + rotation of the whole
   source as `_step` workers in `work/stages/<id>/`, computes the GPS clock alignment for the Van Gestel rides with a ±20 s search, writes
   `test-data/stages/<id>/`; `check [--verify-source]` reports fresh / stale / missing). The sources and their truth come from `clip_sources.json`
   (ids `roanne`, `pontaix`, `rousset`, `grimone`, `cdp`, `pennes`, `lahntal`, `marburg`, `madone`, `amalfi`, `gotthard`, `bavaria`).
   `stepcache.step_keys` takes the source sha256 in place of the file signature (`video_sig`). Tests: `tests/test_stages.py`.
3. **Clips (B):** cutter by stream copy, horizon option, about 20 clips, T1 as pytest marker `clips`; the clip bench reads them. Built 2026-11-19:
   - `rsm/bench/clip_set.json` (committed) lists 21 clips of 30-75 s (561 MB): 6 Pontaix (typical, curves, sharp turns, traffic, one with its own
     horizon calibration), 3 typical coarse-GPS rides, 2 hairpins, 2 known odometry failures (Lahntal, Gotthard valley), 4 cut clips (Gotthard
     intro with standstills, Gotthard sun flash without a cut, Amalfi's edited intro, a Bavaria cut), 2 standstills, 2 traffic. Chosen from the
     frozen stages (most heading change, closest to the median, most traffic candidates, detected standstills and cuts). Cayolle has no stage and no
     clip.
   - `rsm.bench.clips cut [--again]` copies the coded frames from the keyframe at or before the wanted start into `test-data/clips/<id>/` and checks
     that the clip's first decoded frame equals the source frame (on Gotthard, with B-frames, a seek just after a keyframe fell back one GOP, about
     6 s: the cut now aims between two keyframes). `clip.json` holds the exact start in source seconds.
   - Horizon option: the motion step takes `P["calibration"]` (the `motion.json` of the source's stage) and uses its horizon calibration instead of
     calibrating on the clip (`vmsx.motion.analyse_parallel(calibration=...)`); `stepcache.step_keys` keys motion and rotation by it. Without the
     option the image side is unchanged (Gotthard rebuilt and compared, then the 12 stages rekeyed: `rsm.bench.stages rekey --reason`).
   - Running horizon (A24, 2026-11-20): the horizon calibration also carries the focus-of-expansion track of the whole source (`track`, source
    seconds); a clip reads it at clip time + `frame0` / fps, a T2 window keeps it with `track_t0` = its start (`rsm.bench.stagecut`). A clip that
    calibrates itself samples its own frames and stores its track shifted to source seconds.
  - Seed of the traffic candidates: the candidate fits of a disturbed pair are random samples seeded by the pair index. In a clip that index
     counts from the clip's first frame, so a clip drew other candidates than the whole video, picked other fits, and on Bavaria the cut at
     521.5 s was not confirmed (the inliers around it differed). The motion step now takes `P["frame0"]` (the clip's first frame in the source)
     and seeds with the source index (`vmsx.motion.pair_row(seed0=...)`); with it the per-second speed of every clip correlates 0.99-1.00 with
     its stage window and the speed ratio is 1.00.
   - Scores: parity against the stage window for every clip (`vs_full_v_corr`, `vs_full_v_ratio`, `vs_full_yaw_corr`), the fine metrics against
     the verified track on Pontaix only, and events (`cut_at`, `still`: none missed, none false). Bounds per clip (`checks`) from the first run.
   - T1: `tests/test_t1_clips.py`, marker `clips`, deselected by default (`pytest.ini`); `scripts/heavy.sh .venv/bin/python -m pytest -m clips`.
     T0: `tests/test_clips.py` (cut on a synthetic video, events, checks, keys, verified reference).
4. **Route on stages (C):** `regress.py --stages`, short route cases, T2. Built 2026-11-19:
   - `rsm.bench.regress --stages`: every case with a `stage` (regress_cases.json) starts at `map` with motion/ and rotation/ of its frozen stage; no
     video is read and the source need not exist; a stale stage stops the case. The route steps are keyed by the source hash (and window) and go
     through the step cache as before.
   - Short cases are windows of the stages (`window` [t0, t1)): `gotthard-start` 0-588 s (the old 588 s cut video is no longer needed),
     `rousset-end` 8531-9471 s, `pennes-descent` 2700-3300 s, `madone-town` 2400-2760 s (5 landmarks). `rsm.bench.stagecut.window` cuts every
     series of the stage and shifts it to start at 0; the route of a window counts seconds from t0 and the scores add t0 back. A window keeps the
     horizon calibration, the vehicle vote and the traffic picks of the whole video (the image results the route side gets in the whole run).
   - Truth by quality: Pontaix is scored timed against the verified track (no clock alignment); the coarse Van Gestel cases get place scores only
     (`place_road`: share of route seconds within 20 m of the nearest track point, `place_median_m`, `place_p90_m`; no time); checkpoints and
     landmarks as before.
   - OSM: `$RSM_OSM_DIR` defaults to `test-data/osm/` (rhone-alpes; alps and sud cloned there from the app's OSM folder with `cp -c`; Hessen
     downloaded from Geofabrik on 2026-11-20).
   - A window that does not start at the video start carries a `start_bbox` (±1 km around the position at t0 of the confident full run of the
     same stage, never from the GPS), as the app run with a start frame: without it `rousset-end` found no route and `pennes-descent` a road
     14 km away (10-15 min of road in a 60 km frame are ambiguous).
   - First T2 (tag `t2base`, 2026-11-19, cold: 98 min for 13 cases, map and route search not cached; a rerun with unchanged route code takes
     seconds): roanne, pontaix, rousset, grimone, cdp, pennes, amalfi confident; place 99-100 %, p90 ≤ 6 m on the coarse cases; Pontaix
     verified 100 % on the road, along median 2.2 m, p90 5.4 m. `rousset-end` uncertain, `pennes-descent` confident, both 100 % place, p90 ≤ 5 m.
     `gotthard-start` 10/10 checkpoints; `madone-start` landmarks 4 s mean.
   - Known: `lahntal-marburg` and `marburg-lahntal` end in `no_route` (2026-11-20): the image odometry measures about 3x too little speed (the
     T1 clip `lahntal-uniform-35m42`, implied f_eff about 860), the scan finds f_eff 211 and 193. An image-side failure, not one of the route side.
   - Known: `madone-town` is on the right road (median 7 m from the full run) but the scale scan of 6 min in town finds f_eff 230 instead of
     461, so the window comes out 40 % short and the landmarks about 90 s late (case field `known`, shown in the table). The Amalfi tunnel score
     needed `work/amalfi/evidence.json` (the tunnels judged by eye), local work data that was never versioned; removed on 2026-11-20 (maintainer):
     `amalfi` is scored on its verdict only (`score: none`). The Lahntal odometry failure is an open item in docs/HISTORY.md.
   - Tests: `tests/test_stagecut.py` (window, stage mode without video, landmarks in a window, place score).
5. **Long videos (D):** cut `pontaix-10m` and `gotthard-start`, repoint `e2e.rs`, rebuild `runs/`, T3. Built 2026-11-20:
   - `rsm.bench.long` (`cut`, `run`, `score`, `list`) with the videos of `rsm/bench/long_set.json`: cut by stream copy as the clips (the clip cutter
     with another folder), `test-data/long/<id>/video.mp4` and `case.json`; both start at second 0 of the source (first frame equal), Pontaix 289 MB,
     Gotthard 74 MB. `gotthard-start` of regress_cases.json now points at the long video, the old 588 s cut in `work/regress/_videos/` is not used.
   - A long video runs the whole pipeline through the step cache as its route case (`case`: search frame, extract, score) into
     `work/regress/t3/<id>/` and is scored as that case plus the parity with its stage (`par_*`: speed and yaw correlation, speed ratio, scene cuts
     not in both, standstill seconds) and, with `--t2 TAG`, against the T2 run of the same window (`t2_*`). `checks` and `verdict` per video;
     `tests/test_t3_long.py` (marker `long`, deselected by default) runs it: `scripts/heavy.sh .venv/bin/python -m pytest -m long`.
   - First T3 (2026-11-20, cold: 6.6 min for both): parity speed correlation 1.00, ratio 1.02 / 0.99, yaw correlation 0.999 / 0.997, no
     scene cut and no standstill second different; the route on the same road as T2 everywhere. `gotthard-start` on the 480p source: uncertain,
     10/10 checkpoints (max 45 m), the expected verdict of D confirmed. `pontaix-10m`: confident, 100 % on the road, but along median 17 m
     (p90 37 m) against 2.2 m of the whole video: the scale scan of 10 min finds f_eff 355 instead of 423 and the route lags about 15 m (as
     `madone-town` in T2, f_eff 230 instead of 461: the shorter the video, the lower the scale found; a finding of the route side, recorded as
     `known`, the checks set around it).
   - `src-tauri/tests/e2e.rs` reads `test-data/long/pontaix-10m/video.mp4` (`RSM_E2E_VIDEO`) and the finished run `test-data/runs/pontaix-10m`
     (made with `python -m rsm.pipeline run` on that video, the Pontaix search frame and the start time of the test) instead of the whole
     Roanne video and `runs/vallee-de-roanne`.
6. **Clean up:** no test reads `sources/` any more (a T0 test checks that no test or case path points into it); `sources/` stays for T4 (D1).
   Built 2026-11-20:
   - The truth files (the Van Gestel `track.gpx` of every GPS source and the verified Pontaix track) are copied to `test-data/truth/` under the
     same relative paths by `rsm.bench.stages truth` (also the first thing `make` does, so T4 keeps them current); `rsm.bench.gps_truth`,
     the verified scores of the clips (T1) and of regress (T2, T3) read them there.
   - `tests/test_no_sources.py` (T0, runs without data): the data folders of the tests (clips, long, stages, truth, osm) lie outside
     `sources/`; clip_set.json and long_set.json name no files; the stage cases and the long videos take their extract outside it (the video
     path of a stage case is a name only); the defaults of `e2e.rs` point outside it; the verified track is read from `truth/`.
   - Shown on 2026-11-20 with `sources/` renamed: T1 21/21, T3 2/2 and T2 (all 15 stage cases, the same values) run without it.
     (`e2e.rs` was not run that way; its defaults point at `long/`, `runs/` and `osm/`.)
   - The Amalfi tunnel score is gone (maintainer, 2026-11-20); the Lahntal odometry failure is an open item in docs/HISTORY.md.

## 5. Data and time

| | today | after |
|---|---|---|
| read by tests T0-T3 | about 25 GB Van Gestel + about 55 GB own videos (when present) | long 2 x about 0.2-0.4 GB, clips ≤ 2 GB, stages about 0.3-0.5 GB, osm + dem 0.8 GB: **about 3-4 GB** |
| full sources | spread over 4 places | one place, `test-data/sources/`, 89 GB after deduplication, read only by T4 |
| image analysis check | 25 min (clip bench) to 4.4 h (regress) | < 10 min (T1) |
| route check | 40-120 min after a seeding of hours | 5-15 min (T2), scan changes 40-120 min |
| end to end | by hand, whole Roanne video | 15-25 min, two videos (T3) |

## 6. Things to keep in mind

- **Frozen stages age.** After a change to the image side T2 reports its cases as stale until T4 has run. That is the price of fast route tests,
  and it is visible, not silent.
- **Parity.** Clip against full run (`vs_full`) and T3 against the frozen stages are the two checks that the split tests the real pipeline.
- **Licence and copyright.** Van Gestel material is CC BY-NC-SA, the other videos are downloads of third-party videos. Nothing from `test-data/` is
  committed or shared; only synthetic fixtures go into git.
- **Heavy jobs.** T1 to T4 run through `scripts/heavy.sh` (one heavy job at a time) as the benches do today.
- **Determinism.** Motion runs in parallel; tests compare with tolerances, not byte for byte, except the byte-identity checks of step 1.
- **Truth is the bottleneck.** Without GPS a clip or case needs checkpoints read from frames; Gotthard has them, Madone has landmarks, Amalfi
  needs the clock offset of its Strava GPX, Bavaria has none with time. The Nice-Monaco GPX is worth a check.

## 7. Decisions for the maintainer

| id | question | recommendation |
|---|---|---|
| D1 | Keep the full sources (about 90 GB) in `test-data/sources/` after step 6? Without them T4 cannot rebuild the stages after an image-side change. | keep them; tests never read them |
| D2 | App projects whose video moves: leave them broken, relink them in the app, or leave a symlink at the old place? | relink the few you still need; no symlinks |
| D3 | The two long videos: `roanne-10m` and `gotthard-start` (480p)? Alternative to Gotthard: Madone 0:00-10:00 (4K, landmarks, no odometry failure). | decided 2026-11-19 (left to Claude by the maintainer): Pontaix + Gotthard |
| D4 | Clips by stream copy (source pixels, about 18-85 MB per 30 s) instead of the bench's grey re-encode? | stream copy |
| D5 | The removal list of step 0a, including the loss of the Clue cut test. | as listed |
| D6 | Long video 1: `roanne-10m` (coarse GPS, today's e2e default) or `pontaix-10m` (verified truth, timed scores possible)? | decided 2026-11-19 (left to Claude): `pontaix-10m` |
