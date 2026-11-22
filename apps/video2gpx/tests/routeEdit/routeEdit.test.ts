import test from "node:test";
import assert from "node:assert/strict";
import { emptyEdit, insertVia, isRouteEdited, moveVia, nearestArc, normalizeEdit, removeVia } from "../../src/routeEdit.ts";
import type { RoutePoint } from "../../src/types.ts";

const sampleRoute = (): RoutePoint[] =>
  Array.from({ length: 11 }, (_, i) => ({
    t: i * 10,
    lat: 46.0,
    lon: 8.0 + i * 0.001,
    heading: 90,
    confidence: 0.95,
    arc_m: i * 100,
  }));

test("normalizeEdit validates coordinates and drops invalid entries", () => {
  assert.deepEqual(normalizeEdit(null), emptyEdit());
  const ed = normalizeEdit({
    start: { lat: 46.1, lon: 8.2 },
    end: { lat: 999, lon: 8.2 },
    vias: [{ lat: 46.2, lon: 8.3, orig_s: 250 }, { lat: NaN, lon: 8.4 }],
  });
  assert.deepEqual(ed, { start: { lat: 46.1, lon: 8.2 }, end: null, vias: [{ lat: 46.2, lon: 8.3, orig_s: 250 }] });
  assert.equal(isRouteEdited(ed), true);
  assert.equal(isRouteEdited(emptyEdit()), false);
});

test("insertVia orders newly dragged dots along the route arc without fixing timestamps", () => {
  const pts = sampleRoute();
  let vias = insertVia([], { lat: 46.001, lon: 8.007, orig_s: 700 }, 700, pts);
  vias = insertVia(vias, { lat: 46.001, lon: 8.002, orig_s: 200 }, 200, pts);
  vias = insertVia(vias, { lat: 46.001, lon: 8.005, orig_s: 500 }, 500, pts);
  assert.deepEqual(vias.map((v) => v.orig_s), [200, 500, 700]);
  assert.equal(nearestArc(pts, 46.0, 8.004), 400);
});

test("moveVia and removeVia update dots immutably", () => {
  const init = [{ lat: 46.0, lon: 8.1, orig_s: 100 }, { lat: 46.0, lon: 8.2, orig_s: 200 }];
  const moved = moveVia(init, 1, 46.05, 8.25);
  assert.deepEqual(moved[1], { lat: 46.05, lon: 8.25, orig_s: 200 });
  assert.equal(init[1].lat, 46.0);
  const removed = removeVia(moved, 0);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].orig_s, 200);
});
