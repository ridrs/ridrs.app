// node --test tests/atlas/atlas.test.ts   (Node >= 23: TypeScript types are stripped)
// The ridrs Scenic round trip (src/atlas.ts, docs/FEATURE_atlas.md): job file -> project hints, the ridrs Scenic checklist, the payload.
// fixtures/ holds the example job and payload of the contract (pov-atlas VIDEO2GPX-INTEGRATION.md section 8); the atlas tests
// (pov-atlas web/test/video2gpx.test.mjs) use byte-identical copies: the job is what the atlas serves, the payload what it accepts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildPayload, coverageOf, cutPieces, jumpCuts, MAX_SPEED_MS, defaultSpan, freshQc, qcFor, resultSig, jobPlan, jobVehicle, parseJob, payloadName, qcChecks, qcReady, routeAgreement, YTDLP_480P, type AtlasQcState } from "../../src/atlas.ts";
import { exampleEleAt, exampleHint, examplePoints, exampleRun, exampleStandstills, exampleState } from "./example.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const JOB_TEXT = fx("job.example.json");
const PAYLOAD = JSON.parse(fx("result.example.json"));
const job = parseJob(JOB_TEXT);
const checks = (state: AtlasQcState, o: Partial<Parameters<typeof qcChecks>[0]> = {}) =>
  qcChecks({ verdict: "confident", points: examplePoints, standstills: exampleStandstills, cutTimes: [], hintLines: exampleHint, hasRoute: true, state, ...o });
const byId = (items: ReturnType<typeof qcChecks>, id: string) => items.find((i) => i.id === id)!;

test("the example job becomes a project with the search frame, start/end frames, the route hint at 300 m and the atlas link", () => {
  assert.equal(job.video_id, "V2Gexample1");
  const p = jobPlan(job);
  assert.equal(p.name, "Testfahrt Colle");
  assert.equal(p.url, "https://www.youtube.com/watch?v=V2Gexample1");
  assert.deepEqual(p.bbox, [44.97305, 6.961887, 45.02695, 7.057169], "bbox as south, west, north, east");
  assert.deepEqual(p.start_frame, [44.997305, 6.996188, 45.002695, 7.003812]);
  assert.deepEqual(p.end_frame, [44.997305, 7.015244, 45.002695, 7.022868]);
  assert.deepEqual(p.hint, { url: "https://ridrs.example.org/scenic/gpx/V2Gexample1.gpx", name: "V2Gexample1.gpx", buffer_m: 300 });
  assert.equal(p.vehicle, "car");
  assert.deepEqual([p.atlas.base, p.atlas.video_id, p.atlas.job], ["https://ridrs.example.org/scenic", "V2Gexample1", job]);
  assert.equal(JSON.parse(JSON.stringify(p.atlas)).job.route_level, 4, "app.json round trip");
});

test("level 5: corridor 1 km and no start/end frames; no route: no hint; vehicle is a soft prior", () => {
  const raw = JSON.parse(JOB_TEXT);
  const rough = jobPlan(parseJob(JSON.stringify({ ...raw, route_level: 5 })));
  assert.equal(rough.hint!.buffer_m, 1000);
  assert.equal(rough.start_frame, null);
  assert.equal(rough.end_frame, null);
  const none = jobPlan(parseJob(JSON.stringify({ ...raw, route_gpx: null, route_level: null, start_bbox: null, end_bbox: null })));
  assert.equal(none.hint, null);
  // frames outside the search frame are dropped (setup rule: start and end frames lie inside it)
  const outside = jobPlan(parseJob(JSON.stringify({ ...raw, start_bbox: { south: 46, west: 7, north: 46.01, east: 7.01 } })));
  assert.equal(outside.start_frame, null);
  assert.deepEqual(["car", "motorcycle", "bike", "bus", null].map(jobVehicle), ["car", "motorcycle", "bike", "auto", "auto"]);
});

