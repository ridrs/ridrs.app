// node --test tests/router/router.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { STAGES, RESULT_VIEWS, parseRoute, routePath } from "../../src/app/router.ts";

test("ergebnis merges Übersicht, Höhe and Analyse into one stage with 3 views", () => {
  assert.deepEqual([...STAGES], ["einrichten", "berechnung", "ergebnis", "export"]);
  assert.deepEqual([...RESULT_VIEWS], ["uebersicht", "hoehe", "analyse"]);

  assert.deepEqual(parseRoute("#/p/demo-1/ergebnis"), { view: "project", id: "demo-1", stage: "ergebnis", sub: "uebersicht" });
  assert.deepEqual(parseRoute("#/p/demo-1/ergebnis/uebersicht"), { view: "project", id: "demo-1", stage: "ergebnis", sub: "uebersicht" });
  assert.deepEqual(parseRoute("#/p/demo-1/ergebnis/hoehe"), { view: "project", id: "demo-1", stage: "ergebnis", sub: "hoehe" });
  assert.deepEqual(parseRoute("#/p/demo-1/ergebnis/analyse"), { view: "project", id: "demo-1", stage: "ergebnis", sub: "analyse" });
});

test("legacy hoehe and analyse routes resolve to ergebnis sub-views", () => {
  assert.deepEqual(parseRoute("#/p/demo-1/hoehe"), { view: "project", id: "demo-1", stage: "ergebnis", sub: "hoehe" });
  assert.deepEqual(parseRoute("#/p/demo-1/analyse"), { view: "project", id: "demo-1", stage: "ergebnis", sub: "analyse" });
});

test("routePath formats project stage and ergebnis sub-view hashes", () => {
  assert.equal(routePath.project("demo-1", "ergebnis"), "#/p/demo-1/ergebnis");
  assert.equal(routePath.project("demo-1", "ergebnis", "uebersicht"), "#/p/demo-1/ergebnis");
  assert.equal(routePath.project("demo-1", "ergebnis", "hoehe"), "#/p/demo-1/ergebnis/hoehe");
  assert.equal(routePath.project("demo-1", "ergebnis", "analyse"), "#/p/demo-1/ergebnis/analyse");
  assert.equal(routePath.project("demo-1", "export"), "#/p/demo-1/export");
});
