# Feature: Incyclist export (ZIP with video, GPX with elevation, metadata)

Status: planned, 2026-11-11. Builds on APP_SPEC.md and PIPELINE_CLI.md (rsm.pipeline, code hash 2295d18afaa78942).

**Implemented 2026-11-11** (steps 1–4 of section 10; pipeline code hash 10881246f17c6bd9): `src-tauri/src/incyclist.rs`, `src/incyclist.ts`, `rsm/pipeline/{export,dem}.py`. Deviations from this plan, with reasons:
- Elevation smoothing: a running lower quantile (25 % over 200 m) and a Gaussian of sigma 60 m instead of the median 25 m + Gaussian 40 m. The DSM only errs upwards (trees, buildings); the median overestimated the ascent by 5–40 % on five Van Gestel tracks (x3 on Roanne). Details and numbers in PIPELINE_CLI.md.
- The ±25 % grade on steep-tagged edges is not done (the road graph carries no incline tag); the clamp is ±18 % everywhere.
- HDR → SDR uses a generated 3D LUT (lut3d), because the Homebrew ffmpeg has no zscale.
- Results made before refine stored `bridge` get their bridges from `map/graph_real.npz` (search road classes only).
- Place names along the route and climbs as `<segments>` are not in v1 (as planned).

## Goal

At the end of a run the user clicks **"Für Incyclist speichern …"** and gets one `.zip` that Incyclist imports as a video route:

- the video, as an MP4 Incyclist can play;
- a GPX with one point per video second, timestamps tied to the video, the camera position on the driving line, and **elevation**;
- the Incyclist control file (XML), plus metadata and attribution.

The same ZIP must also import cleanly into the Ridrs app (plugin `video-import-incyclist`), which reads exactly this format.

## 1. The format (what Incyclist reads)

This is Incyclist's "own video" import, the `gpx-import` control file. Sources:
- the Ridrs importer `ridrs_app/plugins/video-import-incyclist/incyclist.ts`, which parses real community packages (Van Gestel);
- the Incyclist community templates (intervals.icu forum).

```
<Name>.zip
├── <Name>.xml          control file
├── <Name>.mp4          video
├── <Name>.gpx          track: 1 point per second, ele, time
├── <Name>_preview.jpg  optional preview image (or .png): dropped on the Export stage; Incyclist shows it in the route list
├── video2gpx.json      our metadata (Incyclist ignores unknown files)
└── LIESMICH.txt        attribution, licences, how it was made
```

Control file (UTF-8):

```xml
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<gpx-import>
    <name>FR_Col_de_la_Madone</name>
    <id>video2gpx-<16 hex: hash of video file signature + result></id>
    <country>FR</country>
    <title>Route du Col de la Madone</title>
    <video-file-path>FR_Col_de_la_Madone.mp4</video-file-path>
    <gpx-file-path>FR_Col_de_la_Madone.gpx</gpx-file-path>
    <framerate>50.0</framerate>
    <start-frame>1</start-frame>
    <informations>
        <information distance="20" de="Route du Col de la Madone\nLänge: 22,9 km – Anstieg: 980 hm" en="…\nLength: 22.9 km – Ascent: 980 m" />
        <information distance="100" de="Strecke rekonstruiert mit video2gpx\nKarte © OpenStreetMap-Mitwirkende, Höhen © Copernicus DEM" en="…" />
    </informations>
    <segments/>
</gpx-import>
```

- `<id>` must be unique: Incyclist overwrites an earlier import with the same id. It is deterministic per video and result, so re-exporting the same project replaces its own earlier import and nothing else.
- `<country>` comes from the map data: reverse-geocoding the route start through the app's existing Nominatim client, as ISO 3166 alpha-2. The user can edit it.
- `<framerate>` is the exact stream rate from ffprobe (`r_frame_rate`, e.g. 50, 29.97). It is never rounded to 30.
- **Preview image** (optional): a PNG or JPEG dropped on the Incyclist card (or chosen there) is checked by its bytes (at most 20 MB), kept in the project folder as `incyclist_preview.<ext>` and written to the package as `<Name>_preview.<ext>`. Incyclist looks for `preview.png|jpg` or `<video name>_preview.png|jpg` next to the video (incyclist-services, `routes/list/service.ts`, `checkExistingPreviewFiles`); without one it makes its own from the video.
- `<informations>`: a start note (title, length, ascent) and an attribution note. Later, optionally: place names along the route from OSM (`place=*` nearest the path), and climbs as `<segments>`. Neither is in v1.

