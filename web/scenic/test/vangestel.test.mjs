// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — Van Gestel rides on ridrs Scenic (migrations/0007_sources_and_rides.sql): the catalog of
// content/vangestel (scripts/lib/vangestel.mjs) is imported beside the YouTube export, shown on the site once published,
// offered to the app as the ride catalog (docs/formats/scenic-ride-catalog-v1.md) and never sent to the YouTube API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import worker, { refresh } from '../src/worker.js';
import { handleAdmin } from '../src/admin.js';
import { buildImportSql } from '../scripts/lib/import-sql.mjs';
import { countryCode, loadVanGestel } from '../scripts/lib/vangestel.mjs';
import { compute, defaults, fromQuery, toQuery } from '../site/filters.js';
import { makeD1 } from './d1-shim.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const VG = join(FIXTURES, 'vangestel');
const BASE = 'https://ridrs.example.org/scenic', WHO = { email: 'editor@example.org', via: 'dev' };
const ID = 'vg-test-climb', YT = 'YTYTYTYTY01';
const yt = (id) => ({ video_id: id, channel_id: 'UCcccccccccccccccccccccc', region: 'Alps', place: 'Test', lat: 45, lon: 7, position_exact: true,
  country: 'IT', country_name: 'Italien', footage: 'real', topics: [], tech: null, exported_at: '2026-11-21',
  localization: { level: 2, key: 'anchored', rules_version: 0 },
  route: { distance_km: 1, method: 'osrm_waypoints', line: [[45, 7], [45, 7.01]], creator_links: [], check: null, elevation: null, roads: null } });
const importSql = ({ videos = [yt(YT)], rides = loadVanGestel(VG) } = {}) =>
  buildImportSql({ videos, yt: new Map(), sync: new Map(), rides, today: '2026-11-21', at: 'x' }).sql.join('\n');

// Static assets as wrangler serves them from dist/scenic: vg/<slug>/… from the test catalog.
const ASSETS = { fetch: async (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname);
  const m = /^\/scenic\/vg\/([a-z0-9-]+)\/(.+)$/.exec(p);
  if (m) {
    try { return new Response(readFileSync(join(VG, m[1], m[2]))); } catch { return new Response('Not found', { status: 404 }); }
  }
  if (p === '/scenic/lines.json') return new Response(JSON.stringify({ [ID]: [600000, 4500000, 1, 1], [YT]: [700000, 4500000, 1, 1] }));
  return new Response('index', { headers: { 'content-type': 'text/html' } });
} };

function setup({ publish = true } = {}) {
  const DB = makeD1();
  DB.raw.exec(importSql());
  if (publish) DB.raw.exec(readFileSync(new URL('../scripts/publish-initial.sql', import.meta.url), 'utf8'));
  const env = { DB, ASSETS, BASE_PATH: '/scenic' };
  const get = (path, headers = {}) => worker.fetch(new Request(`${BASE}/${path}`, { headers }), env, null);
  const admin = (method, path, body) => handleAdmin(new Request(`${BASE}/api/admin/${path}`, { method, body: body && JSON.stringify(body),
    headers: body ? { 'content-type': 'application/json' } : {} }), env, WHO, null).then((r) => r.json());
  const row = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  return { DB, env, get, admin, row };
}

