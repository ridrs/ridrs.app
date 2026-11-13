<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0094: Video Routes Stored as `.ride` Packages, Played from the ZIP

Status: proposed on 2026-11-13. Replaces the unified format of [video-sources.md](../ideas/video-sources.md), section 4 (`route.json`, `video.mp4`, `track.gpx`, `thumbnail.*`), and the unpacking of ADR 0067 and ADR 0090.

## Context

A video route is stored today in ridrs' own unified format: the package is copied into the media storage, unpacked, its video and track renamed, the control file translated into `route.json` and the package deleted. For a 9 GB package that writes 18 GB, needs twice the space while it runs and takes as long again as the copy. The unified format was meant to let several delivery formats meet in one; in practice there is one, Incyclist's `gpx-import`, and `route.json` repeats what its control file says.

What exists, measured on 2026-11-13:

- **Incyclist does not import ZIPs.** It reads a `gpx-import` control file from a folder and plays the video next to it; a ZIP is how packages are passed around, unpacked by the rider (`incyclist/services/src/routes/library/service.ts`, `importRouteFile`; no route code reads a ZIP). Its parser (`services/src/routes/base/parsers/xml.ts`, `incyclist.ts`) reads `name`, `id`, `country`, `title` (a string or one child per language), `description1`, `preview` (a picture next to the control file) and `previewURL`, `video-file-path`, `gpx-file-path`, `framerate`, `start-frame`, `end-frame`, `duration`, `next-video`, `informations/information`, `segments/segment`, `cuts/cut`, `elevation-shift` and `autoCorrect`. It looks up the keys it knows and ignores every other element (xml2js, generic mapping). Without `<preview>` it looks for `preview.png`, `preview.jpg`, `<video>_preview.png` and `<video>_preview.jpg` next to the video.
- **Packages of the Van Gestel catalog:** 22 of 23 ZIPs hold their video deflated, one (`col-de-pennes`) stored; read from the central directories by HTTP range. video2gpx writes the video stored and the text deflated (`video2gpx/src-tauri/src/incyclist.rs`, `write_zip`).
- **A stored ZIP entry is a contiguous run of the file.** The `zip` crate 9.1.0 we use (ADR 0067) gives an entry's compression and the offset of its data (`ZipFile::compression`, `data_start`) and copies an entry without recompressing it (`ZipWriter::raw_copy_file`); writing a stored entry needs no compressor.
- **macOS copies a file within one APFS volume as a clone** (`clonefile`): no bytes are written until one side changes.
- **What ridrs keeps about a route today, and where it comes from:**

  | Data | Kept in | Comes from |
  |---|---|---|
  | title, notes, segments, frame rate, start frame, video and track file | `route.json` | the control file |
  | picture | `thumbnail.*`, `route.json` | the package (`preview.*`), or the catalog |
  | importer and version | `route.json` | the importer |
  | author, source, URL, license | `route.json` (`source`), the catalog | the catalog; none for an own package |
  | distance, ascent, duration, sparkline | `routes.json` of `video-source-local`, the catalog | the GPX track |
  | elevation range, start, bounds, profile, path, climbs | the catalog | the GPX track (`pnpm fetch:video-catalog`) |
  | country, level, track type, bike type, tour, added, page, heading, highlight, description, trailer | the catalog | the source's website |
  | codec, end frame | the catalog | the video, the control file |
  | download URL, size, ETag, entries | the catalog | the source's server |

## Decision

### The format: `.ride` v1

A `.ride` file is a ZIP (ZIP64 where needed) whose files, unpacked into a folder, are an Incyclist `gpx-import` folder: Incyclist imports that folder unchanged. ridrs reads it without unpacking.

- **Required:** one `gpx-import` control file (`*.xml`, UTF-8 or UTF-16 with a byte order mark, as Incyclist reads it), the video it names in `<video-file-path>`, the track it names in `<gpx-file-path>`. Paths are relative to the control file.
- **The video entry is stored** (compression method 0). Other entries may be stored or deflated.
- **Read by ridrs:** everything ridrs reads today (`video-file-path`, `gpx-file-path`, `framerate`, `start-frame`, `informations`, `segments`, `title`), and in addition Incyclist's `name` as the title where there is no `title`, `title` per language, and `preview`. The picture is `<preview>`, or the first of Incyclist's names next to the video. ridrs' own names `thumbnail.png` and `thumbnail.jpg` go: video2gpx writes `preview.jpg` and `<preview>`.
- **Extensions over Incyclist's format: none in v1.** Everything ridrs plays and shows is either in Incyclist's format already (title, picture, notes, segments, frame rate, start and end frame, the next part of a tour) or follows from the track (distance, ascent, duration, profile, climbs, bounds) or the video (codec, length). What remains belongs to a source, not to a package: the catalog's website facts and download data stay in the catalog. Author and license of third-party content are the one candidate; they become an element (`<credits author="" url="" license="" license-url=""/>`, which Incyclist ignores) once a `.ride` with third-party content is passed on outside a source that knows them (rule 3).

