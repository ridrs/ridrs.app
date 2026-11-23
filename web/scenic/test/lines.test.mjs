// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — route lines of the overview map (lines.json): the shared encoding (site/lib/lines.js, used by scripts/build.mjs
// and the worker), and the lines set in the admin, which the worker lays over the static lines of the build: a manual route
// (set by hand, or taken from an uploaded video2gpx track) replaces the build's line, and an uploaded video2gpx track gives a line to
// a video that has none. Only published videos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { handleAdmin } from '../src/admin.js';
import { buildImportSql } from '../scripts/lib/import-sql.mjs';
import { encodeLine, decodeLine, simplify } from '../site/lib/lines.js';
import { makeD1 } from './d1-shim.mjs';

const BASE = 'https://ridrs.example.org/scenic';
const PUB = 'PUBPUBPUB01', BARE = 'BAREBAREBA1', DRAFT = 'DRAFTDRAFT1';
// a 2 km bend: east, then north; [lon, lat]
const bend = [...Array.from({ length: 11 }, (_, i) => [7 + i * 0.001, 45]), ...Array.from({ length: 10 }, (_, i) => [7.01, 45 + (i + 1) * 0.001])];
const STATIC = encodeLine([[7, 45], [7.02, 45]]);

const vid = (id, withRoute) => ({ video_id: id, channel_id: 'UCcccccccccccccccccccccc', region: 'Alps', place: 'Test', lat: 45, lon: 7, position_exact: true,
  country: 'IT', country_name: 'Italien', footage: 'real', topics: [], tech: null, exported_at: '2026-11-20',
  localization: { level: 4, key: 'route', rules_version: 0 },
  route: withRoute ? { distance_km: 1.6, method: 'osrm_waypoints', line: [[45, 7], [45, 7.02]], creator_links: [], check: null, elevation: null, roads: null } : null });

const ASSETS = { fetch: async (req) => new URL(req.url).pathname === '/scenic/lines.json'
  ? new Response(JSON.stringify({ [PUB]: STATIC, [DRAFT]: STATIC }), { headers: { 'content-type': 'application/json' } })
  : new Response('index', { headers: { 'content-type': 'text/html' } }) };

function setup() {
  const DB = makeD1();
  DB.raw.exec(buildImportSql({ videos: [vid(PUB, true), vid(BARE, false), vid(DRAFT, true)], yt: new Map(), sync: new Map(), today: '2026-11-20', at: 'x' }).sql.join('\n'));
  DB.raw.exec(`UPDATE video SET site_published = 1 WHERE video_id IN ('${PUB}', '${BARE}')`);
  const run = (sql, ...a) => DB.raw.prepare(sql).run(...a);
  const lines = async () => (await worker.fetch(new Request(`${BASE}/lines.json`), { DB, ASSETS, BASE_PATH: '/scenic' }, null)).json();
  // what the admin writes: a manual route (polyline [[lat, lon]]) with its manual flag, an uploaded video2gpx track
  const manualRoute = (id, lonLat) => {
    run('INSERT OR REPLACE INTO route (video_id, distance_km, method, polyline) VALUES (?, 2, ?, ?)', id, 'video2gpx_track', JSON.stringify(lonLat.map(([lo, la]) => [la, lo])));
    run("INSERT OR REPLACE INTO manual_field (video_id, field, who, at) VALUES (?, 'route', 'editor@example.org', 'x')", id);
  };
  const upload = (id, lonLat) => {
    run("INSERT OR REPLACE INTO route_sync (video_id, method, path, hash) VALUES (?, 'video2gpx', ?, 'h')", id, `api/sync/${id}.json`);
    run('INSERT OR REPLACE INTO sync_track (video_id, json, hash) VALUES (?, ?, ?)', id, JSON.stringify({ v: 1, t: lonLat.map((_, i) => i), c: lonLat }), 'h');
  };
  return { run, lines, manualRoute, upload, DB };
}

test('encoding: delta in 1e-5 degrees, simplified to about 30 m; decodeLine gives the kept points back', () => {
  assert.deepEqual(encodeLine([[7, 45], [7.00001, 45.00002]]), [700000, 4500000, 1, 2]);
  const s = simplify(bend);
  assert.deepEqual(s, [[7, 45], [7.01, 45], [7.01, 45.01]], 'a straight run keeps its ends, the bend its corner');
  assert.deepEqual(decodeLine(encodeLine(bend)), s);
  assert.deepEqual(encodeLine([[7, 45]]), null, 'one point is no line');
});

test('without admin lines, lines.json is the build\'s file cut down to the published videos', async () => {
  const { lines } = setup();
  assert.deepEqual(await lines(), { [PUB]: STATIC });
});

test('a manual route replaces the build\'s line; discarding it brings the build\'s line back', async () => {
  const { lines, manualRoute, run } = setup();
  manualRoute(PUB, bend);
  assert.deepEqual(await lines(), { [PUB]: encodeLine(bend) });
  run("DELETE FROM manual_field WHERE video_id = ? AND field = 'route'", PUB);
  assert.deepEqual(await lines(), { [PUB]: STATIC }, 'a route without the manual flag is the pipeline\'s, already in the build');
});

test('an uploaded video2gpx track gives a line to a video without one; a route of the video wins over its track', async () => {
  const { lines, manualRoute, upload } = setup();
  upload(BARE, bend);
  assert.deepEqual(await lines(), { [PUB]: STATIC, [BARE]: encodeLine(bend) });
  upload(PUB, bend.map(([lo, la]) => [lo + 0.05, la]));
  assert.deepEqual((await lines())[PUB], STATIC, 'the build\'s route stays the line of the map');
  const route = [[7, 45], [7.03, 45]];
  manualRoute(BARE, route);
  assert.deepEqual((await lines())[BARE], encodeLine(route));
});

test('admin lines of unpublished videos stay out', async () => {
  const { lines, manualRoute, upload } = setup();
  manualRoute(DRAFT, bend);
  upload(DRAFT, bend);
  assert.deepEqual(Object.keys(await lines()), [PUB]);
});

test('the admin\'s lines.json has the lines of every video, published or not, with the admin lines laid over them', async () => {
  const { manualRoute, upload, DB } = setup();
  const admin = async () => (await handleAdmin(new Request(`${BASE}/api/admin/lines.json`), { DB, ASSETS, BASE_PATH: '/scenic' }, { email: 'editor@example.org' }, null)).json();
  assert.deepEqual(await admin(), { [PUB]: STATIC, [DRAFT]: STATIC });
  manualRoute(DRAFT, bend);
  upload(BARE, bend);
  assert.deepEqual(await admin(), { [PUB]: STATIC, [DRAFT]: encodeLine(bend), [BARE]: encodeLine(bend) });
});
