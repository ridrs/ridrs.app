---
name: video2gpx-review
description: >-
  Runs video2gpx headless on a video (a YouTube URL or id, or a local file), checks the resulting GPX against OpenStreetMap and against
  the video itself, does a root-cause analysis of the wrong spots and of the spots marked uncertain that are in fact right, and writes a
  report with pipeline improvements. It also adds short video snippets as fast regression tests to video2gpx-runs/_testsuite.
  Use this skill whenever the user wants to run, review, check, validate or debug video2gpx (route-shape-matching / rsm.pipeline)
  on a video, asks why a video2gpx route is wrong or uncertain, wants test cases or snippets from a video for the pipeline, or wants
  to re-run the snippet suite after a pipeline fix. In wishlist mode it picks the next video itself from the ridrs Scenic wishlist
  (video2gpx queue), runs and checks it, and after a successful localisation uploads the video2gpx result to ridrs Scenic and publishes
  the route there. Trigger phrases include "video2gpx Lauf auswerten", "prüf das GPX", "Testfälle aus dem Video", "nächstes Video von der
  Wunschliste", "arbeite die Wunschliste ab", or "video2gpx für Scenic".
---

# video2gpx review

The goal is more than one judged run. The real product is twofold:
- **a growing suite of fast tests** (snippets of a few minutes, each with checkpoints read from the frames);
- **recommendations tied to measured causes.**

With both, a pipeline change can be validated in minutes instead of a full 1–10 h run per video.

The skill itself (this file, `references/`, `scripts/`) lives in the video2gpx app of the ridrs_app repo:
`apps/video2gpx/.claude/skills/video2gpx-review/`. Changes to it are repo changes: make them in a worktree, as any other work in
ridrs_app. The data it makes stay outside the repo, because they hold third-party video and are large. They all live in
`Ridrs/video2gpx-runs/`, found as the first folder above the checkout that has it (`V2G_RIDRS` overrides):

```
video2gpx-runs/
├── <id>/                      one per video (made by ../video2gpx-yt.sh)
│   ├── source/  run/  incyclist/   video, pipeline output, Incyclist folder
│   ├── review/                this skill: series.json, analysis.{json,md}, evidence/<spot>/, verdicts.json, scenic-qc.json, REPORT.md
│   └── scenic/                wishlist mode: job.json, route.gpx, <id>.scenic.json, upload.json
├── _wishlist/state.json       wishlist mode: what happened to each picked video (so a rejected one is not picked again)
├── _testsuite/<case>/         clip.mp4, case.json, bench.json, baseline.json, runs/<tag>/
├── _testsuite/_results/       one table per suite run
└── _cache/                    shared road-graph cache
```

Paths used below:
- `S` is this skill's `scripts/` folder, in the checkout the skill was loaded from (normally `Ridrs/ridrs_app`). `scenic.mjs`
  imports the payload builder and the Scenic validator from that same checkout.
- The run script is `Ridrs/video2gpx-yt.sh` (outside the repo); run it from `Ridrs/`.
- `PY` is the research venv of the runner worktree:
  `Ridrs/ridrs_app-worktrees/video2gpx-runner/apps/video2gpx/research/route-shape-matching/.venv/bin/python`.
- Run every script as `$PY $S/<script>.py …`.

## Ground rules (they protect the user's machine and data)

- **Heavy jobs:** the pipeline runs only through `video2gpx-yt.sh` or `run_tests.py`. Both go through `scripts/heavy.sh`, which allows one
  heavy job at a time under memguard. Never start two runs in parallel, and never call the pipeline without that wrapper. This Mac crashed
  twice from runaway jobs.
- **Long runs go in the background.** Start them with `run_in_background` and wait for the notification. A full run takes about 10–20 min
  per hour of video (motion is the bulk), and it waits for any other heavy job first.
- **Read only on code:** do not edit the runner worktree (`ridrs_app-worktrees/video2gpx-runner`). It is the frozen reference that makes
  results comparable. Fixes belong in a separate worktree. This skill only recommends them; implement one only if the user asks.
- **Video material stays local.** Frames, snippets and the report contain third-party video. Do not upload them, do not publish an
  Artifact with them, and do not send them to web services. The report is a local Markdown file. The one thing that leaves the machine
  is the track payload `<id>.scenic.json` (video seconds, coordinates, QC results, no image), and only to ridrs Scenic in wishlist mode.