### Storage: a folder per route

```text
<media>/videos/<source>/
  routes.json            a cache of the facts from the tracks (local source only), rebuilt when missing
  <route>/
    route.ride           the package, never changed after it is stored
    <path>               optional: a file that replaces or adds the entry <path> of route.ride
```

- **Additions lie unpacked beside the package and count as its entries:** a file whose path, relative to the folder, equals an entry's path (letters compared without case) replaces that entry; any other adds one. A route can thus get a picture, a corrected track or a better control file without its package changing. `route.ride` and `routes.json` are never entries.
- **One Rust module `ride` in `crates/ridrs-media`** knows the overlay: the entries of a route (package and additions), an entry's bytes (whole, for the control file, the track and the picture: at most `MAX_WHOLE`) and the place of a stored entry's data in `route.ride`.
- **`ridrs-media://` serves entries:** the media path `videos/<source>/<route>/<entry>` is an addition where one lies there, else the entry of `route.ride`: a stored entry by range from its offset (the player keeps `httpRangeReader` and ADR 0061), a deflated one whole up to `MAX_WHOLE`, anything else refused. The offer names its entries' URLs by name as before (`availability.files`); the player builds none.
- **One reader of the control file**, moved from `video-import-incyclist` into a package (`@ridrs/ride`: parse the control file, find the picture, inspect peeked entries), used by the sources for their offers and by the video world for the frame rate, start frame and notes. `route.json`, `videoRouteSchema`, `VIDEO_ROUTE_FILE`, `video.importer` and `data.archive` go: no plugin uses them any more.

### Storing a package

- **A package with a stored video is copied**, as `route.ride` into a new folder: on macOS with `clonefile` first (no bytes on the same volume), otherwise in pieces with progress (ADR 0067's channel). Picked and dropped files keep their tokens (ADR 0090, 0093).
- **A package with a deflated video is repacked once:** the video is inflated into a stored entry, every other entry is copied raw (`raw_copy_file`), additions are not merged. The result is `route.ride`; the progress is the video's bytes written. This is the only case that writes the video's bytes again; the original is never changed.
- **A Van Gestel download** lands as `<route>/download.zip.part`, resumable as today, and is then renamed to `route.ride` (stored video) or repacked into it and deleted. Peak space is the package twice while it is repacked.
- **The headless host and the tests** do the same in Node with zip.js (ADR 0065): `data-archive-node` becomes the Node provider of the new operations, and the scenarios' media URLs resolve entries through it.

## Consequences

- An import of a package with a stored video is a copy, on the same APFS volume without bytes; nothing is unpacked, nothing is left behind. Peak space for an own package is once the package (a clone: none), for a repacked one twice the package while it runs.
- Every stored route is still an Incyclist package: unpacked, with its additions copied over its entries, Incyclist imports it. Exporting a route as one `.ride` with its additions merged is a later step.
- The renaming of files, `route.json` and the post-processing per format (video-sources.md, section 5) go. A second delivery format (Tacx RLV, a video with a GPX beside it) becomes a converter into a `.ride`, if a source needs one.
- A route folder holds 1 file instead of 4; additions make enrichment (a picture, a track from video2gpx) a file next to the package.
- The routes on a device in the unified format need a one-time migration into `.ride` packages: control file written from `route.json`, video stored, picture as `preview.*`. On the device of 2026-11-13 these are 8 Van Gestel routes (24 GB); a migration writes each video once, a new download costs the same transfer again.
- `docs/formats/ridrs-ride-v1.md` documents the format, its overlay and its rules for writers (video2gpx).
- Phases:
  1. `@ridrs/ride` (control file, picture, inspection) and the format document; the Rust module `ride` with its tests (entries with overlay, whole entries, offsets of stored entries).
  2. `ridrs-media://` serves entries; the video world reads the control file through `@ridrs/ride` and plays from `route.ride`.
  3. `video-source-local` copies (clone first) or repacks into `<route>/route.ride`; progress in one phase.
  4. `video-source-vangestel` renames or repacks its downloads into `route.ride`.
  5. Migration of routes in the unified format; `route.json`, `video.importer` and `data.archive` are removed.
- Open: whether a `.ride` without stored video is refused or always repacked (this ADR repacks); whether the migration runs on its own at start or by a button.
