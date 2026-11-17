# Feature: insight into the analysis (live preview and analysis viewer)

Status: planned 16 Nov 2026. Part A implemented 16 Nov (choices under "Implementation notes (Part A)"; not yet checked in the real app); Part B is not started. User request:
- While the analysis runs, show what is being analysed: a video frame with the motion or rotation data over it, refreshed every 2–3 s.
- For route search and refinement, show a map with the routes being tried and the current favourite.
- After the analysis, a viewer like the Höhe stage: the video frame at the current time, motion and rotation data as an overlay that can
  be switched on, and the estimated curve radii compared with the map's.
- **Goal:** understand what is wrong, and why, on the stretches the map marks as bad (confidence colours `low` / `none` from `confClass`).

Two parts that can be built one after the other. **Part A** (viewer) needs no change to how a run computes, so it works on existing
projects. **Part B** (live preview) touches the step workers.

## 0. What the pipeline has today [read in the code]

| Step | Worker | Stored per time | Not stored |
|---|---|---|---|
| 1 Videobewegung | `steps_a.motion` → vendored `vmsx/motion.py` | `motion/motion.csv` per frame pair: `time, corners, tracked, inliers, rms_px, s, c, yaw, pitch, roll, diff, rel_speed`; horizon in `motion.json` | the tracked points / flow vectors |
| 2 Rotation | `steps_a.rotation` (far features, fork pool over chunks) | `rotation/win_video_base.npz` per window: `A, B, C, e, sA…, sigma, xspread`, `ok`, `n_pts`, `n_inl`, `why`; `far_heading.npz`; `tracks.pkl` | the far feature points |
| 3 Karte | `steps_b.map_step` | graphs, decoy boxes | – |
| 4 Routensuche | `steps_b` (f_eff × κ scan, decode, posterior) | final route | the scan surface while it grows, the candidates |
| 5 Plausibilität | `steps_b` (19 decoys) | verdict | the decoy routes |
| 6 Verfeinerung | `steps_c.refine` (local pass, forward-backward, anchors, fusion) | `refine/result.npz`: `t, s, s_sd, conf, extrap, in_gap, sg, xy, tunnel…` | intermediate posteriors |
| 7 GPX | `steps_d` | `route_points.json` | – |

Workers report through `common.Worker` (`progress`, `status`, `log` as JSON lines); Rust forwards them to the UI.

## Part A: the analysis viewer (after the run)

### A1. Where

A new stage **"Analyse"** after Ergebnis. The stages become Einrichten, Berechnung, Ergebnis, Analyse, Höhe, Export. The layout is the
same as Höhe: video, map, and below them charts on a common time axis. (Alternative: a panel inside Ergebnis. Open point 1.)

### A2. Series on the time axis (`rsm.pipeline inspect-series`, new CLI command, read-only)

Computed on demand from the stored outputs and cached as `out/inspect/series.json`, together with the code hash. A cached file is
recomputed when the result is newer. Everything is per video second, plus at full pair resolution where that is cheap:

- **Speed:** from vms (`rel_speed` scaled, the nominal speed) and the fused speed from the result (`ds/dt`).
- **Rotation:** yaw rate from vms (`yaw` per pair) and from the far features (`far_heading`), plus pitch and roll; quality per source
  (`inliers`, `rms_px`, far `ok` / `n_inl` / `why` as text).
- **Curvature, the core of the comparison:**
  - **from the video:** κ_video = yaw rate / speed. The radius is R = 1/|κ|, signed left/right, and smoothed over the same window the
    pipeline uses;
  - **from the map:** κ_map along the matched route `xy` at arc `s(t)`, from the heading change of the OSM line over the same distance
    window, so both have the same resolution;
  - the difference, and a match measure per 100 m.
- **Quality per second:** `conf`, `s_sd`, `in_gap`, `extrap`, tunnel, scene cuts (`cuts.json`), the odometry-failure spans (`odofail`),
  local-pass flags.