test("job files that are not atlas jobs are refused with a German reason", () => {
  const raw = JSON.parse(JOB_TEXT);
  const refused = (j: unknown, re: RegExp) => assert.throws(() => parseJob(typeof j === "string" ? j : JSON.stringify(j)), re);
  refused("{nope", /kein JSON/);
  refused([1], /keine Job-Datei/);
  refused({ ...raw, video_id: "x" }, /Video-ID/);
  refused({ ...raw, url: "javascript:alert(1)" }, /Videoadresse/);
  refused({ ...raw, scenic: { base: "https://a.example", video_id: "other123456" } }, /Verweis auf ridrs Scenic/);
  // jobs written before the rename carry the link as "atlas"
  { const { scenic, ...old } = raw; assert.equal(parseJob(JSON.stringify({ ...old, atlas: scenic })).atlas.base, "https://ridrs.example.org/scenic"); }
  refused({ ...raw, route_level: 3 }, /Routenstufe/);
  refused({ ...raw, route_gpx: "file:///etc/passwd" }, /Routenadresse/);
  refused({ ...raw, bbox: { south: 46, west: 7, north: 45, east: 8 } }, /Rahmen \(bbox\)/);
});

test("checklist of the example: all green, coverage without standstills and with the gap, route agreement 1.6 m", () => {
  const items = checks(exampleState());
  assert.deepEqual(items.map((i) => i.id), ["verdict", "coverage", "route_agreement", "cuts", "intro_outro", "viewed"]);
  assert.ok(items.every((i) => i.ok), JSON.stringify(items.filter((i) => !i.ok)));
  assert.ok(qcReady(items));
  assert.deepEqual(byId(items, "coverage").value, { share: 0.963, max_gap_s: 5 });
  assert.deepEqual(byId(items, "route_agreement").value, { median_m: 1.6, max_m: 1.6 });
  assert.equal(byId(items, "route_agreement").blocking, false);
  assert.deepEqual(defaultSpan(examplePoints, null), { t_start: 5, t_end: 145 });
  assert.deepEqual(defaultSpan(examplePoints, 20), { t_start: 21, t_end: 145 }, "after the intro");
});

test("blocking items need green or an override with a note; no_route and a missing span cannot be overridden", () => {
  const st = exampleState();
  let items = checks(st, { verdict: "uncertain" });
  assert.equal(byId(items, "verdict").ok, false);
  assert.ok(!qcReady(items));
  st.overrides.verdict = "   ";
  assert.ok(!qcReady(checks(st, { verdict: "uncertain" })), "a blank note is no note");
  st.overrides.verdict = "Im Ergebnis geprüft, Kehren stimmen";
  items = checks(st, { verdict: "uncertain" });
  assert.equal(byId(items, "verdict").overridden, true);
  assert.equal(byId(items, "verdict").note, "Im Ergebnis geprüft, Kehren stimmen");
  assert.ok(qcReady(items));
  assert.ok(!qcReady(checks({ ...st, overrides: { verdict: "x" } }, { verdict: "no_route" })), "no_route is never overridable");
  const noView = { ...exampleState(), viewed: { start: true, turn: false, end: true } };
  assert.ok(!qcReady(checks(noView)));
  assert.ok(qcReady(checks({ ...noView, overrides: { viewed: "Strecke ohne Kehren und Kreuzungen" } })));
  const bad = { ...exampleState(), t_start: 2 };   // before the first decoded second
  assert.equal(byId(checks(bad), "intro_outro").ok, false);
  assert.ok(!qcReady(checks({ ...bad, overrides: { intro_outro: "x" } })));
  // the route agreement is shown, never blocking: an atlas route 80 m away keeps the list ready
  const far = exampleHint.map((l) => l.map(([la, lo]) => [la + 80 / 111320, lo] as [number, number]));
  items = checks(exampleState(), { hintLines: far });
  assert.equal(byId(items, "route_agreement").ok, false);
  assert.ok(qcReady(items));
  assert.equal(byId(checks(exampleState(), { hasRoute: false }), "route_agreement").value, null);
});

