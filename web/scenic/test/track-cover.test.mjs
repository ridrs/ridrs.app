// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — route editor geometry (site/lib/track-cover.js): videos along a route in its direction, video time at a point,
// the assignment list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kmAlong } from '../site/lib/route-sync.js';
import { coverage, videosAt, timeAt, projectNear, sliceLine, assignFrom, removeAt, segmentsOf, segmentAt, climb, joinSegments } from '../site/lib/track-cover.js';

const DEG_KM = 1 / 111.32;
// Route: 10 km due north from (10, 46.5), a point every 100 m.
const north = (fromKm, toKm, offsetKm = 0, step = 0.1) => {
  const out = [];
  for (let km = fromKm; km <= toKm + 1e-9; km += step) out.push([10 + (offsetKm * DEG_KM) / Math.cos(46.5 * Math.PI / 180), 46.5 + km * DEG_KM]);
  return out;
};
const route = north(0, 10);
const near = (a, b, tol = 0.1) => Math.abs(a - b) <= tol;

test('coverage: a video on the same road in the same direction covers its stretch', () => {
  const cov = coverage(route, { A: north(2, 6), B: north(0, 10, 0.03) });
  const a = cov.find((c) => c.id === 'A'), b = cov.find((c) => c.id === 'B');
  assert.equal(a.intervals.length, 1);
  assert.ok(near(a.intervals[0].from_km, 2) && near(a.intervals[0].to_km, 6), JSON.stringify(a.intervals));
  assert.ok(near(a.intervals[0].v_from_km, 0) && near(a.intervals[0].v_to_km, 4));
  assert.ok(near(b.km, 10), 'a line 30 m beside the route still counts');
  assert.equal(cov[0].id, 'B', 'longest coverage first');
});

test('coverage: the opposite direction, a road 200 m away and a short touch do not count', () => {
  const cov = coverage(route, { back: north(0, 10).reverse(), far: north(0, 10, 0.2), short: north(4, 4.2), away: [[11, 47], [11.1, 47.1]] });
  assert.deepEqual(cov, []);
});

test('coverage: a video riding out and back counts once, for the way in the route direction', () => {
  const outBack = [...north(3, 7), ...north(3, 7).reverse().slice(1)];
  const [c] = coverage(route, { ob: outBack });
  assert.equal(c.intervals.length, 1);
  assert.ok(near(c.intervals[0].from_km, 3) && near(c.intervals[0].to_km, 7));
});

test('videosAt lists the videos holding a km', () => {
  const cov = coverage(route, { A: north(2, 6), C: north(5, 9) });
  assert.deepEqual(videosAt(cov, 5.5).map((v) => v.id).sort(), ['A', 'C']);
  assert.deepEqual(videosAt(cov, 1).map((v) => v.id), []);
  assert.deepEqual(videosAt(cov, 8).map((v) => v.id), ['C']);
});

test('timeAt: video second where the synced track passes, in the right direction only', () => {
  const c = north(0, 10, 0, 0.01), t = c.map((_, i) => 30 + i); // 10 m/s from second 30
  const p = [10, 46.5 + 5 * DEG_KM];
  assert.ok(near(timeAt({ t, c }, p, [0, 1]).t, 530, 1));
  assert.equal(timeAt({ t, c }, p, [0, -1]), null);
  assert.equal(timeAt({ t, c }, [10.1, 46.5], [0, 1]), null);
  // passed twice: nearT picks the pass
  const c2 = [...c, ...c], t2 = c2.map((_, i) => i);
  assert.ok(near(timeAt({ t: t2, c: c2 }, p, [0, 1], { nearT: 1500 }).t, 1500, 1));
});

test('projectNear and sliceLine', () => {
  const cum = kmAlong(route);
  assert.ok(near(projectNear(route, cum, [10.0005, 46.5 + 4.33 * DEG_KM]).km, 4.33, 0.01));
  assert.ok(near(projectNear(route, cum, [10, 46.5 + 8 * DEG_KM], 2, 1).km, 3, 0.01), 'clamped to the window');
  const s = sliceLine(route, cum, 1.05, 2.05);
  assert.ok(near(kmAlong(s).at(-1), 1, 0.001));
  assert.deepEqual(joinSegments([[[1, 2, 300], [3, 4]], [[5, 6]]]), [[1, 2], [3, 4], [5, 6]]);
});