- **No silent overrides.** The skill never overrides a blocking QC check, never uploads with `outside_bbox=1`, and never replaces the
  Scenic route with the video2gpx line. Those are editor decisions: report them instead.
- **Hints:** start, area and route hints are inputs the user might also give in the app. Note in the report which ones the run used. A
  result that needs a hint is a different finding from one that works without.

## Workflow

Two entry points:
- **A video given by the user:** steps 1–6 below.
- **Wishlist mode** ("nächstes Video von der Wunschliste", no video named): the section *Wishlist mode* further down. It picks the video
  itself, uses steps 1–4 for run and check, and ends with upload and publication instead of a full test-making round.

### 1. Run (or reuse) the pipeline

Input: a YouTube URL or id, or a local video file. Options pass through to the run script; the important ones are `--bbox`,
`--start-bbox`, `--hint`/`--no-hint`, `--vehicle`, `--intro-end`, `--anchors`. See `Ridrs/video2gpx-yt.sh --help`.

If `video2gpx-runs/<id>/run/project.json` and `run/refine/result.npz` already exist, the run is finished: go on with step 2, unless the
user wants a fresh run. Otherwise, from `Ridrs/`:

```bash
./video2gpx-yt.sh "<url|id|file>" [options]          # in the background; output in video2gpx-runs/<id>/
```

**Map data:** the script uses the smallest extract in the app's `osm/` folder that covers the area. If none does, it stops with
`map download needs confirmation: rerun with --download-map (about N MB, <region>)`. Ask the user in the chat before you rerun with
`--download-map`. Give the region and the size: extracts are hundreds of MB to several GB, and they are kept in the app's folder for
reuse. A declined download ends the review, unless the user gives a `--pbf FILE`. The Copernicus elevation tiles are fetched
automatically, because they are small.

The search area comes from the POV atlas: its route plus 3 km, with the atlas route as a hint. Without an atlas entry, ask the user for
the area: a place name or a bbox. Pass it as `--bbox S,W,N,E`. If the pipeline exits non-zero, read `run/logs/*.err.log` and
`progress.jsonl`. Report the failure as a finding: area, map extract and memory are the usual reasons.

### 2. Analyse the outputs

```bash
$PY $S/analyze_run.py <id>
```

Read `review/analysis.md`. It has:
- the run summary: verdict and reasons, step times, and every status the pipeline emitted;
- the ranked **check spots** S01…: the pipeline's own weak stretches with their measured causes (from `inspect-series`), merged with
  OSM plausibility flags;
- **control spots** K01…: confident stretches with turns, so that the confident parts get checked too.

The OSM plausibility flags are:

| flag | meaning |
|---|---|
| `speed` / `accel` | jumps, which Incyclist turns into fast-forward |
| `road_class` / `minor_fast` | a road class that does not fit the vehicle |
| `oneway` | travel against a one-way edge |
| `uturn` | a U-turn outside a roundabout |
| `turn_excess` | the path turns ≥ 150° more than the video within 12 s, comparing total turn on both sides (sum of the absolute per-second turns, so roundabouts do not fire): a loop or U-turn that the video does not show. Nice–Monaco: 6 hits, 5 real, 1 false (time lag at a tunnel exit). This is the most reliable loop detector. It also catches overshooting a junction, turning, and coming back on a parallel carriageway, which the chord test misses. Real U-turns do not trigger it. |
| `curve_conf` | video and map curves disagree at high confidence. This is the strongest sign of a route that is confident and wrong. |
| `hint_far` | far from the route hint |

Flags are candidates, not errors: OSM can be wrong, and roads can legally be driven like that. Check each one in the video.

### 3. Check every spot against the video

For each spot (Sxx and Kxx), in time order:

```bash
$PY $S/evidence.py <id> spot S03        # frames.jpg, map.png, series.png, nodes.json in review/evidence/S03/
```

Look at the images with Read:
- **frames.jpg:** 12 frames over the spot ±10 s, with the time and the conf of each.
- **map.png:** the OSM roads (one-way arrows), the decoded path, the position per second coloured by conf, and the turn quanta of the
  100 m cells. Green means a turn in both video and map, orange a map turn the video lacks, purple a video turn the map lacks.
