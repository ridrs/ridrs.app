// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — video2gpx round trip (src/video2gpx.js, VIDEO2GPX-INTEGRATION.md steps A/B and the contract in section 8):
// job endpoint (public and admin), validation of an uploaded result (accepted and rejected), storage as sync track with level 2,
// Prüfmodus to level 1, protection against the import, "Route aus video2gpx übernehmen", undo.
// test/fixtures/video2gpx/ holds the shared example job and payload; apps/video2gpx/tests/atlas/fixtures/ of ridrs_app has byte-identical copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleAdmin, HttpError } from '../src/admin.js';
import worker from '../src/worker.js';
import { buildImportSql } from '../scripts/lib/import-sql.mjs';
import { checkPoints } from '../site/lib/route-sync.js';
import { validateResult, buildJob, growBbox, MAX_POINTS } from '../src/video2gpx.js';
import { makeD1 } from './d1-shim.mjs';

const FIX = new URL('./fixtures/video2gpx/', import.meta.url);
const JOB = JSON.parse(readFileSync(new URL('job.example.json', FIX), 'utf8'));
const RESULT = JSON.parse(readFileSync(new URL('result.example.json', FIX), 'utf8'));
const BASE = 'https://ridrs.example.org/scenic';
const ID = 'V2Gexample1', WHO = { email: 'editor@example.org', via: 'dev' };

// The example video: 1.5 km due east from 7.0° E, 45.0° N, a vertex every 50 m; the pipeline line is [[lat, lon], …].
const LON_PER_M = 1 / (111320 * Math.cos(Math.PI / 4));
const line = Array.from({ length: 31 }, (_, i) => [45, 7 + i * 50 * LON_PER_M]);
const vid = (id, o = {}) => ({ video_id: id, channel_id: 'UCbbbbbbbbbbbbbbbbbbbbbb', region: 'Alps', place: 'Colle Test', lat: 45, lon: 7, position_exact: true,
  country: 'IT', country_name: 'Italien', footage: 'real', vehicle: 'car', topics: [], tech: { fps: 30, max_height: 1080 }, exported_at: '2026-11-18',
  localization: { level: 4, key: 'route', rules_version: 0 },
  route: { distance_km: 1.5, method: 'osrm_waypoints', line, creator_links: [], check: null, elevation: null, roads: null }, ...o });
const yt = new Map([[ID, { channel_id: 'UCbbbbbbbbbbbbbbbbbbbbbb', channel_title: 'Testkanal', title: 'Testfahrt Colle', duration_s: 150, status: 'public', embeddable: true }]]);

function setup(videos = [vid(ID)]) {
  const DB = makeD1();
  DB.raw.exec(buildImportSql({ videos, yt, sync: new Map(), today: '2026-11-18', at: 'x' }).sql.join('\n'));
  DB.raw.exec('UPDATE video SET site_published = 1'); // the public endpoints only serve published videos
  const env = { DB, BASE_PATH: '/scenic' };
  const call = async (method, path, body) => {
    const res = await handleAdmin(new Request(`${BASE}/api/admin/${path}`, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      headers: body === undefined ? {} : { 'content-type': 'application/json' } }), env, WHO, null).catch((err) => {
      if (err instanceof HttpError) return new Response(JSON.stringify({ ...err.extra, error: err.message, status: err.status }), { status: err.status, headers: { 'content-type': 'application/json' } });
      throw err;
    });
    return res.json();
  };
  const q = (s, ...a) => DB.raw.prepare(s).get(...a);
  return { env, call, q, DB };
}
const upload = (call, p) => call('POST', `videos/${ID}/video2gpx`, p);
const clone = (x) => JSON.parse(JSON.stringify(x));

test('job: public endpoint and admin copy give exactly the shared example job', async () => {
  const { env, call, DB } = setup();
  const res = await worker.fetch(new Request(`${BASE}/api/videos/${ID}/video2gpx-job.json`), env, null);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), new RegExp(`${ID}\\.v2g\\.json`));
  assert.deepEqual(await res.json(), JOB);
  assert.deepEqual(await call('GET', `videos/${ID}/video2gpx-job.json`), JOB);
  // Hidden: the public endpoint says 404, the admin still gets the job.
  DB.raw.exec(`UPDATE video SET hidden = 1 WHERE video_id = '${ID}'`);
  assert.equal((await worker.fetch(new Request(`${BASE}/api/videos/${ID}/video2gpx-job.json`), env, null)).status, 404);
  assert.equal((await call('GET', `videos/${ID}/video2gpx-job.json`)).video_id, ID);
  assert.equal((await worker.fetch(new Request(`${BASE}/api/videos/nope/video2gpx-job.json`), env, null)).status, 400);
});