- **Reasons per bad stretch:** contiguous `low` / `none` stretches, each with a short list of measured causes. The rules are simple and
  documented, for example:
  - "Videobewegung unsicher (Inlier < x)";
  - "Rotation verrauscht";
  - "Kurven passen nicht zur Karte (κ-Abweichung y)";
  - "Lücke / Tunnel";
  - "Szenenschnitt";
  - "Position streut ± z m".

  Every cause carries its value.

The pipeline itself does not change; existing results stay byte-identical (test).

### A3. Overlay on the current frame (`rsm.pipeline inspect-frame --t <s>`, new CLI command)

Points are not stored, so they are recomputed for the frame pair at time t. That means one vms pair and one far-feature window, which
should take about 0.5 s. The output is JSON:

- **motion:** tracked points with flow vectors (inlier or outlier), the horizon line, the road-flow fit (yaw / pitch / roll / speed
  of this pair);
- **rotation:** far feature points with their motion, the band lines, the fitted rotation.

The frame itself comes from the app's video element (no JPEG needed). The command must use exactly the pipeline's parameters (`C.VMS`,
`C.FAR`, horizon from `motion.json`). This is diagnosis only; it never changes stored results. It is called when playback pauses or the user
scrubs, and while playing every 2–3 s (debounced, one call at a time).

### A4. The view

- **Video** with an overlay canvas exactly on top of the picture (letterbox-aware). Toggles: "Bewegung" (flow vectors, inliers green /
  outliers red, passing traffic the speed ignores magenta, dashed and crossed out (A17 / A18), horizon) and "Rotation" (far features, band lines, a yaw-rate arrow). They are off by default and remembered in
  `localStorage`. A small legend explains the values of the frame.
- **Charts** (canvas, the code of `elevationChart.ts` reused or generalised):
  1. Kurvenradius: video vs map, as signed curvature (a radius axis is unreadable near straights) with a radius scale as labels.
  2. Gierrate vms / far features.
  3. Geschwindigkeit.
  4. Qualität: inliers, rms, `s_sd`.
  5. A band with the confidence colour of the map and the bad stretches.

  All charts share zoom and pan, hover shows the values, and a click seeks the video. A cursor follows playback.
- **Map:** the route in the confidence colours (as today). Optionally the curve mismatch as a colour: hover on a chart marks the point on
  the map, and a click on the map seeks the video.
- **List "Schwache Abschnitte"**: each bad stretch with km, duration and its causes. "Anzeigen" zooms the charts and the map there and seeks
  the video to its start.

## Part B: live preview while the analysis runs

### B1. Pipeline: `Worker.preview(step, data, jpeg=None)`

- Throttled to one update every 2.5 s per step.
- Writes `out/<step>/preview.json` (and `preview.jpg`, at most 480 px wide, quality 70) atomically.
- Emits `{"type": "preview", "step": …, "seq": n}`.
- A preview never influences the computation. The run's results with preview on and off must be byte-identical (test on a short project),
  and the runtime may grow by at most 3 % (measure).
- The previews are deleted when the step ends, or kept as the last state (open point 3).

| Step | Preview content |
|---|---|
| 1 Videobewegung | the current frame (the vms loop already has it decoded) + tracked points, flow vectors, inliers, horizon; yaw / pitch / roll / speed of the pair; a sparkline of the speed so far |
| 2 Rotation | the chunks run in a fork pool, so the parent takes the last finished chunk: its last window's far points (returned by the chunk, small) + a frame grabbed with ffmpeg at that time (cheap, every 2.5 s at most); a sparkline of the yaw rate so far |
| 3 Karte | the boxes being loaded (search box, decoy boxes) on the map |
| 4 Routensuche | the f_eff × κ score surface as it is filled (small heatmap), the route currently being decoded or tested (grey), and the **favourite** (best so far, blue), with its score |
| 5 Plausibilität | the decoy routes with their scores against the favourite |
| 6 Verfeinerung | the route with the current spread (`s_sd`) as a corridor, the anchors as dots, the local pass's current piece |