- **series.png:** speed, yaw (video against map; positive is left), conf, and the motion quality.

Judge the spot by matching what the frames show against the map at the same seconds:
- turn direction and sharpness, junction type (T, crossroads, roundabout with its exit count);
- tunnels, bridges, the sea or a river on which side;
- lanes and one-way roads, town and street signs, distinctive buildings.

At junctions and stops, check the line **second by second**, not just the road. Use `evidence.py frames` at 1–2 s spacing, and a zoom
of the path with one dot per second. A route can have the right streets and still overshoot the junction, U-turn and come back. Compare
the path's turn with the video's turn (`series.json` → `yaw`, left positive) over the same seconds.

Spot ids are stable: a re-analysis keeps the ids of spots in `analysis.json` / `verdicts.json`, and new spots get the next free number.

For more detail, use:
- `evidence.py <id> frames 351,352,353` for exact seconds at 640 px;
- `evidence.py <id> overlay 352`: the tracked motion points (green inlier, red outlier, magenta traffic) and the far-feature points on
  the frame. This is the main tool for causes in the motion and rotation steps.

Write each judgement to `review/verdicts.json`, one entry per spot:

```json
{"spot": "S03", "t0": 577, "t1": 634, "verdict": "wrong|correct_uncertain|correct|unclear",
 "observed": "11:28 roundabout, 3rd exit; 11:35 sign 'Monaco 18'; sea on the right",
 "pipeline": "Promenade des Anglais, conf 0.18; ~40 s late (turn quantum at 11:52 matches the roundabout at 11:28)",
 "truth": {"road": "Boulevard X", "lat": 43.70, "lon": 7.27, "how": "OSM junction node 1234 from nodes.json matches the roundabout at 11:28"},
 "error_m": 350, "cause": "search.wrong_branch", "cause_evidence": "...", "test": "nice-monaco-roundabout-x"}
```

Be honest about `unclear`. A frame without a distinctive feature cannot confirm a position. Several features that agree in sequence can
(a turn, then a roundabout, then a tunnel). The control spots tell how far the confident parts can be trusted. A wrong control spot is
the most important finding of the review: treat it as an error spot.

### 4. Root-cause analysis

Do this for every `wrong` spot, and also for every `correct_uncertain` spot, because there the pipeline doubts a correct result. Follow
`references/causes.md`. In short:
- find the **first step whose output is wrong**;
- measure the cause against its limit;
- check a counter-example in the same video.

Group spots that share one cause. Ten uncertain straights with "no junctions" are one finding (`confidence.no_information`), not ten. When
a cause points into the code, read the module and the config comment in the runner worktree. Name the function and the value involved,
and say whether the cause is already known (FINDINGS.md, docs/DECISIONS.md, docs/HISTORY.md open items).

### 5. Fast tests from the video

For every distinct cause, make at least one test:
- each `wrong` cause gets an `error` test;
- each `correct_uncertain` cause gets an `uncertain_correct` test;
- one or two `correct` control spots may become guard tests (`control`), so that a fix cannot break something that works.

Read `references/test-cases.md` before making the first test. In short:
- **Snippet:** the problem plus enough lead-in to start from a known place. It needs about 2–3 km of driving with at least 3 turns,
  because the route search calibrates anew on the snippet. That is usually 2–5 min of video, at most 7 min, and it should run in
  about 2–5 min.
- **Checkpoints:** 3–8 seconds where the frames prove the position. Each one is placed on an OSM node from `nodes.json`, with a `why`
  saying what the frame shows. The first one serves as the start frame.

```bash
$PY $S/make_test.py <id> --name <video>-<place>-<problem> --t0 … --t1 … --checkpoints review/tests/<name>.cps.json \
    --kind error|uncertain_correct|control --spot S03 --cause <id> --why "…"
$PY $S/run_tests.py --only <name> --tag base-<runner-commit> --save-baseline     # in the background; heavy job
```

The test must **reproduce**:
- an `error` test should FAIL today;
- an `uncertain_correct` test should PASS with low focus conf;
- a `control` test should PASS.

