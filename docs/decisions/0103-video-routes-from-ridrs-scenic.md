<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0103: Video Routes from ridrs Scenic

Status: proposed on 2026-11-21, on the maintainer's request that the app ship no catalog of video routes in a plugin and read them from ridrs Scenic, and that the section "Real video" of the ride page be "Scenic". Changes ADR 0095 (the app's catalog) and the place of the catalog of ADR 0070. Since ADR 0105 the downloads are `download-ride-package`'s; the source hands its routes to it.

## Context

`video-source-vangestel` bundled the catalog of the 23 rides of Fred Van Gestel (`plugins/video-source-vangestel/catalog/`, 102 MB with the packages without video, the pictures and the overlays): every change of a route, a picture or a peaks list needed a new app, and every distribution of the app bundled content under a non-commercial license. ridrs Scenic (`web/scenic`, ridrs.app/scenic) lists the same rides beside its YouTube videos since 2026-11-21 and serves them to the app as a ride catalog (`docs/formats/scenic-ride-catalog-v1.md`).

## Decision

- **The plugin `video-source-scenic`** replaces `video-source-vangestel`. It reads `https://ridrs.app/scenic/api/ride/v1/catalog.json` through `net.http` and offers each route as a key of `route.offer`, `video-source-scenic/<Scenic's id>` (`vg-<slug>` for Van Gestel). The downloads are as before (ADR 0094); the overlay files come from Scenic through `data.fetch` instead of the app's bundle.
- **Offline:** the last catalog is kept in the app files (`training/scenic-ride-catalog.json`; the native app replaces files only below `recordings/`, `training/` and `config/`) with its ETag; at start its routes are offered at once, then Scenic is asked with `If-None-Match`. Without a network and without a kept catalog no route is offered; a downloaded route of a kept catalog plays.
- **Withdrawn routes** go from the offers, unless they are on the device: then they stay until the rider removes them.
- **Former downloads:** a route that `video-source-vangestel` downloaded (`videos/video-source-vangestel/<slug>`) is moved to `videos/video-source-scenic/vg-<slug>` at start, so that nobody downloads gigabytes again. `MediaFiles.move` moves folders too (both providers did already). Favourites and "Ride again" of the old ids are not carried over (the app is a preview).
- **The catalog** moves to `content/vangestel/` of the repository: `pnpm fetch:video-catalog` writes it, ridrs Scenic imports it from there, and the scenarios read it; no plugin references it, so the app does not bundle it. The hand-made thumbnails and peaks lists stay under version control. `categoriseClimbs` and `nameClimbs` move to `@ridrs/ride`, the profile picture of the tool to `scripts/lib/`.
- **The ride page** calls the section "Scenic" (English and German); it lists the video offers of every source, the rider's own imported routes included.
- **The native app** allows `https://ridrs.app/scenic/api/ride/*` for `net.http` and `https://ridrs.app` for pictures (CSP `img-src`).
- **Scenarios** never reach Scenic: every scenario that runs `video-source-scenic` gets a simulated one (`tests/support/simulated-scenic.ts`) that serves `tests/fixtures/scenic/ride-catalog.json` (Scenic's answer of 2026-11-21) and the files of `content/vangestel`.

## Consequences

- The app needs Scenic once to list the routes; Scenic must be deployed before an app with this plugin ships.
- A changed picture, peaks list or route reaches every app with the next catalog, without a new app.
- The app's distribution bundles no non-commercial content any more; whether LICENSING.md section 2 changes is the maintainer's decision.
- `tests/fixtures/scenic/ride-catalog.json` must be fetched again when `content/vangestel` changes; the format's test vector is shared with Scenic's tests (`web/scenic/test/fixtures/ride-catalog/`).
