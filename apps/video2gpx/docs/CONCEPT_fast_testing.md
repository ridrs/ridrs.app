# Concept: faster experiments on route detection (2026-11-13)

Goal: a change to the route logic (for example the acceptance test of the local pass) is judged on all bench cases in **minutes**, not hours.
Only a change to the motion or rotation step may need a long run, and then only once.

## 1. Where the time goes (measured, `work/regress/*/<case>/steps/*.done.json`, seconds)

| case | motion | rotation | map | route_search | refine | gpx |
|---|---|---|---|---|---|---|
| roanne | 517 | 204 | 2 | 101-153 | 7-21 | 1 |
| pontaix | 406 | 100 | 3 | 220-330 | 4-20 | 1 |
| rousset | 1403 | 473 | 33 | 1080-2150 | 26-260 | 1 |
| grimone | 764 | 166 | 21 | 158-1380 | 11-74 | 1 |
| cdp | 888 | 183 | 23 | 195-1283 | 9-350 | 1 |
| pennes | 3251 | 384 | 3 | 408-597 | 20-296 | 1 |
| madone-start | 738 | 243 | 67 | 17-24 | 6-8 | 1 |
| madone-nohint | 954 | 249 | 4 | 56 | 5-85 | 1 |
| amalfi | 1747 | 955 | 29 | 45-58 | 37-59 | 1 |

- **Motion + rotation: about 4.4 h for the 9 cases.** They are already seeded for all 9 (`work/regress/f4seed`), so a change after them never needs
  to recompute them. (Lahntal / Marburg have no runs at all.)
- **route_search: about 40-120 min** for the 9 cases, almost all of it the calibration scan (88 coarse + 15 refinement HMM runs per case).
- **refine + gpx: about 2-20 min** for the 9 cases.
- Today the bench runs cases one after the other, with `in_hash="bench"` (no real step hashes). `--from-step` / `--seed-tag` are chosen by hand, and
  seeds of the right code version exist only for some cases (`flatrc`: 3, `bf`: 4). That is why a complete answer took hours. The local-pass
  change, for example, needs only refine: about 3-5 min for all 9 cases once route_search is seeded with the current code.

## 2. Building blocks

### A. Step cache by real input hash (biggest gain)

- The bench stores every finished step under `work/regress/_cache/<case>/<step>/<hash>/`, where hash = code hash of the modules of that step
  (`freeze.py` already has the module list and code hash) + hash of the step's input artifacts + the params / config keys it reads.
  The pipeline already computes such an `in_hash` for `--resume`; the bench uses it instead of `"bench"`.
- A run of any tag looks up every step in the cache and computes only the steps whose hash changed, and everything after them.
  `--from-step` and `--seed-tag` become unnecessary (kept as overrides).
- Result: a change in `local.py` reruns refine + gpx only, for all cases, automatically; a change in `steps_b.py` reruns route_search onward.
- Effort about 0.5-1 day. Risk: a step that reads a config key not listed in its hash would be reused wrongly. Mitigation: hash the whole `config.py`
  per step at first (coarser, still correct).

### B. Reuse the calibration scan

- route_search = scan (expensive) + candidate choice, decode, posterior (cheap). Split it: the scan surface is cached by (steps hash, map hash,
  hash of the HMM model parameters and grids).
- Changes after the scan (candidate rules, verdict, decode, posterior, hints logic) then rerun only the decode: about 2-5 % of route_search,
  that is seconds to 1 min per case.
- A change to the emission / transition model or the grid changes the hash and the scan runs again, as it must.
- Effort about 0.5 day.

### C. Probe: one function, all cases, in-process

- `rsm.bench.probe <name>`: loads the cached artifacts of every case and calls only the changed function in one process (no subprocesses,
  no checkpoints), then prints a small table against the baseline: same-road share, position difference, and the decisions of the function
  (for the local pass: tested stretches, margin, unexplained turns, kept / accepted).
- Probes are small Python files under `rsm/bench/probes/` (the Gotthard scripts `work/gotthard-diag/d*.py` are the prototype).
- Use: answer "does the change fire, and where?" in 1-3 min before a real bench run.
- Effort about 0.5 day.

### D. Short clip cases with checkpoint truth

- Hard spots as their own cases, cut from the seeded tracks (no new motion run; as done for the Bavaria clip): Gotthard 0:00-8:00 (village vs.
  bypass), Rousset end (last 940 s wrong), Madone town, Bavaria start. Full pipeline from map on: 1-3 min each.
- Truth where there is no GPS: checkpoints "at video time t the camera is at this point", read from frames, in the existing format of
  `regress_landmarks.json`. Gotthard: station car park 0:24, Bahnhofstrasse/Gotthardstrasse 1:08, Dorfbrücke 2:20, junction 4:12, Hospental 6:15.
  Score = time error at every checkpoint.
- Add Gotthard as a full case too, seeded from the app project (motion and rotation exist up to 16:04).
- Effort about 1 day (checkpoints partly by the maintainer).

