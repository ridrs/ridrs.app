<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0065: ZIP Entries by HTTP Range with zip.js

Status: proposed on 2026-11-06, for the video catalog tool ([video-sources.md](../ideas/video-sources.md)). Amended the same day: `data-archive-node` unpacks downloaded packages with it too.

## Context

cycling.vangestel.online offers each video ride as one ZIP: the Incyclist control file, the GPX track and the MP4, 0.77 to 11.2 GB, 66.5 GB for all 23. Everything the catalog needs (title, segments, notes, the track for distance, ascent and profile) lies in the two small entries. The server answers HTTP range requests (`206`, without `Accept-Ranges` on them), and the files above 4 GB are ZIP64. Every entry is deflated, so the small ones can be read on their own but the video cannot be read in place.

## Decision

- **`@zip.js/zip.js` 2.24.0** (BSD-3-Clause, pure JS, ESM, no dependencies; Node, browsers and the WebView) reads the central directory and single entries over HTTP range requests (`HttpRangeReader` with `forceRangeRequests`). It handles ZIP64. Development dependency of the root for `scripts/fetch-video-catalog.ts`.
- Web workers are off (`configure({ useWebWorkers: false })`): the entries are a few hundred kB.
- Rejected: own central-directory code on `node:zlib` (generic, against rule 2; ZIP64 and data descriptors are easy to get wrong); `yauzl` and `unzipper` (Node only, no range reader); `fflate` (no ZIP64 central directory with random access by range).

## Consequences

- The catalog of all routes costs about 40 kB of transfer per route instead of 66.5 GB.
- The same library can read a ZIP's entries in the app later (the WebView has `fetch` and `DecompressionStream`), for example to preview a route that is not in the shipped catalog.
- **`data-archive-node`** (`data.archive` for the headless host and the tests) unpacks downloaded packages with it: a zip.js `Reader` over a file handle reads by range, a zip.js `Writer` writes each entry to disk chunk by chunk, so an 11 GB video never sits in memory. A zip.js `Writer` rather than a web `WritableStream`: zip.js tells streams by the global `WritableStream`. zip.js refuses entry names that leave the folder; the plugin checks the paths again. The native app gets its own `data.archive` in Rust, with its own decision.
- The UI scenarios' DOM (happy-dom) replaces `WritableStream` and `TransformStream` but not `ReadableStream`; a pipe across the two breaks zip.js. `tests/support/ui-dom.ts` keeps Node's set, as a WebView has one set.