## 2. The GPX

- **One `trkpt` per video second**, exactly the existing `route_points.json` (t, lat/lon on the driving line, heading, confidence).
- **`time`** = a fixed base + t. Use the start time chosen by the user. If none was set, use `2000-01-01T00:00:00Z`; the Van Gestel packages use `1999-12-31T23:00:00Z`. Incyclist syncs video and track through these timestamps relative to the first point, so:
  - **Trim to the recognised span.** The seconds before the first and after the last decoded second (`extrapolated=true`, position clamped to the route end) are dropped. The first exported second sets `<start-frame>` = round(t_first × fps) + 1. The video is not cut.
  - **No speed spikes.** The smoother output is monotone. Seconds inside long vms gaps (`in_gap`) keep the smoothed position. Incyclist turns speed jumps into slow-motion or fast-forward, so before writing, check that no point-to-point speed exceeds the vehicle's plausible maximum, and spread the excess linearly over the neighbouring seconds if one does.
  - **Standstills** (traffic light) produce several points at the same distance. Incyclist then has no distance for those frames and skips them, which is the desired behaviour on a trainer. They are kept, but at most 1 point per 0.5 m of progress, so the GPX has no exact duplicates.
- **`ele`**: section 3.
- **Extensions:**
  - `<gte:gps speed="…"/>` (km/h) as in the Van Gestel files, which helps Incyclist with playback speed;
  - our own `rsm:conf` (posterior). Unknown extensions are ignored.
- **Metadata:**
  - the name;
  - the description: the driving-line rule, "reconstructed from the video, no GPS", the confidence summary;
  - the copyright: ODbL, OpenStreetMap contributors;
  - the link: the video source if known;
  - `creator="video2gpx <app version> / rsm.pipeline <hash>"`.

## 3. Elevation (new)

**Source:** the Copernicus DEM GLO-30. It is free with attribution, 1° × 1° Cloud-Optimised GeoTIFF tiles (Float32, about 25–60 MB each), with public, account-free download from `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_<N..>_00_<E...>_00_DEM/…tif`. Another project of the maintainer already uses it, with the same attribution text.

**Download in the app (Rust, like the Geofabrik pbf download):**
- the tiles covering the route bbox plus 500 m, usually 1–2 (Madone: N43 E007);
- stored in `~/Library/Application Support/org.video2gpx.app/dem/` and reused;
- with progress, cancel, and a size estimate shown before the download. "Höhendaten" appears in the map-data section of the settings, next to the OSM files.

**Sampling (pipeline, Python, numpy only):**
1. **Minimal COG reader.** Read the TIFF tags, decode the DEFLATE tiles with `zlib`, undo the floating-point predictor (predictor 3: byte de-interleave plus horizontal differencing, about 20 lines of numpy), and use bilinear interpolation. This adds no GDAL or rasterio and keeps the sidecar small. The fallback is `tifffile` if a tile uses something the reader does not support; the reader refuses rather than guessing.
2. **Sample** at the per-second points and on a 5 m grid along the path, for smoothing.
3. **Corrections**, along the path, in metres:
   - **Tunnels and bridges** (OSM `tunnel` / `bridge` on the path; refine already carries `tunnel`, `bridge` is to be added). The DEM shows the mountain or the valley floor there, so interpolate linearly between the portals or abutments.
   - **DSM noise** (trees, buildings, the 30 m grid across hairpins): a robust smoother along the path. Use a median of 25 m, then a Gaussian of about 40 m, then clamp the grade to ±18 % (±25 % on edges tagged steep) by limiting the slope and re-integrating.
   - **Ascent and descent** with a 3 m hysteresis, for the start note and the summary.
4. **Fallback without DEM** (offline or refused download): export without `ele`, with a clear note in the dialog. Incyclist then rides the route flat.

**Quality check (dev):** compare with the Van Gestel GPX elevation for Roanne and Pontaix–Chamaloc (barometric plus GPS). Target: RMS ≤ 5 m, ascent within ±10 %.

