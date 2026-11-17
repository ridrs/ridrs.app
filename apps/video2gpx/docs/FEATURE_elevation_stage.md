# Feature: elevation as its own stage ("Höhe")

Status: implemented 15 Nov 2026 (choices under "Implementation notes"; not yet checked in the real app). User request: elevation becomes a separate step between step 3 (Ergebnis) and
step 4 (Export). The download happens there, and the profile can be checked in detail. The method behind the profile is in
[ELEVATION_STRATEGY.md](ELEVATION_STRATEGY.md) (decision P17).

## 1. Stage flow

`STAGES` in `src/app/router.ts` becomes `einrichten, berechnung, ergebnis, hoehe, export`. The route is `#/p/<id>/hoehe`, and the label
in `STAGE_LABEL` (`src/app/shell.ts`) is "Höhe". The numbers 1–5 in the stage bar follow automatically.

- **Availability.** `hoehe` is available when `S.result` exists, the same as `ergebnis`. `export` stays available when a result exists. If
  no profile exists yet, the export says so and links to the Höhe stage (§4).
- **Stage marks.** `ergebnis` gets its check mark once the stage was visited or a profile exists (as today). `hoehe` gets a check mark when
  a current profile exists (§3, "current"), and a spinner while elevation data are downloading or the profile is being computed.
- After a run ends the app still goes to Ergebnis (unchanged). Ergebnis gets a primary "Weiter: Höhe" button where it now leads to
  Export. The Höhe stage gets "Weiter: Export".

## 2. What the Höhe stage shows (`src/views/elevation.ts`, new)

The layout is the existing workspace with the map and the video (like Ergebnis). The main area holds:

1. **Sources and download**
   - A list of all sources for the route from `dem_status` (online): Copernicus tiles (present / sea / missing) and every
     national or regional source (`extras.sources`). Each row shows title, region, licence, blocks present / needed and download size.
   - **One "Höhendaten laden" button** for everything missing, with progress (tile or block, bytes), a cancel button and the error text.
     This uses the existing `demDownload` / `onDemProgress` / `onDemDone`.
   - The profile is computed again after a download (`profileLoad`), automatically.
   - **Offline**, or if the user does not download: the profile is computed from what is there, and the missing sources are listed as such.
   - **The download moves here from the export dialog.** The export dialog keeps only a status line (§4).
2. **Profile chart over the whole route** (canvas, own code as in `ridePanel.ts`; no new chart library)
   - **x axis:** distance in km. **y axis:** height in m. Zoom (wheel, pinch, buttons +/−/all) and pan (drag). Zoomed in down to about
     200 m width, so single 5 m samples can be seen.
   - **Layers**, each switchable with a checkbox, with a legend:
     - final profile (thick line);
     - comparison profile "nur Copernicus (P13)" (thin, dashed), i.e. what the profile would be without the extra sources;
     - **raw samples per source** as dots in the source's colour. A dot's opacity is the weight the estimator gave it, so the dots
       the profile trusts are solid and the rejected ones are faint;
     - background bands: tunnels and bridges (interpolated), Copernicus void-filled pixels, and terrain ruggedness (0–1, as a thin
       strip under the chart);
     - a grade strip coloured by grade (green < 4 %, yellow < 8 %, orange < 12 %, red above).
   - **Hover:** a tooltip with km, height, grade, the source share at that point, the ruggedness and the strategy
     ("robust, mehrere Quellen" / "P13"). The position is marked on the map.
   - **Click:** the video seeks to that point (via the arc → time mapping the ride panel already uses), and the map follows.
   - Video playback moves a cursor line in the chart.
3. **Key figures**
   - ascent, descent, min, max and max grade (over 50 m);
   - the share of the route per strategy and per source, and the comparison with P13 (ascent difference);
   - a list of the **conspicuous stretches**: the 5 stretches where the final profile and P13 differ the most, and stretches where the
     grade exceeds 12 %. Each has a button that zooms the chart and the map there.
4. **Attribution:** the sources actually used, with licence (from the profile).

**Inspection only:** the stage shows the profile and the data it came from. Manual editing of heights is not part of this feature; that
would be a later decision.

## 3. Pipeline: diagnostics with the profile

`rsm.pipeline profile` (`export.elevation_profile`) also writes `out/elevation_diag.json` next to `elevation_profile.json`. Its
`version` is 2. `elevation_profile.json` stays compatible and gains `diag: "elevation_diag.json"` and the code hash it was made with.

Contents, all on the profile's 5 m grid (index i ↔ arc `s0 + i·ds`), rounded to 0.1 m or 0.01, and kept compact (arrays, not objects):