Route geometries are sent as lat/lon lists simplified to about 10 m, so a preview stays small.

### B2. App

- In the Berechnung stage a panel **"Einblick"** next to the step list: the preview of the running step. With several steps running (1–3
  side by side) there is one tab per step; the newest step is followed unless the user picks one.
- A frame with the overlay drawn from the JSON (the same overlay code as A4). The map uses the existing map panel with layers for
  candidates, favourite and corridor.
- Updates on the `preview` event, re-reading the file, so it refreshes about every 2.5 s. A small "aktualisiert vor x s" note.
- Rust: forward the `preview` event (`run-preview`), plus a command `run_preview(project, step)` that returns the JSON and the JPEG as a data URL.

## Common rules

- Pipeline: back up the edited files, write tests, run `pytest`, re-freeze, update `PIPELINE_CLI.md`. Run heavy runs only under
  `scripts/guard.sh`, one at a time.
- `pnpm build`, `pnpm test:ui` and `cargo test` must pass. Check the views in the browser preview with mock scenarios: during the run,
  the Analyse stage, light and dark mode, a narrow window.
- Build the app only when it is closed, with `--config src-tauri/tauri.sidecar.conf.json`.
- Docs: decisions P19 (Analyse) and P20 (Einblick), HISTORY, README.

## Decisions (user, 16 Nov)

1. Analyse is **its own stage** (6 stages).
2. **Part A first.** Part B follows later.
3. Previews after the run: open until Part B starts (recommendation: delete).

## Implementation notes (Part A)

Choices where the spec left room, and what is where.