test("coverage: a gap over 60 s or less than 90 % fails; standstills do not count as driving", () => {
  const pts = examplePoints.map((p) => ({ ...p, in_gap: p.t >= 20 && p.t <= 85 }));
  const c = coverageOf(pts.filter((p) => p.t >= 5 && p.t <= 145), exampleStandstills);
  assert.equal(c.max_gap_s, 60, "66 s gap minus the 6 s standstill");
  assert.ok(c.share < 0.9);
  assert.equal(byId(checks(exampleState(), { points: pts }), "coverage").ok, false);
});

test("cuts: pieces between the cuts must each be ticked", () => {
  assert.deepEqual(cutPieces([3, 50, 100, 200], 5, 145), [[5, 50], [50, 100], [100, 145]]);
  const st = exampleState();
  let it = byId(checks(st, { cutTimes: [50, 100] }), "cuts");
  assert.equal(it.ok, false);
  assert.deepEqual(it.value, { times: [50, 100], checked: [] });
  st.cuts_checked = [5, 50, 100];
  it = byId(checks(st, { cutTimes: [50, 100] }), "cuts");
  assert.equal(it.ok, true);
  assert.equal(byId(checks(exampleState()), "cuts").ok, true, "no cuts: nothing to check");
});

test("payload of the example result is exactly the shared example payload", () => {
  const state = exampleState();
  const items = checks(state);
  const p = buildPayload({ job, ...exampleRun, points: examplePoints, standstills: exampleStandstills, cutTimes: [], state, items, eleAt: exampleEleAt });
  assert.deepEqual(JSON.parse(JSON.stringify(p)), PAYLOAD);
  assert.deepEqual(Object.keys(p), ["video_id", "pipeline_hash", "app_version", "vehicle", "offset_m", "t", "c", "e", "t_start", "t_end", "cuts", "standstills",
    "verdict", "verdict_basis", "confidence_mean", "coverage", "route_km", "qc"]);
  assert.equal(p.t.length, 141);
  assert.ok(p.t.every((x, i) => i === 0 || x === p.t[i - 1] + 1), "one position per video second");
  assert.deepEqual(p.c[0], [7, 44.999986], "c is [lon, lat]");
  assert.equal(payloadName(job), "V2Gexample1.scenic.json");
  // without a profile there is no e; an unfinished list writes nothing
  assert.equal("e" in buildPayload({ job, ...exampleRun, points: examplePoints, standstills: exampleStandstills, cutTimes: [], state, items, eleAt: null }), false);
  const open = { ...state, viewed: { start: false, turn: false, end: false } };
  assert.throws(() => buildPayload({ job, ...exampleRun, points: examplePoints, standstills: exampleStandstills, cutTimes: [], state: open, items: checks(open) }), /Prüfliste/);
  assert.equal(freshQc(examplePoints, null).viewed.start, false);
});

// A video with a cut the scene detection missed: the position jumps 155 m in one second (like 4NgYtX5PiVo at 166 s). ridrs Scenic refuses
// a speed over 252 km/h unless a cut lies within 1 s, so the payload marks the jump as a cut, and the checklist value names it for the hint.
const JUMP_M = 155;
const LON_PER_M = 1 / (111320 * Math.cos(Math.PI / 4));
const withJump = examplePoints.map((p) => (p.t >= 31 ? { ...p, lon: Math.round((p.lon + JUMP_M * LON_PER_M) * 1e7) / 1e7 } : p));
const speedsOk = (t: number[], c: [number, number][], cuts: number[]) => t.every((x, i) => {
  if (!i) return true;
  const k = Math.cos(((c[i - 1][1] + c[i][1]) / 2) * Math.PI / 180);
  const v = Math.hypot((c[i][0] - c[i - 1][0]) * k, c[i][1] - c[i - 1][1]) * 111320 / (x - t[i - 1]);
  return v <= MAX_SPEED_MS || cuts.some((y) => y >= t[i - 1] - 1 && y <= x + 1);
});

