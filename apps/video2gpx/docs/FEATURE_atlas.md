# Feature: POV Drive Atlas round trip (job file in, `<id>.atlas.json` out)

Status: implemented (steps A and B of the plan), 2026-11-18. Plan and contract: `pov-atlas/VIDEO2GPX-INTEGRATION.md` (sections 1-6; the
formats in section 8). Decision P21.

## What it does

```
Atlas admin "Job-Datei laden" -> <id>.v2g.json -> video2gpx: drop or "Atlas-Job öffnen …" -> project with URL and hints
  -> import with the user's own template (P2) -> run -> Export stage, card "Atlas": checklist -> "Für den Atlas speichern …"
  -> <id>.atlas.json -> Atlas admin "video2gpx-Ergebnis hochladen" -> sync track, Lokalisierungsstufe 2 -> Prüfmodus -> 1
```

Not built (open maintainer decisions of the plan): the `video2gpx://` deep link (step C), sending directly with a service token (step D),
map lines and `data/manual.json` in the atlas build (step E), replacing the atlas route automatically, deleting the local video.

## Opening a job (`src/features/atlasJob.ts`, `src/atlas.ts` `parseJob`, `jobPlan`)

- A `*.v2g.json` dropped on the window, or picked with **"Atlas-Job öffnen …"** on the start page, creates a new project. The file is
  read by the Rust command `atlas_job_read` (only `*.v2g.json`, at most 1 MB) and checked in `parseJob` (video id, https URL, atlas link,
  route level 4/5, boxes); anything else is refused with a German message.
- The project gets the hints the app already has (P9), stored exactly as if the user had set them:
  - search frame = `bbox` (the atlas makes it the route's box plus 3 km, the app's own margin around a hint; without a route a 60 × 60 km
    square around the pin, the app's title-suggestion size), so no title suggestion runs;
  - start / end frame = `start_bbox` / `end_bbox` (route ends ± 300 m), only for route level 4 and only when inside the search frame;
  - route hint = `route_gpx`, downloaded once by `atlas_hint_download` into the project's `hint/` folder (as `hint_import` does for a local
    file: http(s) only, at most 30 MB, must be GPX), corridor **300 m at level 4, 1 km at level 5**; the pipeline's fallback to the whole
    frame stays on (`hint_fallback: auto`). If the download fails, the project is made without the hint and a toast says so;
  - vehicle as the soft prior (P4): `car`, `motorcycle`, `bike` as they are, anything else (the atlas mostly has none) automatic;
  - name = the job's title; `app.json` `atlas` = `{base, video_id, job, qc, written}`.
- The video is not loaded automatically. Einrichten shows where the project comes from and, without a video, a button
  **"Video importieren"** with the user's default template for addresses and the job's URL (the import runs only on that click, P2). Without a
  template it shows the template of the plan as text to copy into the settings (no preset, P2 and E13):

  ```text
  yt-dlp -f "bv*[height>=480]" -S "+res,vcodec:h264,fps" --no-playlist -P {out} -o "%(id)s_%(height)sp.%(ext)s" -- {url}
  ```

  At least 480p, video only (one file, no ffmpeg merge), smallest height ≥ 480 first, then H.264, then the higher frame rate.

## The "Atlas" card of the Export stage (`src/views/atlasCard.ts`, `src/atlas.ts` `qcChecks`)

Only for a project made from a job. Every **blocking** item must be green or explicitly overridden with a note; the state (span, ticks, notes)
is kept in `app.json` (`atlas.qc`). It belongs to one result (`atlas.qc.result` = SHA-256 of `route_points.json`): after a new
calculation with a different result the list starts fresh (span from the result, no overrides, nothing ticked), so ticks of an earlier
result never pass a new one; only the free note for the atlas is kept.

| Item | Rule | Override |
|---|---|---|
| Ergebnis | `confident` | `uncertain` with a note; `no_route` never |
| Abdeckung | ≥ 90 % of the driving seconds between start and end (sure standstills do not count) have a measured position (not in a gap, not extrapolated), and no run without one is longer than 60 s | with a note |
| Übereinstimmung mit der Atlas-Route | median distance of the driving line to the atlas route ≤ 50 m (600 evenly spread points, as the atlas computes it) | not blocking: shown only, because the atlas route may be the wrong one |
| Schnitte | the scene cuts between start and end are listed; each piece between them is ticked as checked in the Analyse stage (no cuts: green). A jump the scene detection missed (below) is named in the detail and in `value.jumps` (`[{t, m}]`), not blocking | with a note |
| Anfang und Ende | `t_start` / `t_end` set, inside the decoded route; default: the first and last decoded second after the intro ("Aus dem Ergebnis") | never |
| Angesehen | ticks: the start, a hairpin or junction, and the end played against the map | with a note |

## The payload (`src/atlas.ts` `buildPayload`, Rust `atlas_result_write`)

"Für den Atlas speichern …" writes `<id>.atlas.json` (save dialog; Rust accepts only `*.atlas.json`, a JSON object, at most 2 MB) with exactly
the fields of the contract: `video_id, pipeline_hash, app_version, vehicle, offset_m, t, c, e?, t_start, t_end, cuts, standstills, verdict,
verdict_basis, confidence_mean, coverage, route_km, qc`.

- `t`: video seconds, one per second (the `points` of `route_points.json`, not the 5 Hz GPX raster) from `t_start` to `t_end`, extrapolated
  points left out; `c`: `[[lon, lat]]` on the driving line, 6 decimals; `e`: heights from the current elevation profile (P13/P17) by arc
  length, only when the profile is current and covers every point.
- `cuts`: the scene-cut times inside the span (the atlas allows a position jump only there); `standstills`: `[[t0, t1]]` of the sure standstills.
  A step faster than 252 km/h (`MAX_SPEED_MS`, the atlas's limit, measured on the rounded payload points) with no detected cut within 1 s
  is a cut the scene detection missed: `jumpCuts` adds a cut at the middle of the step, so the atlas accepts the file. The card shows a
  warning with the time, distance and speed of each such jump, to check in the video; a jump that is not a cut is a wrong position there.
- `qc`: `{checks: [{id, ok, blocking, overridden, note, value}], note, checked_by: null}`; the atlas fills `checked_by` from the uploader's identity.

The atlas side (validation, storage, level 2, Prüfmodus, "Route aus video2gpx übernehmen") is described in the plan and in
`pov-atlas/web/README.md`.

## Tests

- `tests/atlas/atlas.test.ts` (`pnpm test:ui`): job → project plan, refused job files, the checklist (green, overrides, coverage, cuts,
  route agreement never blocking), and the payload of a synthetic run (`tests/atlas/example.ts`) equals `tests/atlas/fixtures/result.example.json`.
- `tests/atlas/fixtures/` (`job.example.json`, `result.example.json`) are byte-identical copies of `pov-atlas/web/test/fixtures/video2gpx/`:
  the atlas test checks that its job endpoint serves exactly `job.example.json` and that `result.example.json` is accepted and stored.
  Change both copies together.
- Rust: `atlas::tests` (file name, URL, GPX and JSON checks).
- Mock scenarios: `?mock=atlas` (Export with the card), `atlas-uncertain` (an override needed), `atlas-setup` (a fresh job project without
  a video); "Atlas-Job öffnen …" on the start page of any scenario creates a job project.

## Not verified

- Not run in the real Tauri app: drop of a `.v2g.json` on the window, the native save dialog, the GPX download from a real atlas host and
  the import with a real yt-dlp template. Checked in the browser mock only.
- `pnpm ui-shots` (axe, screenshots) was not run for the new scenarios.
