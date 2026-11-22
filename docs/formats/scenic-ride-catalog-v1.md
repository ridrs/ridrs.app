<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs Scenic ride catalog, version 1

The video routes that ridrs Scenic (`web/scenic`, served under ridrs.app/scenic) offers for riding in the app: every published entry with a ride package (today the rides of Fred Van Gestel). The app's video source reads it instead of a catalog bundled with a plugin.

- **Request:** `GET <scenic>/api/ride/v1/catalog.json`, e.g. `https://ridrs.app/scenic/api/ride/v1/catalog.json`.
- **Caching:** the answer carries an `ETag` (a hash of the body) and `Cache-Control: public, max-age=600`. A request with `If-None-Match` set to the current tag gets `304 Not Modified` without a body.
- **Visibility:** an entry is listed only while it is visible on the public site (published in the admin, not hidden). An entry that disappears from the list was withdrawn; a client keeps a route it already downloaded.
- **URLs** are absolute. Files of Scenic carry `?h=<first 12 hex digits of their SHA-256>`, so a changed file gets a new URL.
- **Example:** `web/scenic/test/fixtures/ride-catalog/catalog.example.json`, the answer for the test catalog in `web/scenic/test/fixtures/vangestel/`; Scenic's tests check that the worker answers exactly that.

## Shape

```json
{
  "format": "ridrs-scenic-ride-catalog",
  "version": 1,
  "sources": { "<source id>": { "name": "…", "author": "…", "url": "…", "license": { "id": "CC-BY-NC-SA-4.0", "name": "…", "url": "…" } } },
  "routes": [ { … } ]
}
```

A client reads `format` and `version` first and ignores a catalog of another format or a higher major version. Fields it does not know it ignores.

### `sources`

Who made the content and under which license, by source id. Every route names its source; a client shows these credits wherever it shows the route (LICENSING.md, section 6a).

### `routes[]`

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Scenic's id of the entry, unique and stable: `vg-<slug>` for Van Gestel. |
| `source` | string | Key of `sources`. |
| `title` | string | As the source names the route. |
| `page` | URL | The route's page at its source. |
| `country` | string, optional | ISO 3166-1 alpha-2. |
| `level` | string, optional | The source's difficulty as it writes it (`Easy`, `Moderate`, `Hard`). |
| `tour` | object, optional | `{ "name": string, "part": positive integer }` for a route that is a part of a tour. |
| `distance` | number | m along the route. |
| `ascent` | number | m climbed. |
| `duration` | number | s the video runs along the route. |
| `sparkline` | number[] | Elevations in m, evenly spaced from start to end, at least 2. |
| `climbs` | object[] | Categorised climbs in their order (ADR 0070): `category` (`HC`, `1`–`4`), `start`, `end` (m along the route), `gain` (m), `grade` (%), `summit` (m), `name` (optional). |
| `tile` | URL, optional | The route's small picture for a card, about 800 px wide. |
| `overlay` | object[] | Files that improve the route's package (ADR 0094): `path` (as the package's entry it improves), `size` (bytes), `sha256` (hex), `url`. |
| `download` | object | The package with its video at its source: `url`, `format` (`incyclist-gpx-import`), `size` (bytes), `etag` (optional, as the source's server sends it), `kind` (optional: the kind of download, which picks the app's downloader, ADR 0105; `ride-package` where it is missing). |