test('job: start/end frames only for a confirmed route; approximate route level 5; pin only without route', () => {
  const v = { video_id: ID, title: 't', duration_s: 10, lat: 45, lon: 7, country: 'IT', vehicle: null };
  const l = line.map(([la, lo]) => [lo, la]);
  const route = { gpx_path: `gpx/${ID}.gpx` };
  const rough = buildJob({ v, route, loc: { loc_level: 5 }, line: l, base: BASE });
  assert.equal(rough.route_level, 5);
  assert.equal(rough.start_bbox, null);
  assert.equal(rough.end_bbox, null);
  assert.equal(rough.route_gpx, `${BASE}/gpx/${ID}.gpx`);
  // Levels 1-3 carry the route level in gates; a verified video with a confirmed route still gets frames.
  const verified = buildJob({ v, route, loc: { loc_level: 1, gates: JSON.stringify({ route: 4 }) }, line: l, base: BASE });
  assert.equal(verified.route_level, 4);
  assert.ok(verified.start_bbox && verified.end_bbox);
  const pin = buildJob({ v, route: null, loc: { loc_level: 6 }, line: null, base: BASE });
  assert.deepEqual([pin.route_gpx, pin.route_level, pin.start_bbox, pin.end_bbox], [null, null, null, null]);
  assert.deepEqual(pin.bbox, growBbox({ south: 45, west: 7, north: 45, east: 7 }, 30));
  const none = buildJob({ v: { ...v, lat: null, lon: null }, route: null, loc: null, line: null, base: BASE });
  assert.equal(none.bbox, null);
});

test('result: the shared example payload is accepted and stored as a manual video2gpx sync track, level 2', async () => {
  const { call, q, env } = setup();
  const r = await upload(call, RESULT);
  assert.equal(r.changed, true, JSON.stringify(r));
  assert.equal(r.level, 2);
  assert.equal(r.points, RESULT.t.length);
  assert.ok(r.route_agreement.median_m < 5, JSON.stringify(r.route_agreement));
  assert.equal(r.route_offer, false);
  const sync = q('SELECT * FROM route_sync WHERE video_id = ?', ID);
  assert.deepEqual([sync.method, sync.path, sync.t_start_s, sync.t_end_s, sync.hash], ['video2gpx', `api/sync/${ID}.json`, RESULT.t_start, RESULT.t_end, r.hash]);
  const track = JSON.parse(q('SELECT json FROM sync_track WHERE video_id = ?', ID).json);
  assert.deepEqual(track, { v: 1, t: RESULT.t, c: RESULT.c, e: RESULT.e });
  const loc = q('SELECT * FROM localization WHERE video_id = ?', ID);
  assert.deepEqual([loc.loc_level, loc.loc_key, loc.method], [2, 'anchored', 'video2gpx']);
  assert.equal(loc.err_cross_med_m, r.route_agreement.median_m);
  const gates = JSON.parse(loc.gates);
  assert.equal(gates.route, 4);
  assert.equal(gates.video2gpx.pipeline_hash, RESULT.pipeline_hash);
  assert.equal(gates.video2gpx.qc.checked_by, WHO.email, 'checked_by comes from the identity, not from the file');
  assert.deepEqual(gates.video2gpx.standstills, RESULT.standstills);
  for (const f of ['sync', 'localization']) assert.ok(q('SELECT 1 x FROM manual_field WHERE video_id = ? AND field = ?', ID, f), f);
  assert.ok(q("SELECT 1 x FROM localization_log WHERE video_id = ? AND to_level = 2 AND reason = 'video2gpx_uploaded'", ID));
  const log = await call('GET', `log?video_id=${ID}`);
  assert.equal(log[0].entity, 'sync');
  assert.equal(log[0].who, WHO.email);
  // Public: the track is served from D1, the video says synced.
  const pub = await worker.fetch(new Request(`${BASE}/api/sync/${ID}.json`), env, null);
  assert.deepEqual(await pub.json(), track);
  assert.equal((await (await worker.fetch(new Request(`${BASE}/api/videos/${ID}`), env, null)).json()).sync.method, 'video2gpx');
  // Same file again: nothing changes.
  assert.equal((await upload(call, RESULT)).changed, false);
});

