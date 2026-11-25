// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — route player timeline (site/lib/route-play.js): segments, km <-> video time, gaps on the speed model,
// clock, and the handover timing of the two-player deck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAY, normalize, videoMapping, buildTimeline, segAtKm, segAtClock, sAtKm, kmAtS, clockAtKm, kmAtClock, videoTimeAtKm, nextVideo, deckPlan, startAt }
  from '../site/lib/route-play.js';
import { kmAlong } from '../site/lib/route-sync.js';

const DEG = 1 / 111.32; // degrees of latitude per km (route-sync's equirectangular measure)
// 10 km due north from (10, 46), a point every 100 m.
const line = Array.from({ length: 101 }, (_, i) => [10, 46 + i * 0.1 * DEG]);
const cum = kmAlong(line);
// A synced track along the route: 20 m/s from km a at second t0, with a stop of 10 s at km a + 1 and a 300 m detour off the road
// (east) for 15 s after km a + 2, during which the route km does not move.
function track(a, t0, km) {
  const t = [], c = [];
  let pos = a, s = t0;
  const push = (lon) => { t.push(s); c.push([lon, 46 + pos * DEG]); s++; };
  while (pos < a + km) {
    push(10);
    if (Math.abs(pos - (a + 1)) < 0.01) for (let i = 0; i < 10; i++) push(10);
    if (Math.abs(pos - (a + 2)) < 0.01) for (let i = 0; i < 15; i++) push(10 + 0.3 * DEG / Math.cos(46 * Math.PI / 180));
    pos = Math.round((pos + 0.02) * 1000) / 1000;
  }
  push(10);
  return { t, c };
}

test('normalize: gap from km 0, merged gaps, continuous assignments of one video merged, unplayable ones are gaps', () => {
  const n = normalize([
    { from_km: 1, video_id: 'A', t_from_s: 10, t_to_s: 100 }, { from_km: 3, video_id: 'A', t_from_s: 100.5, t_to_s: 200 },
    { from_km: 5, video_id: 'B', t_from_s: null, t_to_s: null }, { from_km: 6, video_id: null }, { from_km: 7, video_id: 'A', t_from_s: 300, t_to_s: 350 },
    { from_km: 8, video_id: 'C', t_from_s: 5, t_to_s: 60 }], 10);
  assert.deepEqual(n.map((s) => [s.from_km, s.to_km, s.video_id, s.t_from, s.t_to]),
    [[0, 1, null, null, null], [1, 5, 'A', 10, 200], [5, 7, null, null, null], [7, 8, 'A', 300, 350], [8, 10, 'C', 5, 60]]);
  assert.deepEqual(normalize([], 4).map((s) => [s.from_km, s.to_km, s.video_id]), [[0, 4, null]]);
});

test('videoMapping: rising km, the stop and the detour hold the km, ends exact; linear fallback for a track off the route', () => {
  const tr = track(2, 50, 4);
  const t1 = tr.t.at(-1);
  const m = videoMapping(line, cum, tr, 2, 6, 50, t1);
  assert.equal(m.linear, false);
  assert.equal(m.K[0], 2); assert.equal(m.K.at(-1), 6); assert.equal(m.S.at(-1), t1 - 50);
  for (let i = 1; i < m.K.length; i++) assert.ok(m.K[i] >= m.K[i - 1]);
  // at the stop (km 3) the km stands still for 10 s
  const atStop = m.S.filter((_, i) => Math.abs(m.K[i] - 3) < 1e-6).length;
  assert.ok(atStop >= 10, String(atStop));
  // the detour is 300 m off: those points do not count, the km waits at 4
  const at4 = m.S.filter((_, i) => Math.abs(m.K[i] - 4) < 0.005).length;
  assert.ok(at4 >= 15, String(at4));
  const far = { t: [0, 100], c: [[11, 46], [11, 46.1]] };
  assert.deepEqual(videoMapping(line, cum, far, 1, 3, 0, 100), { K: [1, 3], S: [0, 100], linear: true });
  assert.equal(videoMapping(line, cum, null, 1, 3, 0, 100).linear, true);
});

