// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — routes uploaded as GPX (src/tracks.js): parser, simplification, admin API, public GeoJSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpx, simplify, lengthKm, publicTracks, MAX_POINTS, DEFAULT_COLOR } from '../src/tracks.js';
import { handleAdmin, HttpError } from '../src/admin.js';
import { makeD1 } from './d1-shim.mjs';

const WHO = { email: 'editor@example.org', via: 'dev' };
// 10 km due north from (46.5, 10.0), one point every ~11 m.
const pts = Array.from({ length: 901 }, (_, i) => [10, 46.5 + (i * 10) / 900 / 111.2]);
const gpx = (body, name = 'Stilfser &amp; Joch') => `<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Meta</name></metadata>
<trk><name>${name}</name>${body}</trk></gpx>`;
const seg = (p) => `<trkseg>${p.map(([lo, la]) => `<trkpt lat="${la}" lon='${lo}'><ele>1000</ele></trkpt>`).join('')}</trkseg>`;

test('parseGpx: track name, segments, attributes in any order and quotes', () => {
  const g = parseGpx(gpx(seg(pts.slice(0, 3)) + '<trkseg><trkpt lon="11" lat="47"/><trkpt lon="11.1" lat="47.1"/></trkseg>'));
  assert.equal(g.name, 'Stilfser & Joch');
  assert.equal(g.segments.length, 2);
  assert.deepEqual(g.segments[1], [[11, 47], [11.1, 47.1]]);
  assert.equal(g.points, 5);
});

test('parseGpx: routes (rtept) when there is no track; errors for no GPX and no line', () => {
  const g = parseGpx('<gpx><rte><name>Plan</name><rtept lat="1" lon="2"/><rtept lat="1.1" lon="2.1"/></rte></gpx>');
  assert.equal(g.name, 'Plan');
  assert.deepEqual(g.segments, [[[2, 1], [2.1, 1.1]]]);
  assert.throws(() => parseGpx('<kml></kml>'), /Keine GPX/);
  assert.throws(() => parseGpx('<gpx><wpt lat="1" lon="2"/></gpx>'), /keinen Track/);
});

test('simplify keeps a straight line to its ends, caps the point count, length stays', () => {
  assert.deepEqual(simplify([pts]), [[pts[0], pts.at(-1)].map(([lo, la]) => [lo, Math.round(la * 1e5) / 1e5])]);
  const zig = Array.from({ length: 20000 }, (_, i) => [10 + i * 1e-4, 46 + (i % 2) * 3e-4]);
  const out = simplify([zig]);
  assert.ok(out[0].length <= MAX_POINTS);
  assert.ok(Math.abs(lengthKm([pts]) - 10) < 0.05);
});

test('admin: upload, list, edit, publish, delete; public GeoJSON has published ones only', async () => {
  const env = { DB: makeD1() };
  const call = async (method, path, body) => {
    const init = { method };
    if (body instanceof FormData) init.body = body;
    else if (body) { init.body = JSON.stringify(body); init.headers = { 'content-type': 'application/json' }; }
    const res = await handleAdmin(new Request(`http://localhost:8788/api/admin/${path}`, init), env, WHO, null).catch((err) => {
      if (err instanceof HttpError) return new Response(JSON.stringify({ error: err.message, status: err.status }), { status: err.status });
      throw err;
    });
    return res.json();
  };
  const form = (text, fields = {}) => {
    const f = new FormData();
    f.set('file', new File([text], 'stelvio.gpx', { type: 'application/gpx+xml' }));
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const t = await call('POST', 'tracks', form(gpx(seg(pts)), { published: '0' }));
  assert.equal(t.name, 'Stilfser & Joch');
  assert.equal(t.color, DEFAULT_COLOR);
  assert.equal(t.published, false);
  assert.ok(Math.abs(t.distance_km - 10) < 0.05);
  assert.equal((await call('POST', 'tracks', form('nope'))).status, 415);

  assert.equal((await publicTracks(env)).features.length, 0);
  const p = await call('PATCH', `tracks/${t.track_id}`, { published: true, color: '#00AAFF', name: 'Stelvio' });
  assert.deepEqual([p.published, p.color, p.name], [true, '#00aaff', 'Stelvio']);
  assert.equal((await call('PATCH', `tracks/${t.track_id}`, { color: 'red' })).status, 400);

  const pub = await publicTracks(env);
  assert.equal(pub.features.length, 1);
  assert.equal(pub.features[0].geometry.type, 'LineString');
  assert.deepEqual(pub.features[0].properties, { id: t.track_id, name: 'Stelvio', description: null, color: '#00aaff', km: t.distance_km });

  const list = await call('GET', 'tracks');
  assert.equal(list.length, 1);
  assert.equal(list[0].line[0].length, 2);
  const log = await call('GET', 'log');
  assert.deepEqual(log.map((e) => e.entity), ['track', 'track']);

  await call('DELETE', `tracks/${t.track_id}`);
  assert.equal((await call('GET', 'tracks')).length, 0);
  assert.equal((await call('DELETE', `tracks/${t.track_id}`)).status, 404);
});
