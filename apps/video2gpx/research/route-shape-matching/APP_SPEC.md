<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Video → GPX app: UI and product specification (draft v0.1, 2026-11-11)

This specification packages the route-shape-matching research (FINDINGS.md) into a product. The user's requirements are marked **[U]**. Additions derived from the research are marked **[R]**. Open questions are listed at the end. It is not built yet. A consolidation step (frozen pipeline, fixed rules, blind test) comes first; see FINDINGS.md.

## 1. Goal

For a road video without GPS (bike, motorcycle, car), produce a **GPX file whose timestamps match the video**, with the **camera's driving line** rather than the OSM centre line. **[U]**

- Version 1 approximates the driving line with a fixed lateral offset from the centre line, marked as "to be refined later". **[U]**
- The final algorithm is classical, without AI or ML, and runs locally and offline. **[R]**

## 2. Main screen

```
┌──────────────────────────────────────────────┬───────────────────────────────────────────────┐
│ VIDEO                                        │ MAP                       [ Search place…  🔍 ] │
│ ┌──────────────────────────────────────────┐ │ ┌───────────────────────────────────────────┐ │
│ │  preview frame / player                  │ │ │  OSM map, view = search area             │ │
│ │                                          │ │ │  (after the run: route coloured by       │ │
│ └──────────────────────────────────────────┘ │ │   confidence, cursor = current frame)   │ │
│ ▶ ❚❚  ───────●──────────────  12:34 / 2:07:10 │ └───────────────────────────────────────────┘ │
│ title: "Driving the Amalfi Coast"            │ Area 42 × 19 km · map data: ✓ local          │
│                                              │ [ Download map data for this area… ]          │
├──────────────────────────────────────────────┴───────────────────────────────────────────────┤
│ [ ▶ Start matching ]   Vehicle: [ Bicycle ▾ ]   Driving line: [ 1.5 m right of centre ▾ ]   │
│ ① Video motion ✓ ─ ② Rotation ✓ ─ ③ Map ✓ ─ ④ Route search 63 % ─ ⑤ Check ─ ⑥ Refine ─ ⑦ GPX │
│ ████████████████████████░░░░░░░░░░  step 4 of 7: route search, 63 %, about 4 min left       │
│ Status: ● running well  ·  best match so far: clear (margin 9.8)                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Layout:** the screen is split into two areas, the video and the map. **[U]** On narrow windows they stack: video on top, map below. **[R]**
- **Video area:**
  - After import it shows the player with a preview frame. **[U]**
  - After the run, the player and map are synchronised **[R]**:
    - playing moves a cursor (position and heading arrow) along the route;
    - clicking the route seeks the video to that moment (as in the prototype `rsm/bench/verify_map.py`, which the user tested).
- **Map area [U]:**
  - It has a search field.
  - On open it shows the **most likely map section derived from the video title**.
  - The user can search another place or pan and zoom. **The visible map section is the search area** and therefore the search radius.
- **[R] Area check:** once the video motion has been analysed (step ①), the app knows a rough route length. If the visible area is clearly too small for that length, it warns. Amalfi showed that a too-small box cuts the route.
- **Vehicle type [R]:** bicycle, motorcycle or car. This sets the prior for the distance scale and the default driving-line offset.

## 3. Map data: local, with download **[U]**

- **All OSM data lives on the user's computer.** Matching never needs the network.
- **The app shows which regions are available locally.** For a map section without local data it offers a download: region name, size in MB, source.
  - Source: Geofabrik extracts, e.g. `italy/sud`, `france/rhone-alpes`, `germany/hessen`.
  - The download needs the user's explicit start and runs with progress and cancel.
  - **[R]** Only the road network of the chosen area is extracted and cached for matching (MB, not hundreds of MB).
- **[R] Place search offline:** from place names in the local extracts. Online geocoding (Nominatim) is only an optional extra, used when the user allows it.
- **[R] Attribution:** "© OpenStreetMap contributors, ODbL" on the map and in the exported GPX metadata.

## 4. Matching run: steps and progress **[U]**

Start button, then a step bar with the current step highlighted, and a progress bar in % within the step. **[U]** The steps and how % is measured **[R]**:

| # | step | what happens | progress in % | typical time per video minute |
|---|---|---|---|---|
| ① | Video motion | decode, frame-to-frame motion (yaw, relative speed) | frames done / total | 7–18 s |
| ② | Rotation | far-feature rotation, a drift-free heading | frames done / total | 2–8 s |
| ③ | Map | load the local OSM area, build the road graph | phases (read, filter, graph) | – (about 0.5–2 min per area) |
| ④ | Route search | dense HMM over all road positions, scanned over camera calibrations (angle × distance scale) | calibration grid cells done / total | – (minutes) |
| ⑤ | Plausibility check | the same search on about 19 decoys (mirrored video, shuffled, foreign maps) | decoys done / 19 | – (minutes) |
| ⑥ | Refinement | anchors (curves, later more), fusion, per-segment distance factors | phases | – (seconds to a minute) |
| ⑦ | GPX | driving line (lateral offset), timestamps, export | phases | seconds |

- **Total:** a 2 h video takes about 30–60 min on a current Mac. It runs in the background, can be cancelled, and resumes after a crash or quit from the last finished step (each step writes a checkpoint). **[R]**
- **Resources:** at most 4 worker processes and a hard memory guard. A runaway job crashed the development machine twice. **[R]**

## 5. Confidence and "how is it going" **[U]**

Shown **during** the run and with the result. Thresholds are placeholders, to be calibrated on test videos. **[R]**

**During the run (status light: good / difficult / problem):**

| signal | from step | good | difficult |
|---|---|---|---|
| usable video motion | ① | ≥ 85 % of time | < 70 % (many cuts, darkness, shake) |
| rotation quality | ② | low yaw noise (bike level) | yaw noise ≥ 3× bike level (e.g. motorcycle) |
| calibration peak | ④ | clear interior peak | flat or at the grid edge |
| best route vs decoys | ⑤ | real route beats every decoy with a clear margin | a decoy is as good or better |

**With the result:**
- **Overall verdict:**
  - "Route found (confident)": the real route beats all decoys (p ≤ 0.05) with a margin.
  - "Route found (uncertain)".
  - "No reliable route": the app says so honestly instead of showing a wrong route.
- **Per point:** confidence 0–100 %, the posterior of the route search.
  - The route is coloured by confidence on the map; uncertain stretches are grey.
  - A thin confidence strip under the video timeline shows where the video is uncertain.
- **Expected accuracy, as a plain sentence:** "Road: correct where confident. Position along the road: about 5–10 m near curves, up to 20–40 m on long straights. Lateral: approximation." This is based on the research numbers.

## 6. Output: GPX **[U]**

- **Times:** one track point per second, `<time>` = video start time + video seconds; plus one point at the exact start and end of every sure standstill (millisecond time, PIPELINE_CLI "Sure standstill").
  - The video start time is a user-set date and time, or a fixed epoch if unknown (see open question 3).
- **Position:** the OSM centre line shifted **laterally by an adjustable offset**.
  - Default 1.5 m to the right of travel. Measured on the bike videos: the camera rides 1.5–2.6 m right of the centre line.
  - Cars and motorcycles: about half a lane width (1.5–1.75 m).
  - One-way roads: 0 m.
  - **[R]** Left-hand traffic countries flip the side.
  - **[R]** The offset is computed as a proper smoothed offset curve, so hairpins get no loops or kinks.
  - Marked in the file as "driving line: approximation, refinement planned".
- **Elevation:** in the Incyclist export (section 10), from the Copernicus DEM GLO-30, downloaded on demand like map data. The plain GPX export has none.
- **[R] Extensions per point:** confidence, and a flag for points outside the decoded span or in vms gaps.
- **[R] Project file:** reopen a finished match without rerunning.

## 7. Later (v2 and beyond) **[U]**

- **Visual explanation of intermediate results:**
  - the turn signature of the video against the map;
  - candidate routes as they appear;
  - the calibration surface;
  - the decoy comparison;
  - so the user understands what happens in the background.
- **[R] User help:** "this frame is here" (one confirmed anchor), which turns a difficult video into an easy one, since tracking from a true anchor works well.
- **[R] Finer driving line:** lateral position from the video (lane markings, road edge).
- **[R] More anchor kinds:** tunnel portals, bridges, place signs, lane-marking counts.

## 8. Decisions (user, 2026-11-11)

1. **Platform: a standalone macOS Tauri app,** not part of the Ridrs app. v1 calls the Python pipeline as a local background tool (sidecar). Porting parts later stays open.
2. **Video source: local files only, plus a generic import command.**
   - The usual way in is a file picker or drag and drop.
   - **Import field:** a text field where the user pastes **one shell command that puts a video file into the project's import folder**, e.g. `cp ~/Movies/ride.mp4 "$OUT"`. The user may equally type another command there (e.g. a downloader they installed themselves). The app has **no YouTube or download feature of its own**; it only runs the user's command.
   - **[R] Execution rules:**
     - Run only on an explicit "Import" click, never automatically, and never from text found in a video title, file or web page.
     - Show the exact command before it runs.
     - Working directory and `$OUT` are the project's import folder; the app sets them as environment variables and does not rewrite the command.
     - Show live stdout and stderr in a log panel, with a cancel button (kill the process group).
     - Accept the result when exactly one new video file appears in the import folder; otherwise show an error.
     - Keep a history of the user's own commands for reuse.
   - **[R] Distribution:** a sandboxed Mac App Store build cannot run arbitrary commands. This feature therefore assumes direct distribution, a signed and notarised app outside the App Store.
   - See the licence note below.
3. **GPX start time: the user chooses it.** There is an input for date and time, with a default (a fixed epoch, or the file's creation date if plausible), and it can be changed after the run without recomputing.
4. **Videos with location jumps (cuts): out of scope for v1.**
   - The pipeline assumes one continuous drive.
   - **[R]** If the run finds a jump (a long stretch with no route, or the jump state in the tracker), the app says so instead of joining nonsense. Splitting into GPX segments is a later feature.
5. **Vehicle type: estimated by the app, not constrained too much.**
   - The app derives a guess from the video: speed range, motion pattern, roll (lean).
   - It is used only as a soft prior. The calibration scan stays wide for every type (distance scale ×0.8–3.5, wide angle scale), so a wrong guess cannot exclude the true route.
   - The user may override it; the guess sets the default driving-line offset.

**Licence note on YouTube downloads (not legal advice).** With a generic import command the app contains no download or YouTube function at all; whatever the user types is their own action. The app neither distributes download code nor works around YouTube technically. The question of whether downloading is allowed remains:
- YouTube's terms of service generally forbid downloading without a download button or permission.
- The video content is the creator's copyright; Creative Commons videos (like the Van Gestel ones, CC BY-NC-SA) are fine within their licence.
- The app should make the user responsible, not encourage downloading, and favour local files and openly licensed videos.
- If the app is ever distributed through the Mac App Store, any built-in download integration risks rejection.
- The GPX derived from a video (a route and timestamps) is facts rather than creative content, but sharing frames or clips is subject to the video's licence.


## 9. Search frame, start frame, route hint (2026-11-11, `video2gpx/docs/FEATURE_area_hints.md`)

- **Search frame.** The search area is a rectangle the user draws on the map (blue; drag to draw, move by dragging, resize with the corner handles, ✕ deletes), no longer the visible map section ("Sichtbaren Ausschnitt" sets it to the view in one click). Coverage by local map data and the size warnings refer to the frame; its size is in the info line ("Suchrahmen 18 × 14 km"). It is proposed from the title suggestion (60 × 60 km around the hit) or from a route hint (its box plus 3 km). Dashed and locked during a run; afterwards it stays as used.
- **Start / end frame.** Optional smaller rectangles (green "Start", red "Ende"), clamped into the search frame; pass to the pipeline as `--start-bbox` / `--end-bbox` (hard constraint on the first / last HMM state, tolerance 150 m).
- **Route hint.** "Laden …" takes a `.gpx` or `.kml`, copied into the project (`hint/`); drawn as a thin dashed purple line "Vermutete Strecke (Hinweis)" with a faint band of the corridor width; the corridor (default 300 m, slider 100 m to 2 km) limits the roads of the map step. A poor corridor result is retried once on the full frame by the pipeline (the result says which was used).
- **Legend** under the map: search frame, start, end, hint, route of the result. **Run panel:** "Hinweise: Startrahmen ✓ · Routenhinweis (300 m) ✓"; new status lights (Startrahmen, Endrahmen, Routenhinweis, Übereinstimmung mit Hinweis); the result shows "mit Routenhinweis (300 m)" / "mit Startrahmen" chips (or "Routenhinweis verworfen" after the fallback); the hint stays on the map.
- **Pipeline source.** The app runs the pipeline bundled in the app (frozen sidecar) by default; "Entwicklermodus: externes Python" in Settings (visible badge in the header) switches to the research venv. Settings and the result show the pipeline version (code hash of `frozen.json`). ffmpeg is still external (PATH / Homebrew / setting).

## 10. Export for Incyclist (2026-11-11, `video2gpx/docs/FEATURE_incyclist_export.md`)

- **Button** "Für Incyclist speichern …" next to "GPX exportieren …" once a result exists. Verdict `uncertain` or `no_route`: "Die Route ist unsicher. Trotzdem exportieren?" first.
- **Dialog:** title (the cleaned video title: IDs, emojis, 4K/HDR tags removed), name (ASCII-safe file names, prefixed with the country, e.g. `FR_Col_de_la_Madone`), country (ISO alpha-2 from Nominatim reverse of the route start, editable), elevation status ("Höhendaten vorhanden" or "Download 43 MB nötig" with "Jetzt laden"; "Fehlende Höhendaten beim Export laden" on by default), video options ("Ton weglassen" on, "In SDR umwandeln" for HDR, "Auflösung" 1440p / 1080p), the plan with size and time, target ZIP or folder, estimated size. The options are stored per project in app.json (`incyclist`).
- **Steps with progress and cancel:** 1 Höhendaten laden, 2 Höhen berechnen (`rsm.pipeline export`), 3 Video vorbereiten (ffmpeg `-progress`), 4 ZIP schreiben. Cancel kills the running process group; nothing is left (`.part` files and the project's `export/` folder are removed). At the end: path, length, ascent, size, start frame, "Im Finder zeigen".
- **Video ladder:** MP4/MOV with H.264, HEVC or AV1 and no audio to drop: copied as is. Other containers with H.264, HEVC, AV1 or VP9, or audio to drop: remuxed (`-c:v copy`, audio dropped or AAC, `+faststart`). Other codecs, SDR or a smaller resolution: re-encoded with `hevc_videotoolbox` (`-fps_mode passthrough`); HDR to SDR through a generated 33³ LUT (PQ / HLG BT.2020 → Hable → BT.709), because the Homebrew ffmpeg has no zscale. After remux or encode the output must start at 0 s and last as long as the source (± 1 s), else the export fails.
- **Package:** `<Name>.xml` (gpx-import control file: name, id `video2gpx-<16 hex>` = FNV-1a of the video signature and the route points, country, title, video and GPX file, exact framerate, start-frame, two informations), `<Name>.mp4` (stored), `<Name>.gpx`, `video2gpx.json` (versions, input video, options, plan and check, verdict, confidence, hints, vehicle and driving line, f_eff / kappa, local pass and alignment, elevation corrections, start frame and trimmed seconds, sources and licences), `LIESMICH.txt` (German and English: what it is, "Position aus dem Video rekonstruiert, kein GPS", confidence, attribution OSM / Copernicus / ffmpeg when re-encoded, the video's rights stay with its author, private use only for third-party videos). ZIP64, `<dest>.part` then rename; disk space is checked first.
- **Elevation data** appear in "Kartendaten" under "Höhendaten" (list, delete), stored in `<app data>/dem/`.
- **Commands:** `incyclist_info`, `incyclist_export` (events `incyclist-progress`, `incyclist-done`), `incyclist_cancel`, `dem_status`, `dem_download` (events `dem-progress`, `dem-done`), `dem_cancel`, `dem_list`, `dem_remove`, `geo_country`.
- **Open (only checkable in Incyclist):** VP9 in MP4, whether standstills are skipped, whether `<start-frame>` is used, whether `<id>` / `<country>` are needed.
