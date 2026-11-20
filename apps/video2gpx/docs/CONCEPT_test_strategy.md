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
  stages/<case>/stage.json          code hash of the image side, sha256 of the source, parameters, horizon, GPS alignment
  osm/ dem/                         as today; later cut per case
  runs/                             finished runs for the app e2e (as today)
```

`vangestel/` moved to `sources/vangestel/`. The tests read `clips/`, `long/` and `stages/` only.

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
| `made` | date, machine, seconds per step |

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
  | typical straight / curves with GPS | 6 | one per Van Gestel area: Roanne, Pontaix, Rousset, Grimone, CdP, Pennes |
  | sharp turns with GPS | 3 | hairpins Rousset, Grimone |
  | known odometry failure | 2 | `lahntal-uniform-35m42` (vms speed about 3x too low), Gotthard valley road 3:50-5:50 |
  | scene cuts and false cuts | 3-4 | Gotthard sun flash 3:00-3:20 and intro cut 0:20, Cayolle intro cut 0:49 (only if they pass on the 480p source, see section 4) |
  | standstill | 2 | a stop and a slow crawl in traffic, chosen from the full runs |
  | traffic / occlusion | 1-2 | passing traffic, Amalfi or Nice-Monaco |

- **Scoring:** secured clips against the aligned GPS with the existing metrics (`v_fail`, `v_err_med`, `rot_rms_deg`, `turn_err`); event clips
  with plain assertions (a cut at t, no cut in [a, b], standstill from a to b); every clip also against its own window in the full run
  (`vs_full_*` correlation ≥ 0.95 as a parity check). Expected values and tolerances live in `clip.json`.
- The GPS alignments (`work/vangestel/align_<name>.json`) are lost; T4 computes them again once and stores them in `stage.json`.

### C. Route tests on frozen stages (T2)

- `regress.py` gets a mode `--stages`: the case starts at `map` with `motion/` and `rotation/` copied (or cloned with `cp -c`) from
  `stages/<case>/`. Step cache and scan memo work as before.
- **Short route cases** cut from the frozen stages (window t0-t1 of the track series, no video): the hard spots, with checkpoints or the GPS as
  truth, 1-3 min each. Start list: Gotthard start 0:00-9:48 (odometry failure, village vs. bypass; 10 checkpoints exist), Rousset end (last 940 s
  wrong), Madone town, Bavaria start, Pennes descent.
- **Full cases** on frozen stages: the 8 Van Gestel rides, Madone, Amalfi, Gotthard, Bavaria. With the scan memo a change after the scan reruns in
  minutes; a change to the HMM reruns the scan (40-120 min for all, as it must).
- Probes (`rsm.bench.probe`) stay the fastest check of one changed function on all cases.

### D. Two long videos (T3)

| id | window | why | truth |
|---|---|---|---|
| `roanne-10m` | Vallée de Roanne 0:00-10:00 | a good GPS ride, the e2e default today (full run in `runs/`) | GPS, cut to the window |
| `gotthard-start` | Gotthard 480p 0:00-9:48 | the only case with an odometry failure, a disputed start and scene cuts; exercises `odofail.py`, the local pass, islands and the verdict | 10 checkpoints (`regress_landmarks.json`) |

- `e2e.rs` reads `long/roanne-10m/` instead of the full Roanne video (`RSM_E2E_VIDEO`); `runs/vallee-de-roanne` is rebuilt from the 10 minutes.
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
   `scripts/heavy.sh`) and the GPS alignments again.
3. **Clips (B):** cutter by stream copy, horizon option, about 20 clips, T1 as pytest marker `clips`; the clip bench reads them.
4. **Route on stages (C):** `regress.py --stages`, short route cases, T2.
5. **Long videos (D):** cut `roanne-10m` and `gotthard-start`, repoint `e2e.rs`, rebuild `runs/`, T3.
6. **Clean up:** no test reads `sources/` any more (a T0 test checks that no test or case path points into it); `sources/` stays for T4 (D1).

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
| D3 | The two long videos: `roanne-10m` and `gotthard-start` (480p)? Alternative to Gotthard: Madone 0:00-10:00 (4K, landmarks, no odometry failure). | Roanne + Gotthard |
| D4 | Clips by stream copy (source pixels, about 18-85 MB per 30 s) instead of the bench's grey re-encode? | stream copy |
| D5 | The removal list of step 0a, including the loss of the Clue cut test. | as listed |
