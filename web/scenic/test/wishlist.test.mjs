// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — wishlist for video2gpx (src/wishlist.js, migrations/0009_wishlist.sql): public votes (one per visitor,
// video and day, same-origin only, only refinable visible videos, daily cap) and the admin queue (order, top, done,
// dismissed, refined videos drop out, undo, export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { handleAdmin } from '../src/admin.js';
import { WISHES_PER_DAY } from '../src/wishlist.js';
import { buildImportSql } from '../scripts/lib/import-sql.mjs';
import { makeD1 } from './d1-shim.mjs';

const BASE = 'https://ridrs.example.org/scenic', WHO = { email: 'editor@example.org', via: 'dev' };
const A = 'AAAAAAAAAA1', B = 'BBBBBBBBBB1', C = 'CCCCCCCCCC1', SYNCED = 'SYNCSYNC001', DRAFT = 'DRAFTDRAFT1';
const line = [[45, 7], [45, 7.01], [45, 7.02]];
const vid = (id, level) => ({ video_id: id, channel_id: 'UCcccccccccccccccccccccc', region: 'Alps', place: 'Test', lat: 45, lon: 7, position_exact: true,
  country: 'IT', country_name: 'Italien', footage: 'real', topics: [], tech: null, exported_at: '2026-11-24',
  localization: { level, key: 'route', rules_version: 0 },
  route: { distance_km: 1.6, method: 'osrm_waypoints', line, creator_links: [], check: null, elevation: null, roads: null } });

function setup() {
  const DB = makeD1();
  DB.raw.exec(buildImportSql({ videos: [vid(A, 4), vid(B, 4), vid(C, 5), vid(SYNCED, 2), vid(DRAFT, 4)], yt: new Map(), sync: new Map(), today: '2026-11-24', at: 'x' }).sql.join('\n'));
  DB.raw.exec(`UPDATE video SET site_published = 1, title = 'Fahrt ' || video_id WHERE video_id != '${DRAFT}'`);
  const env = { DB, ASSETS: { fetch: async () => new Response('index') }, BASE_PATH: '/scenic', WISH_SALT: 'test' };
  const wish = (id, { ip = '203.0.113.1', origin = 'https://ridrs.example.org' } = {}) => worker.fetch(new Request(`${BASE}/api/videos/${id}/wish`,
    { method: 'POST', headers: { 'cf-connecting-ip': ip, ...(origin ? { origin } : {}) } }), env, null);
  const get = (path) => worker.fetch(new Request(`${BASE}/${path}`), env, null).then((r) => r.json());
  // HttpError becomes {error} with its status, as in src/worker.js.
  const admin = (method, path, body) => handleAdmin(new Request(`${BASE}/api/admin/${path}`, { method, body: body && JSON.stringify(body),
    headers: body ? { 'content-type': 'application/json' } : {} }), env, WHO, null)
    .then((r) => (r.headers.get('content-type').includes('ndjson') ? r.text() : r.json()), (err) => ({ error: err.message }));
  return { DB, wish, get, admin };
}

test('public: one vote per visitor and day, refinable visible videos only, same origin only', async () => {
  const { DB, wish, get } = setup();
  assert.deepEqual((await get(`api/videos/${A}`)).wish, { refinable: true, votes: 0, url: `api/videos/${A}/wish` });
  let r = await wish(A);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, counted: true, votes: 1 });
  // The same visitor again: not counted twice.
  assert.deepEqual(await (await wish(A)).json(), { ok: true, counted: false, votes: 1 });
  assert.equal((await (await wish(A, { ip: '203.0.113.2' })).json()).votes, 2);
  assert.equal((await get(`api/videos/${A}`)).wish.votes, 2);
  // No IP address is stored, only the day's hash.
  assert.ok(DB.raw.prepare('SELECT voter FROM wish_vote').all().every((x) => /^[0-9a-f]{32}$/.test(x.voter)));
  // Level 2 is already secured; an unpublished video does not exist for the public; other sites cannot vote.
  assert.equal((await get(`api/videos/${SYNCED}`)).wish.refinable, false);
  assert.equal((await wish(SYNCED)).status, 409);
  assert.equal((await wish(DRAFT)).status, 404);
  assert.equal((await wish(B, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await wish(B, { origin: null })).status, 403);
  assert.equal((await wish('x')).status, 400);
});

