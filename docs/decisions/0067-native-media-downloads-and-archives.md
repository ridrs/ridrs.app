<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0067: Media, Downloads and Archives in the Native App

Status: proposed on 2026-11-07 ([video-sources.md](../ideas/video-sources.md), step V2b).

## Context

V2a made video downloads work headless: `storage.media`, `data.fetch` and `data.archive` have Node providers. The native app runs its plugins in a WebView without Node. A video package is up to 11.2 GB: it must not pass through the WebView, must survive interruptions, and the video world (a UI plugin) can reach a stored file only by a URL it reads by range (ADR 0061).

## Decision

- **One crate, `crates/ridrs-media`**, with the `media_*` commands of the app: the small file operations of `storage.media`, `media_fetch` / `media_fetch_cancel` and `media_extract`. Everything lies below `media` in the app data directory; every path is checked like an app file path (`paths.rs`). Three thin plugins use it: `storage-media-tauri`, `data-fetch-tauri`, `data-archive-tauri`. The commands, not the fs plugin's scopes: one path check for all media, and the fs plugin's scopes stay at recordings, training and config.
- **Downloads with `reqwest` 0.12.28**, the version and rustls features `tauri-plugin-http` already brings: no second HTTP or TLS stack. Streamed to `<target>.part`, resumed with `Range` and `If-Range` by the rules of `data-fetch-node`; progress over a Tauri channel, at most four times a second; a cancel flag per job. Only `https://` URLs: the command lies outside `tauri-plugin-http`'s scope.
- **Archives with the `zip` crate 9.1.0** (MIT; ZIP64 included), pinned (`=9.1.0`): the newest release older than two weeks. Only decompression: `flate2` on `zlib-rs` (pure Rust, Zlib licence), no compressor. Entries are streamed to disk off the async runtime (`spawn_blocking`); a name that leaves the folder (`enclosed_name`) fails the extraction.
- **The app's own scheme `ridrs-media://`** serves the media to the WebView (`protocol.rs`), registered with `register_asynchronous_uri_scheme_protocol` and answered off the main thread. The URL's path is the media path (`convertFileSrc(path, 'ridrs-media')`), never a path of the device; it is resolved and checked like every media path. Every answer carries `Access-Control-Allow-Origin: *`, the CORS preflight of a range request (`OPTIONS`) is answered, and a range answer is at most 16 MB. A file without a range is sent whole only up to 64 MB. The CSP names `ridrs-media:` and `http://ridrs-media.localhost` (Windows and Android) in `img-src`, `media-src` and `connect-src`.
- **The video world's range reader** (`httpRangeReader`) asks again for the rest of a range the server cut short, and learns the file's size from the first `Content-Range`, so it never reads past the end.

Amended on 2026-11-07, after the first ride in the macOS app failed with "Load failed": the decision first used Tauri's asset protocol. Its 416 answer carries no `Access-Control-Allow-Origin`, so the cross-origin read at the end of the file (the MP4 index reads up to it) failed, and it cuts every range answer at 1000 KiB while the reader expected the full length. The own scheme, the fallback of the proposal's section 2, controls these headers; `http-range` 0.1.6 (MIT, the version Tauri uses) parses the `Range` header.
- Rejected: downloads in the WebView (`fetch` and the fs plugin: every byte through IPC); `tauri-plugin-upload` (download without resume or `If-Range`); Tauri's asset protocol (see the amendment above).

## Consequences

- `cargo test` in `crates/ridrs-media` runs the Rust tests: paths, files, extraction (an entry leaving its folder), downloads against a local server that breaks off, changes its file or is cancelled, and the scheme's answers (ranges, 416 and preflight with CORS, paths outside the media). `cargo run --example fetch-and-extract` checks a source by hand.
- The headless app leaves the three Tauri plugins out, the native bundle the three Node ones.
- Open: range reads through `ridrs-media://` on Android and iOS are not measured yet.