test('timeline: video segments run on video time, gaps on the speed model; clock and km both ways; video time at km', () => {
  const tr = track(2, 50, 4);
  const tl = buildTimeline({ line: [line], segments: [{ from_km: 2, video_id: 'A', t_from_s: 50, t_to_s: tr.t.at(-1) }, { from_km: 6, video_id: null }],
    tracks: new Map([['A', tr]]) });
  assert.ok(Math.abs(tl.km - 10) < 1e-6);
  assert.deepEqual(tl.segs.map((s) => [s.from_km, s.to_km, s.video_id]), [[0, 2, null], [2, 6, 'A'], [6, tl.km, null]]);
  const [g0, v, g1] = tl.segs;
  // 2 km at the speed model's 90 km/h on a straight (with acceleration from the start): about 80–120 s
  assert.ok(g0.dur > 70 && g0.dur < 130, String(g0.dur));
  assert.equal(v.c0, g0.dur);
  assert.equal(v.dur, tr.t.at(-1) - 50);
  assert.ok(Math.abs(tl.dur - (g0.dur + v.dur + g1.dur)) < 1e-9);
  // round trips
  for (const km of [0, 0.7, 2, 2.5, 3.5, 5.99, 6, 8, 9.999]) assert.ok(Math.abs(kmAtClock(tl, clockAtKm(tl, km)) - km) < 0.002, `km ${km}`);
  for (const c of [0, 10, g0.dur + 1, g0.dur + 100, tl.dur - 1]) {
    const k = kmAtClock(tl, c);
    assert.ok(k >= 0 && k <= tl.km);
  }
  // at km 2.5 the video plays 25 s after t_from (20 m/s, before the stop)
  assert.ok(Math.abs(videoTimeAtKm(v, 2.5) - 75) <= 1, String(videoTimeAtKm(v, 2.5)));
  // km 3 (the stop) maps to the first second of the stop
  assert.ok(Math.abs(videoTimeAtKm(v, 3) - 100) <= 1, String(videoTimeAtKm(v, 3)));
  assert.ok(Math.abs(kmAtS(v, sAtKm(v, 4.5)) - 4.5) < 0.002);
  assert.equal(segAtKm(tl, 2), v); assert.equal(segAtKm(tl, 1.999), g0); assert.equal(segAtKm(tl, tl.km), g1);
  assert.equal(segAtClock(tl, v.c0), v); assert.equal(segAtClock(tl, tl.dur + 5), g1);
});

test('deck plan: next video after at most one gap, buffered 30 s ahead or from the start of a short segment; start before by the latency', () => {
  const segs = [{ from_km: 0, video_id: 'A', t_from_s: 0, t_to_s: 100 }, { from_km: 2, video_id: 'B', t_from_s: 500, t_to_s: 520 },
    { from_km: 2.4, video_id: null }, { from_km: 3, video_id: 'C', t_from_s: 7, t_to_s: 107 }];
  const tl = buildTimeline({ line, segments: segs });
  const [a, b, gap, c] = tl.segs;
  assert.equal(nextVideo(tl, a.i), b); assert.equal(nextVideo(tl, b.i), c); assert.equal(nextVideo(tl, c.i), null);
  assert.equal(deckPlan(tl, 10).preload, null);
  assert.equal(deckPlan(tl, 100 - PLAY.preloadS + 1).preload, b);
  // B lasts 20 s: C (after the gap) is buffered from B's start on only if C starts within 30 s of it
  const p = deckPlan(tl, b.c0 + 1);
  assert.equal(p.seg, b);
  assert.equal(p.preload, c.c0 - b.c0 <= PLAY.preloadS ? c : null);
  // the 600 m gap lasts less than 30 s: C is buffered for the whole gap, so the picture comes at once when the black box ends
  assert.ok(gap.dur < PLAY.preloadS, String(gap.dur));
  assert.equal(deckPlan(tl, gap.c0 + 0.5).preload, c);
  assert.equal(startAt(b, 0.3), b.c0 - 0.3);
  assert.equal(startAt(b, 0.3, 2), b.c0 - 0.6);
});