If it does not reproduce, the snippet has lost context the full run had (a different calibration, a different vehicle estimate). Widen
it, pin the vehicle, or add a checkpoint before the problem, and re-test once. If it still does not reproduce:
1. set `"reproduces": false` and a `note` in its case.json;
2. cover the cause with the **seeded full case** of this video instead (`make_test.py --full-from route_search`, see
   references/test-cases.md). It reuses motion and rotation of the finished run, and takes minutes rather than the full run time.
The lost context is itself a finding: report it.

### 6. Report

Write `review/REPORT.md` following `references/report-template.md`:
- what was checked, and how;
- each finding with its frames, map and series as evidence, its cause, and its test;
- the recommendations, ordered by impact. Each one names the module or config, the expected effect on the named tests, the regression
  risk, and the exact commands that validate a fix in minutes;
- a list of what was not checked.

Finish by giving the user, in the chat:
- the verdict after checking (how much of the route is right);
- the top recommendations;
- the new tests and their total runtime;
- the path to REPORT.md.

## Wishlist mode: from the Scenic wishlist to a published route

Visitors of ridrs Scenic wish videos for video2gpx; the admin keeps them as a queue (`GET /api/admin/queue`, order: editor priority,
then votes, then oldest wish). This mode works that queue off by itself. The Scenic side is `$S/scenic.mjs` (run it with `node`). It
builds the payload with the app's own `qcChecks`/`buildPayload` (`apps/video2gpx/src/atlas.ts`) and checks it with the Scenic's own
`validateResult` (`web/scenic/src/video2gpx.js`), so it follows the contract of `pov-atlas/VIDEO2GPX-INTEGRATION.md` section 8 exactly.

**Server.** Always the online Scenic `https://ridrs.app/scenic` with its live database; never the local dev server (its database
has no wishes) and there is no override. It sits behind Cloudflare Access. `scenic.mjs` signs in with the service token
`video2gpx-review` (Zero Trust → Service Auth; the /api/admin application has a *Service Auth* policy for it). It reads the token
itself from the macOS keychain, services `ridrs-scenic-cf-access-client-id` and `ridrs-scenic-cf-access-client-secret`;
`CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` or `CF_ACCESS_TOKEN` in the environment take precedence. Never print, copy or
store the token anywhere else, and never look for it in files. If the script reports missing credentials, ask the user to put
the token in the keychain; a 403 means the token expired or the Access policy does not allow it. If the server is not reachable, say so and stop: do not start a local dev server
as a fallback. Every upload and publish in this mode is live on ridrs.app.

One video per invocation, unless the user asks for more ("die nächsten 3"); then one after the other, never in parallel (heavy jobs).

### W1. Pick

```bash
node $S/scenic.mjs pick --n 3          # first fitting wishes in queue order, plus the skipped ones with their reason
```