test('result: the import never overwrites an uploaded track; anchors do not replace it', async () => {
  const { call, q, DB } = setup();
  await upload(call, RESULT);
  const hash = q('SELECT hash FROM route_sync WHERE video_id = ?', ID).hash;
  // The next pipeline export brings a catalogue track and the route level again.
  const sync = new Map([[ID, { method: 'video2gpx', tStart: 0, tEnd: 100, hash: 'pipeline' }]]);
  DB.raw.exec(buildImportSql({ videos: [vid(ID)], yt, sync, today: '2026-11-19', at: 'y' }).sql.join('\n'));
  assert.equal(q('SELECT hash FROM route_sync WHERE video_id = ?', ID).hash, hash);
  assert.equal(q('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 2);
  assert.ok(q('SELECT 1 x FROM sync_track WHERE video_id = ?', ID));
  const r = await call('POST', `videos/${ID}/anchors`, { t: 50, lon: 7 + 450 * LON_PER_M, lat: 45 });
  assert.equal(r.sync.status, 'pipeline_track');
  assert.equal(q('SELECT hash FROM route_sync WHERE video_id = ?', ID).hash, hash);
});

test('result: Prüfmodus lifts it to level 1; a changed upload drops it to 2, the same one keeps 1', async () => {
  const { call, q } = setup();
  await upload(call, RESULT);
  const hash = q('SELECT hash FROM route_sync WHERE video_id = ?', ID).hash;
  const pts = checkPoints({ t: RESULT.t, c: RESULT.c }, line.map(([la, lo]) => [lo, la]));
  const pass = await call('POST', `videos/${ID}/review`, { hash, points: pts.map((t) => ({ t })) });
  assert.equal(pass.passed, true, JSON.stringify(pass));
  assert.equal(q('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 1);
  // The same track again (e.g. uploaded twice from two machines): stays verified.
  const again = clone(RESULT); again.qc.note = 'zweiter Upload';
  assert.equal((await upload(call, again)).level, 1);
  // A changed track: level 2, the verification goes.
  const moved = clone(RESULT); moved.c[10] = [moved.c[10][0] + 0.00001, moved.c[10][1]];
  const r = await upload(call, moved);
  assert.equal(r.level, 2);
  const loc = q('SELECT * FROM localization WHERE video_id = ?', ID);
  assert.deepEqual([loc.loc_level, loc.verified_hash], [2, null]);
  assert.ok(q("SELECT 1 x FROM localization_log WHERE video_id = ? AND from_level = 1 AND to_level = 2 AND reason = 'track_changed'", ID));
});

test('result: points outside the search frame are rejected with a code and pass when the editor overrides', async () => {
  const { call, q } = setup();
  const p = clone(RESULT); p.c = p.c.map(([lo, la]) => [lo, la + 0.2]);
  const r = await upload(call, p);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'outside_bbox');
  assert.equal(r.outside.points, p.t.length);
  assert.ok(r.outside.max_km > 10);
  const ok = await call('POST', `videos/${ID}/video2gpx?outside_bbox=1`, p);
  assert.equal(ok.changed, true, JSON.stringify(ok));
  const g = JSON.parse(q('SELECT gates FROM localization WHERE video_id = ?', ID).gates);
  assert.equal(g.video2gpx.bbox_override.points, p.t.length);
  assert.equal(g.video2gpx.bbox_override.by, WHO.email);
});

test('result: rejected cases (id, order, speed, bbox, size, checklist, verdict, json)', async () => {
  const { call, q } = setup();
  const reject = async (mut, re, status = 400) => {
    const p = clone(RESULT); mut(p);
    const r = await upload(call, p);
    assert.equal(r.status, status, `${re}: ${JSON.stringify(r)}`);
    assert.match(r.error, re);
  };
  await reject((p) => { p.video_id = 'AAAAAAAAAAA'; }, /gehört zu Video AAAAAAAAAAA/);
  await reject((p) => { p.t[5] = p.t[4]; }, /streng steigen/);
  await reject((p) => { p.t = p.t.slice(1); }, /verschieden lang/);
  await reject((p) => { p.c[20] = [p.c[20][0] + 0.01, p.c[20][1]]; }, /Unplausible Geschwindigkeit/);
  await reject((p) => { p.c = p.c.map(([lo, la]) => [lo, la + 0.2]); }, /außerhalb des Suchrahmens/);
  await reject((p) => { p.c[3] = [7, 'x']; }, /kein \[lon, lat\]/);
  await reject((p) => { p.e = p.e.slice(2); }, /e muss/);
  await reject((p) => { p.t = p.t.map((x) => x + 100); }, /Video ist nur 150 s/);
  await reject((p) => { p.qc.checks[0] = { ...p.qc.checks[0], ok: false, overridden: false }; }, /Prüfliste nicht vollständig: verdict/);
  await reject((p) => { p.qc.checks[0] = { ...p.qc.checks[0], ok: false, overridden: true, note: ' ' }; }, /Prüfliste nicht vollständig/);
  await reject((p) => { delete p.qc; }, /qc fehlt/);
  await reject((p) => { p.verdict = 'no_route'; }, /keine Route/);
  await reject((p) => { delete p.pipeline_hash; }, /pipeline_hash/);
  await reject((p) => { p.t_end = p.t_start; }, /t_start und t_end/);
  // Too many points, too large, not JSON.
  const many = Array.from({ length: MAX_POINTS + 1 }, (_, i) => i);
  assert.throws(() => validateResult({ ...RESULT, t: many, c: many.map(() => RESULT.c[0]) }, JOB), (e) => e.status === 413);
  const big = await upload(call, JSON.stringify({ ...RESULT, pad: 'x'.repeat(1_600_000) }));
  assert.equal(big.status, 413);
  assert.match((await upload(call, '{nope')).error, /kein JSON/);
  assert.equal(q('SELECT count(*) n FROM route_sync WHERE video_id = ?', ID).n, 0, 'nothing stored');
});

test('result: a jump is allowed at a listed scene cut; a non-blocking route check may be red', () => {
  const p = clone(RESULT);
  for (let i = 80; i < p.c.length; i++) p.c[i] = [p.c[i][0] + 0.003, p.c[i][1]]; // 236 m forward at 85 s
  assert.throws(() => validateResult(p, JOB), /Unplausible/);
  p.cuts = [p.t[80] - 0.4];
  assert.doesNotThrow(() => validateResult(p, JOB));
  const red = clone(RESULT);
  red.qc.checks = red.qc.checks.map((x) => (x.id === 'route_agreement' ? { ...x, ok: false } : x));
  assert.equal(red.qc.checks.find((x) => x.id === 'route_agreement').blocking, false);
  assert.doesNotThrow(() => validateResult(red, JOB));
});

test('route agreement: median > 50 m offers the route; "Route aus video2gpx übernehmen" keeps the level; undo restores', async () => {
  // The Scenic route lies 80 m north of the driving line: same video, wrong road.
  const shifted = line.map(([la, lo]) => [la + 80 / 111320, lo]);
  const { call: call2, q: q2 } = setup([vid(ID, { route: { ...vid(ID).route, line: shifted } })]);
  const r = await call2('POST', `videos/${ID}/video2gpx`, RESULT);
  assert.ok(r.route_agreement.median_m > 75, JSON.stringify(r));
  assert.equal(r.route_offer, true);
  assert.equal(q2('SELECT method FROM route WHERE video_id = ?', ID).method, 'osrm_waypoints', 'default keeps the Scenic route');
  const t = await call2('PUT', `videos/${ID}/route`, { action: 'from_track' });
  assert.equal(t.changed, true, JSON.stringify(t));
  const route = q2('SELECT * FROM route WHERE video_id = ?', ID);
  assert.equal(route.method, 'video2gpx_track');
  assert.equal(route.gpx_path, `api/videos/${ID}/route.gpx`);
  assert.ok(Math.abs(route.distance_km - 1.4) < 0.1, route.distance_km);
  const first = JSON.parse(route.polyline)[0];
  assert.deepEqual(first, [RESULT.c[0][1], RESULT.c[0][0]]);
  assert.equal(q2('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 2, 'the level stays');
  assert.equal(q2('SELECT method FROM route_sync WHERE video_id = ?', ID).method, 'video2gpx', 'the track stays');
  // Undo the upload: no track, the route level again.
  const up = (await call2('GET', `log?video_id=${ID}`)).find((e) => e.entity === 'sync');
  const routeEdit = (await call2('GET', `log?video_id=${ID}`)).find((e) => e.entity === 'route');
  await call2('POST', `log/${routeEdit.id}/undo`);
  await call2('POST', `log/${up.id}/undo`);
  assert.equal(q2('SELECT count(*) n FROM route_sync WHERE video_id = ?', ID).n, 0);
  assert.equal(q2('SELECT loc_level FROM localization WHERE video_id = ?', ID).loc_level, 4);
  assert.equal(q2("SELECT count(*) n FROM manual_field WHERE video_id = ? AND field = 'sync'", ID).n, 0);
  assert.match((await call2('PUT', `videos/${ID}/route`, { action: 'from_track' })).error, /Kein hochgeladener video2gpx-Track/);
});

test('export: an uploaded track goes to manual.json with its json', async () => {
  const { env, call } = setup();
  await upload(call, RESULT);
  const res = await handleAdmin(new Request(`${BASE}/api/admin/export`), env, WHO, null);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const s = lines.find((l) => l.type === 'sync' && l.video_id === ID);
  assert.equal(s.method, 'video2gpx');
  assert.equal(s.track.t.length, RESULT.t.length);
});
