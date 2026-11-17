// node --test tests/analyse/analyseStats.test.ts   (Node >= 23: TypeScript types are stripped)
import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_SPAN_S, clampView, confCls, fmtClock, indexAt, kappaOfRadius, kappaTickLabel, letterbox, niceTicks, radiusText, robustRange, stretchAt, timeTicks, toPicture, valueAt, viewFor, zoomAround } from "../../src/analyseStats.ts";

test("clock and time ticks", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(65.4), "1:05");
  assert.equal(fmtClock(3725), "1:02:05");
  const t = timeTicks(0, 180, 6);
  assert.deepEqual(t, [0, 30, 60, 90, 120, 150, 180]);
  assert.ok(timeTicks(1000, 1030, 6).every((x) => x % 5 === 0 && x >= 1000 && x <= 1030));
  assert.deepEqual(timeTicks(5, 5), [5], "an empty span has one tick");
  assert.ok(timeTicks(0, 26000, 6).length >= 3, "hours");
  assert.deepEqual(niceTicks(-12, 12, 4), [-10, -5, 0, 5, 10]);
});

test("zoom and pan arithmetic on the time axis", () => {
  const v = { v0: 0, v1: 600 };
  const z = zoomAround(v, 0.5, 300, 0, 600);
  assert.ok(Math.abs(z.v1 - z.v0 - 300) < 1e-9 && z.v0 > 0 && z.v1 < 600, "halved around the middle");
  const edge = zoomAround(v, 0.5, 0, 0, 600);
  assert.equal(edge.v0, 0, "the point under the pointer stays where it is");
  let w = v;
  for (let i = 0; i < 20; i++) w = zoomAround(w, 0.4, 100, 0, 600);
  assert.ok(Math.abs(w.v1 - w.v0 - MIN_SPAN_S) < 1e-9, "no narrower than 10 s");
  assert.deepEqual(clampView({ v0: -50, v1: 100 }, 0, 600), { v0: 0, v1: 150 });
  assert.deepEqual(clampView({ v0: 500, v1: 900 }, 0, 600), { v0: 200, v1: 600 });
  assert.deepEqual(clampView({ v0: 0, v1: 5 }, 0, 600), { v0: 0, v1: 10 });
  const s = viewFor(100, 120, 0, 600);
  assert.ok(s.v0 < 100 && s.v1 > 120 && s.v1 - s.v0 >= 40, "room around a stretch");
  const first = viewFor(0, 4, 0, 600);
  assert.equal(first.v0, 0);
});

test("curvature as radius text and axis labels (left positive)", () => {
  assert.equal(radiusText(10), "links, R 100 m");
  assert.equal(radiusText(-20), "rechts, R 50 m");
  assert.equal(radiusText(0.2), "geradeaus");
  assert.equal(radiusText(null), "–");
  assert.equal(radiusText(0.8), "links, R 1,3 km");
  assert.equal(kappaTickLabel(kappaOfRadius(100)), "L 100 m");
  assert.equal(kappaTickLabel(-kappaOfRadius(50)), "R 50 m");
  assert.equal(kappaTickLabel(0), "0");
});

test("the overlay lies on the letterboxed picture", () => {
  // a 16:9 stage showing a 4:3 video: bars left and right
  const a = letterbox(1600, 900, 1440, 1080);
  assert.ok(Math.abs(a.h - 900) < 1e-9 && Math.abs(a.w - 1200) < 1e-9 && Math.abs(a.x - 200) < 1e-9 && a.y === 0);
  // a 16:9 video in a 16:9 stage: the whole stage
  const b = letterbox(1600, 900, 3840, 2160);
  assert.deepEqual([b.x, b.y, Math.round(b.w), Math.round(b.h)], [0, 0, 1600, 900]);
  // a tall video: bars top and bottom of nothing, left and right large
  const c = letterbox(800, 450, 1080, 1920);
  assert.ok(c.x > 200 && Math.abs(c.h - 450) < 1e-9);
  // unknown size: the box
  assert.deepEqual(letterbox(800, 450, 0, 0), { x: 0, y: 0, w: 800, h: 450 });
  // frame coordinates (640 x 360) map to the picture, corners included
  assert.deepEqual(toPicture(a, 640, 360, 0, 0), [200, 0]);
  assert.deepEqual(toPicture(a, 640, 360, 640, 360), [1400, 900]);
  assert.deepEqual(toPicture(a, 640, 360, 320, 180), [800, 450]);
});

test("series lookups", () => {
  const S = { n: 181, t0: 0, dt: 1 };
  assert.equal(indexAt(S, 12.4), 12);
  assert.equal(indexAt(S, -5), 0);
  assert.equal(indexAt(S, 999), 180);
  assert.equal(confCls(0.95, 0), "high");
  assert.equal(confCls(0.9, 0), "high");
  assert.equal(confCls(0.7, 0), "mid");
  assert.equal(confCls(0.49, 0), "low");
  assert.equal(confCls(0.99, 1), "none", "extrapolated is none whatever the value");
  assert.equal(confCls(null, 0), "none");
  const st = [{ t0: 10, t1: 20 }, { t0: 40, t1: 50 }] as any;
  assert.equal(stretchAt(st, 45), st[1]);
  assert.equal(stretchAt(st, 30), null);
  assert.equal(valueAt([0, 10, null, 4], 0.5), 5);
  assert.equal(valueAt([0, 10, null, 4], 1.5), 10, "next to a gap the value of the second itself");
  assert.equal(valueAt([0, 10, null, 4], 2.2), null);
  assert.equal(valueAt([0, 10], 5), null);
  assert.equal(valueAt([2, 4], 1), 4);
});

test("robust display range ignores outliers", () => {
  const a = Array.from({ length: 200 }, (_, i) => (i === 7 ? 5000 : Math.sin(i / 5) * 10));
  const [lo, hi] = robustRange([a], 0.01, 0.99, true, 0, 1);
  assert.ok(hi < 20 && lo > -20 && Math.abs(lo + hi) < 1e-9, "symmetric, not stretched by the spike");
  const [l2, h2] = robustRange([[null, null]], 0.01, 0.99, false, 0, 4);
  assert.deepEqual([l2, h2], [-4, 4], "no data: the floor");
  const [l3, h3] = robustRange([[5, 5, 5]], 0, 1, false, 0, 4);
  assert.deepEqual([l3, h3], [3, 7], "a flat series gets the minimum height");
});
