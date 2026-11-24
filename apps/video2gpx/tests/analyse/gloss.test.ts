// node --test tests/analyse/gloss.test.ts   (Node >= 23: TypeScript types are stripped)
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVEL_TONE, gloss } from "../../src/features/gloss.ts";

test("cut_jump signal formats German warning for Signale", () => {
  assert.equal(LEVEL_TONE.difficult, "warn");
  const single = gloss({
    key: "cut_jump",
    signal: "cut_jump",
    level: "difficult",
    value: 10643.3,
    message: "free jump across scene cut at 34:35 (10.6 km): the section after the cut was re-matched freely on the map; verify the route after the cut",
  });
  assert.equal(single.label, "Schnitt-Sprung");
  assert.ok(single.text.includes("34:35 (10,6 km)"), single.text);
  assert.ok(single.text.includes("prüfen"), single.text);

  const many = gloss({
    key: "cut_jump",
    signal: "cut_jump",
    level: "difficult",
    value: 2300.0,
    message: "free jump across scene cut at 1:02 (2.3 km), 5:10 (450 m) and 2 more: the section after the cut was re-matched freely on the map; verify the route after the cut",
  });
  assert.ok(many.text.includes("1:02 (2,3 km), 5:10 (450 m) und 2 weitere"), many.text);
});
