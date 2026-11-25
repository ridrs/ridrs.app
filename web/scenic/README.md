<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs Scenic – Website (Phase 1–4)

Served under **ridrs.app/scenic** (`BASE_PATH` in `wrangler.jsonc`). It lives next to the ridrs.app site in `ridrs_app/web/` and stays its own Worker; ridrs.app hands `/scenic/*` to it (Service Binding, below). Locally both run together at http://localhost:8787/ (`pnpm dev:site`).

**Data stays outside the repository.** The pipeline (YouTube metadata, routes, elevation, `export/`) and the local wrangler state live in `Ridrs/pov-atlas/`, found by walking up from this folder (`scripts/lib/paths.mjs`; `SCENIC_PIPELINE` overrides). Every local wrangler command goes through `node scripts/wrangler.mjs …`, which adds `--persist-to <pipeline>/dev-state`, so this checkout and every worktree see the same local database.

Cloudflare Worker with static assets and D1, as planned in [../CLOUDFLARE-KONZEPT.md](../CLOUDFLARE-KONZEPT.md) (section 4).

| Path | What |
|---|---|
| `site/` | Front end: `index.html`, `app.js` (full-screen map, search mask top centre with suggestions and filters, route dialog on the left; on phones a bottom sheet; no route list; only wiring), `filters.js` (filter state, URL, predicates, facet counts; pure, unit-tested), `panel.js` (filter panel, quick chips, active-filter chips), `player.js` (two-click YouTube player with the synced route pointer, from `catalog-web/site/video.js`), legal pages |
| `src/worker.js` | `/api/points`, `/api/videos/:id`, `/api/search`, `/api/sync/:id.json`, `/api/videos/:id/route.gpx`, `/api/videos/:id/incyclist.zip`, `/api/videos/:id/video2gpx-job.json`, `/api/images/:id`, `/api/videos/:id/package.zip`, `/api/ride/v1/catalog.json`, `/vg/:slug/…`, `/admin` + `/api/admin/*`, and the daily YouTube API refresh (`scheduled`, YouTube entries only) |
| `src/rides.js` | Van Gestel rides: package without video (ZIP), ride catalog of the app |
| `src/auth.js` | Cloudflare Access JWT check for the admin, local dev bypass |
| `src/admin.js` | admin API: edits with `edit_log` and undo, anchors and sync tracks, Prüfmodus, route editing (OSRM), images (R2), collections, opt-out, export |
| `src/tracks.js` | routes uploaded as GPX in the admin (tab „Routen“, not tied to a video, migration 0010): parse, simplify to ≤ 4000 points, admin CRUD, public `GET /api/tracks` (GeoJSON of the published ones, drawn in their own colour with a legend entry) |
| `site/admin/route-editor.js`, `site/lib/track-cover.js` | route editor (`#t=<id>`, button „Videos zuordnen“ in the tab „Routen“, migration 0011): elevation profile (`<ele>` of the GPX, or Open-Meteo for a GPX without heights), seek from start to end, the videos riding the position in the route's direction (video lines of `lines.json`, refined with the synced track where there is one), „Ab hier zuordnen“ writes `track_video` (from km, video, video seconds at both ends); „Vorschlag erzeugen“ fills the route greedily (synced first, then furthest reach); the player follows the video along the route and changes video at each assignment. API in `src/tracks.js` |
| `src/wishlist.js` | wishlist for video2gpx: public vote (one per visitor, video and day, hashed, no IP stored, at most 30 a day), admin queue (order, top, done, dismissed), see [Wishlist](#wishlist-for-video2gpx) |
| `src/video2gpx.js` | video2gpx round trip: job, validation of an uploaded result, route agreement (contract: [../VIDEO2GPX-INTEGRATION.md](../VIDEO2GPX-INTEGRATION.md) section 8) |
| `src/incyclist.js`, `src/images.js` | Incyclist package (fflate), image type and size sniffing |
| `site/admin/` | admin UI (`/admin`) |
| `site/lib/route-sync.js` | route geometry, speed model, anchor track, level rules, Prüfmodus (shared by worker and admin, unit-tested) |
| `scripts/pull_manual.mjs` | admin export → `../data/manual.json` |
| `migrations/` | D1 schema (phase 1 subset of the concept's data model) |
| `scripts/build.mjs` | `dist/` = site + MapLibre + ridrs fonts (`vendor/fonts`, from `@fontsource`, self-hosted, no Google Fonts) + `gpx/` (from `../export/routes`) + `sync/` (time-synced tracks) |
| `scripts/lib/vangestel.mjs` | reads the Van Gestel catalog (`content/vangestel` of the repository) |
| `scripts/lib/thumbnails.mjs` | web versions (640 and 1280 px JPEG) of a ride's big overlay picture |
| `scripts/import.mjs` | `../export/` and the Van Gestel catalog → D1 upsert (SQL from `scripts/lib/import-sql.mjs`). Never touches editorial fields, manual fields or verified localizations; `--dry-run` only writes `build/import.sql` |
| `test/` | `node --test test/` (`pnpm test`): filters, URL, speed; route sync and level rules; import protection (node:sqlite with the migrations); JWT and dev bypass; admin API; Incyclist; video2gpx job and upload (`test/fixtures/video2gpx/`, shared with ridrs_app `apps/video2gpx/tests/atlas/fixtures/`) |
| `scripts/lib/sync-sources.mjs` | Time-synced tracks; for now the video2gpx tracks of `catalog-web`, matched by YouTube id |

## Van Gestel rides

Besides YouTube, ridrs Scenic lists the rides of Fred Van Gestel ([cycling.vangestel.online](https://cycling.vangestel.online/indoor/videos/), CC BY-NC-SA 4.0). They are the video routes the ridrs app can ride: the app reads them from Scenic instead of a catalog bundled with a plugin.

- **Data:** [`content/vangestel/`](../../content/vangestel/) of this repository (`SCENIC_VANGESTEL` overrides it), written by `pnpm fetch:video-catalog`: `index.json`, per route `package/` (the package without its video, ADR 0095), `thumbnail.jpg` (made by hand), `overlay/`. Without the folder the import leaves the Van Gestel rows as they are.
- **Model** (migration 0007): `video.source` (`youtube` or `vangestel`), table `source` (author and license per source), table `ride_package` (download, sparkline, climbs, files with their hashes). Ids are `vg-<slug>`. Each route gets its route from the creator's GPX track (`method = creator_gpx`) and Lokalisierungsstufe 3: the track runs with the video, but nobody checked it. The YouTube refresh never touches these videos.
- **Site:** quick chip and panel filter *In ridrs fahrbar* (`ride=1`). The dialog shows the route's picture instead of a player (the video is only in the original download), tour, difficulty, climbs and credits with the license; *Paket ohne Video* (`/api/videos/:id/package.zip`: the package files, the overlay and `LIESMICH.txt`) replaces the generated Incyclist package.
- **App:** `GET /api/ride/v1/catalog.json`, format in ridrs_app [`docs/formats/scenic-ride-catalog-v1.md`](../../docs/formats/scenic-ride-catalog-v1.md); `test/fixtures/ride-catalog/catalog.example.json` is the answer for the test catalog `test/fixtures/vangestel/`.
- **Files:** the build copies them to `dist/scenic/vg/<slug>/` and the track to `gpx/vg-<slug>.gpx`; the worker serves them only for visible videos.
- **Pictures:** the overlay picture (2752×1536, up to 8.6 MB) is too big for the dialog. The build writes web versions of it to `vg/<slug>/web/picture-640.jpg` and `picture-1280.jpg` (`scripts/lib/thumbnails.mjs`, Jimp, [ADR 0104](../../docs/decisions/0104-scenic-ride-pictures-resized-with-jimp.md)); the dialog loads them with `srcset` and never the original, which only the app needs (package, catalog). `build/thumbs/<sha256>/` keeps them by the original's hash, so only new or changed pictures are resized.

## Filters

All filtering runs in the browser on the `/api/points` rows (about 10k); a filter change makes no request. `filters.js` computes the result and every facet count in one pass (about 1 ms in node and in the browser; with the panel's DOM update about 10 ms).

- Quick chips under the search bar: *Synchron abspielbar* (Stufe 1–3), *Mit Route* (1–5), *4K+*, *50/60 fps*, *HDR*, *Direkt abspielbar*, *Nur im Kartenausschnitt*. They set the same fields as the panel.
- Panel sections (open state in `localStorage`): **Ort** country (multi-select with search, flags, sorted by number of videos), region, topics; **Strecke** Lokalisierungsstufe "mindestens", length km, duration min; **Bild** resolution, fps, HDR, bitrate; **Video** published year, views, channel (search), embeddable, plus stars and editors' pick as soon as any video has them; **Inhalt** 360° and simulator/games (off by default). Presets ("Vorschläge") just set fields.
- Every option shows how many videos it leaves with all other filters applied; options with 0 are dimmed. Active filters show as removable chips when the panel is closed. On ≤ 760 px the panel is a full-height sheet with a sticky "N Videos anzeigen".
- Resolution thresholds allow 7 % below the nominal height (a 2026 px portrait upload counts as 4K). Videos without technical data drop out of the resolution, fps, HDR and bitrate filters; the panel says how many have data.

### URL

Filters live in the query, the open video in the hash: `/?c=IT,FR&res=2160&km=20-80#v=<id>&t=<s>`. Default values are not written; back and forward restore both. Discrete changes add a history entry, a slider drag or a typed search adds one per gesture.

| Parameter | Meaning |
|---|---|
| `q` | search text |
| `c` | countries, ISO codes, comma-separated |
| `reg` | region (export value, e.g. `Alps`) |
| `tp` | topics, comma-separated |
| `loc` | Lokalisierungsstufe at least (1–6; 7 = all, default) |
| `km`, `dur`, `yr` | ranges `lo-hi`, either end may be empty (`km=20-`, `yr=-2020`); km and min top out at 300 and 240 = open |
| `res` | minimum height 1080 / 1440 / 2160 / 4320 |
| `fps=50`, `hdr=1`, `emb=1`, `pick=1` | at least 50 fps, HDR, embeddable, editors' pick |
| `br` | bitrate at least 10 / 20 / 40 Mbit/s |
| `views` | at least 10000 / 100000 / 1000000 views |
| `ch` | channels as YouTube channel ids (`UC…`), comma-separated; ids stay stable when a channel is renamed |
| `stars` | at least n stars |
| `vr=1`, `sim=1` | also show 360° videos, simulator and game footage |
| `map=1` | only the current map viewport (the summary then reads "N im Ausschnitt · M gefiltert · T gesamt") |

### Country

`video.country` (ISO 3166-1 alpha-2) and `country_name` (German, `NAME_DE`) come from `scripts/export_public.py` of the pipeline: point in polygon of the video's lat/lon against Natural Earth admin-0 countries (`../data/geo/countries.geojson`, public domain, the same approach as `../scripts/plaus_common.py`). Points at sea or just off the coast take the nearest country within 25 km, otherwise null. Natural Earth features without an ISO code are mapped by hand (Somaliland → SO, N. Cyprus → CY, Siachen → IN). Coverage on 2026-11-18: 9,741 of 9,745 videos (9,289 inside a polygon, 452 by the 25 km rule, 4 null), 97 countries. `/api/points` sends the German names once as a `countries` map.

## Languages

The public site speaks ten languages, chosen for the target group (indoor cycling platforms such as Zwift, ROUVY, Incyclist and Kinomap, and road-trip / POV-drive viewers on YouTube): **English, German, French, Spanish, Italian, Dutch, Portuguese, Polish, Japanese, Korean** (`LANGS` in `site/i18n.js`).

- **Automatic:** the first of the browser's languages (`navigator.languages`) that is in the list; any other language gets English. `?lang=xx` and the language menu in the footer override it (the menu stores the choice in `localStorage`).
- **Texts:** `site/locales/<lang>.js`, one `{key: text}` object per language; `en.js` is the reference and the fallback for missing keys. `{placeholders}`, plural forms per `Intl.PluralRules` category. `test/i18n.test.mjs` fails when a language lacks a key, a placeholder or a plural form.
- **Data:** numbers, dates and percentages via `Intl` in the interface language; country names via `Intl.DisplayNames` (the API's German names are the fallback); region and topic names from the locale files; place names on the base map from OpenStreetMap `name:xx` where present. Video titles, channel names and place names from the pipeline stay as they are. Search also matches the translated country, region and topic names.
- **Legal pages** (`impressum`, `datenschutz`, `lizenz`): German (binding) and English in one file each; German browsers see German, all others English (`site/legal.js`).
- **Admin:** German only.
- New language: add it to `LANGS`, copy `en.js` to `<lang>.js` and translate; the test lists what is missing.

## Look

Logo, colours and type come from ridrs (`ridrs_app/web/public/logo.svg`, `favicon.svg`, tokens from `ridrs_app/web/src/landing.js`): cyan/lime, Chakra Petch italic caps for headings, Plus Jakarta Sans for text, JetBrains Mono for labels.

- **Dark interface, light map:** the interface is always dark (ridrs tokens in `style.css`), the map always light (OpenFreeMap `positron`). Everything drawn on the map uses the `--map-*` tokens; the level colours `--l1` … `--l7` read on both. There is no theme switch.
- If the ridrs logo changes, copy it again into `site/ridrs-logo.svg` and `site/favicon.svg`.

## Route lines on the map

`scripts/build.mjs` writes `dist/lines.json` with every exported (OSM-derived) route line, simplified to about 30 m and delta-encoded in 1e-5 degrees (about 1.5 MB, 0.7 MB compressed). The page loads it after the map, draws the routes of the filtered videos from zoom 5 on, coloured by Lokalisierungsstufe, and opens the video on click. The dialog still uses the full line from `/api/videos/:id`.

- **Lines set in the admin** are not in the build: the worker lays them over the build's file when it serves `lines.json` (`linesJson` in `src/worker.js`). A manual route (set by hand or „Route aus video2gpx übernehmen“, `manual_field` `route`) replaces the build's line; an uploaded video2gpx track gives a line to a video without one. Encoding and simplification are shared in `site/lib/lines.js` (build, worker, page).
- **Open video:** while its exact route is drawn, its coarse overview line is hidden, so the map shows one line.

## Several videos at one point

Videos located only from the title (Lokalisierungsstufe 7) or pinned to the same place share their exact position: about 5,500 videos sit on about 590 shared points (up to 361 on one). The map therefore has one feature per position with `n` = number of videos; clusters sum `n` (`clusterProperties`), so the numbers are videos, not points. A position with several videos is a ring with the number; clicking it opens the choice of exactly these videos in the dialog (sorted by Lokalisierungsstufe, then views), and a video opened from there has a link back to the choice. This is not a route list: it only lists what lies on that one point.

## Under ridrs.app/scenic

- **Path:** everything lives under `/scenic`. `scripts/build.mjs` writes the site to `dist/scenic/`, the worker strips `BASE_PATH` before routing (`src/base.js`), and every URL the pages use is relative, so the admin at `/scenic/admin/` reaches `../api/admin/…`. Requests outside `/scenic` answer 404; locally `/` redirects to `/scenic/`.
- **Joining ridrs.app (recommended):** ridrs Scenic stays its own Worker (`ridrs-scenic`, own D1, R2, cron). The existing `ridrs-app` Worker (ridrs_app/web, custom domain ridrs.app) forwards the path through a Service Binding, so no second route on the domain is needed:

  ```toml
  # ridrs_app/web/wrangler.toml
  [[services]]
  binding = "SCENIC"
  service = "ridrs-scenic"
  ```

  ```js
  // ridrs_app/web/src/router.js, first line of route()
  if (pathname === "/scenic" || pathname.startsWith("/scenic/")) return env.SCENIC.fetch(request);
  ```

  The request keeps its URL, so origin checks, the Access JWT header and the CSRF guard work unchanged. Deploy `ridrs-scenic` first, then `ridrs-app`.
- **robots.txt:** it belongs to ridrs.app; add `Disallow: /scenic/admin` there (the admin also sends `noindex`).
- **Access:** one Cloudflare Access application for `ridrs.app/scenic/admin*` and `ridrs.app/scenic/api/admin/*`; its team domain and AUD go into `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`.

## Local development

```bash
python3 scripts/export_public.py     # in Ridrs/pov-atlas: refresh export/
pnpm install                          # here, in web/scenic (own pnpm project, not part of the app workspace)
pnpm migrate:local                    # once, and after new migrations (0005 phase-4 tables, 0006 publication, 0007 sources and rides, 0009 wishlist)
pnpm import                           # export/ -> local D1
pnpm dev:site                         # build + ridrs.app and ridrs Scenic together: http://localhost:8787/ and /scenic/
pnpm dev                              # ridrs Scenic alone: http://localhost:8788/scenic/
pnpm test                             # node --test test/
```

`.dev.vars` holds `YOUTUBE_API_KEY` for the local cron (`curl http://localhost:8788/cdn-cgi/local/scheduled` with `pnpm dev`). It is not in git.

## Publication

The public site shows only videos the editors published in the admin (`video.site_published`, migration 0006; checkbox „Veröffentlicht“, list filter „veröffentlicht“ / „nicht veröffentlicht“). Every public endpoint uses the same condition (`VISIBLE` in `src/worker.js`: published, not hidden, public on YouTube, no channel opt-out), and so do the static files of the build: `lines.json`, `gpx/<id>.gpx` and `sync/<id>.json` go through the worker (`run_worker_first`), which filters `lines.json` and answers 404 for the files of unpublished videos.

- New videos from the import start unpublished; the import never writes the flag.
- Start set: every video at Lokalisierungsstufe 1 or 2 (track secured by video2gpx), and every Van Gestel ride. Migration 0006 publishes the first in a database that already holds data; on an empty database (first deploy) run `pnpm publish:initial` once after the first import. A database that had videos before the Van Gestel rides came gets them published once with `pnpm publish:vangestel`.
- `hidden` (phase 4) still blocks a video even when it is published; the admin shows that checkbox only for videos that have it set.

## Admin (phase 4, „Redaktion“)

`/admin` (UI) and `/api/admin/*` (API). Every request needs a verified identity, otherwise 403 (page and API, `src/auth.js`):

- **Production:** Cloudflare Access application over `/admin*` and `/api/admin/*`. The worker checks the `Cf-Access-Jwt-Assertion` JWT itself (RS256 against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `aud`, `exp`, issuer). Set `ACCESS_TEAM_DOMAIN` (team name or `<team>.cloudflareaccess.com`) and `ACCESS_AUD` (the application's AUD tag) in `wrangler.jsonc` `vars`. Without both every admin request is 403.
- **Local:** `ADMIN_DEV_EMAIL=dev@localhost` in `.dev.vars` stands in for the JWT, but only for plain-http requests whose hostname is `localhost`, `127.0.0.1` or `[::1]` (wrangler dev). On any real host or over https it is ignored, so it can never open production. `.dev.vars` is read at start: restart `pnpm dev` after adding it.
- `/admin` is `noindex` (meta, `X-Robots-Tag`, `robots.txt`) and `no-store`. Every write stores the identity in `edit_log`.

| Area | What |
|---|---|
| Redaktion | **published** (shown on the public site), stars, editor's pick, note, collections (`collection`, `collection_item`: create, rename, order, delete) |
| Verortung | place, region, country, move pin |
| Route | set start/via/end on the map and re-route via OSRM (`router.project-osrm.org`, car, at most 1 request/s), reverse, discard. Stored as a manual route (`manual_field` `route`, GPX served by `/api/videos/:id/route.gpx`); elevation and road shares of a re-routed route come back with the next pipeline run |
| Anker | pause the video, „Anker setzen“ (key A), click the map: the anchor snaps to the route line (`sync_anchor`). The worker rebuilds the track (`sync_track`, served as `/api/sync/<id>.json`, `route_sync.method = anchors`) and the level |
| video2gpx | „Job-Datei laden“ saves `<id>.v2g.json` for the desktop app video2gpx (also `GET /api/videos/<id>/video2gpx-job.json`, public). „video2gpx-Ergebnis hochladen“ takes its `<id>.scenic.json`: checked (id, time order, speed ≤ 252 km/h except at cuts, inside the job's frame, ≤ 1.5 MB / 4 h, checklist complete), stored as a manual sync track (`route_sync.method = video2gpx`, `/api/sync/<id>.json`), level 2 with the distance to the ridrs Scenic route; median over 50 m offers „Route aus video2gpx übernehmen“. Undo via Protokoll. Details: [../VIDEO2GPX-INTEGRATION.md](../VIDEO2GPX-INTEGRATION.md) section 8 |
| Warteschlange | the wishlist as the video2gpx queue (tab „Warteschlange“, list filter „auf der Wunschliste“, tag in the list, field in the editor): „In die Warteschlange“, „An die Spitze“, „Erledigt“, „Ablehnen“, „Wieder öffnen“; logged and undoable. Details: [Wishlist](#wishlist-for-video2gpx) |
| Prüfmodus | ≥ 10 check points (one per 3 min, up to 20, plus up to 6 hairpins); confirm (Enter), drag the orange pointer or mark the wrong road (F); passed = all on the right road and ≤ 25 m along it → level 1 with the track hash; failed → corrections become anchors (`source = review`) |
| Bilder | JPG/PNG/WebP ≤ 10 MB, type checked from the bytes, rights and credit, main image, delete (R2 binding `IMAGES`, local in `.wrangler/state`) |
| Kanäle | opt-out: the channel's videos disappear at once, the next import deletes their pipeline rows |
| Protokoll | every change with person and time; „Zurücknehmen“ writes the old state back (logged itself). Images cannot be undone |

**Sync rules** (`site/lib/route-sync.js`, `LOC_RULES.version = 1`): between two anchors the time is spread along the route by the speed model (curve radius, climbs, acceleration limits; with a constant model this is piecewise linear in km); before the first and after the last anchor the model runs on, scaled by the speed observed between the anchors. Level 2 needs a route of level 4 or better, an anchor within max(500 m, 5 % of the route) of the start and of the end, and at least max(2, ⌈km / 10⌉) anchors; fewer anchors give level 3. Videos with a pipeline track (video2gpx) keep it: their anchors are stored for the pipeline only. Any change of an anchor track drops a level 1 back to 2 (new hash).

**Manual fields always win:** fields the pipeline also writes get a row in `manual_field` (`place`, `region`, `lat`, `lon`, `position_exact`, `country`, `country_name`, `route`, `localization`, `sync`). `scripts/import.mjs` skips them (tested in `test/import.test.mjs`); stars, notes, picks and hidden are never in the import at all.

**Back to the pipeline:** `node scripts/pull_manual.mjs [--url https://<site>]` writes `data/manual.json` of the pipeline from `GET /api/admin/export` (ndjson: editorial and manual fields, manual routes, localizations, anchors, anchor tracks, collections, opt-outs, image metadata, `edit_log`, `localization_log`). For production use an Access service token (`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`) or `CF_ACCESS_TOKEN`. Next step, not done: `scripts/export_public.py` of the pipeline should read `data/manual.json` (manual place/region/pin as export values, manual routes instead of the pipeline route, anchors for video2gpx and the sync step of 3.6), so that D1 and the export agree; the import already protects these fields either way.

**Incyclist** (`GET /api/videos/:id/incyclist.zip`, button in the dialog): from Lokalisierungsstufe 3 (greyed out with a note below that, warning at 3). `<CC>_<Name>.xml`, `.gpx` (one point per video second, elevation from the track or the route profile by km, `<time>` from 2000-01-01T00:00:00Z counted from the start frame, `<ridrs:videoTime>` = video second), the main image if one exists (JPG preferred, else PNG/WebP as is), `LIESMICH.txt`; no video. `<start-frame>` = round(t_start × fps) + 1 as catalog-web reads it; without fps 30 is assumed and said in LIESMICH. Level 3 without a stored track: start, end and the speed model over the whole video. Cached 24 h under a key of track hash, route, image, fps and level.

## Wishlist for video2gpx

Visitors put a video on the wishlist in the dialog („Add to wishlist“); the editors work the list off as the queue of what video2gpx refines next (migration 0009, `src/wishlist.js`).

- **Who can wish:** only for a visible YouTube video at Lokalisierungsstufe 3 or worse (`wish.refinable` in `/api/videos/:id`); a ride or a video with a secured track has no button. `POST /api/videos/:id/wish`, same origin only (403 otherwise).
- **Counting:** one vote per visitor, video and day: `wish_vote.voter` is SHA-256 of day, IP address and the secret `WISH_SALT` (set it with `wrangler secret put WISH_SALT`; without it the hash has no secret part). Rows of earlier days are deleted with the next vote; no IP address is stored. At most 30 new wishes per visitor and day (429). The browser remembers its own wishes in `localStorage` only to show the button as done.
- **Queue order:** „An die Spitze“ (`priority`, smaller first), then votes, then the oldest wish. Done and dismissed wishes leave the queue; a wish whose video got a video2gpx track (uploaded result or level ≤ 2) counts as done by itself. Votes after „Ablehnen“ still count but do not reopen the wish.
- **For scripts:** `GET /api/admin/queue` (`?all=1` with the closed ones) gives the open queue in order, each row with `position` and `job` (the admin URL of its `video2gpx-job.json`); `POST /api/admin/queue {video_id}`, `PATCH /api/admin/queue/<id> {status | top | priority}`. The export (`/api/admin/export`) has a `wish` line per video. Not done yet: the runner (`video2gpx-yt.sh`) or the desktop app taking the next job from this queue.

## Deploy (not done yet)

1. `npx wrangler login`
2. `npx wrangler d1 create ridrs-scenic`, put the id into `wrangler.jsonc`
3. `npx wrangler d1 migrations apply ridrs-scenic --remote`
4. `npx wrangler secret put YOUTUBE_API_KEY`; `npx wrangler secret put WISH_SALT` (any long random string); `npx wrangler r2 bucket create ridrs-scenic-images`; Cloudflare Access application for `ridrs.app/scenic/admin*` and `ridrs.app/scenic/api/admin/*`, its AUD and the team domain into `vars`
5. `node scripts/import.mjs --remote`, then `pnpm publish:initial --remote` (once: publishes the start set, see below), then `pnpm build && npx wrangler deploy`

Before going public: have `site/impressum.html` and `site/datenschutz.html` (German and English) checked.

## Deviations from the concept, for now

- GPX and sync tracks are static assets, not R2. Workers static assets allow files up to 25 MB, and all 1,848 GPX files fit. R2 comes with the PMTiles base map.
- Base map: OpenFreeMap tiles (allowed for public sites), as in `catalog-web`. Self-hosted PMTiles later.
- Plain JavaScript instead of Astro. Static SEO pages per country and region come in phase 5.
- No elevation profile yet: elevation comes from the DEM in phase 2.
- Preview image variants (1280×720, 400×225 via Cloudflare Images) are not generated yet: the original is served and packed.
- Junctions are not used for Prüfmodus check points (no junction data yet); hairpins are.
