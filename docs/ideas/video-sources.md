<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Proposal: Video Sources, Route Offers and Local Media

**Status: proposal of 2026-11-06. Built: the catalog tool (section 6), V1 (route offers on the ride page) and V2 (downloads, headless and native, section 8); the import of own Incyclist packages (ADR 0090).** Everything else is a plan. Each step is taken up with its use case, its Cucumber scenarios and its ADRs (AGENTS.md rules 1, 3 and 9).

The goal: every video ride of [cycling.vangestel.online](https://cycling.vangestel.online/indoor/videos/) shows up on the ride page with its metadata, preview image, altitude profile and credits. A rider can download one, ridrs prepares it, and it plays in the video world. Further sources come as further small plugins.

## Decisions of the maintainer (2026-11-06)

- **Post-processing per package format**, not per source. A source names the format of what it delivers, and an importer plugin for that format turns it into the unified format.
- **Route offers** are the ride page's interface: plugins offer routes as data, and the ride page renders them uniformly.
- **The plugin that offers a route decides whether the route needs a download.** If it does, it has the content fetched and stored on the device. The same flow serves the desktop and the mobile apps.
- **Resumable downloads are a generic data-fetch plugin**, not part of a video library. There is no video library plugin.
- **Commercial use is excluded.** The catalog ships as non-commercial content (LICENSING.md, section 6a; NOTICE).

## 1. Facts (checked on 2026-11-06)

**Today's code**

- `ui-world-video` plays an Incyclist library: one folder per route with the control file (`gpx-import` XML), the GPX track and the MP4. It reads the video by URL with HTTP range requests (`httpRangeReader` in `video-index.ts`). Only the **Vite dev server** serves those URLs, under `/videos/` from `RIDRS_VIDEO_DIR`.
- A UI plugin's context (`UiContext`) has **events only**: no capabilities, no file access. A UI plugin can reach a file only by URL.
- The player derives everything from the GPX track when the ride starts: plausible track (ADR 0063), smoothed video time (ADR 0062), terrain and position. It reads the MP4 sample table wherever `moov` lies (ADR 0061).
- `ui-area-ride` lists placeholder routes (`routes.ts`); **Go** publishes `activity.start-requested` with no world.
- `net.http` returns the body **as text**. It cannot download binary files, let alone 11 GB.
- The UI bridge replays only the **latest envelope per event id** to a new subscriber. If several plugins publish the same event, a page that mounts later sees only the last one.

**The source**

- 23 videos, 66.5 GB in all (0.77–11.2 GB each). 19 are AV1, 4 are H.264. There are 5 tours (series of 3–4 parts).
- The site is static MkDocs HTML with **no API and no feed**: a list table, and one page per video (description, thumbnail, OSM track image, profile image, trailer, ZIP link).
- One ZIP per video. Every entry is **deflated**, the MP4 too, so **the video cannot be streamed or range-read out of the ZIP**. The ZIPs above 4 GB are **ZIP64**.
- nginx serves the ZIPs with range requests (`206`), an `ETag` and `Last-Modified`, so downloads can be resumed and changes can be detected.
- The control files carry more than the player uses today. `<segments>` are named sub-rides with a start and end in metres. `<informations>` are bilingual notes by distance. `<id>` and `<next-video>` chain the parts of a tour. Three control files are **UTF-16 BE with a BOM**, which the player's `loadLibrary` cannot read today.
- In the MP4s `moov` sits **at the end** of the file.
- License: **CC BY-NC-SA 4.0**, by Fred Van Gestel.

## 2. Local playback: what the issue is

Storing a download on the device is not the problem: the source plugin can write files on the desktop and on mobile. The problem is the last step, **playing a stored file**:

- The player is a UI plugin. It runs in the WebView, and its only ways out are events and URLs (section 1).
- An 11 GB video cannot travel over events. The player has to read it by byte range, a few hundred kB per frame group, from wherever it lies.
- Today those ranges come from `http://localhost:…/videos/…`, which **only the Vite dev server answers**. A built app (macOS, Windows, Android, iOS) has no such server. A downloaded video would sit on the disk, and the player would have no URL for it.

**The fix is small:** the media storage gives each stored file a URL that the WebView can read by range.

- Tauri's built-in **asset protocol** (`convertFileSrc`, scoped to the media directory) serves local files to the WebView and answers range requests. It needs no own Rust code.
- If it falls short on a platform (Android's WebView handled ranges badly in the past), a **custom URI scheme** `ridrs-media://` (`register_asynchronous_uri_scheme_protocol`) serves the same files with ranges in about 50 lines of Rust.
- The route offer and `route.json` carry that URL. The player keeps `httpRangeReader(url)` unchanged, and thumbnails work the same way in an `<img>`.
- Spike first: measure range reads of a 1080p AV1 route on a Pixel 8 and on macOS through the asset protocol (needed: about 1–5 MB/s with low latency per range).

## 3. Plugins and contracts

Since ADR 0068 (app state and services beside the bus) offers are app state, not events: every provider owns the keys of its offers in the topic `route.offer`, and Download and Remove are the services `route.fetch` and `route.remove`, routed to the offer's owner. `route-catalog`, the `route.offers` capability and the `route.*` events are gone.

```text
                   app state route.offer (one key per offer)
ui-landscape-demo ──┐
video-source-…   ───┼── ctx.state.set ──► route.offer ── ctx.state.watch ──► ui-area-ride ── Go ──► activity.start-requested
(later: others)  ───┘                                                        │                    { world: { landscape, route } }
                                                                             └── ctx.call route.fetch / route.remove { key }
video-source-vangestel                                                            (to the owner of the key)
  │ owns its offers' keys; provides route.fetch and route.remove:
  ├──► data.fetch      (data-fetch-tauri)        resumable download into media storage
  ├──► data.archive    (data-archive-tauri)      streamed extraction, where the format needs it
  ├──► video.importer  (video-import-incyclist)  format → unified format, chosen by the offer's format
  └──► storage.media   (storage-media-tauri)     where media lives; a range-readable URL per file
                                                       ▲
ui-world-video (player) ── watches its route's key of route.offer, reads route.json and video.mp4 by URL ─┘
```

| Plugin | Type | Size | Job |
|---|---|---|---|
| `video-source-vangestel` | transport | tiny | Offers the shipped catalog as keys of `route.offer`. Decides per route whether a download is needed (always, for this source). `route.fetch` answers once the download started (or rejects with the reason it cannot start) and runs fetch → import; each change of an offer's availability is one key. `route.remove` answers once the route is gone. |
| `data-fetch-tauri` | transport | small + Rust | Provides `data.fetch`: a URL into a media path, in Rust, with resume (`Range` + `If-Range` on the ETag), progress, cancel and a free-space check. Jobs survive a restart. Knows nothing about videos. Headless tests use `data-fetch-node`. |
| `data-archive-tauri` | transport | small + Rust | Provides `data.archive`: extracts a ZIP (ZIP64, streamed) into a media folder. |
| `video-import-incyclist` | transport | small | Provides `video.importer` for the format `incyclist-gpx-import`. Reads the control file by its BOM, checks the GPX with `plausibleTrack` and writes `route.json`. |
| `storage-media-tauri` | storage | small | Provides `storage.media`: the media root (app data by default) and a range-readable URL per file (section 2). Large files only; `storage.app-files` stays for small documents. |
| `ui-area-ride` | ui | — | Watches `route.offer` (by provider, then title); publishes `activity.start-requested { world }`; calls `route.fetch` and `route.remove` and shows a refusal's reason. |
| `ui-world-video` | ui | — | Reads `route.json` instead of Incyclist files; watches `route.offer` and loads its route again only when that route's key changes. Incyclist knowledge moves to the importer. |

What a second source repeats (listing offers, tracking availability, fetch then import) goes into a shared package `@ridrs/video-source`, as `@ridrs/metric-source` does for the metric plugins. A source plugin stays at its catalog, a URL function and its format's name. The generic data plugins (`data.fetch`, `data.archive`) also serve later non-video content: map tiles, workout libraries, firmware.

**`RouteOffer`** (contract, Apache-2.0), the ride page's unit:

```ts
interface RouteOffer {
  id: string;                    // '<provider>/<route>', e.g. 'vangestel/col-de-pennes'
  kind: 'world' | 'video';
  title: string;
  distance: number; ascent: number; duration?: number;   // m, m, s
  sparkline?: readonly number[];                          // elevations, evenly spaced
  thumbnail?: string;                                     // URL the UI may load
  tags: { country?: string; level?: string; tour?: { name: string; part: number } };
  credits: { author: string; source: string; url: string; license: string };
  availability:
    | { state: 'ready' }
    | { state: 'fetchable'; size: number }
    | { state: 'fetching'; received: number; size: number }
    | { state: 'unsupported'; reason: string }              // e.g. AV1 on a device without a decoder
    | { state: 'failed'; reason: string };
  world: { landscape: string; route: string };            // what Go puts into activity.start-requested
}
```

A built-in world is always `ready`. A video source's offer is `fetchable` until its route is stored. Credits are a required field: the ride page shows them on the card, and the video world shows them at the start of the ride.

## 4. The unified format: ridrs video route v1

```text
<media>/videos/<source>/<route>/
  route.json      the contract (zod schema in @ridrs/contracts, documented in docs/formats/)
  video.mp4       H.264 or AV1, as delivered; moov anywhere
  track.gpx       the original track, unchanged
  thumbnail.jpg   optional
```

`route.json` holds:
- `format`, `version`, `id`, `title`, `description`;
- `source`: id, name, url, author, license;
- `distance`, `ascent`;
- `notes[]`: distance, text by language;
- `segments[]`: name, start, end;
- `video`: file, codec, framerate, startFrame, endFrame;
- `track`: file;
- `imported`: the importer plugin's id and version, and the source ETag.

Choices:

- **Keep the original GPX and derive the track at ride start**, as today. A better algorithm (ADRs 0062, 0063) then reaches every stored route without a re-import.
- **No transcode by default.** Before offering a download, the source checks `VideoDecoder.isConfigSupported` for the codec. Where AV1 cannot be decoded, the offer is `unsupported`. A transcode to H.264 needs FFmpeg and its own licensing review, so it would be a separate optional native plugin.
- **No faststart rewrite.** The player finds `moov` anywhere (ADR 0061).
- **Disk space:** a deflated ZIP cannot be played in place. The ZIP is downloaded resumably, extracted as a stream, then deleted. Peak space is about twice the video, and `data.fetch` checks for it before it starts.

## 5. Post-processing per format

| Format | Delivered as | Importer steps |
|---|---|---|
| `incyclist-gpx-import` | ZIP: control XML, GPX, MP4 | `data.archive` extract → decode control file by BOM → read title, frame rate, start frame, notes, segments, tour chain → check GPX → write `route.json`, rename to `video.mp4` and `track.gpx` |
| `incyclist-gpx-import-folder` | the same files in a folder (today's `RIDRS_VIDEO_DIR`) | the same steps without extraction |
| *(later)* | e.g. Tacx RLV, MP4 + GPX pairs | one importer each, when a source needs it |

A new source with a known format adds no post-processing at all.

## 6. Built: the catalog tool

`pnpm fetch:video-catalog [--out <folder>] [--only <route id> …]` (`scripts/fetch-video-catalog.ts`, [ADR 0065](../decisions/0065-zip-entries-by-http-range-zip-js.md)):

1. reads the site's list and tour tables and each video page (`happy-dom`);
2. reads each ZIP's central directory and its XML and GPX entries by range (zip.js; ZIP64 and UTF-16 handled), about 40 kB per route instead of the videos' 66.5 GB;
3. runs the GPX through the player's own `plausibleTrack` and computes length, ascent, elevation range, start, bounds, a 64-point sparkline, and a profile and path every 100 m;
4. writes `plugins/video-source-vangestel/catalog/index.json` (the list, 61 kB), `<id>/route.json` (detail, about 25 kB each) and `<id>/thumbnail.jpg` (about 270 kB each; 6.3 MB in all).

It sends requests one at a time with a pause and an identifying User-Agent. It does not ship the OSM track images (ODbL) or the site's profile images; ridrs draws its own. Unchanged sources give byte-identical files. Lengths match the site within about 0.5 %. Ascents match within about 5 %, except Valdrôme 3 (82 m against 136 m) and Col de Pennes (1216 m against 1177 m). ridrs computes ascent the same way for every source, and the site's figures stay in `stated`.

## 7. Licensing

- The catalog is CC BY-NC-SA 4.0 and ships as non-commercial content: `catalog/README.md`, NOTICE, LICENSING.md section 6a.
- Downloaded videos stay on the rider's device and come from their origin. ridrs never mirrors or re-hosts them.
- The credits in every route offer and at the start of a ride satisfy the attribution.
- Worth asking Fred Van Gestel anyway: he may welcome being listed, and a JSON feed on his site would replace the HTML scraping.

## 8. Steps

1. **V0 (done):** the catalog tool, the shipped catalog, the `video-source-vangestel` skeleton, the licensing update.
2. **V1, list (done):** `RouteOffer`, `route.offers` (`packages/contracts/src/route.ts`) and the aggregator `route-catalog`. `ui-landscape-demo` offers the demo course and `video-source-vangestel` its 23 routes as `fetchable`; the ride page lists, filters and starts them, and Today's "Ride again" uses them. The placeholder routes are gone from the ride page (Search and Events still show their own placeholders). Scenarios: `tests/features/ui/route-offers.feature`. V1 has only the states `ready` and `fetchable`, and providers' offers are read once at start; changing offers come with V2.
3. **Spike, local playback:** asset protocol range reads on macOS and on a Pixel 8 (section 2).
4. **V2a, fetch and ride, headless (done):**
   - Contracts: `storage.media` (`MediaFiles`), `data.fetch` and `data.archive` (`data.ts`), `video.importer` and the unified format `route.json` (`video.ts`), and the offer states `fetching` and `failed`, `ready` with `content` and `removable`, and the events `route.fetch-requested`, `route.remove-requested` and `route.offers-changed` (`route.ts`).
   - Node providers: `storage-media-node`, `data-fetch-node` (resumable with `Range` + `If-Range`; unit-tested against a local server that breaks off) and `data-archive-node` (zip.js, streamed).
   - `video-import-incyclist` (format `incyclist-gpx-import`, ADR 0066). `video-source-vangestel` fetches, imports, keeps, finds again after a restart and removes its routes; `route-catalog` merges anew on `route.offers-changed`.
   - The ride page: Download, progress, failure with its reason, Remove from this device. The video world plays a downloaded route from its `route.json`.
   - Scenarios: `tests/features/ui/video-downloads.feature`; the downloads are simulated there, everything after them is real.
   - The native app bundles none of the Node providers and does not start the importer yet: a download there fails with "This app cannot download routes yet".
5. **V2b, native (built, not yet tried on a device):** `crates/ridrs-media` with the app's `media_*` commands; `storage-media-tauri` (media in the app data directory, URLs through the app's own `ridrs-media://` scheme; Tauri's asset protocol failed, see ADR 0067), `data-fetch-tauri` and `data-archive-tauri`; the importer runs in the app ([ADR 0067](../decisions/0067-native-media-downloads-and-archives.md)). Still open: a download and a ride in the running app on macOS, then on Android and iOS (step 3).
6. **App state and services (ADR 0068, 2026-11-07):** offers moved to the app state `route.offer`, Download and Remove to the services `route.fetch` and `route.remove` (section 3). `route-catalog`, `route.offers`, `route.catalog-changed`, `route.offers-changed`, `route.fetch-requested` and `route.remove-requested` are gone; a download that cannot start says why at once, a download's progress changes one offer, and a download during a ride leaves no trace in its journal. Scenarios: `route-offers.feature` ("A download that cannot start says why"), `video-downloads.feature` ("Progress changes only the downloading route").
7. **V3:** today's `RIDRS_VIDEO_DIR` folder as a second provider through `incyclist-gpx-import-folder`. This is the first proof that importers are bound to formats, not sources.
8. **Cancel (2026-11-07):** the service `route.cancel` stops a download on its way (`VideoDownloads.cancel` aborts `data.fetch`; the part stays for the next download; an import already running finishes). Headless scenarios: `tests/features/world/cancel-a-download.feature`. On the ride page: **Cancel download** in the route details while a download is on its way, and on every route card that is not ready a Download or Cancel button beside the badge with its size or progress (`ui-area-ride`; scenarios in `tests/features/ui/video-downloads.feature`). A refused call from a card says why in the badge's place.
9. **V4, a second remote source:** only then extract `@ridrs/video-source` from what the two have in common.

## Open questions

1. Where does large media live by default: the app data directory, or a folder the rider chooses (an SD card on Android, an external disk)? On Android a chosen folder needs the Storage Access Framework.
2. Should segments become separate offers on the ride page ("Col de Pennes, second climb"), or be chosen in the route's details?
3. Tours: offer "ride the whole tour" (the `next-video` chain) now, or later?
4. Should the source refresh its catalog at runtime (the same range reads work in the WebView), or only with app updates?
