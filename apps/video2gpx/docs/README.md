# video2gpx: documentation index

Everything about the product, the project and the research is in this folder (`apps/video2gpx/` of the ridrs repository). It is a standalone app with its own build; it is not part of the pnpm workspace.

## Folder layout

```
apps/video2gpx/                    the product: Tauri app for macOS, runs on Linux (standalone build)
├── README.md                      app overview, setup, development, build, tests, architecture
├── PACKAGING.md                   bundled pipeline (PyInstaller sidecar), ffmpeg, size, signing
├── docs/
│   ├── README.md                  this index
│   ├── DECISIONS.md               every product and technical decision, with the reason
│   ├── HISTORY.md                 how we got here: research arc, results, background, open items
│   ├── FEATURE_area_hints.md      search frame, start/end frame, route hint (implemented)
│   ├── FEATURE_incyclist_export.md  Incyclist export plan (implemented; deviations noted inside)
│   ├── FEATURE_ui_redesign.md     UI redesign (stages, design system, mock scenarios)
│   ├── FEATURE_analysis_insight.md the Analyse stage (Part A implemented; choices in "Implementation notes (Part A)"; Part B live preview planned)
│   ├── FEATURE_elevation_stage.md elevation as its own stage "Höhe" (implemented; choices in "Implementation notes")
│   ├── FEATURE_atlas.md           POV Drive Atlas round trip: job file in, checklist "Atlas", <id>.atlas.json out (implemented, P21)
│   ├── CONCEPT_fast_testing.md    step cache, scan memo, probes, clip bench (built 2026-11-13)
│   ├── CONCEPT_test_strategy.md   clips for the image analysis, frozen stages for the route, two 10 min videos (concept)
│   ├── BAVARIA_DIAGNOSIS.md       why the Bavaria video failed; fixes F1-F5
│   ├── ELEVATION_ANALYSIS.md, DEM_STUDY.md  elevation noise root cause; better elevation models
│   ├── ELEVATION_STRATEGY.md      regional DEM sources (registry, licences) and the robust road-height estimator (P17)
│   └── screenshots/
├── src/, src-tauri/, scripts/     app code (scripts/guard.sh = memory guard, scripts/build-sidecar.sh)
└── research/
    ├── route-shape-matching/      the research package `rsm` and the frozen pipeline `rsm.pipeline`
    │   ├── README.md              research overview and how to run
    │   ├── PROPOSAL.md            original research proposal
    │   ├── FINDINGS.md            chronological lab notebook: every experiment, number and verdict
    │   ├── APP_SPEC.md            product spec of the app (UI, steps, statuses, decisions §8, later sections)
    │   ├── PIPELINE_CLI.md        the pipeline CLI contract (run, retime, export, profile; JSON-lines events)
    │   ├── rsm/, tests/, tools/   code, tests, tools/memguard.py
    │   └── work/                  NOT in git: video-derived outputs, caches, test runs (about 7 GB)
    ├── road-reconstruction/       optional, not in this repository: COLMAP route experiments (linked here locally)
    └── video-motion-speed/        optional, not in this repository: origin of the vms motion code, vendored as rsm/pipeline/vmsx
```

Some research code reads the two optional folders by relative path (`../road-reconstruction/...`); the pipeline and the app do not need them.

## Where things live outside the repository

| What | Where |
|---|---|
| App data: projects, settings, OSM pbf, DEM tiles, cache | `~/Library/Application Support/org.video2gpx.app/` (`projects/`, `settings.json`, `osm/`, `dem/`, `cache/`) |
| Release app | `src-tauri/target/release/bundle/macos/video2gpx.app` (ad-hoc signed, not notarised) |
| Test material (git-ignored `test-data/` in this app; Van Gestel material is CC BY-NC-SA, the other videos are third-party downloads for private use) | `sources/` all full videos, one folder per source with a `source.json` (origin, licence, truth): `sources/vangestel/<route>/` the Van Gestel rides (`video.mp4`, `track.gpx`), a copy of the Ridrs Van Gestel source folder, and `sources/<id>/video.<ext>` for Gotthard, Cayolle, Madone, Amalfi, Bavaria, Nice-Monaco, Verdon (2), Switzerland valley (`$RSM_VIDEOS` defaults to `sources/`; the bench reads paths from `rsm/bench/regress_cases.json` and `clip_sources.json`, `~`, `$V2G_TEST_DATA` and `$RSM_VIDEOS` are expanded); see [CONCEPT_test_strategy.md](CONCEPT_test_strategy.md); `osm/rhone-alpes.osm.pbf`; `runs/vallee-de-roanne/` a finished pipeline run; `dem/` Copernicus and regional DEM tiles; `road-reconstruction/routes/` camera poses of Pennes and Menglonnais. The tests and the benches read it by default; the GPX of the realdata tests come from `plugins/video-source-vangestel/catalog/` |
| OSM extracts | `~/Library/Application Support/org.video2gpx.app/osm/` (downloaded by the app from Geofabrik) |

Fill `test-data/` before running the e2e and realdata tests (APFS clones with `cp -c` cost no disk space). No videos, GPS tracks or video-derived data are committed; `test-data/` and `research/*/work/` are git-ignored.

## Rules for working here

- **Heavy jobs:** run them through `scripts/heavy.sh` (machine-wide lock plus `scripts/guard.sh`), one at a time.
- **Memory.** Large map builds can exhaust the memory of a laptop. Run every heavy job through `scripts/guard.sh`, which kills the process group above 12 GB or below 25 % free. Use at most 4 workers, and run only one heavy job at a time.
- **Never commit video-derived data.** Frames, tracks and runs go to `research/*/work/`, which git ignores.
- **Rebuilding the app** replaces the running binary. Build only when the app is closed (`pgrep -x video2gpx`). The order is `scripts/guard.sh scripts/build-sidecar.sh`, then `scripts/guard.sh pnpm tauri build --config src-tauri/tauri.sidecar.conf.json`.
- **Changing pipeline code.**
  1. Back up the edited files to `research/route-shape-matching/work/pipeline_backup_<date>_<topic>/`.
  2. Add tests to `tests/test_pipeline.py` and run `.venv/bin/python -m pytest -q tests/`.
  3. Re-freeze with `.venv/bin/python -m rsm.pipeline.freeze`, which writes the code hash shown in the app.
  4. Update `PIPELINE_CLI.md`.
