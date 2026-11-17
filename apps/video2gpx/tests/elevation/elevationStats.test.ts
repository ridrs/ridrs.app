// node --test tests/elevation/elevationStats.test.ts   (Node >= 23: TypeScript types are stripped)
import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_SPAN_M, clampView, de, gradeClass, gradeSeries, maxGrade, niceTicks, shareText, smoothedDifference, steepStretches, topDifferences, viewFor, zoomAround } from "../../src/elevationStats.ts";

const ramp = (n: number, ds: number, pct: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + (i * ds * pct) / 100);
/** a continuous profile from pieces [samples, grade %] */
const chain = (ds: number, ...parts: [number, number][]): number[] => { const z = [0]; for (const [n, pct] of parts) for (let i = 0; i < n; i++) z.push(z[z.length - 1] + (ds * pct) / 100); return z; };

test("grade and its classes", () => {
  const g = gradeSeries(ramp(40, 5, 6), 5);
  assert.ok(g.every((x) => Math.abs(x - 6) < 1e-9), "a 6 % ramp is 6 % everywhere, ends included");
  assert.deepEqual([3.9, 4, 7.9, 8, 11.9, 12, -15].map(gradeClass), [0, 1, 1, 2, 2, 3, 3]);
  assert.ok(Math.abs(maxGrade(chain(5, [20, 2], [20, 10]), 5) - 10) < 1e-9);
  assert.equal(de(4.5, 0), "5");
  assert.equal(de(12.5, 1), "12,5");
});

test("the places where two profiles differ most: sorted, apart, above the threshold", () => {
  const n = 400, ds = 5, z = new Array<number>(n).fill(100), ref: (number | null)[] = new Array(n).fill(100);
  for (let i = 50; i < 70; i++) ref[i] = 100 + 8;                 // 8 m too high at 250..350 m
  for (let i = 300; i < 320; i++) ref[i] = 100 - 4;               // 4 m too low at 1500..1600 m
  for (let i = 100; i < 104; i++) ref[i] = 100.5;                 // below the threshold
  ref[200] = null;                                                  // null counts as no difference
  const t = topDifferences(z, ref, ds, 0, 5, 300, 1.5);
  assert.equal(t.length, 2);
  assert.ok(t[0].a < t[1].a && t[0].value > t[1].value);
  assert.ok(t[0].a >= 150 && t[0].b <= 450);
  assert.equal(topDifferences(z, ref, ds, 0, 1).length, 1, "count");
  const sm = smoothedDifference(z, ref, ds, 100);
  assert.ok(Math.max(...sm) <= 8 && Math.max(...sm) > 6);
});

test("steep stretches are merged and report the steepest grade", () => {
  const z = chain(5, [40, 3], [30, 14], [40, 2], [30, 13]);
  const s = steepStretches(z, 5, 0, 12);
  assert.equal(s.length, 2);
  assert.ok(s[0].a > 150 && s[0].value > 13 && s[1].value > 12);
  assert.deepEqual(steepStretches(ramp(100, 5, 5), 5), []);
});

test("axis ticks are round and inside the range", () => {
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(412, 468, 5), [420, 430, 440, 450, 460]);
  for (const [lo, hi] of [[0, 62.3], [3.1, 3.4], [-8, 14]]) { const t = niceTicks(lo, hi, 6); assert.ok(t.length >= 2 && t.every((v) => v >= lo - 1e-9 && v <= hi + 1e-9)); }
  assert.deepEqual(niceTicks(5, 5), [5]);
});

test("zoom keeps the point under the pointer, stays inside the route and stops at 200 m", () => {
  const L = 62_000;
  let v = { v0: 0, v1: L };
  v = zoomAround(v, 0.5, 31_000, 0, L);
  assert.ok(Math.abs(v.v1 - v.v0 - 31_000) < 1e-6 && v.v0 >= 0 && v.v1 <= L);
  const at = 40_000; let w = { v0: 30_000, v1: 50_000 };
  const f = (at - w.v0) / (w.v1 - w.v0);
  w = zoomAround(w, 0.25, at, 0, L);
  assert.ok(Math.abs((at - w.v0) / (w.v1 - w.v0) - f) < 1e-9, "the point under the pointer stays at the same place");
  for (let i = 0; i < 40; i++) w = zoomAround(w, 0.5, at, 0, L);
  assert.ok(Math.abs(w.v1 - w.v0 - MIN_SPAN_M) < 1e-6, "the narrowest view is 200 m");
  const out = zoomAround(w, 1e6, at, 0, L);
  assert.deepEqual(out, { v0: 0, v1: L }, "zoomed out fully = the whole route");
  assert.deepEqual(clampView({ v0: -500, v1: 700 }, 0, L), { v0: 0, v1: 1200 });
  assert.deepEqual(clampView({ v0: L - 100, v1: L + 900 }, 0, L), { v0: L - 1000, v1: L });
  const short = clampView({ v0: 0, v1: 50 }, 0, 120);
  assert.ok(short.v1 - short.v0 >= 120 - 1e-9 || short.v1 - short.v0 >= MIN_SPAN_M || short.v1 - short.v0 === 120);
  const vf = viewFor(1000, 1100, 0, L);
  assert.ok(vf.v0 < 1000 && vf.v1 > 1100 && vf.v1 - vf.v0 >= MIN_SPAN_M);
});

test("source shares as text", () => {
  assert.equal(shareText([{ title: "Copernicus DEM GLO-30", sh: 0.21 }, { title: "TINITALY 1.1 (Italy, INGV)", sh: 0.62 }, { title: "NASADEM (SRTM)", sh: 0.02 }]), "TINITALY 62 %, Copernicus DEM GLO-30 21 %");
  assert.equal(shareText([]), "keine");
});