test('the Van Gestel catalog is read with its package, pictures and track', () => {
  const [r] = loadVanGestel(VG);
  assert.equal(r.id, ID);
  assert.equal(r.slug, 'test-climb');
  assert.equal(r.route.title, 'Test Climb - Part 1 - Col de Test');
  assert.equal(r.source.author, 'Test Author');
  assert.equal(r.country, 'FR');
  assert.equal(countryCode('Germany'), 'DE', 'not the historic DD');
  assert.deepEqual(r.package.map((f) => f.path), ['XX_Test-Climb.xml', 'XX_Test_Climb.gpx']);
  assert.match(r.package[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(r.thumbnail.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.gpx, 'XX_Test_Climb.gpx');
  assert.equal(r.line.length, 11);
  assert.deepEqual(r.line[0], [45, 6]);
  assert.equal(loadVanGestel(join(FIXTURES, 'missing')), null, 'no catalog folder: no rides, the import leaves them alone');
});

test('import: a Van Gestel route becomes a video of its source with route, ride package and level 3, unpublished', () => {
  const { row } = setup({ publish: false });
  const v = row('SELECT * FROM video WHERE video_id = ?', ID);
  assert.equal(v.source, 'vangestel');
  assert.equal(v.channel_id, null);
  assert.equal(v.title, 'Test Climb - Part 1 - Col de Test');
  assert.equal(v.country, 'FR');
  assert.equal(v.duration_s, 300);
  assert.equal(v.published_at, '2023-12-01');
  assert.equal(v.site_published, 0);
  assert.deepEqual([v.lat, v.lon], [45, 6]);
  assert.equal(row('SELECT source FROM video WHERE video_id = ?', YT).source, 'youtube');
  const r = row('SELECT * FROM route WHERE video_id = ?', ID);
  assert.equal(r.method, 'creator_gpx');
  assert.equal(r.distance_km, 1.4);
  assert.equal(r.ascent_m, 100);
  assert.equal(r.gpx_path, `gpx/${ID}.gpx`);
  assert.ok(JSON.parse(r.profile).length >= 2);
  const l = row('SELECT * FROM localization WHERE video_id = ?', ID);
  assert.deepEqual([l.loc_level, l.loc_key, l.method], [3, 'estimated', 'creator_gpx']);
  const p = row('SELECT * FROM ride_package WHERE video_id = ?', ID);
  assert.equal(p.download_url, 'https://cycling.example.org/rlv/XX_Test_Climb.zip');
  assert.equal(p.download_size, 2000012345);
  assert.equal(JSON.parse(p.package).length, 2);
  assert.equal(row("SELECT author FROM source WHERE source_id = 'vangestel'").author, 'Test Author');
  assert.equal(row("SELECT count(*) n FROM video_fts WHERE video_fts MATCH 'Author'").n, 1, 'the author is searchable like a channel');
});

test('import: without the catalog folder the Van Gestel rows stay; a route that left the catalog goes', () => {
  const { DB, row } = setup();
  DB.raw.exec(importSql({ rides: null }));
  assert.equal(row('SELECT site_published FROM video WHERE video_id = ?', ID).site_published, 1);
  DB.raw.exec(importSql({ rides: [] }));
  assert.equal(row('SELECT count(*) n FROM video WHERE video_id = ?', ID).n, 0);
  assert.equal(row('SELECT count(*) n FROM ride_package').n, 0);
  assert.equal(row('SELECT count(*) n FROM video WHERE video_id = ?', YT).n, 1);
});

test('the YouTube refresh never asks about Van Gestel videos', async () => {
  const { DB, row } = setup();
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ items: [] })); };
  try { await refresh({ DB, YOUTUBE_API_KEY: 'k' }); } finally { globalThis.fetch = real; }
  assert.ok(asked.length > 0);
  assert.ok(asked.every((u) => !u.includes(ID)));
  assert.equal(row('SELECT status FROM video WHERE video_id = ?', ID).status, null);
});

test('publication: the start set publishes Van Gestel; points, dialog and assets follow the flag', async () => {
  const unpublished = setup({ publish: false });
  assert.equal((await unpublished.get(`api/videos/${ID}`)).status, 404);
  assert.equal((await unpublished.get('vg/test-climb/thumbnail.jpg')).status, 404);
  const { get } = setup();
  const pts = await (await get('api/points')).json();
  const at = (f) => pts.fields.indexOf(f);
  const vg = pts.rows.find((r) => r[0] === ID);
  assert.ok(vg, 'listed on the map');
  assert.equal(vg[at('src')], 'vangestel');
  assert.equal(vg[at('ride')], 1);
  assert.equal(vg[at('channel')], 'Test Author');
  assert.equal(pts.rows.find((r) => r[0] === YT)[at('ride')], 0);
  assert.equal((await get('vg/test-climb/thumbnail.jpg')).status, 200);
  assert.equal((await get('vg/other/thumbnail.jpg')).status, 404);
});