It skips videos that are hidden, from an opted-out channel, longer than 4 h, without a search area in their job, or already handled
(`_wishlist/state.json`; `--retry` ignores that, only on the user's request). Take the first pick and record it:
`node $S/scenic.mjs state <id> picked`. Tell the user in one line which video it is (title, channel, place, length, votes).

### W2. Job and run

```bash
node $S/scenic.mjs prepare <id>        # scenic/job.json + scenic/route.gpx; prints the video2gpx-yt.sh options from the job
```

The options are what the app would set from the same job (`jobPlan`): `--bbox`, `--start-bbox`/`--end-bbox` (confirmed route only),
`--hint` with 300 m (route level 4) or 1 km (level 5) corridor, `--vehicle`, `--country`. Use them instead of the POV-atlas defaults of
the run script. First run it with `--dry-run`: if it stops with `map download needs confirmation`, do not download in this mode. Record
`state <id> skipped "map download needed: <region>, <size>"`, go back to W1 for the next pick, and list the needed map in the final
report. Otherwise start the real run in the background (step 1 rules) and `state <id> running`.

If the run fails, record `state <id> failed "<short reason>"`, report it as in step 1, and stop (or go on with the next pick when the
user asked for several).

### W3. Check

Do steps 2–4: `analyze_run.py`, then every S and K spot against the frames, written to `review/verdicts.json`. Leave no spot
unjudged (`unclear` is a judgement; the payload step refuses spots without a verdict). In addition, check these three explicitly in the
frames against the map, because they stand for the app's "Angesehen" check:
- **start:** the first driving seconds after the intro;
- **turn:** at least one hairpin, roundabout or junction, second by second;
- **end:** the last driving seconds.

Write `review/scenic-qc.json`:

```json
{"viewed": {"start": "3:51–4:05 Ausfahrt Kreisverkehr, passt zu OSM-Knoten 123", "turn": "K02 11:28 Kreisverkehr 3. Ausfahrt", "end": "75:00–75:11 Hafen Monaco"},
 "cuts_checked": [1834.5], "note": "kurze Zusammenfassung der Prüfung"}
```

An entry in `viewed` is what the frames showed, never a placeholder; leave it out (empty) when that part could not be confirmed.
`cuts_checked` lists the start of each piece after a scene cut that was checked in the frames (needed when the video has cuts).
Optional `t_start` / `t_end` replace the first and last driving second when the default is wrong (an outro that is not driving).

### W4. Gate: is the localisation good enough?

```bash
node $S/scenic.mjs payload <id>        # exit 0: scenic/<id>.scenic.json written; exit 2: not good enough, problems listed
```

It writes the payload only when all of these hold:
- the pipeline verdict is `confident` (no override of an `uncertain`);
- no spot is `wrong`, every spot is judged, and at least one control spot is `correct`;
- every blocking check of the app's list is green: coverage ≥ 90 % with no gap > 60 s, start/end inside the route, every cut piece
  checked, start/turn/end viewed;
- the Scenic would accept it: id, strictly increasing time, speeds ≤ 252 km/h outside cuts, every point inside the job's search frame,
  ≤ 14,400 points, ≤ 1.5 MB.

Route agreement with the Scenic route is shown, not blocking (the Scenic route can be the wrong one).

**Not good enough (exit 2):** record `state <id> rejected "<main problem>"`. Do not upload. Then do steps 4–6 as for any review (root
causes, tests, `REPORT.md`): a failed wish is exactly the material the test suite needs. Leave the wish open in the Scenic.

### W5. Upload and publish

Only after exit 0 of W4:

```bash
node $S/scenic.mjs upload <id>         # POST /api/admin/videos/<id>/video2gpx → sync track, Lokalisierungsstufe 2
node $S/scenic.mjs publish <id>        # PATCH site_published = true (refused for hidden videos, opted-out channels, level > 2)
node $S/scenic.mjs state <id> published
```

The upload is logged in the Scenic `edit_log` (undoable there) with the token's identity. The wish counts as done by itself
once the track is a video2gpx track; do not change its status. If the upload is refused, record `state <id> failed "<server message>"`
and report the message; do not retry with an override.

`payload` reports `route_offer: true` when the line is more than 50 m (median) from the Scenic route or there is none. Then the admin
offers "Route aus video2gpx übernehmen"; mention it in the report with the median and max distance, and leave it to the user.

### W6. Report (wishlist mode)

In the chat:
- which server, which video (title, link `<base>/#v=<id>`), its queue position and votes;
- the outcome: published (points, km, coverage, mean confidence, level 2) or rejected / skipped / failed with the reason;
- what the frame check showed (start, turn, end, number of spots and their verdicts);
- for a rejection: the top causes and the new tests, with the path to `REPORT.md`;
- open editor decisions: route offer, maps to download for skipped wishes.

A short `review/REPORT.md` is enough for a published video (what was checked, the spot table, the payload numbers).

## Re-validating after a fix

When the user has a fix in another worktree:

```bash
$PY $S/run_tests.py --rsm <fix-worktree>/apps/video2gpx/research/route-shape-matching            # whole suite
$PY $S/run_tests.py --rsm … --only a,b --seed <baseline-tag> --from-step refine                   # only steps after the change: seconds
```

Read `_testsuite/_results/<tag>.md`. Each case is compared with its baseline:
- **REGRESSION:** a checkpoint lost; the run exits 1;
- **FIXED:** all checkpoints now hit;
- **BETTER / WORSE:** focus conf ±0.1;
- **SAME.**

Only `--from-step` a step at or after the first one the change touches. Otherwise the reused earlier steps hide the change. To move a
proven case into the repo bench (`rsm/bench/regress_cases.json` and `regress_landmarks.json`), use its `bench.json`. That is a repo
change: do it only on the user's request, in a dev worktree.
