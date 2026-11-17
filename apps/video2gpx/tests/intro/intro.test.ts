// node --test tests/intro/intro.test.ts   (Node >= 23: TypeScript types are stripped)
import assert from "node:assert/strict";
import { test } from "node:test";
import { introChanged, introMmss, introParam } from "../../src/intro.ts";

test("the intro end set by hand is a positive video second, rounded for the run", () => {
  assert.equal(introParam(49.2549), 49.25);
  assert.equal(introParam(50.336), 50.34);
  for (const x of [0, -1, NaN, Infinity, null, undefined, "49"]) assert.equal(introParam(x), null);
});

test("a rerun is needed only when the value differs from the last run", () => {
  assert.ok(introChanged(49.25, null));
  assert.ok(introChanged(null, 49.25));
  assert.ok(!introChanged(49.251, 49.25));
  assert.ok(!introChanged(null, undefined));
});

test("label time", () => {
  assert.equal(introMmss(49.25), "0:49");
  assert.equal(introMmss(125.9), "2:05");
});
