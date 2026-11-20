<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Filter plan (website, phase 1)

Goal: filters that are fast to use, show what each choice yields, can be shared as a link, and cover the data the ridrs Scenic actually has. Layout rules stay: search mask top centre, route dialog left, no route list.

## Data the filters can use (local D1, 2026-11-18)

| Field | Coverage | Use |
|---|---|---|
| region | 13 coarse regions, all videos | keep, but below country |
| **country** | not in the data yet | **new**: point in polygon of lat/lon against `data/geo/countries.geojson` (Natural Earth, public domain; already used by `scripts/plaus_common.py`) → ISO A2 + German name (`NAME_DE`) |
| loc (Lokalisierungsstufe) | all | keep |
| km (route length) | 1,848 routes | new range filter |
| dur | all | keep, as a range slider |
| height, fps, hdr, bitrate | about 6,000 of 8,819 so far (fetch_tech still running), all later | resolution, fps buckets, HDR; bitrate is not in `/api/points` yet, add it |
| published | all, 2010–2026 | new: year range |
| views | all | new: minimum (e.g. 10k / 100k / 1M) |
| channel | 580 channels | new: channel picker with search |
| topics | 1,331 videos, 6 topics (Tour de France, Giro d'Italia, Dolomites, Ötztaler, Maratona, Tuscany) | new: topic chips |
| embeddable, projection (360°), footage | all | keep |
| vehicle | only 18 set | **not** a filter yet (phase 2) |
| stars, editors_pick | none set yet | filter appears automatically once any value exists |
| audio_language | 57 % set, mostly en | leave out |

## UI

1. **Quick chips** directly under the search bar, one tap each: *Synchron abspielbar*, *Mit Route*, *4K+*, *50/60 fps*, *HDR*, *In ridrs Scenic abspielbar*. Same state as the matching fields in the panel.
2. **Panel in sections** (instead of the flat grid), each collapsible, opened state remembered in `localStorage`:
   - **Ort:** country (searchable multi-select, sorted by count, with flag emoji from ISO), region, topic chips.
   - **Strecke:** Lokalisierungsstufe (segmented 1–7 control "mindestens"), distance km (two-handle range), duration min (two-handle range).
   - **Bild:** resolution (segmented: alle / 1080p / 1440p / 4K / 8K), fps (alle / ≥ 50), HDR, bitrate minimum (alle / 10 / 20 / 40 Mbit/s).
   - **Video:** published year range, views minimum, channel (searchable), only embeddable.
   - **Inhalt:** 360°, simulator and games (both off by default, as now).
3. **Live counts (facets):** every option shows how many videos it would leave, with all other filters applied (e.g. "Italien 425"). Options with 0 are dimmed, not removed. Computed client-side on the ~9k rows, debounced (≤ 1 frame).
4. **Active filters as removable chips** below the bar when the panel is closed (`4K+ ×`, `Italien ×`, `20–80 km ×`), plus "Alle zurücksetzen".
5. **Map viewport:** toggle *Nur im Kartenausschnitt*; the summary line then reads "312 im Ausschnitt · 2.140 gefiltert · 8.819 gesamt". Suggestions respect it.
6. **Shareable state:** filters live in the URL query (`?c=IT,FR&res=2160&km=20-80…`), the video stays in the hash (`#v=…&t=…`). Back/forward restore both. Default values are not written.
7. **Presets** (a small "Vorschläge" row in the panel): *Alpenpässe in 4K*, *Lange Fahrten über 1 h*, *Synchron mit Karte*, *Tour-de-France-Anstiege*. A preset just sets the fields.
8. **Accessibility and mobile:** all controls keyboard-usable, range sliders with number inputs as fallback, labels in German; on ≤ 760 px the panel is a full-height sheet with a sticky "N Videos anzeigen" button.

## Data and API changes

- `scripts/export_public.py`: add `country` (ISO A2) and `country_name` (German) per video from lat/lon; videos at sea or outside polygons: nearest polygon within 25 km, else null. Report counts in `REPORT.md`.
- `migrations/0002_country.sql`: `video.country TEXT`, index; `import.mjs` writes it.
- `src/worker.js` `/api/points`: add fields `country`, `kbps` (bitrate), `year` (or keep `published`); keep the compact `{fields, rows}` form. Country names come as a small `{code: name}` map in the same response.
- No new requests per filter change: everything is client-side.

## Code structure

- New `site/filters.js`: filter state, URL (de)serialisation, predicate builder, facet counts. Pure functions, unit-tested with `node --test` in `web/test/filters.test.mjs`.
- `site/app.js`: only wiring (map source update, summary, suggestions).
- `site/index.html` / `style.css`: the new panel, chips and range controls in the ridrs style (tokens in `style.css`).

## Done when

- All filters above work together, counts are correct (unit tests for predicates, facets, URL round trip).
- A link with filters and `#v=` reproduces the same view.
- Desktop and 375 px layout checked, no horizontal scroll, filter change < 50 ms on 9k videos.
- README updated (filters, URL parameters, country source and licence).
