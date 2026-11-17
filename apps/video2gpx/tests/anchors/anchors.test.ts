// node --test tests/anchors/anchors.test.ts   (Node >= 23: TypeScript types are stripped)
import assert from "node:assert/strict";
import { test } from "node:test";
import { addAnchor, anchorReport, anchorReportDe, anchorsParam, fmtT, normalizeAnchors, removeAnchor, rerunArgs, rerunChoices, sameAnchors } from "../../src/anchors.ts";

const B: [number, number, number, number] = [46.633, 8.592, 46.635, 8.596];

test("anchors are stored sorted, validated and serialised for the run", () => {
  let a = addAnchor([], 68.04, B);
  a = addAnchor(a, 24, [46.63, 8.59, 46.631, 8.591]);
  assert.deepEqual(a.map((x) => x.t), [24, 68]);
  assert.equal(addAnchor(a, 68.3, B).length, 2, "an anchor at the same time is replaced");
  assert.equal(addAnchor(a, 10, [3, 2, 1, 4]).length, 2, "an invalid frame is ignored");
  assert.deepEqual(removeAnchor(a, 0).map((x) => x.t), [68]);
  const json = JSON.parse(JSON.stringify({ anchors: a }));
  assert.deepEqual(normalizeAnchors(json.anchors), a, "app.json round trip");
  assert.deepEqual(normalizeAnchors([{ t: "x", bbox: B }, { t: 3 }, null, { t: 5, bbox: B }]), [{ t: 5, bbox: B }]);
  assert.equal(anchorsParam([]), null);
  assert.deepEqual(anchorsParam(a), a);
  assert.ok(sameAnchors(a, [...a].reverse()) && !sameAnchors(a, removeAnchor(a, 1)) && sameAnchors(null, []));
  assert.equal(fmtT(68.9), "1:08");
  assert.equal(fmtT(375), "6:15");
});

test("step choice of a rerun maps to the CLI options", () => {
  assert.deepEqual(rerunArgs(null), { resume: true, from_step: null });
  assert.deepEqual(rerunArgs("route_search"), { resume: true, from_step: "route_search" });
  assert.deepEqual(rerunArgs("refine"), { resume: true, from_step: "refine" });
  assert.deepEqual(rerunArgs("motion"), { resume: true, from_step: "motion" });
  assert.throws(() => rerunArgs("nope" as any));
  assert.deepEqual(rerunChoices({}), ["motion"]);
  assert.deepEqual(rerunChoices({ motion: true, rotation: true, map: true }), ["motion", "rotation", "map", "route_search"]);
  assert.deepEqual(rerunChoices({ motion: true, rotation: true, map: true, route_search: true, plausibility: true, refine: true, gpx: true }).at(-1), "gpx");
});

test("report of the pipeline in German", () => {
  const r = anchorReport({ n: 2, used: [{ t: 24, bbox: { south: 1, west: 2, north: 3, east: 4 } }], dropped_t: [68] })!;
  assert.deepEqual(r.used[0].bbox, [1, 2, 3, 4]);
  assert.equal(anchorReportDe(r), "1 von 2 Ortsangaben berücksichtigt; nicht erfüllbar und ignoriert: 1:08");
  assert.equal(anchorReportDe(anchorReport({ n: 1, used: [{ t: 5, bbox: [1, 2, 3, 4] }], dropped_t: [] })!), "1 von 1 Ortsangabe berücksichtigt");
  assert.equal(anchorReport(null), null);
});