test('assignments: set from a km, replace, merge equal neighbours, remove, segments', () => {
  let l = assignFrom([], 0, 'A');
  l = assignFrom(l, 4, 'B');
  l = assignFrom(l, 7.12345, 'C');
  assert.deepEqual(l, [{ from_km: 0, video_id: 'A' }, { from_km: 4, video_id: 'B' }, { from_km: 7.123, video_id: 'C' }]);
  assert.deepEqual(assignFrom(l, 4, 'A'), [{ from_km: 0, video_id: 'A' }, { from_km: 7.123, video_id: 'C' }], 'same video as before: merged');
  assert.deepEqual(assignFrom(l, 5, 'B'), l, 'same video as the running one: nothing new');
  assert.deepEqual(assignFrom(l, 9, null).at(-1), { from_km: 9, video_id: null });
  assert.deepEqual(assignFrom([], 2, null), [], 'no leading gap');
  assert.deepEqual(removeAt(l, 4), [{ from_km: 0, video_id: 'A' }, { from_km: 7.123, video_id: 'C' }]);
  assert.deepEqual(removeAt([{ from_km: 0, video_id: 'A' }, { from_km: 2, video_id: 'B' }, { from_km: 3, video_id: 'A' }], 2), [{ from_km: 0, video_id: 'A' }]);
  const segs = segmentsOf(l, 10);
  assert.deepEqual(segs.map((s) => [s.from_km, s.to_km]), [[0, 4], [4, 7.123], [7.123, 10]]);
  assert.equal(segmentAt(segs, 4).video_id, 'B');
  assert.equal(segmentAt(segs, 10).video_id, 'C');
  assert.equal(segmentAt(segmentsOf([{ from_km: 2, video_id: 'A' }], 10), 1), null);
});

test('climb with hysteresis', () => {
  assert.deepEqual(climb([[0, 100], [1, 101], [2, 110], [3, 108], [4, 90]]), { up: 10, down: 20 });
  assert.deepEqual(climb(null), { up: 0, down: 0 });
});

test('autoAssign: synced first, then the furthest reach; gaps get "no video"', async () => {
  const { autoAssign } = await import('../site/lib/track-cover.js');
  const cov = coverage(route, { long: north(0, 6), synced: north(0, 3), late: north(5, 8) });
  const rank = (id) => (id === 'synced' ? 1 : 0);
  const l = autoAssign(cov, 10, rank);
  assert.deepEqual(l.map((x) => x.video_id), ['synced', 'long', 'late', null]);
  assert.ok(near(l[1].from_km, 3) && near(l[2].from_km, 6) && near(l[3].from_km, 8), JSON.stringify(l));
  assert.deepEqual(autoAssign(coverage(route, { mid: north(4, 6) }), 10).map((x) => [Math.round(x.from_km), x.video_id]), [[4, 'mid'], [6, null]]);
  assert.deepEqual(autoAssign([], 10), []);
});

test('intervals bridge a longer gap when the video goes on as far as the route, not when it jumps', async () => {
  const { intervals, samples } = await import('../site/lib/track-cover.js');
  const smp = samples(route);
  const vkm = Float64Array.from(smp, (s) => (s.km < 3 || s.km > 3.6 ? s.km + 1 : NaN));
  assert.equal(intervals(smp, vkm).length, 1, 'a 600 m gap, video continues: one run');
  const jump = Float64Array.from(smp, (s) => (s.km < 3 ? s.km + 1 : s.km > 3.6 ? s.km + 5 : NaN));
  assert.equal(intervals(smp, jump).length, 2, 'the video jumped: two runs');
  const far = Float64Array.from(smp, (s) => (s.km < 3 || s.km > 4.5 ? s.km : NaN));
  assert.equal(intervals(smp, far).length, 2, 'more than maxGapKm: two runs');
});

test('timeAtKm follows the continuous pass where the video passes a place twice', async () => {
  const { timeAtKm, coverLine, samples } = await import('../site/lib/track-cover.js');
  // the video drives km 0–3, loops back to km 0 and drives on to km 10: 10 m/s, 1 point a second
  const c = [...north(0, 3, 0, 0.01), ...north(0, 3, 0.5, 0.01).reverse(), ...north(0, 10, 0, 0.01)], t = c.map((_, i) => i);
  const smp = samples(route), cov = coverLine(smp, c);
  const at5 = timeAtKm({ t, c }, cov.vkm, smp, 5), at2 = timeAtKm({ t, c }, cov.vkm, smp, 2);
  assert.ok(Math.abs(at5 - (602 + 500)) < 3, String(at5));
  assert.ok(at2 < 300 || at2 > 600, 'one of the passes, a real one');
  assert.ok(at5 - timeAtKm({ t, c }, cov.vkm, smp, 4.5) > 40, 'time runs on along the route');
});
