<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0104: Web Versions of Scenic's Ride Pictures with Jimp

Status: proposed on 2026-11-21, for ridrs Scenic (`web/scenic`).

## Context

The route dialog of ridrs Scenic shows a Van Gestel ride's overlay picture in place of a player. These pictures are 2752×1536 and 1.7 to 8.6 MB each (PNG or JPEG), 73 MB for all 23 rides. The dialog shows them 440 px wide (the sheet's width on phones), so every opened ride loaded several megabytes.

## Decision

- `scripts/build.mjs` writes two JPEG web versions of each ride's overlay picture, `vg/<slug>/web/picture-640.jpg` and `picture-1280.jpg` (quality 80, aspect ratio kept, never enlarged; `scripts/lib/thumbnails.mjs`). The dialog loads them with `srcset` and never the original: it stays in `overlay/` for the app (the package without video), and the site has no full-size view.
- The URLs carry the first 12 hex digits of the original's sha256 (`?h=`), so a new picture replaces the old one in caches.
- **`jimp` 1.6.1** (MIT, pure JS, ESM) reads PNG and JPEG, resizes and writes JPEG. It is a development dependency of `web/scenic` and runs in the build only. Resizing one picture to both widths takes about 0.4 s.
- `build/thumbs/<sha256>/` (ignored by git) keeps the web versions by the original's hash: a later build copies them instead of resizing (13 s → 3 s for 23 rides).
- Rejected: `sharp` (native libvips binaries, against rule 2); macOS `sips` (one platform only); resizing in the Worker (no image library on Workers without the paid Images binding, and the pictures are known at build time); WebP (Jimp does not write it without a WASM plugin, and a 1280 px JPEG at 255 kB is already small enough).

## Consequences

- An opened ride loads 70 kB (640 px) or 255 kB (1280 px) instead of up to 8.6 MB.
- Pictures uploaded in the admin (`/api/images/:id`, R2) are not covered. They are stored as uploaded; making web versions of them would happen at upload time.
- The dialog sets `sizes` to the dialog's default width (440 px). A user who drags the dialog much wider on a 1× screen gets the 640 px version, which is slightly soft.
