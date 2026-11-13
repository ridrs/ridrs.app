<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0095: Video Packages without Their Video

Status: proposed on 2026-11-13. Builds on [ADR 0094](0094-video-routes-stored-as-ride-packages.md).

## Context

Two places keep video routes without their video:

- **The Van Gestel catalog of the app** (`plugins/video-source-vangestel/catalog/`) keeps, per route, `route.json`: facts the catalog tool derived from the package's control file and GPX track (notes, segments, a profile and a path every 100 m) and from the site (heading, highlight, description). The app reads none of it; it reads `index.json`. The control file and the track themselves are not kept.
- **The catalog website** (`Ridrs/catalog-web/`) offers each route as a ZIP without video to download, for riding it in Incyclist with the video from elsewhere. Its ZIPs carry a control file it writes itself, a track thinned to 100 m without times (so it no longer maps onto the video), `thumbnail.jpg`, which Incyclist does not show, and `route.json` in the unified format that ADR 0094 replaced.

Both are a package of ADR 0094 without its video, written in formats of their own.

## Decision

- **A package without video** is a `.ride` package (ADR 0094, `docs/formats/ridrs-ride-v1.md`) less its video: every file of the package but the one its control file names in `<video-file-path>`, byte for byte, and the files that improve it (overlay) where a catalog has them. The control file still names the video: unpacked beside the video, the folder is the whole package, and Incyclist imports it. Nothing is added that the format does not know: no `route.json`, no `thumbnail.jpg`.
- **The app's catalog keeps each route as one** (`catalog/<id>/package/`): the catalog tool reads every file of the package but its video by HTTP range (ADR 0065) and keeps it unchanged; `overlay/` keeps the files that improve it (ADR 0094, phase 6). `route.json` goes; what the app shows stays in `index.json`, derived from the package by the tool. The package's files are not referenced by URL, so the app's bundle does not grow by them.
- **The catalog website zips these packages** as they are, the overlay applied, with a read-me (`LIESMICH.txt`) beside them, and derives its map and profile from the original track. Packages of its own (`Ridrs/catalog/`) are packages without video too, video2gpx's or any other.
- **The website's local preview takes uploads**: a Van Gestel ZIP or a `.ride` file is read in the browser by range, its video left out, and the rest sent to the preview server, which keeps it as a package without video in `Ridrs/catalog/` and builds the site again. The public site stays read-only.

## Consequences

- A package from the website is a Van Gestel package without its video: its track keeps the times that map it onto the video, so the original video placed beside it rides as with the original package.
- The app's catalog grows by the packages' small files (control files, tracks of about 1 MB, the pictures some packages bring), in the repository but not in the app's bundle.
- The site's derived texts of a route (heading, highlight, description) are no longer kept; nothing used them.
- `pnpm fetch:tracks` of the website and its cache of original tracks go: the tracks are in the packages.