test('dialog record of a Van Gestel route: source, credits, ride data and the package instead of YouTube', async () => {
  const { get } = setup();
  const v = await (await get(`api/videos/${ID}`)).json();
  assert.equal(v.url, 'https://cycling.example.org/indoor/videos/france/test-climb/');
  assert.equal(v.embeddable, false);
  assert.deepEqual(v.source, { id: 'vangestel', name: 'Van Gestel – Cycling pages', author: 'Test Author', url: 'https://cycling.example.org/indoor/videos/',
    license: { id: 'CC-BY-NC-SA-4.0', name: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' } });
  assert.equal(v.channel.name, 'Test Author');
  assert.deepEqual(v.ride.tour, { name: 'Test Climb', part: 1 });
  assert.equal(v.ride.level, 'Moderate');
  assert.equal(v.ride.climbs[0].name, 'Col de Test');
  assert.equal(v.ride.download_size, 2000012345);
  const h = createHash('sha256').update(readFileSync(join(VG, 'test-climb/overlay/preview.jpg'))).digest('hex').slice(0, 12);
  assert.deepEqual(v.image, { url: `vg/test-climb/web/picture-1280.jpg?h=${h}`,
    srcset: `vg/test-climb/web/picture-640.jpg?h=${h} 640w, vg/test-climb/web/picture-1280.jpg?h=${h} 1280w`,
    width: null, height: null, rights: null, credit: 'Test Author' });
  assert.deepEqual(v.incyclist, { available: true, level: 3, warn: false, url: `api/videos/${ID}/package.zip`, package: true });
  assert.equal(v.route.gpx, `gpx/${ID}.gpx`);
});

test('package without video: the package files, the overlay and a read-me, never the video', async () => {
  const { get } = setup();
  const res = await get(`api/videos/${ID}/package.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /filename="test-climb\.zip"/);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['LIESMICH.txt', 'XX_Test-Climb.xml', 'XX_Test_Climb.gpx', 'preview.jpg']);
  assert.equal(strFromU8(files['preview.jpg']), 'preview of the test climb\n');
  assert.match(strFromU8(files['LIESMICH.txt']), /Test Author/);
  assert.match(strFromU8(files['LIESMICH.txt']), /CC BY-NC-SA 4\.0/);
  assert.equal((await get(`api/videos/${YT}/package.zip`)).status, 404, 'only entries with a ride package');
});

test('ride catalog for the app: exactly the test vector, with ETag and 304', async () => {
  const { get, admin } = setup();
  const res = await get('api/ride/v1/catalog.json');
  assert.equal(res.status, 200);
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'ride-catalog/catalog.example.json'), 'utf8'));
  assert.deepEqual(await res.json(), expected);
  const etag = res.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]+"$/);
  assert.equal((await get('api/ride/v1/catalog.json', { 'if-none-match': etag })).status, 304);
  // Withdrawn in the admin: gone from the catalog, with a new tag.
  await admin('PATCH', `videos/${ID}`, { site_published: false });
  const after = await get('api/ride/v1/catalog.json', { 'if-none-match': etag });
  assert.equal(after.status, 200);
  assert.deepEqual((await after.json()).routes, []);
});

test('filter "rideable in ridrs" (ride=1): only entries with a ride package, in the URL and as a facet', () => {
  const videos = [{ id: 'a', ride: 1, topics: [], search: '' }, { id: 'b', ride: 0, topics: [], search: '' }];
  const s = { ...defaults(), ride: true };
  assert.deepEqual(compute(videos, s).result.map((v) => v.id), ['a']);
  assert.equal(compute(videos, defaults()).facets.ride, 1);
  assert.equal(toQuery(s), '?ride=1');
  assert.equal(fromQuery('?ride=1').ride, true);
});
