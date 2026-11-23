// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — admin API (src/admin.js) against the migrations in node:sqlite: edits with log and undo,
// anchors -> sync track -> Lokalisierungsstufe, Prüfmodus, route editing, collections, opt-out, export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, HttpError } from '../src/admin.js';
import { buildImportSql } from '../scripts/lib/import-sql.mjs';
import { checkPoints } from '../site/lib/route-sync.js';
import { makeD1 } from './d1-shim.mjs';

const ID = 'AAAAAAAAAAA', WHO = { email: 'editor@example.org', via: 'dev' };
// 25 km due east along the equator, a vertex every ~111 m; the pipeline line is [[lat, lon], …].
const KM = (km) => km / 111.32;
const line = Array.from({ length: 226 }, (_, i) => [0, KM(i * 25 / 225)]);
const vid = (id, o = {}) => ({ video_id: id, channel_id: 'UCaaaaaaaaaaaaaaaaaaaaaa', region: 'Alps', place: 'Bormio', lat: 0, lon: 0, position_exact: true,
  country: 'IT', country_name: 'Italien', footage: 'real', topics: [], tech: null, exported_at: '2026-11-18', localization: { level: 4, key: 'route', rules_version: 0 },
  route: { distance_km: 25, method: 'osrm_waypoints', line, creator_links: [], check: null, elevation: { profile: [[0, 100], [25, 600]] }, roads: { class_share: { primary: 1 } } }, ...o });

function setup() {
  const DB = makeD1();
  const { sql } = buildImportSql({ videos: [vid(ID), vid('BBBBBBBBBBB')], yt: new Map(), sync: new Map(), today: '2026-11-18', at: 'x' });
  DB.raw.exec(sql.join('\n'));
  DB.raw.exec(`UPDATE video SET duration_s = 1800, title = 'Testfahrt'`);
  const env = { DB };
  const call = async (method, path, body) => {
    // The worker turns HttpError into {error} with its status (src/worker.js); the same here.
    const res = await handleAdmin(new Request(`http://localhost:8788/api/admin/${path}`, { method, body: body ? JSON.stringify(body) : undefined,
      headers: body ? { 'content-type': 'application/json' } : {} }), env, WHO, null).catch((err) => {
      if (err instanceof HttpError) return new Response(JSON.stringify({ error: err.message }), { status: err.status, headers: { 'content-type': 'application/json' } });
      throw err;
    });
    return res.headers.get('content-type').includes('ndjson') ? res.text() : res.json();
  };
  const q = (s, ...a) => DB.raw.prepare(s).get(...a);
  q.fields = (id) => DB.raw.prepare('SELECT field FROM manual_field WHERE video_id = ? ORDER BY field').all(id).map((r) => r.field);
  return { env, call, q };
}

