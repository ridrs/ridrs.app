<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0090: Own Video Packages, Picked in Rust and Offered by a Local Source

Status: proposed on 2026-11-12 ([video-sources.md](../ideas/video-sources.md), sections 3 to 5).

## Context

Riders want to ride their own routes: Incyclist packages (a ZIP with the video, its GPX track and the control file) from other sources or made by themselves. The import of the format exists (`video-import-incyclist`, `video.importer`), but only for packages that a source downloads into the media storage. A package the rider has on the disk is up to 15 GB: it cannot travel through the WebView (`<input type="file">` would read it into memory), and `data.archive` unpacks only media files.

## Decision

- **`data.pick`** (capability, `packages/contracts/src/data.ts`): the system's open dialog brings a file into the media storage. `pick(filter)` answers once the dialog closed with the file's name, its size and `copyTo(target)`, or with nothing when the rider cancelled. The caller never learns where the file lies.
- **In the native app the dialog runs in Rust** (`apps/native/src-tauri/src/media_pick.rs`, plugin `data-pick-tauri`): `media_pick` opens it through the Rust API of `tauri-plugin-dialog` (ADR 0085, no new library) and keeps the chosen path behind a one-time token; `media_pick_copy` copies it to a media path (`ridrs_media::paths::resolve`). No `dialog:allow-open` and no fs scope for the chosen file are granted to the WebView, so a page can neither open dialogs nor copy files of its choice.
- **`video-source-local`** (transport plugin): owns the offers of imported routes (`video-source-local/<route>`, always `ready` and removable) and its key of the new app state **`route.import`** (`idle`, `importing` with the file's name, `failed` with the reason). The service **`route.import`** (keyed by that state) opens the dialog and answers once it closed; copying, unpacking (`data.archive` through the importer) and importing run after it, and their outcome is the state, as ADR 0068 asks of long work. The route's distance, climb, duration and profile come from its GPX track (`fast-xml-parser`, ADR 0066); they are kept in `videos/video-source-local/routes.json`, so a start reads no track.
- A route's title is the package's file name without `.zip` and with `_` as spaces; its folder is the title in lower case letters, digits and `-`, with `-2`, `-3`, … for a title imported again.
- `route.json`'s `source` is optional: an own package has no known author, URL or license.
- **The ride page** shows the import as the first card of a list while a provider of `route.import` offers it for that list's kind, so it appears only where the app can import.

## Consequences

- `data.pick` has no headless provider; the Cucumber scenarios simulate the dialog. The headless app leaves `data-pick-tauri` out.
- Peak disk space is the package twice plus the video while it is copied and unpacked; the package is removed before the import reports that it is done.
- On Android the dialog returns content URIs that `into_path` cannot read; the import then fails with the reason. Android needs its own copy from a content URI when it imports.
- A second format (e.g. a video with a GPX track beside it) adds an importer and a filter of the dialog; the local source keeps one list.