## 4. The video

Incyclist plays MP4 in its Electron player. The Van Gestel packages are AV1 in MP4, so Chromium codecs in MP4 work. A fixed ladder:

| Input | Default action | Time |
|---|---|---|
| MP4/MOV with H.264, HEVC or AV1 | copy into the ZIP as is | I/O only |
| WebM/MKV with AV1, VP9, H.264 or HEVC (e.g. Madone: AV1 + Opus in WebM, 9 GB) | remux to MP4: `ffmpeg -c:v copy`, audio to AAC or dropped, `-movflags +faststart` | about 1–3 min for 9 GB |
| other codecs (e.g. ProRes, MPEG-2) | re-encode H.264 or HEVC with VideoToolbox | about real time |

**Options in the dialog:**
- **"Ton weglassen"** (drop audio), on by default: indoor riding needs no engine noise, and it is smaller.
- **"In SDR umwandeln"** (convert to SDR), suggested for HDR (PQ/HLG) because HDR looks pale on most screens. Re-encode with tone-mapping (zscale/tonemap) through VideoToolbox HEVC; it takes about as long as the video.
- **"Auflösung verringern"** (reduce resolution): 4K → 1440p or 1080p. This is a re-encode and it shrinks the file a lot.

Copy and remux keep every frame and its time, so the GPX stays in sync. A re-encode must keep the frame rate (`-fps_mode passthrough`) and the start time (check the first PTS = 0 with ffprobe after encoding).

**Licence:** ffmpeg stays external (PATH or Homebrew) as now. Remux and AAC need no GPL parts. VideoToolbox is the system's encoder (no x264 or x265).

## 5. The ZIP

**Writing:**
- Written in Rust (crate `zip`, ZIP64 on: files over 4 GB, e.g. Madone).
- The video is **stored, not compressed**: video does not compress, and it is fast. The text files are deflated.
- Write to `<dest>.part` and rename at the end, so a cancelled or failed export leaves no broken ZIP.

**Before starting:**
- Check the free disk space against video size + 10 % (+ the size of the remuxed MP4 if a temporary file is needed).
- To avoid the temporary file: pipe ffmpeg's MP4 output into the ZIP entry. MP4 with `faststart` needs a seekable output, so in v1 remux into a temp file in the project folder, and delete it afterwards.

**Alternative in the dialog:** "Als Ordner speichern" (same files, no ZIP), for users who copy into Incyclist's video folder by hand.

## 6. Metadata (`video2gpx.json` and LIESMICH.txt)

**`video2gpx.json`:**
- app and pipeline version (hash);
- input video (name, size, codec, fps, duration, HDR yes/no);
- the export options;
- the verdict and its basis;
- the mean confidence and the share below 0.5;
- the hints used (frames, route hint);
- the vehicle and the driving-line rule;
- f_eff and kappa;
- the local pass, alignment and standstill statistics;
- the DEM tiles used and the elevation corrections (tunnel or bridge metres, clamped metres);
- the start-frame and trimmed seconds;
- the data sources with their licences.

**`LIESMICH.txt`** (German and English):
- what the package is;
- "Position aus dem Video rekonstruiert, kein GPS" (position reconstructed from the video, no GPS);
- the confidence;
- the attribution: OSM ODbL, Copernicus DEM, ffmpeg if re-encoded;
- the note that **the video's rights stay with its author**. Packages made from third-party videos (e.g. YouTube) are for private use only.

## 7. App changes (video2gpx)

**Result panel:** next to "GPX speichern", add **"Für Incyclist speichern …"**.
- It is active once a result exists.
- With the verdict "uncertain" or "no route", ask first: "Die Route ist unsicher. Trotzdem exportieren?" (The route is uncertain. Export anyway?)

**Dialog:**
- **Title.** Prefilled with the cleaned video title (the title-candidate code: tags, emojis and IDs removed).
- **Name.** Used for the file names, ASCII-safe: e.g. `FR_Col_de_la_Madone`.
- **Country.**
- **Elevation.** Status ("Höhendaten vorhanden", or "Download 32 MB nötig" with a button).
- **Video options.** Section 4, each showing an estimated time and size.
- **Target.** ZIP or folder.
- **Estimated size.**