test('editorial and location fields: change, edit_log with identity, manual flag, undo', async () => {
  const { call, q } = setup();
  await call('PATCH', `videos/${ID}`, { stars: 4, editors_pick: true, editor_note: 'Schön', place: 'Passo X', pin: { lat: 0.01, lon: 0.02 }, country: { country: 'ch', country_name: 'Schweiz' } });
  const v = q('SELECT * FROM video WHERE video_id = ?', ID);
  assert.deepEqual([v.stars, v.editors_pick, v.editor_note, v.place, v.lat, v.lon, v.country, v.country_name], [4, 1, 'Schön', 'Passo X', 0.01, 0.02, 'CH', 'Schweiz']);
  const manual = q.fields(ID);
  assert.deepEqual(manual, ['country', 'country_name', 'lat', 'lon', 'place', 'position_exact']);
  const log = await call('GET', `log?video_id=${ID}`);
  assert.equal(log.length, 6);
  assert.ok(log.every((e) => e.who === 'editor@example.org'));
  const placeEdit = log.find((e) => e.field === 'place');
  assert.deepEqual(placeEdit.old, { value: 'Bormio', manual: false });
  // Undo the place edit: value and manual flag go back; undo is logged and itself undoable.
  const u = await call('POST', `log/${placeEdit.id}/undo`);
  assert.equal(u.changed, true);
  assert.equal(q('SELECT place FROM video WHERE video_id = ?', ID).place, 'Bormio');
  assert.ok(!q.fields(ID).includes('place'));
  assert.equal((await call('POST', `log/${placeEdit.id}/undo`)).error, 'Schon zurückgenommen');
  await call('POST', `log/${u.log_id}/undo`);
  assert.equal(q('SELECT place FROM video WHERE video_id = ?', ID).place, 'Passo X');
  assert.match((await call('PATCH', `videos/${ID}`, { stars: 7 })).error, /Sterne/);
  assert.match((await call('PATCH', `videos/${ID}`, { title: 'x' })).error, /nicht editierbar/);
});
test('anchors: snapped to the route, track built, level 3 then 2, back after delete and undo', async () => {
  const { call, q } = setup();
  let r = await call('POST', `videos/${ID}/anchors`, { t: 60, lon: KM(0.3), lat: 0.0005 }); // 55 m beside the road
  assert.equal(r.changed, true);
  assert.ok(Math.abs(r.anchor.lat) < 1e-9, 'snapped onto the line');
  assert.equal(r.sync.status, 'built');
  assert.equal(r.sync.level, 3);
  await call('POST', `videos/${ID}/anchors`, { t: 900, lon: KM(12), lat: 0 });
  r = await call('POST', `videos/${ID}/anchors`, { t: 1700, lon: KM(24.6), lat: 0 });
  assert.equal(r.sync.level, 2, JSON.stringify(r.sync.rule));
  const sync = q('SELECT * FROM route_sync WHERE video_id = ?', ID);
  assert.equal(sync.method, 'anchors');
  assert.equal(sync.path, `api/sync/${ID}.json`);
  const track = JSON.parse(q('SELECT json FROM sync_track WHERE video_id = ?', ID).json);
  assert.equal(track.t.length, track.c.length);
  assert.ok(track.e.length === track.t.length);
  const loc = q('SELECT * FROM localization WHERE video_id = ?', ID);
  assert.deepEqual([loc.loc_level, loc.loc_key, loc.method, loc.anchor_count], [2, 'anchored', 'anchors_manual', 3]);
  assert.ok(q("SELECT 1 x FROM manual_field WHERE video_id = ? AND field = 'localization'", ID));
  assert.ok(q("SELECT 1 x FROM localization_log WHERE video_id = ? AND to_level = 2 AND reason = 'anchors_added'", ID));
  // Too far from the route, and outside the video.
  assert.match((await call('POST', `videos/${ID}/anchors`, { t: 100, lon: KM(5), lat: 0.05 })).error, /neben der Route/);
  assert.match((await call('POST', `videos/${ID}/anchors`, { t: 5000, lon: KM(5), lat: 0 })).error, /außerhalb/);
  // Delete the middle anchor -> level 3; undo -> level 2 again.
  r = await call('DELETE', `videos/${ID}/anchors/900`);
  assert.equal(r.sync.level, 3);
  const del = (await call('GET', `log?video_id=${ID}`)).find((e) => e.entity === 'anchor' && e.new === null);
  await call('POST', `log/${del.id}/undo`);
  assert.equal(q('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 2);
  // Remove all anchors: the level falls back to the route's 4 and the track goes.
  for (const t of [60, 900, 1700]) await call('DELETE', `videos/${ID}/anchors/${t}`);
  assert.equal(q('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 4);
  assert.equal(q('SELECT count(*) n FROM route_sync WHERE video_id = ?', ID).n, 0);
});

test('Prüfmodus: pass -> level 1 with hash; a later anchor change drops it to 2', async () => {
  const { call, q } = setup();
  for (const [t, km] of [[30, 0.2], [900, 12], [1750, 24.8]]) await call('POST', `videos/${ID}/anchors`, { t, lon: KM(km), lat: 0 });
  const track = JSON.parse(q('SELECT json FROM sync_track WHERE video_id = ?', ID).json);
  const hash = q('SELECT hash FROM route_sync WHERE video_id = ?', ID).hash;
  const pts = checkPoints(track, line.map(([la, lo]) => [lo, la]));
  const fail = await call('POST', `videos/${ID}/review`, { hash, points: pts.map((t, i) => (i === 2 ? { t, wrong_road: true } : { t })) });
  assert.equal(fail.passed, false);
  assert.equal(fail.level, 2);
  const pass = await call('POST', `videos/${ID}/review`, { hash, points: pts.map((t) => ({ t })) });
  assert.equal(pass.passed, true);
  const loc = q('SELECT * FROM localization WHERE video_id = ?', ID);
  assert.deepEqual([loc.loc_level, loc.loc_key, loc.verified_by, loc.verified_hash], [1, 'verified', 'editor@example.org', hash]);
  assert.equal(JSON.parse(loc.check_points).length, pts.length);
  assert.ok(q("SELECT 1 x FROM localization_log WHERE video_id = ? AND reason = 'review_passed'", ID));
  assert.equal((await call('POST', `videos/${ID}/review`, { hash: 'old', points: [] })).error, 'Der Track hat sich während der Prüfung geändert');
  await call('POST', `videos/${ID}/anchors`, { t: 450, lon: KM(6), lat: 0 });
  assert.equal(q('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 2);
  assert.ok(q("SELECT 1 x FROM localization_log WHERE video_id = ? AND reason = 'track_changed'", ID));
});

test('route: set (manual, level 4), reverse, discard, undo', async () => {
  const { call, q } = setup();
  const newLine = [[0, 0], [KM(5), 0.001], [KM(10), 0]];
  let r = await call('PUT', `videos/${ID}/route`, { action: 'set', line: newLine, via: [[0, 0], [KM(10), 0]] });
  assert.equal(r.changed, true);
  let route = q('SELECT * FROM route WHERE video_id = ?', ID);
  assert.equal(route.method, 'manual_osrm');
  assert.equal(route.gpx_path, `api/videos/${ID}/route.gpx`);
  assert.ok(Math.abs(route.distance_km - 10) < 0.2);
  assert.equal(q('SELECT count(*) n FROM route_road WHERE video_id = ?', ID).n, 0);
  assert.ok(q("SELECT 1 x FROM manual_field WHERE video_id = ? AND field = 'route'", ID));
  await call('PUT', `videos/${ID}/route`, { action: 'reverse' });
  route = q('SELECT * FROM route WHERE video_id = ?', ID);
  assert.deepEqual(JSON.parse(route.polyline)[0], [0, KM(10)]);
  assert.equal(route.method, 'manual_osrm_reversed');
  await call('PUT', `videos/${ID}/route`, { action: 'discard' });
  assert.equal(q('SELECT count(*) n FROM route WHERE video_id = ?', ID).n, 0);
  assert.equal(q('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 6);
  const log = (await call('GET', `log?video_id=${ID}`)).filter((e) => e.entity === 'route');
  assert.equal(log.length, 3);
  await call('POST', `log/${log[0].id}/undo`); // undo the discard
  assert.equal(q('SELECT method FROM route WHERE video_id = ?', ID).method, 'manual_osrm_reversed');
  assert.equal(q('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 4);
  // Undo in order back to the pipeline route, which then is no longer manual.
  await call('POST', `log/${log[1].id}/undo`);
  await call('POST', `log/${log[2].id}/undo`);
  assert.equal(q('SELECT method FROM route WHERE video_id = ?', ID).method, 'osrm_waypoints');
  assert.equal(q('SELECT count(*) n FROM route_road WHERE video_id = ?', ID).n, 1);
  assert.equal(q("SELECT count(*) n FROM manual_field WHERE video_id = ? AND field = 'route'", ID).n, 0);
});

test('collections, opt-out and export', async () => {
  const { call, q } = setup();
  const c = await call('POST', 'collections', { title: 'Die schönsten Pässe' });
  assert.equal(c.slug, 'die-schonsten-passe');
  await call('POST', `collections/${c.collection_id}/items`, { video_id: ID });
  await call('POST', `collections/${c.collection_id}/items`, { video_id: 'BBBBBBBBBBB' });
  await call('PUT', `collections/${c.collection_id}/items`, { order: ['BBBBBBBBBBB', ID] });
  let list = await call('GET', 'collections');
  assert.deepEqual(list[0].items.map((i) => i.video_id), ['BBBBBBBBBBB', ID]);
  const orderEdit = (await call('GET', 'log')).find((e) => e.entity === 'collection_order');
  await call('POST', `log/${orderEdit.id}/undo`);
  list = await call('GET', 'collections');
  assert.deepEqual(list[0].items.map((i) => i.video_id), [ID, 'BBBBBBBBBBB']);
  await call('PATCH', `collections/${c.collection_id}`, { title: 'Pässe' });
  await call('DELETE', `collections/${c.collection_id}/items/${ID}`);
  const del = await call('DELETE', `collections/${c.collection_id}`);
  assert.equal(del.changed, true);
  assert.equal((await call('GET', 'collections')).length, 0);
  await call('POST', `log/${del.log_id}/undo`);
  assert.equal((await call('GET', 'collections'))[0].title, 'Pässe');

  await call('POST', 'optout', { channel_id: 'UCaaaaaaaaaaaaaaaaaaaaaa', note: 'E-Mail vom 18.11.' });
  assert.equal((await call('GET', 'optout'))[0].videos, 2);
  assert.match((await call('POST', 'optout', { channel_id: 'nope' })).error, /Kanal-ID/);

  await call('PATCH', `videos/${ID}`, { stars: 5, place: 'Hand' });
  await call('POST', `videos/${ID}/anchors`, { t: 60, lon: KM(0.3), lat: 0 });
  const lines = (await call('GET', 'export')).trim().split('\n').map((l) => JSON.parse(l));
  const types = new Set(lines.map((l) => l.type));
  for (const t of ['meta', 'video', 'anchor', 'sync', 'localization', 'collection', 'optout', 'edit', 'localization_log']) assert.ok(types.has(t), t);
  const v = lines.find((l) => l.type === 'video' && l.video_id === ID);
  assert.equal(v.editorial.stars, 5);
  assert.equal(v.manual.place, 'Hand');
  assert.ok(lines.filter((l) => l.type === 'edit').every((e) => e.who));
});
test('list filter "noimage": level 1 and 2 without a preview image, in the list and on the map', async () => {
  const { env, call } = setup();
  const run = (s, ...a) => env.DB.raw.prepare(s).run(...a);
  const C = 'CCCCCCCCCCC', D = 'DDDDDDDDDDD';
  env.DB.raw.exec(buildImportSql({ videos: [vid(ID), vid('BBBBBBBBBBB'), vid(C), vid(D)], yt: new Map(), sync: new Map(), today: '2026-11-18', at: 'x' }).sql.join('\n'));
  run('UPDATE localization SET loc_level = 1 WHERE video_id = ?', ID);
  run('UPDATE localization SET loc_level = 2 WHERE video_id IN (?, ?)', 'BBBBBBBBBBB', C);
  // D stays at level 4: no image either, but not in the filter
  run("INSERT INTO video_image (image_id, video_id, kind, r2_key, mime, is_primary) VALUES ('img1', 'BBBBBBBBBBB', 'upload', 'k', 'image/jpeg', 1)");
  const list = await call('GET', 'videos?only=noimage');
  assert.deepEqual(list.rows.map((r) => r.video_id).sort(), [ID, C]);
  const map = await call('GET', 'videos?only=noimage&map=1');
  assert.deepEqual(map.rows.map((r) => r[0]).sort(), [ID, C]);
  // a ride whose package brings its own picture has a preview image
  run(`INSERT INTO ride_package (video_id, download_url, download_format, download_size, distance_m, ascent_m, sparkline, thumbnail, package)
    VALUES (?, 'u', 'incyclist-gpx-import', 1, 1, 1, '[]', '{"path":"thumbnail.jpg"}', '[]')`, C);
  assert.deepEqual((await call('GET', 'videos?only=noimage')).rows.map((r) => r.video_id), [ID]);
});
