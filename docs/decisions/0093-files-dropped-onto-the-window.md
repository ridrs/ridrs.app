<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0093: Files Dropped onto the Window, Read in Rust from the Drag Pasteboard

Status: proposed on 2026-11-12.

## Context

Riders want to drag a workout file (`.zwo`, `.fit`, `.erg`, `.mrc`, `.tcx`, intervals.icu text, a ZIP of workouts) or an own video route (an Incyclist package as `.zip` or `.ride`) onto the app window, see a preview tile like the one the library will show, and add it to the library by letting go. Today a file dropped anywhere but the import page's drop zone opens in the WebView: an image or a video replaces the app (`dragDropEnabled: false`, so WebKit loads what nobody took).

Packages are up to 15 GB and must not travel through the WebView (ADR 0090). Measured in the native app on macOS 26 (spike, branch `spike/drag-drop`, 2026-11-12):

- **Tauri's native drag and drop cannot be used.** `tauri-runtime-wry` 2.12.3 answers every drag event with `true`, and `wry` 0.57.1 then never forwards `draggingEntered`, `draggingUpdated` or `performDragOperation` to WebKit: with `dragDropEnabled: true` no HTML5 drag reaches the page, including the calendar, the workout editor and library → calendar.
- **While a file hovers, WebKit tells the page nothing about it:** `dataTransfer.types` is `["Files"]`, `items` and `files` are empty; names and contents come with the drop only.
- **The system's drag pasteboard (`NSPasteboard(name: .drag)`) has the files while they hover.** A Tauri command read the name, size and every ZIP entry of a 15.6 GB Incyclist package 7 ms after `dragenter`, in 1 ms (the ZIP's central directory only); at the drop its `changeCount` was unchanged.
- **Accepting the drag and preventing the drop's default keeps the WebView where it is.**

## Decision

- **The WebView keeps its drags** (`dragDropEnabled: false`). The host takes every external drag no one else took (`Files` or `text/uri-list` in `dataTransfer.types`; the app's own drags carry `text/plain`): its `drop` is prevented, so nothing dropped opens in the WebView (`suppressBrowserChrome`, `apps/native/src/browser-chrome.ts`).
- **Rust reads what is dragged from the drag pasteboard** (`apps/native/src-tauri/src/media_drop.rs`, macOS) when the page sees `Files` arrive, and keeps the paths behind the tokens of `data.pick` (ADR 0090): the WebView learns names, sizes and the small files a preview needs (`PEEK_LIMIT`, 8 MB: a dropped file that is no ZIP, and the ZIP entries of `PEEK_EXTENSIONS`: control files, tracks, `*.json` and workout files; an hour of GPX track is about 1.3 MB), never a path. A token is copied once (`media_pick_copy`) and dropped on `dragleave` or after the import. Rust reads the pasteboard only while the page sees an external file drag, and the number of files must match.
- **`data.drop`** (capability, `packages/contracts/src/data.ts`): enter / drop / leave of files, each a `PickedFile` with an id and `peek()`, and `file(id)` while its drag or drop lasts. Plugin `data-drop-tauri` in the native app; a provider from HTML5 files for the browser preview and simulated drops in the Cucumber scenarios. Like every capability it is for plugins, not for the UI, which reaches it through app state and services.
- **`VideoImporter.inspect(entries)`** tells from the peeked entries whether a package is of the importer's format and which entry holds its track, with the reasons its import gives; `video-source-local` makes the preview of it (`route.import-preview`), so the UI never handles a package's bytes.
- **`file-drop`** (storage plugin, headless) listens to `data.drop` and owns the app state **`file.drop`** (key `window`): each file's verdict (`reading`, `workouts` with the canonical workouts and whether the library has them, `route` with a provider's preview, `refused` with the reason) while it hovers, `importing`, then `done` with what was added. Its service **`file.drop.import`** adds them: workouts through `training.library.save` with ids as the import page chooses them (`chooseWorkoutId`, moved to `@ridrs/workout`), video routes through `route.import`. Nothing imports on its own: only the layer calls it.
- **`ui-file-drop`** contributes to the new extension point **`main/overlay`** of the main screen (its layout's `overlays`; the main screen frames every screen but the ride and the debriefing, so nothing shows or imports during a ride): a layer over the whole window that shows a preview tile per file (up to four, then "+ n more") and imports on drop: workouts through `training.library.save` into the ridrs library, video routes through `route.import` with the dropped file instead of the dialog, previewed by `route.import-preview` of `video-source-local`. Nothing appears while a ride is running or paused; such a drop is discarded.
- **Recognition:** `.ride` is a video route; a ZIP with a valid Incyclist control file is a video route whatever else it holds (video2gpx adds `video2gpx.json` and `LIESMICH.txt`); otherwise a ZIP with workout files is workouts; any other file is not importable. `.ride` is an Incyclist package with another extension; `data.pick` of the ride page accepts `zip` and `ride`.
- The workout analysis of `ui-workout-import` (`detectFormat`, the importers by format, `analyseFile`, `unzip`) moves to `@ridrs/workout`, which both plugins use.

## Consequences

- Phase 1 stops dropped files from opening in the WebView. Phase 2 adds `data.drop`, `VideoImporter.inspect`, `route.import` with a dropped file, `route.import-preview`, `.ride` in the open dialog, and moves the workout analysis. Phase 3 reads the drag pasteboard in Rust (`media_drop.rs`, `data-drop-tauri`). Phase 4 adds `file-drop`, `file.drop`, `main/overlay`, `ui-file-drop`, and `preview` in the input of `ui.route-profile`, a route's title and elevations before it is an offer.
- The drop plugin asks Rust at every `dragenter` of files (2 to 7 ms) and tells of a drag once: a `dragleave` lost to a reload does not hide the next drag. A file of a drag that was copied already gets a new token for the same drag.
- A route the rider brings is an offer from the moment its import starts, with the new availability `importing` (the facts of its preview for a dragged package, none yet for a chosen one), and becomes `ready`, or goes with a failure: the ride page lists it at once as "Importing" and offers Go once it is ready. A drop of workouts the library has closes the layer. Files ridrs cannot import are ignored: no layer, no tile.
- wry's web view answers `draggingUpdated:` with `Copy` where WebKit says no operation (wry 0.57, `drag_drop.rs`), so the pointer showed a plus over every file. At startup `media_drop::honour_refused_drags` gives that method of wry's class WebKit's own answer back: the page's `dropEffect` decides.
- Listing the own workouts needs `fs:allow-read-dir` for `$APPDATA/training/workouts`: before, the ridrs library failed to start once a workout was saved.
- Saving an original needs the folder `$APPDATA/training/originals`: `fs:allow-mkdir` allows it now. Before, the import page could not save an original on a device where the folder was not there yet.
- Windows and Linux have no drag pasteboard reader; there the layer shows after the drop from the HTML5 files, and large packages fall back to the dialog. Android has no drag and drop.
- A file association for `.ride` (double-click in the Finder) is a later step that uses the same import.
- An own ridrs manifest inside `.ride` may come later; the package stays readable by Incyclist.
