// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — publication (migrations/0006_site_published.sql): the public worker serves only videos the editors
// published in the admin; the import starts new videos unpublished and never touches the flag; the start set is level ≤ 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { handleAdmin } from '../src/admin.js';
import { buildImportSql } from '../scripts/lib/import-sql.mjs';
import { makeD1 } from './d1-shim.mjs';

const BASE = 'https://ridrs.example.org/scenic', WHO = { email: 'editor@example.org', via: 'dev' };
const PUB = 'PUBPUBPUB01', DRAFT = 'DRAFTDRAFT1';
const line = [[45, 7], [45, 7.01], [45, 7.02]];
const vid = (id, level) => ({ video_id: id, channel_id: 'UCcccccccccccccccccccccc', region: 'Alps', place: 'Test', lat: 45, lon: 7, position_exact: true,
  country: 'IT', country_name: 'Italien', footage: 'real', topics: [], tech: null, exported_at: '2026-11-19',
  localization: { level, key: level === 2 ? 'anchored' : 'route', rules_version: 0 },
  route: { distance_km: 1.6, method: 'osrm_waypoints', line, creator_links: [], check: null, elevation: null, roads: null } });
const importSql = (videos) => buildImportSql({ videos, yt: new Map(), sync: new Map(), today: '2026-11-19', at: 'x' }).sql.join('\n');

// Static assets as wrangler serves them from dist/scenic.
const ASSETS = { fetch: async (req) => {
  const p = new URL(req.url).pathname;
  if (p === '/scenic/lines.json') return new Response(JSON.stringify({ [PUB]: [700000, 4500000, 1, 1], [DRAFT]: [700000, 4500000, 2, 2] }), { headers: { 'content-type': 'application/json' } });
  if (/^\/scenic\/(gpx|sync)\//.test(p)) return new Response(`asset ${p}`);
  return new Response('index', { headers: { 'content-type': 'text/html' } });
} };

function setup() {
  const DB = makeD1();
  DB.raw.exec(importSql([vid(PUB, 2), vid(DRAFT, 4)]));
  DB.raw.exec(readFileSync(new URL('../scripts/publish-initial.sql', import.meta.url), 'utf8'));
  const env = { DB, ASSETS, BASE_PATH: '/scenic' };
  const get = (path) => worker.fetch(new Request(`${BASE}/${path}`), env, null);
  const admin = (method, path, body) => handleAdmin(new Request(`${BASE}/api/admin/${path}`, { method, body: body && JSON.stringify(body),
    headers: body ? { 'content-type': 'application/json' } : {} }), env, WHO, null).then((r) => r.json());
  return { DB, env, get, admin };
}

test('start set: only level 1–2 videos are published; the import adds new videos unpublished and keeps the flag', async () => {
  const { DB } = setup();
  const flag = (id) => DB.raw.prepare('SELECT site_published FROM video WHERE video_id = ?').get(id).site_published;
  assert.equal(flag(PUB), 1);
  assert.equal(flag(DRAFT), 0);
  // A second import (DRAFT now at level 2, a new video) changes no flag.
  DB.raw.exec(importSql([vid(PUB, 4), vid(DRAFT, 2), vid('NEWNEWNEW01', 2)]));
  assert.deepEqual([flag(PUB), flag(DRAFT), flag('NEWNEWNEW01')], [1, 0, 0]);
});

test('public API, lines, GPX and sync assets only for published videos', async () => {
  const { get } = setup();
  const pts = await (await get('api/points')).json();
  assert.deepEqual(pts.rows.map((r) => r[0]), [PUB]);
  assert.equal((await get(`api/videos/${PUB}`)).status, 200);
  assert.equal((await get(`api/videos/${DRAFT}`)).status, 404);
  assert.deepEqual(Object.keys(await (await get('lines.json')).json()), [PUB]);
  assert.equal((await get(`gpx/${PUB}.gpx`)).status, 200);
  assert.equal((await get(`gpx/${DRAFT}.gpx`)).status, 404);
  assert.equal((await get(`sync/${PUB}.json`)).status, 200);
  assert.equal((await get(`sync/${DRAFT}.json`)).status, 404);
  assert.equal((await get('gpx/kurz.gpx')).status, 404);
  assert.equal((await get('gpx/sub/x.gpx')).status, 404);
});

test('admin: publish and unpublish with edit log, list filter and undo', async () => {
  const { get, admin } = setup();
  assert.equal((await admin('GET', `videos/${DRAFT}`)).site_published, false);
  await admin('PATCH', `videos/${DRAFT}`, { site_published: true });
  assert.equal((await get(`api/videos/${DRAFT}`)).status, 200);
  const list = await admin('GET', 'videos?only=unpublished');
  assert.deepEqual(list.rows.map((r) => r.video_id), []);
  assert.deepEqual((await admin('GET', 'videos?only=site_published')).rows.map((r) => r.video_id).sort(), [DRAFT, PUB].sort());
  const log = await admin('GET', `log?video_id=${DRAFT}`);
  assert.equal(log[0].field, 'site_published');
  await admin('POST', `log/${log[0].id}/undo`);
  assert.equal((await get(`api/videos/${DRAFT}`)).status, 404);
  assert.equal((await admin('GET', 'videos?only=unpublished')).rows[0].site_published, 0);
});

test('admin map view: all videos with position, published or not, with the list filters', async () => {
  const { admin } = setup();
  const all = await admin('GET', 'videos?map=1');
  assert.deepEqual(all.fields.slice(0, 6), ['id', 'title', 'lon', 'lat', 'loc', 'pub']);
  assert.deepEqual(all.rows.map((r) => [r[0], r[5]]).sort(), [[DRAFT, 0], [PUB, 1]]);
  assert.deepEqual((await admin('GET', 'videos?map=1&only=unpublished')).rows.map((r) => r[0]), [DRAFT]);
});