test('public: at most WISHES_PER_DAY new wishes per visitor and day; old days are cleared', async () => {
  const { DB, wish } = setup();
  const ids = Array.from({ length: WISHES_PER_DAY }, (_, i) => `ZZZZZZZZ${String(i).padStart(3, '0')}`);
  // Extra rows straight into video (a second import would delete the videos that are not in it).
  for (const id of ids) DB.raw.prepare("INSERT INTO video (video_id, channel_id, lat, lon, site_published, source) SELECT ?, channel_id, lat, lon, 1, 'youtube' FROM video WHERE video_id = ?").run(id, A);
  for (const id of ids) assert.equal((await wish(id)).status, 200);
  assert.equal((await wish(A)).status, 429);
  assert.equal((await wish(A, { ip: '198.51.100.7' })).status, 200);
  DB.raw.exec("UPDATE wish_vote SET day = '2000-01-01'");
  assert.equal((await wish(B)).status, 200);
  assert.equal(DB.raw.prepare("SELECT count(*) AS n FROM wish_vote WHERE day = '2000-01-01'").get().n, 0);
});

test('admin queue: order by priority, votes and age; top, done, dismissed, refined drop out; undo; list marker; export', async () => {
  const { DB, wish, admin } = setup();
  await wish(A); await wish(B); await wish(B, { ip: '203.0.113.9' });
  assert.equal((await admin('POST', 'queue', { video_id: C })).changed, true);
  let q = await admin('GET', 'queue');
  assert.deepEqual(q.map((r) => [r.video_id, r.votes, r.position]), [[B, 2, 1], [A, 1, 2], [C, 0, 3]]);
  assert.equal(q[0].job, `${BASE}/api/admin/videos/${B}/video2gpx-job.json`);
  // „An die Spitze“: C first; the order of the rest stays.
  await admin('PATCH', `queue/${C}`, { top: true });
  assert.deepEqual((await admin('GET', 'queue')).map((r) => r.video_id), [C, B, A]);
  await admin('PATCH', `queue/${A}`, { top: true });
  assert.deepEqual((await admin('GET', 'queue')).map((r) => r.video_id), [A, C, B]);
  // Done and dismissed leave the open queue but stay with ?all=1.
  await admin('PATCH', `queue/${C}`, { status: 'done' });
  await admin('PATCH', `queue/${B}`, { status: 'dismissed' });
  assert.deepEqual((await admin('GET', 'queue')).map((r) => r.video_id), [A]);
  q = await admin('GET', 'queue?all=1');
  assert.deepEqual(q.map((r) => [r.video_id, r.status, r.position]), [[A, 'open', 1], [B, 'dismissed', null], [C, 'done', null]]);
  assert.equal(q[2].priority, null); // a closed wish loses its place at the top
  assert.match((await admin('PATCH', `queue/${A}`, { status: 'later' })).error, /Status/);
  assert.match((await admin('PATCH', `queue/${SYNCED}`, { status: 'done' })).error, /Nicht auf der Wunschliste/);
  // A video whose track video2gpx secured drops out by itself.
  DB.raw.prepare("INSERT INTO route_sync (video_id, method, path) VALUES (?, 'video2gpx', 'api/sync/x.json')").run(A);
  assert.deepEqual(await admin('GET', 'queue'), []);
  assert.equal((await admin('GET', 'queue?all=1'))[0].refined, true);
  // Undo the dismissal: B is open again with its votes.
  const log = await admin('GET', `log?video_id=${B}`);
  assert.equal(log[0].entity, 'wish');
  await admin('POST', `log/${log[0].id}/undo`);
  assert.deepEqual((await admin('GET', 'queue')).map((r) => [r.video_id, r.votes]), [[B, 2]]);
  // Marker and filter in the video list, detail, export.
  const list = await admin('GET', 'videos?only=wish');
  assert.deepEqual(list.rows.map((r) => [r.video_id, r.wish_status, r.wish_votes]), [[B, 'open', 2]]);
  assert.equal((await admin('GET', `videos/${B}`)).wish.votes, 2);
  const exp = (await admin('GET', 'export')).trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.type === 'wish');
  assert.deepEqual(exp.map((x) => x.video_id).sort(), [A, B, C].sort());
});

test('admin queue: an editor\'s own entry can be undone; voting reopens nothing the editors closed', async () => {
  const { DB, wish, admin } = setup();
  const r = await admin('POST', 'queue', { video_id: A });
  assert.equal((await admin('POST', 'queue', { video_id: A })).changed, false);
  await admin('POST', `log/${r.log_id}/undo`);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM wish').get().n, 0);
  await wish(B);
  await admin('PATCH', `queue/${B}`, { status: 'dismissed' });
  await wish(B, { ip: '203.0.113.5' });
  const row = DB.raw.prepare('SELECT votes, status FROM wish WHERE video_id = ?').get(B);
  assert.deepEqual({ ...row }, { votes: 2, status: 'dismissed' });
  assert.match((await admin('POST', 'queue', { video_id: 'nope' })).error, /Unbekannte/);
});