- `z_p13`: the profile without national or regional sources (Copernicus + fill + P13). This can be computed in the same run, because
  `profile_multi` already computes `z_p13`.
- `rug`: ruggedness 0–1. `filled`: Copernicus void-filled (0/1). `gap`: tunnel/bridge (0/1). `w_dtm`: the blend weight of the robust
  estimator (0 = P13 only, 1 = robust only).
- `sources`: per source `{name, title, colour index, z: [...], w: [...]}`. `z` is the axis sample (offset 0), cross-slope corrected
  as in `_stack`, NaN → null. `w` is the final IRLS weight of that sample, normalised 0–1 per route.
  - Only the axis column is shipped, not the ±15 m columns, to keep the file small: 62 km is about 12 400 samples per source.
  - `robust_road_height` must return its final weights. Extend `info` with them. **The profile itself must not change**: the
    pipeline tests and a byte comparison of `elevation_profile.json` `z` before and after on Amalfi have to pass.
- `strategy_share`, `source_share`, `max_grade_pct`: the figures for §2.3.

**Current.** A profile is current when its `pipeline_hash` equals the app's frozen code hash and no source block was added or removed
since then. The Rust side compares this in `profile_load` (new field `stale: bool`), and the Höhe stage then recomputes. This also fixes
the HISTORY open item that old profiles are not recomputed when the pipeline version changes.

**Rules:** back up the edited Python files to `research/route-shape-matching/work/pipeline_backup_<date>_elevation-stage/`. Add tests in
`tests/` (diag file written, shapes, weights in 0–1, `z` unchanged). Run `.venv/bin/python -m pytest -q tests/` and re-freeze with
`.venv/bin/python -m rsm.pipeline.freeze`. Update `PIPELINE_CLI.md`.

## 4. Export

- The export dialog (`src/incyclist.ts`) loses the download button and the checkbox `download_dem`. Instead it shows one line: "Höhenprofil:
  aktuell (Quellen …)" with a check icon, or "Höhenprofil fehlt / veraltet" with a link "Zur Höhe" (warn icon).
- Export is still possible without a profile: the backend computes the elevation from the tiles that are present, as today. If the
  Copernicus tiles are missing, the export needs the Höhe stage first. Its button is then disabled, with that reason.
- **The export reuses `elevation_profile.json`** when it is current, instead of computing again (HISTORY open item). The heights per GPX
  point are interpolated from the 5 m profile at each point's arc. Check in `incyclist.rs` / `export.py` where the export computes its
  elevation, and switch it there; the GPX must get the same `ele` values as from the profile (test).
- `download_dem` stays readable in old saved options, but is ignored.

## 5. Playback panel (`src/ridePanel.ts`)

The ±100 m profile under the video stays. Its download note "Genauere Höhendaten verfügbar … Laden" becomes a link to the Höhe stage
("Höhendaten prüfen"). The download itself happens only in the Höhe stage.

## 6. Mock and tests

- `src/mock/index.ts`: `profileLoad` returns a profile with `diag`. A new mock call returns a `elevation_diag` for it: two sources, a
  tunnel, a filled stretch and one stretch where the sources disagree. `demStatus` covers one missing extra source, and a mock download
  with progress exists. A scenario in `src/mock/scenarios.ts` opens the Höhe stage.
- The Tauri side: a new command `profile_diag(project)` reads `elevation_diag.json` (or the profile JSON returns it inline if it is small
  enough; choose one, document it). Add to `api.ts`, `tauri.ts`, `types.ts`.
- Tests: `pnpm build` (tsc), `pnpm test:ui`, `cargo test` in `src-tauri`, the Python tests. The Rust test `src-tauri/tests/e2e.rs` must keep
  passing.
- The view is checked in the browser preview with the mock (`pnpm dev`, port 1450, `?mock=…`): the stage bar with 5 steps, download
  progress, the chart with zoom, hover and layers, light and dark mode, and a narrow window.

## 7. Docs

- `docs/DECISIONS.md`: a new entry P18 "Höhe as its own stage". Adjust P10 (export: no download there any more) and P15 (playback panel).
- `docs/HISTORY.md`: close the two open items (profile as a step reused by the export; old profiles not recomputed).
- `docs/README.md` if it describes the stages.

## 8. Out of scope

Manual height editing; new DEM sources; changes to the estimator; notarisation and bundling FFmpeg.

## 9. Implementation notes

Choices where the spec left room, and what is where.