**Progress:** in the run-panel style, with these steps:
1. Höhendaten laden (download elevation data)
2. Höhen berechnen (compute elevation)
3. Video vorbereiten (prepare video: copy, remux or encode, with percent from ffmpeg `-progress`)
4. ZIP schreiben (write ZIP)

There is a cancel button; cancelling kills the process group.

**At the end:** a "Im Finder zeigen" (show in Finder) button, and the summary: length, ascent, size.

**Rust commands:**
- `dem_status(project)`, `dem_download(tiles)`, `dem_cancel()`
- `incyclist_export(project, options, dest)`, which emits progress events
- `incyclist_cancel()`

**Persistence:** the last export options are saved per project in app.json.

## 8. Pipeline changes (rsm.pipeline)

**New subcommand:**

```
python -m rsm.pipeline export --out DIR --dem-dir DIR [--trim auto|off] [--start-time ISO] --dest FILE.gpx --summary FILE.json
```

- It reads the finished result (`refine/result.npz`, `route_points.json`, map flags) and writes the Incyclist GPX with `ele` plus a JSON summary: length, ascent, descent, trimmed seconds, start-frame, elevation corrections, country hint from the bbox.
- **No new checkpoint step.** It is an export, and repeating it is cheap.
- The JSON-lines progress protocol is as for `run`.
- Re-freeze the pipeline (new code hash).

**Refine** stores `bridge` along the path next to `tunnel`. This is small, and the refine checkpoint hash changes.

The video and ZIP stay in Rust, since ffmpeg is already called from Rust and the ZIP crate streams.

## 9. Tests and acceptance

**Unit tests (pipeline):**
- COG reader against a small synthetic GeoTIFF with predictor 3 (written by the test);
- bilinear sampling;
- tunnel and bridge interpolation;
- grade clamp;
- ascent hysteresis;
- trim and start-frame;
- the speed-spike guard;
- the GPX schema (time strictly increasing, one point per second).

**Unit tests (Rust):**
- ZIP64 with a file over 4 GB, using a sparse test file;
- the `.part` rename;
- cancel leaves nothing behind;
- the XML is escaped (titles with `&`, quotes, umlauts).

**Compatibility:** parse the exported control file with the Ridrs importer's `parseControl`. Run it as a test fixture in this repo, not by changing ridrs_app.

**E2E, Roanne** (has GPS and Van Gestel elevation):
- export with copy (MP4 in);
- elevation RMS against the Van Gestel `ele` at most 5 m, ascent within 10 %;
- the ZIP imports into the Ridrs app (manual).

**E2E, Madone:**
- WebM to MP4 remux, 9 GB, ZIP64;
- the "In SDR umwandeln" option on a 2-minute test cut;
- ZIP opens in Finder and imports in Incyclist.

**Manual, by the user, in Incyclist** (this cannot be automated here):
- the import works;
- the video plays (AV1 MP4, HDR and SDR);
- the map position follows the video;
- the elevation profile is plausible;
- a standstill is skipped.

## 10. Order of work and effort (estimate)

1. **Pipeline export:** GPX with trim, speed guard, standstill handling and metadata, without elevation. Plus the Rust ZIP with copy or remux, the button and the dialog. This is already a usable Incyclist package: about 1 day.
2. **Elevation:** DEM download in Rust, COG reader, sampling, corrections, and the Roanne comparison: about 1–1.5 days.
3. **Video options:** SDR conversion and resolution reduction with progress: about 0.5 day.
4. **Finishing:** the informations or notes, LIESMICH, the folder option, and docs (APP_SPEC, PIPELINE_CLI). Then rebuild the sidecar and app: about 0.5 day.

## Open questions (to check in Incyclist itself)

- Does Incyclist play VP9-in-MP4? It is not needed for Madone (AV1), but it matters for other YouTube downloads. If not, re-encode VP9 inputs.
- How does Incyclist treat standstills: does it skip the frames as assumed?
- Does it use `<start-frame>` as Ridrs does? If not, cut the video at the first exported second (a stream copy cut at a keyframe, with the GPX shifted to that keyframe).
- Does it need `<id>` or `<country>` to import, or are they optional?