### E. Parallel cases inside one heavy job

- Peak memory per case 0.3-5 GB; route_search uses 4 workers. The bench could run 2 cases at a time when memguard sees enough free memory: about
  2x faster for route_search-heavy runs.
- **Needs a decision by the maintainer:** today the rule is one heavy job at a time. This stays one job (one lock), but runs two cases inside it.
- Effort about 0.5 day.

## 3. Test levels with time budgets

| level | what | when | time |
|---|---|---|---|
| T0 | unit tests (`pytest tests/`) | every edit | about 15 s |
| T1 | probe of the changed function, all cases + clips | before every bench run | 1-3 min |
| T2 | bench from the first changed step (cache), all seeded cases + clips | to accept a change | refine-only: 3-5 min; decode-only: 5-10 min; scan: 40-120 min (about half with E) |
| T3 | full bench including motion and rotation | only after changes to motion or rotation, overnight | about 5-6 h |

Most route logic work (local pass, verdict, candidates, refine, line) then lands in T1 + T2 in under 15 min.

## 4. Order of work

1. **One-time seeding:** route_search with the current code for the cases without such a seed (rousset, cdp, pennes, madone-nohint), in the
   background, about 1 h once. After that the acceptance test can be judged on all 9 cases in about 5 min.
2. **A (cache) + C (probe):** the biggest gain for the current work.
3. **D (clips with checkpoints, Gotthard as a case):** covers exactly the failures we are working on; without it a fix like the acceptance test is only
   tested on cases where it never fires.
4. **B (scan reuse)**, then **E** if the maintainer agrees.

Not proposed: making motion faster (the speed work is paused, and with the cache motion runs only when its code changes); a smaller HMM
for experiments (results would differ from the shipped pipeline).

## 5. Built (2026-11-13): A-D

All development-only, under `research/route-shape-matching/rsm/bench/` (not frozen, not in the sidecar). Run from `research/route-shape-matching`.

### A. Step cache (`stepcache.py`, used by `regress.py`)

- Key of a step = previous key + file hashes of the step's static import closure (`config.py` excluded) + values of the config names that code
  reads + the case params (motion / rotation: the video only). Test: an edit of `local.py` or of `LOCAL_ACCEPT_NATS` changes the keys of refine and
  gpx only; an edit of `osm.py` leaves motion and rotation alone (`tests/test_bench_tools.py`).
- Store: `work/regress/_cache/<case>/<step>/<key>/`. `regress.py` uses it by default; `--from-step` / `--seed-tag` switch back to the old reuse,
  `--no-cache` turns it off.
- `--adopt TAG [--adopt-steps motion,rotation,map]` puts finished steps of an earlier run into the cache under the current keys (the caller asserts
  that they are current). Done for the 9 cases from `f4seed` (motion, rotation, map).
- Usual call, any change: `scripts/heavy.sh .venv/bin/python -m rsm.bench.regress --tag <name> --code work --baseline seed1` (only the changed steps
  and the ones after them run).

### B. Scan memo (`steps_b.scan_kappa`)

- With `RSM_SCAN_MEMO=1` (the bench sets it; the app never does) every Viterbi score of the calibration scan is stored under an exact key (transition
  tables of the grid, HMM parameters except a_ang, steps, frame masks, code of `dp.py` / `grid.py` / `seq.py`) in `work/regress/_data/scan_memo/`.
  A route_search rerun after a change that does not touch the HMM (candidate choice, verdict, decode, posterior, hints) reuses the scan scores.

### C. Probes (`probe.py`, `probes/`)

- `.venv/bin/python -m rsm.bench.probe local_accept --tag seed1 [--save base | --baseline base]`: the local pass with its acceptance test on every
  case, in one process, against the stored refine result. New probes: a module in `probes/` with `NEEDS` and `run(d, case) -> dict`.

### D. Clip bench for motion and rotation (`clips.py`, `clip_sources.json`)

- 14 source videos, 44 clips of 75 s (Gotthard valley 120 s), chosen automatically from the full runs (`turns`, `fast`, `weak`, `typical`;
  without a full run 25 / 50 / 75 %). List: `work/clips/clips.json`; clips: `work/clips/<id>/clip.mkv` (640 x 360 grey, x264 crf 8, about 100 MB).
- Classes: **secured** (Van Gestel GPS, aligned: alignment file or yaw-rate correlation ≥ 0.7 over the clip) and **open** (no reference yet:
  Amalfi Strava without clock offset, Madone, Gotthard, Bavaria, Clue, Cayolle). A secured clip whose alignment fails becomes open with the reason.
- `scripts/heavy.sh .venv/bin/python -m rsm.bench.clips run [--only ids|sources] [--class secured|open] [--save NAME] [--baseline NAME]` runs the real
  motion and rotation steps (through the step cache) and writes `work/clips/results/`.
