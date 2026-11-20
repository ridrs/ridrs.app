# video2gpx (Beta)

A desktop app (Tauri 2) for macOS, also runnable on Linux ([see below](#linux)), that turns a **road video without GPS** into a **GPX file whose timestamps match the video**.
It packages the research pipeline `rsm.pipeline` of `research/route-shape-matching` (see its `APP_SPEC.md` and
`PIPELINE_CLI.md`). The UI is in German. Matching is offline; only the map display (OSM raster tiles), the place search
(Nominatim) and the optional map download (Geofabrik) use the network, each only on the user's action.

Status: **beta**. The pipeline is bundled as a PyInstaller sidecar (default; see [PACKAGING.md](PACKAGING.md)); "Entwicklermodus"
runs the research venv instead. Features since M1: area hints, local pass, timing fixes, Incyclist export, elevation profile.

## Repository layout and documentation

This repository holds the product, the project and the research: the app (`src/`, `src-tauri/`), the research package and
frozen pipeline (`research/route-shape-matching/`), and the documentation. Start with **[docs/README.md](docs/README.md)**
(layout, where data lives, working rules), then [docs/DECISIONS.md](docs/DECISIONS.md) (all decisions with reasons) and
[docs/HISTORY.md](docs/HISTORY.md) (research arc, results, open items).

## What it does

| Area | Behaviour |
|---|---|
| Workflow | Start (one field for a URL or a path, file picker, drop, recent projects) → per project six stages **Einrichten · Berechnung · Ergebnis · Analyse · Höhe · Export**, plus the views Werkzeuge (first run: ffmpeg/ffprobe/yt-dlp with the `brew install` line), Kartendaten and Einstellungen. Hash routes, keyboard usable throughout, light and dark. See [docs/FEATURE_ui_redesign.md](docs/FEATURE_ui_redesign.md) and `docs/screenshots/`. |
| Projects | A project is a folder in the app data dir (`~/Library/Application Support/org.video2gpx.app/projects/<id>/`): `app.json`, `import/` (import folder), `out/` (`--out` of the pipeline), `events.jsonl` (last run), `poster.jpg`, `frames/` (fallback). Recent projects are listed on the start page ("Alle Projekte" expands the list). |
| Import | File picker, drag and drop (the video stays where it is, nothing is copied), or an **import template** (a command with `{input}` and `{out}`, run without a shell; APP_SPEC 8.2, DECISIONS P2): runs only on the click, shows the exact command, `OUT` = import folder, live log, cancel (kills the process group), accepts exactly one new video file. One neutral example (`cp`) is shipped, no downloader template. |
| Video panel | HTML5 player on the local file through Tauri's asset protocol, with the pipeline-independent preview frame (ffmpeg). If the web view cannot play the format (e.g. VP9 in mkv, some HDR), a clear message appears and ffmpeg-extracted frames (every 5 s) are used instead; map sync keeps working. |
| Map panel | Leaflet, OSM raster tiles, attribution "© OpenStreetMap contributors (ODbL)". Place search via Nominatim (only on click, max. 1 request/s, policy shown). The first section is suggested from the video title (blind-test rule: whole title, then fragments, prefer hits with local map data). **The search area is a frame the user draws** (blue; move, resize with the corners, ✕ deletes; "Sichtbaren Ausschnitt" takes the view), its size is shown and coverage / size warnings refer to it. Optional **start frame** (green) and **end frame** (red) inside it, and an optional **route hint** (.gpx / .kml, dashed purple, corridor 100 m to 2 km) that limits the roads; a poor corridor result is retried by the pipeline on the whole frame. Legend under the map. See [docs/FEATURE_area_hints.md](docs/FEATURE_area_hints.md); screenshots `04-setup.jpg`, `05-setup-hints.jpg`. |
| Map data | List of local `.osm.pbf` files (app data dir, plus "add existing file" which links in place, never copies), the local extract covering the current bbox (header bbox), and "download from Geofabrik": loads `index-v1.json`, picks the smallest region whose polygon contains the bbox, shows name and size (HEAD), downloads with progress and cancel only after the click. |
| Run | Start, vehicle (auto/bike/motorcycle/car), driving-line offset (empty = pipeline default), start time (optional), optional decoy test (0/3/19), cancel, resume (`--resume`). Vertical step list (several steps can run at once), overall bar and ETA, a "Video laden" row when the run was started during an import (it begins when the import ends, DECISIONS E8), signals from the `status` events, end states with an action per exit code. The run goes on when the project is left (activity chip in the bar). |
| Result | Verdict (with "ohne Täuschungstest" when no decoys ran), route coloured by per-point confidence, video and map synchronised (marker with heading arrow; click on the route seeks the video), one timeline with the confidence strip and the elevation profile of the whole route (a keyboard slider), accuracy note. Analyse stage: why weak stretches are weak (video overlay of the tracked points, curvature of the video against the map, rotation, speed, quality, the causes per stretch). Höhe stage: the sources of the elevation data with the download, the profile over the whole route (zoom, layers, hover, click) and its key figures. Export stage: GPX to a chosen place, Incyclist package, start time via `rsm.pipeline retime` without recompute. |
| POV Drive Atlas | A job file `<id>.v2g.json` from the atlas admin (drop or "Atlas-Job öffnen …") creates a project with the job's address, search frame, start/end frame, the atlas route as the route hint and the vehicle; the video comes through the user's own import template. The Export stage then has a card **"Atlas"** with a checklist (each item green or overridden with a note) and writes `<id>.atlas.json` for the upload in the atlas admin. See [docs/FEATURE_atlas.md](docs/FEATURE_atlas.md). |
| Settings | The **pipeline bundled in the app (sidecar) runs by default**; Settings show its version (frozen code hash) and the result stores it (`pipeline_hash`). **"Entwicklermodus: externes Python"** (badge "Entwicklermodus" in the header) switches to the research `.venv` (interpreter, pipeline folder, optional other sidecar). Existing settings without the switch use the bundled pipeline. ffmpeg/ffprobe (default: PATH and Homebrew; **ffmpeg is not bundled yet**), online title lookup on/off. Clear errors if the bundled pipeline, ffmpeg are missing. |

## Setup

Requirements: macOS 11+, Rust (rustup), Node 20+, pnpm, and for the pipeline the research environment
(`research/route-shape-matching/.venv`, Python 3.14) plus `ffmpeg`/`ffprobe` (`brew install ffmpeg`).

```sh
pnpm install
```

## Linux

The app runs on Linux in developer mode: the pipeline runs from the research venv, not the bundled sidecar (the sidecar build
script is macOS only). Tested on Ubuntu 26.04 (x86_64, X11, WebKitGTK 2.52) from a fresh clone.

```sh
# 1. System libraries for Tauri (WebKitGTK) and GStreamer plugins for the video panel (Debian/Ubuntu names)
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libxdo-dev gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav ffmpeg python3.14-venv
# 2. Rust and pnpm (no sudo)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"
npm install -g --prefix ~/.local pnpm@10        # ~/.local/bin must be on PATH
# 3. Start (from apps/video2gpx): creates research/route-shape-matching/.venv on the first run, turns developer mode on
./dev.sh
```

- The first start compiles the Rust side (about 4 minutes); later starts take seconds.
- Settings and projects live in `~/.local/share/org.video2gpx.app/` (on the Mac: `~/Library/Application Support/org.video2gpx.app/`).
- Another Python 3.14 than `python3.14` on the PATH: `PYTHON=/path/to/python3.14 ./dev.sh`.
- yt-dlp is optional; a current one comes from `pipx install yt-dlp` (`~/.local/bin` is searched).
- "Im Dateimanager zeigen" selects the file through the freedesktop `FileManager1` D-Bus interface (Nautilus, Dolphin, Thunar, ...)
  and otherwise opens its folder with `xdg-open`.
- `libEGL warning: ... Permission denied` on a remote desktop or VM without GPU access is harmless: WebKitGTK renders in software.
  If the window stays blank or white, start with `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./dev.sh`.
- The UI unit tests (`pnpm test:ui`) need Node 22.18 or newer (type stripping); the app itself runs with Node 20.
- Not done on Linux: a packaged build with the bundled sidecar (`.deb`/AppImage) and the memory guard `scripts/guard.sh`.

## Development

```sh
pnpm dev                 # Vite on http://127.0.0.1:1450 (browser, mocked Tauri layer, see below)
pnpm tauri dev           # the real app with the Rust command layer
```

Heavy commands (cargo builds, pnpm installs/builds, pipeline runs) go through the memory guard on this machine:

```sh
scripts/guard.sh pnpm install
scripts/guard.sh pnpm build
scripts/guard.sh pnpm tauri build --debug
```

`scripts/guard.sh` wraps `research/route-shape-matching/tools/memguard.py --max-gb 12 --min-free 25` and sets
`CARGO_BUILD_JOBS=4`.

### Browser preview with a mocked Tauri layer

Outside Tauri, `src/api.ts` loads `src/mock/index.ts` (same interface as `src/tauri.ts`), with a synthetic route and a tiny
test video (`public/mock/`, removed from the production build). `?mock=<scenario>` picks the state, the hash picks the view
(`?mock=result#/p/demo-1/export`); `&theme=light|dark`, `&freeze=1` (deterministic), `&at=<pct>`, `&dem=missing`,
`&total=unknown`, `&video=webm`, `&hint=kml`. Scenarios (`src/mock/scenarios.ts`): `start`, `recent`, `notemplate`, `tools`,
`tools-ytdlp`, `tools-nopipeline`, `import`, `import-error`, `templates`, `dev`, `project`, `fresh`, `nosuggest`, `noframe`,
`nomap`, `novideo`, `videomissing`, `offline`, `mapdata`, `frames`, `running`, `running-start`, `running-parallel`,
`running-stream`, `cancelled`, `failed`, `result`, `uncertain`, `noroute`, `difficult`, `hints`, `result-frames`, `export`,
`export-uncertain`, `export-running`, `export-done`, `atlas`, `atlas-uncertain`, `atlas-setup`, `selfcheck` (aliases `empty`, `noenv`).

```sh
pnpm ui-shots            # every scenario light and dark (+ 900 × 640 subset): screenshots, axe WCAG 2.1 AA, console errors,
                         # overflow, self-check, focus checks; needs `pnpm dev` and Google Chrome (playwright-core, axe-core)
pnpm ui-shots -- --list  # the URLs, for checking by hand
```

Shots go to `research/route-shape-matching/work/ui-shots/` (git-ignored); a selection is in `docs/screenshots/`.

## Build

```sh
scripts/guard.sh pnpm build                       # frontend (tsc + vite)
scripts/guard.sh cargo build --manifest-path src-tauri/Cargo.toml
scripts/guard.sh pnpm tauri build --debug         # debug .app: src-tauri/target/debug/bundle/macos/video2gpx.app (ad-hoc signed)
```

### Tests

```sh
# End to end through the Rust command layer, against the real pipeline (needs the research venv, ffmpeg, the Roanne video and
# the rhone-alpes extract; paths at the top of src-tauri/tests/e2e.rs). Network tests use Geofabrik and Nominatim once.
scripts/guard.sh cargo test --manifest-path src-tauri/Cargo.toml --test e2e -- --ignored --nocapture --test-threads=1
```

## Architecture

```
src/                      TypeScript frontend (Vite, no framework; Leaflet), see docs/FEATURE_ui_redesign.md
  main.ts                 boot: api, shell, views, event wiring, router
  app/                    router (hash routes), shell (bar, stages, activity chips, toasts, live region), project, theme
  features/               import (classifySource, templates, import state), run (checklist, start/cancel/resume), gloss (texts)
  views/                  start, tools, setup, run, result, export, maps, settings, importDetails
  ui/                     tokens/base/components/layout/views CSS, components.ts, icons.ts, dialog.ts
  mapPanel.ts frames.ts hint.ts      Leaflet map, frame editing (mouse and keyboard), route hints
  videoPanel.ts ridePanel.ts         player (HTML5 or ffmpeg-frame fallback), readouts, elevation data
  incyclist.ts            Incyclist export card
  atlas.ts                POV Drive Atlas: job file -> project hints, the "Atlas" checklist, the <id>.atlas.json payload (pure; views/atlasCard.ts, features/atlasJob.ts)
  state.ts                store, event bus, run-event reducer (parallel steps, input events)
  api.ts / tauri.ts / mock/          command interface; real (invoke/listen) and mock implementation with scenarios
src-tauri/src/            Rust command layer (independent of Tauri apart from lib.rs)
  ctx.rs                  data dir, event emitter closure, running-process state
  settings.rs             settings.json (incl. the user's import templates), tool lookup `find_tool` for ffmpeg/ffprobe (required)
                          and yt-dlp (optional, never bundled): setting, PATH, Homebrew, /usr/local, MacPorts, ~/.local/bin, then
                          the login shell (`command -v`); versions cached per file
  projects.rs             project folders, events, result loading, GPX export
  pipeline.rs             env check (tools with versions, `ytdlp`, `brew`; Python only in developer mode), `rsm.pipeline run/retime`
                          child process, JSON-lines parsing, cancel, `follow_import` (a run that waits for the running import)
  import.rs               import by template: split into words without a shell, `{input}`/`{url}`/`{path}`/`{out}` filled in after
                          the split, validation, exact argument preview, progress parser (yt-dlp, percent, file size), cancel
  pbf.rs                  .osm.pbf header bbox (own protobuf reader), local list/link, Geofabrik index, download
  geo.rs                  Nominatim (1 req/s) and the title-based suggestion
  atlas.rs                POV Drive Atlas: read a .v2g.json job, download its route as the hint, write <id>.atlas.json
  video.rs                ffprobe, preview frame, fallback frames
  proc.rs                 process groups (`process_group(0)`, `killpg`)
  lib.rs                  Tauri commands and setup
```

The pipeline is called as
`python -m rsm.pipeline run --video V --bbox S,W,N,E --pbf P --out <project>/out [--vehicle …] [--offset-m …] [--start-time …] [--decoys N] [--resume]`
with `cwd` and `PYTHONPATH` = the pipeline folder, `RSM_DATA_DIR` = `<app data>/cache`, `RSM_FFMPEG`/`RSM_FFPROBE` resolved from
settings, PATH or Homebrew, `PYTHONDONTWRITEBYTECODE=1`. Every stdout line is JSON; the events go to the UI (`pipeline-event`) and
to `events.jsonl`, so a reopened project shows the last run's steps and status lights. The child is a process group leader:
cancel sends SIGTERM to the group (the pipeline stops its step and exits 130), SIGKILL after 15 s.

Security: the web view reads only files the app allows at run time through the asset protocol scope (the project's video, poster
and frames); native dialogs and Rust commands do the rest. An import template is split into words by quoting rules and started directly, without a shell, only after the
user's click (`import.rs`); the working directory and `$OUT` are the project's import folder. A DMG is built by adding the overlay
`--config src-tauri/tauri.dmg.conf.json` to the build command (after the sidecar overlay). CSP allows images from the OSM tile servers only.