**Pipeline**
- `z` is unchanged: `robust_road_height` and `profile_multi` take an optional `diag` dict that only receives copies of intermediate arrays. Tests compare the outputs with and without it, and on Amalfi (62 km, three sources) the `z` array of `elevation_profile.json` was identical before and after (12 423 values).
- `w` of a source is the estimator's plausibility factor `1 / (1 + (residual / scale)²)` of the last pass (0–1, 0 for a missing sample or inside a gap), not the precision-weighted weight. Reason: it answers "did the estimator trust this sample", independent of how precise the source is, so a Copernicus and a LiDAR dot are comparable. The weight a source has in the result is a separate array `sh` (share of the final height, 0–1), which the hover tooltip and `source_share` use.
- `gap` is the tunnel / bridge mask widened by the portal pad, the stretch that is interpolated. `z_p13` is the profile of the same run without the national sources (Copernicus + fill + P13 filter).
- The profile JSON also gains `blocks` ({source: blocks of the route in the cache}); `version` stays 1. `dem-plan` reports `missing_bytes` per source.
- The export reuses a current profile (`export.current_profile`): hash equal, `blocks` equal to the plan of the cache now, newer than the result. GPX heights are `np.interp` of the 5 m profile at each point's arc; ascent and descent in the summary are computed on that interpolation over the exported span. Test: GPX `ele` equals the profile within the 0.1 m rounding.

**Rust**
- `profile_diag(project)` is a separate command (returns null without a file). Inline would have added about 0.8 MB to every `profile_load`, which the playback panel calls too.
- `profile_load(project, recompute)` returns `stale` and `stale_reason` (`result`, `pipeline`, `blocks`, `stamp`). It recomputes without being asked only when the result is newer than the profile (as before) or there is no profile; for the other reasons the Höhe stage asks with `recompute: true`, so the playback panel never waits for a recompute. A profile without a `blocks` record (made before this change) falls back to the old comparison with `.extras-updated`.
- The app's code hash comes from `rsm.pipeline version` (`pipeline::code_hash`), cached per executable and modification time.
- `incyclist::info` carries `profile` (`current` / `stale` / `missing`, source, ascent); the export no longer downloads anything. If the Copernicus tiles are missing the UI disables the button with the reason; the backend itself stays lenient (exports without heights, as before). `ExportOptions.download_dem` stays in the struct and in saved options and is ignored. The export's first step is renamed "Höhendaten prüfen", the second "GPX mit Höhen".

**UI**
- `src/elevation.ts` is the shared state (profile, diagnostics, sources, download); the Höhe stage, the playback panel (`ridePanel.ts`, which no longer loads or downloads by itself) and the stage bar read it. `src/elevationStats.ts` holds the pure functions (grade, stretches, ticks, zoom arithmetic; tested in `tests/elevation/`), `src/elevationChart.ts` the canvas chart, `src/views/elevation.ts` the stage, `src/mock/elevation.ts` the mock.
- The stage grid is video and map on top, the content below. The Copernicus tiles are one row of the source list; every `extras.sources` entry is its own row. The "im Profil" column uses the sources of the profile (the fill mask counts when the profile has void-filled stretches).
- Stage marks: Ergebnis gets its check once it was visited or a current profile exists; Höhe has a spinner while downloading or computing, a check when the profile is current.
- Chart: wheel and pinch zoom around the pointer, buttons and keys (`+ − 0`, arrows, Enter) too, drag pans, a click seeks the video, double click zooms in; narrowest view 200 m. The y axis follows the final profile and P13 in view; samples outside are clipped. Dot opacity is 0.1 + 0.9 × `w`; where the estimator did not run, dots are drawn at 0.7. The grade and ruggedness strips show the steepest / roughest sample per pixel column when zoomed out. Layer switches are kept in `localStorage`.
- Conspicuous stretches: the 5 places with the largest 100 m-smoothed difference between the final profile and P13 (at least 1.5 m, at least 300 m apart), plus every stretch where the grade over 50 m exceeds 12 % (runs closer than 100 m merged). "Anzeigen" zooms the chart and highlights the stretch on the map. The hover position is drawn on the map, and the stage opens with the cursor line following playback.
- Mock scenarios: `hoehe` (national data missing, Copernicus present), `hoehe-full`, `hoehe-missing` (everything missing, download with progress), `hoehe-stale` (recomputed on opening), `hoehe-old` (profile without diagnostics). `pnpm ui-shots` has `hoehe` and `hoehe-download`.

**Not done / not verified**
- Not tried in the real app or with the real sidecar (neither was built, as asked): the download events, the `version` call for the code hash, and `profile_stale` against a real cache. Offline behaviour was only exercised by reading the code path (the button is disabled, a note says what is missing).
- No manual height editing, no new sources, no change to the estimator (§8).