**Pipeline** (`rsm/pipeline/insight.py`, named so because `inspect.py` would shadow the standard library; CLI `inspect-series`, `inspect-frame`; no step changed)
- **Series grid:** one value per video second, taken from the result's own `t`. No pair-resolution arrays: 158 000 pairs would be 100 times the file for nothing the charts can show. The file is 0.3 to 1.2 MB (2 000 to 7 600 s) and made in 1 to 4 s.
- **Rotation:** the pipeline's own series builder (`farrot.series.build`, read only) gives yaw per far window; rates are per second in degrees, left positive, scaled by `f_far / f_eff` (angle = px / f_eff, as the route search decoded it in `route.pkl`). Pitch and roll are the vms values.
- **Curvature:** a heading change over a window of **30 m** (between the pipeline's 6 m and 18 m smoothing). Video: heading from the fused series over the video's own distance (vms speed times kappa where at least half the pairs are usable, else the fused ds/dt); map: unwrapped heading of the OSM line over 30 m of arc at the fused position `s(t)`. Windows spanning more than 20 s (a standstill), the pairs next to a scene cut and extrapolated seconds are blank. Left positive in both (checked: correlation 0.78 on confident seconds of Verdon). Shown in 1/km with radius labels.
- **Match per 100 m:** `dev` = mean |video minus map| in degrees per 100 m; `match` = 1 minus rms difference over max(rms of the map, 1/300 m), so straights with no curve content match.
- **Weak stretches:** seconds with confidence below 0.5 or extrapolated (the map's classes low and none); runs closer than 3 s are merged, stretches under 4 s are not listed, seconds before a skipped intro are ignored.
- **Causes** (each a measured value with its limit, strongest first; `TH` in the module):
  - `edge`: extrapolated for at least half of it.
  - `odofail`: inside a failure span of `odofail.fail_spans` for at least 30 %.
  - `motion`: usable share of vms pairs below 0.6 (the pipeline's own `ODO_LOW_USABLE`), or median inliers below 40 % of the run's median.
  - `rotation`: far windows valid in less than 50 %, with the commonest reason (few corners / few inliers / narrow / fit not trusted); or the vms-far yaw difference above 2.5 times the run's median.
  - `curves`: mean curve-rate disagreement at least 1.5 times the median of the run's confident 20 s windows (at least 20 degrees per 100 m), at least 0.9 of the curve content, at least 8 degrees of turning. Relative to the run, because Verdon's confident windows already disagree by 25 degrees per 100 m (short polyline kinks).
  - `speed`: video speed and fused speed differ by 25 % or more over the stretch.
  - `straight`: less than 10 degrees of turning over 150 m or more.
  - `gap`, `tunnel`: at least 30 % inside a vms gap or the matched tunnel.
  - `cut`: a scene cut within 5 s.
  - `kept`: the local pass kept the search route against another road (conf capped at 0.5).
  - `spread`: median `s_sd` of 20 m or more. `slow`: median speed under 1 m/s.
  - `ambiguous` (only when nothing else fires): the final confidence is the posterior of the local pass, so a weak stretch without a disturbance means several roads fit alike; the search posterior of `route.pkl` is quoted next to it (on Verdon the search was 100 % sure where the final posterior was 0 to 10 %).
- **inspect-frame:** reuses `vmsx.motion` (tracker, fit, `pair_row`) and the rotation chunk's masks, tracking and `model.fit_window`. Parameters come from what the run stored: horizon, region of interest and `destatic_tau` of `motion.json` (absent: a run before the destatic filter, so none), the band rows, focal length and window length of `win_video_base.npz`; thresholds from `C.FAR` and the vms module. The destatic filter is warmed up over 40 earlier frames. The far fit is random (RANSAC); the step seeds one generator per 120 s chunk, so the generator is replayed from the chunk start with the stored point counts of the earlier windows. The csv row and every band fit then come out identical, and the result carries `agree` and the stored values. A video with irregular timestamps (Amalfi) can offset the frame index; then `agree` is false and the UI says so.
- **Tests:** `tests/test_insight.py` (synthetic run for the series; a synthetic 4 s video through the real vms pass and far chunk for the frame agreement; mismatch and part failure; generator replay).

**Rust** (`src-tauri/src/inspect.rs`): `inspect_series` reads `out/inspect/series.json` when `version`, `result_mtime` (seconds) and `pipeline_hash` match, else runs the command. `inspect_frame` keeps a request counter: a new request ends the running process group and the older call answers `{superseded: true}`; one process at a time. The app passes the video it plays.

**UI**
- Shared time-axis chart written new (`analyseChart.ts`, five lanes in one canvas) instead of generalising `elevationChart.ts`: the elevation chart is built around a distance axis with sample layers and strips, the lanes here need per-lane value axes. The pure arithmetic is a time-axis copy in `analyseStats.ts` (tested), the interaction code follows the elevation chart.
- Overlay (`analyseOverlay.ts`): a canvas inside the video panel placed over the stage; the letterbox rectangle comes from the video's own size. Requests: debounced 160 ms after a seek or pause, every 2.5 s while playing; the picture is drawn only while the data are within 0.6 s (playing: 4 s) of the player time, else a note says so. Switches are kept in `localStorage` (`v2g.analyseOverlay`), chart lanes in `v2g.analyseLayers`.
- Stage mark: spinner while the series is read, check once visited and read. Mock scenarios `analyse` (one weak stretch) and `analyse-bad` (five, one per kind), `?frame=error` and `?frame=slow` for the overlay.

**Not done / not verified**
- Not tried in the real app or with the sidecar (neither built, as asked). The overlay was checked in the browser preview against the mock video only; its alignment on a real letterboxed video of another aspect ratio is covered by the unit test of the rectangle, not by eye.
- The optional curve-mismatch colouring of the map is not built (hover and stretch highlight are).
- Thresholds of the causes were set on Verdon and Gotthard (confident and uncertain runs) and looked at on Amalfi, Bavaria and Clue du Pérou; no ground truth for the causes exists.
