<!-- SPDX-License-Identifier: CC-BY-NC-SA-4.0 -->

# ridrs Scenic ride catalog for the scenarios

`ride-catalog.json` is the answer of `https://ridrs.app/scenic/api/ride/v1/catalog.json` (format: [docs/formats/scenic-ride-catalog-v1.md](../../../docs/formats/scenic-ride-catalog-v1.md)) as of 2026-11-21: the 23 rides of Fred Van Gestel. The simulated Scenic (`tests/support/simulated-scenic.ts`) serves it, and the files it names under `vg/<slug>/` from [content/vangestel](../../../content/vangestel/). Fetch it again when the catalog in `content/vangestel` changes.

The routes, their notes and pictures are by Fred Van Gestel, [cycling.vangestel.online](https://cycling.vangestel.online/indoor/videos/), licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); the profiles and climbs are derived from his GPX tracks and shared under the same license. Third-party content for non-commercial use (LICENSING.md, section 6a).