test("a jump faster than 252 km/h without a detected cut is marked as a cut in the payload", () => {
  assert.equal(MAX_SPEED_MS, 70, "the same limit as the ridrs Scenic upload check");
  const state = exampleState();
  const found = jumpCuts(withJump, [], 5, 145);
  assert.equal(found.length, 1);
  assert.equal(found[0].t, 30.5, "between the two seconds");
  assert.deepEqual([found[0].from, found[0].to], [30, 31]);
  assert.ok(Math.abs(found[0].m - (JUMP_M + 10)) < 1, `${found[0].m} m`);
  const p = buildPayload({ job, ...exampleRun, points: withJump, standstills: exampleStandstills, cutTimes: [], state, items: checks(state, { points: withJump }) });
  assert.deepEqual(p.cuts, [30.5]);
  assert.ok(speedsOk(p.t, p.c, p.cuts), "ridrs Scenic accepts every step");
  assert.ok(!speedsOk(p.t, p.c, []), "without the cut it would refuse the file");
  // detected cuts come first; a jump next to a detected cut adds nothing
  assert.deepEqual(jumpCuts(withJump, [31.4], 5, 145), []);
  assert.deepEqual(buildPayload({ job, ...exampleRun, points: withJump, standstills: exampleStandstills, cutTimes: [31.4, 90], state,
    items: checks({ ...state, cuts_checked: [5, 31.4, 90] }, { points: withJump, cutTimes: [31.4, 90] }) }).cuts, [31.4, 90]);
  // outside the span, or at normal speed, nothing is marked
  assert.deepEqual(jumpCuts(withJump, [], 40, 145), []);
  assert.deepEqual(jumpCuts(examplePoints, [], 5, 145), []);
});

test("the checklist names a jump marked as a cut, so the export page can show it; without one the value is unchanged", () => {
  const it = byId(checks(exampleState(), { points: withJump }), "cuts");
  assert.equal(it.ok, true, "a hint, not a blocking item");
  assert.deepEqual((it.value as { jumps: unknown }).jumps, [{ t: 30.5, m: 165 }]);
  assert.match(it.detail, /1 Sprung ohne erkannten Schnitt als Schnitt eingetragen/);
  assert.deepEqual(byId(checks(exampleState()), "cuts").value, { times: [], checked: [] }, "the shared example payload stays as it is");
});

test("the 480p import template of the plan (offered as text only, P2)", () => {
  assert.match(YTDLP_480P, /^yt-dlp -f "bv\*\[height>=480\]" -S "\+res,vcodec:h264,fps" --no-playlist -P \{out\} .* -- \{url\}$/);
});

test("the checklist belongs to one result: a new result starts it fresh (span, overrides, ticks), the same result keeps it", async () => {
  const sig = await resultSig('{"points":[1]}');
  assert.match(sig, /^[0-9a-f]{64}$/, "SHA-256 hex");
  assert.equal(await resultSig('{"points":[1]}'), sig, "same text, same signature");
  assert.notEqual(await resultSig('{"points":[2]}'), sig);
  const done: AtlasQcState = { ...exampleState(), result: sig, overrides: { verdict: "geprüft" }, cuts_checked: [40] };
  assert.equal(qcFor(done, sig, examplePoints, null), done, "same result: the ticks stay");
  const fresh = qcFor(done, "other", examplePoints, null);
  assert.equal(fresh.result, "other");
  assert.deepEqual(fresh.viewed, { start: false, turn: false, end: false });
  assert.deepEqual(fresh.overrides, {});
  assert.deepEqual(fresh.cuts_checked, []);
  assert.deepEqual([fresh.t_start, fresh.t_end], [defaultSpan(examplePoints, null).t_start, defaultSpan(examplePoints, null).t_end]);
  assert.equal(fresh.note, "Beispiel", "the free note for the atlas is kept (it stays visible and editable)");
  const legacy = { ...exampleState(), result: undefined } as unknown as AtlasQcState;
  assert.equal(qcFor(legacy, sig, examplePoints, null).viewed.start, false, "a state without a result is stale");
  assert.equal(qcFor(null, sig, examplePoints, null).result, sig);
});