- Metrics, secured: `usable` (share of seconds with ≥ half good vms pairs), `v_fail` (share of seconds over 1.5 m/s that are unusable or > 30 % off
  the GPS speed after one scale per clip), `v_err_med` (median |log ratio|), `v_scale` (GPS / nominal), `stall_s` (longest run far below the clip
  median, a vms failure), `rot_cover` (share of time in far-feature tracks), `rot_rms_deg` (2 s heading increments against GPS after one gain per
  clip), `turn_err` (relative error on increments > 5°), `f_eff_implied` (449 / gain), `vs_full_*` (clip against the same window of the full run).
  Open: the same without the reference columns.

### Measured (2026-11-13)

| what | time |
|---|---|
| one-time seeding of the 9 cases (route_search, refine, gpx with the current code; motion / rotation / map adopted) | about 70 min |
| bench rerun without any change (9 cases, all from the cache) | 24 s, identical to the seed |
| route_search rerun with the scan memo (Roanne) | 28 s instead of 46 s (grids and decodes still run) |
| cutting the 44 clips | about 3 min (6.3 GB) |
| motion + rotation on the 44 clips (first run, cached afterwards) | about 25 min (motion 10-30 s, rotation ~10 s per clip) |
| clip scoring only (`clips score`) | about 1 min |

Clip results, baseline saved as `work/clips/results/base.{md,json}`: 22 secured clips (all 8 GPS videos), 22 open.
- Secured medians: `v_fail` 2 %, `v_err_med` 5 %, `rot_rms_deg` 3.5°, `turn_err` 30 %; implied f_eff mostly 430-530.
- Real failures found: `lahntal-uniform-35m42` (GPS 7.5 m/s, vms speed about 3x too low, v_fail 56 %, implied f_eff 862) and the Gotthard valley clip
  (usable 42 %, a 7 s stall, rotation cover 32 %). These are the first test cases for an odometry-failure detector.
- Clip against full run: speed and yaw correlate ≥ 0.95 for almost all clips. Exception `grimone-typical-39m45` (yaw correlation 0.55): the motion step
  calibrates the horizon from the clip (157 rows) instead of the whole video (171 rows); the far-feature band moves. A clip therefore also tests the
  horizon calibration on 75 s; for exact parity the clip would need the full run's horizon (a pipeline option, not built).
- GPS alignment: searched ±20 s over 300 s of the full run (± 5 s missed CdP, whose GPS runs 9 s late). Still open: `lahntal-uniform-11m54`
  (corr 0.22) and `marburg-uniform-38m46` (0.61), both without a full run, aligned on the clip alone.

Known limits: the scan memo still builds the grids of every kappa (the key needs the transition tables); clips need a full run of the source to get
the `vs_full` columns and the robust GPS alignment (Lahntal, Marburg and Cayolle have none).

### Gotthard start case (2026-11-14)

Case `gotthard-start` of `regress.py`: the first 588 s of the Gotthard video (`work/regress/_videos/gotthard-start-588s.mp4`, stream copy from the
keyframe at 0, video only; cut at 9:48 on a straight before the hairpins at 10:00-11:30), with the app's parameters (alps.osm.pbf, bbox 48 x 47 km,
vehicle auto, no hint). The only case with an odometry failure (valley road 4:22-5:36) and a disputed start (village loop vs. Umfahrungsstrasse
bypass), so the only one where `odofail.py`, the local-pass acceptance test, the island refinement and the motor posterior of the verdict act
(docs/GOTTHARD_DIAGNOSIS.md). Truth: 10 checkpoints read from frames at 1 s spacing and placed on OSM nodes (`regress_landmarks.json`, key
`gotthard-start`, with the reasoning per point): car park 0:30, Bahnhofstrasse/Gotthardstrasse 1:07, Oberalpstrasse mini roundabout 1:42,
Dorfbrücke 2:19, junction to the valley road 4:13, farm crossroads 4:53, slip roads 5:36, Hospental roundabout 6:19, tunnel 7:25, last bend before
the straight 8:20; tolerance 50 m at sharp junctions, 100 m elsewhere. Score `checkpoints`: distance of the route at each checkpoint second, columns
`cp ok` (hits / 10), `cp med m`, `cp max m`, per-checkpoint distances in the notes (`!` = outside the tolerance).
`scripts/heavy.sh .venv/bin/python -m rsm.bench.regress --tag <tag> --code work --only gotthard-start` (first run: 6 min for all steps; reruns come from the step cache).
First result (tag `gts1`, current code, islands off): **no_route**, 0/10 checkpoints, route about 20-25 km off near Erstfeld (46.82, 8.65). The clip's
odometry gives 2.2 nominal km for about 6 km driven (usable 77 %, gaps 4:23-5:39, 6:55-7:43 and three short ones after); the scan's highest point
(f_eff 250, distance scale 2.30) is rejected as implausible, the used candidate (f_eff 504, 0.86) is at the scan edge and flat. The full-video app run
found kappa 2.00 on the same start; on 10 minutes alone the distance scale is out of the accepted range. The verdict is honest (no false confident).
