// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — anchor interpolation, sync track building, level rules and Prüfmodus (site/lib/route-sync.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kmAlong, project, pointAt, buildTrack, anchorLevel, trackAt, checkPoints, evaluateReview, speedModel, LOC_RULES } from '../site/lib/route-sync.js';

// Straight line along the equator, 0.1° = 11.132 km, a vertex every ~111 m.
const LINE = Array.from({ length: 101 }, (_, i) => [i * 0.001, 0]);
const KM = (km) => [km / 111.32, 0];
const lonKm = (p) => p[0] * 111.32;

test('geometry: km along, projection, point at km', () => {
  const cum = kmAlong(LINE);
  assert.ok(Math.abs(cum.at(-1) - 11.132) < 1e-6);
  const p = project(LINE, cum, [0.05, 0.001]); // ~111 m north of km 5.566
  assert.ok(Math.abs(p.km - 5.566) < 1e-3);
  assert.ok(Math.abs(p.dist_m - 111.32) < 0.5);
  assert.ok(Math.abs(lonKm(pointAt(LINE, cum, 3)) - 3) < 1e-9);
});

test('speed model slows down in a hairpin', () => {
  // 1 km east, a U-turn of radius ~20 m, 1 km back west.
  const line = [];
  for (let i = 0; i <= 100; i++) line.push([i * 0.0000898, 0]);
  const cx = 100 * 0.0000898, r = 0.00018;
  for (let a = 1; a < 18; a++) line.push([cx + r * Math.sin((a * Math.PI) / 18), r - r * Math.cos((a * Math.PI) / 18)]);
  for (let i = 100; i >= 0; i--) line.push([i * 0.0000898, 2 * r]);
  const { V, K } = speedModel(line, kmAlong(line));
  const slowest = Math.min(...V), atStraight = V[Math.round(0.3 / 0.025)];
  assert.ok(slowest < 8, `hairpin speed ${slowest} m/s`);
  assert.ok(atStraight > 20, `straight speed ${atStraight} m/s`);
  assert.ok(K.length > 80);
});

test('buildTrack: piecewise linear between anchors on a straight road, model outside', () => {
  const r = buildTrack({ line: LINE, anchors: [{ t: 100, lon: KM(1)[0], lat: 0 }, { t: 500, lon: KM(9)[0], lat: 0 }], duration: 3600 });
  const { track } = r;
  assert.equal(track.v, 1);
  assert.equal(track.t.length, track.c.length);
  for (let i = 1; i < track.t.length; i++) assert.equal(track.t[i] - track.t[i - 1], 1); // one point per second
  const kmAt = (s) => lonKm(trackAt(track, s));
  assert.ok(Math.abs(kmAt(100) - 1) < 0.01);
  assert.ok(Math.abs(kmAt(300) - 5) < 0.01); // halfway in time = halfway in km (constant model speed)
  assert.ok(Math.abs(kmAt(500) - 9) < 0.01);
  // 8 km in 400 s = 20 m/s against the model's 25 m/s: factor 1.25, so km 0 is reached 50 s before t=100.
  assert.ok(Math.abs(r.factor - 1.25) < 0.01);
  assert.equal(track.t[0], 50);
  assert.ok(Math.abs(track.t.at(-1) - (500 + (11.132 - 9) * 1000 / 20)) <= 1);
});

test('buildTrack: anchors against the direction of travel are dropped; no anchors = start/end estimate', () => {
  const r = buildTrack({ line: LINE, anchors: [{ t: 100, lon: KM(2)[0], lat: 0 }, { t: 200, lon: KM(1)[0], lat: 0 }, { t: 300, lon: KM(4)[0], lat: 0 }], duration: 1000 });
  assert.deepEqual(r.dropped.map((a) => a.t), [200]);
  assert.equal(r.anchors.length, 2);
  const est = buildTrack({ line: LINE, duration: 600 });
  assert.equal(est.track.t[0], 0);
  assert.equal(est.track.t.at(-1), 600);
  assert.ok(Math.abs(lonKm(est.track.c.at(-1)) - 11.132) < 1e-3);
  assert.equal(buildTrack({ line: [[0, 0]], duration: 10 }), null);
});

test('buildTrack: elevation from the profile, scaled to the line length', () => {
  // The profile's km (DEM sampling) may run longer than the drawn line: its end maps to the line's end.
  const r = buildTrack({ line: LINE, duration: 100, profile: [[0, 100], [22.264, 300]] });
  assert.equal(r.track.e[0], 100);
  assert.equal(r.track.e.at(-1), 300);
  assert.ok(Math.abs(r.track.e[50] - 200) < 2);
});

test('anchorLevel: start, end and one anchor per 10 km give level 2', () => {
  const L = (kms, routeLevel = 4, routeKm = 25) => anchorLevel({ routeLevel, routeKm, anchorKms: kms }).level;
  assert.equal(LOC_RULES.endToleranceKm(25), 1.25);
  assert.equal(L([0.2, 12, 24.5]), 2);
  assert.equal(L([0.2, 24.5]), 3); // 25 km need 3
  assert.equal(L([3, 12, 24.5]), 3); // no start anchor
  assert.equal(L([0.2, 12, 20]), 3); // no end anchor
  assert.equal(L([0.1, 2.9], 4, 3), 2); // short route: 2 anchors
  assert.equal(L([0.2, 12, 24.5], 5), 5); // weakest link: rough route stays 5
  assert.equal(L([], 4), 4);
  assert.equal(anchorLevel({ routeLevel: 4, routeKm: 25, anchorKms: [0.2, 24.5] }).reason, 'too_few_anchors');
});

test('Prüfmodus: at least 10 check points; 25 m along the road passes, more fails', () => {
  const { track } = buildTrack({ line: LINE, duration: 600 });
  const pts = checkPoints(track, LINE);
  assert.ok(pts.length >= 10);
  assert.ok(pts.every((s) => s >= track.t[0] && s <= track.t.at(-1)));
  const confirm = evaluateReview({ line: LINE, track, points: pts.map((t) => ({ t })) });
  assert.equal(confirm.passed, true);
  assert.equal(confirm.err_max_m, 0);
  const pos = (t, dm) => { const p = trackAt(track, t); return { t, lon: p[0] + dm / 111320, lat: 0 }; };
  const small = evaluateReview({ line: LINE, track, points: pts.map((t, i) => (i === 3 ? pos(t, 20) : { t })) });
  assert.equal(small.passed, true);
  assert.ok(Math.abs(small.err_max_m - 20) < 0.5);
  const far = evaluateReview({ line: LINE, track, points: pts.map((t, i) => (i === 3 ? pos(t, 60) : { t })) });
  assert.equal(far.passed, false);
  assert.equal(far.points[3].ok, false);
  const wrong = evaluateReview({ line: LINE, track, points: pts.map((t, i) => ({ t, wrong_road: i === 0 })) });
  assert.equal(wrong.passed, false);
  assert.equal(evaluateReview({ line: LINE, track, points: pts.slice(0, 5).map((t) => ({ t })) }).passed, false); // too few points
});
