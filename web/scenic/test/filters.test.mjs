// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/  — predicates, facet counts, URL round trip and speed of site/filters.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, prepare, filter, compute, toQuery, fromQuery, activeChips, QUICK, PRESETS, flag, isDefault } from '../site/filters.js';
import { setLocale } from '../site/i18n.js';
import de from '../site/locales/de.js';

setLocale('de', de); // labels below are the German ones

const V = (o) => ({ id: o.id, title: 't', channel: 'A', lat: 46, lon: 10, region: 'Alps', place: 'P', views: 1000, dur: 1800,
  published: '2020-05-01', embeddable: 1, projection: 'rectangular', footage: 'real', topics: [], stars: null, pick: 0,
  loc: 7, height: 1080, fps: 30, hdr: 0, km: null, synced: 0, country: 'IT', kbps: 5000, ...o });

const data = () => prepare([
  V({ id: 'a', country: 'IT', height: 2160, fps: 60, kbps: 25000, loc: 4, km: 42, title: 'Passo Stelvio', views: 2_000_000 }),
  V({ id: 'b', country: 'FR', height: 2160, fps: 50, hdr: 1, kbps: 45000, loc: 5, km: 120, topics: ['Tour de France'], published: '2024-07-01' }),
  V({ id: 'c', country: 'CH', height: 1080, fps: 30, loc: 6, dur: 5400, channel: 'B', region: 'Alps' }),
  V({ id: 'd', country: 'US', region: 'North America', lat: 37, lon: -100, height: null, fps: null, kbps: null, loc: 7, embeddable: 0, published: '2012-01-01' }),
  V({ id: 'e', country: 'IT', projection: '360', loc: 3, km: 10, synced: 1 }),
  V({ id: 'f', country: 'FR', footage: 'simulator', height: 4304, loc: 7 }),
  V({ id: 'g', country: null, lat: 40, lon: -30, region: 'Atlantic Islands', height: 2026, views: 50 }),
]);
const ids = (xs) => xs.map((v) => v.id).sort().join('');
const S = (o) => ({ ...defaults(), ...o });

test('defaults hide 360° and simulator videos only', () => {
  assert.equal(ids(filter(data(), defaults())), 'abcdg');
  assert.equal(ids(filter(data(), S({ vr: true, sim: true }))), 'abcdefg');
});

test('single predicates', () => {
  const d = data();
  assert.equal(ids(filter(d, S({ c: ['IT', 'FR'] }))), 'ab');
  assert.equal(ids(filter(d, S({ reg: 'Alps' }))), 'abc');
  assert.equal(ids(filter(d, S({ tp: ['Tour de France'] }))), 'b');
  assert.equal(ids(filter(d, S({ loc: 5 }))), 'ab');
  assert.equal(ids(filter(d, S({ loc: 3, vr: true }))), 'e');
  assert.equal(ids(filter(d, S({ km: [20, 80] }))), 'a');
  assert.equal(ids(filter(d, S({ km: [100, 300] }))), 'b', 'upper end of the slider is open');
  assert.equal(ids(filter(d, S({ dur: [60, null] }))), 'c');
  assert.equal(ids(filter(d, S({ dur: [null, 45] }))), 'abdg');
  assert.equal(ids(filter(d, S({ res: 2160 }))), 'abg', '2026 px counts as 4K');
  assert.equal(ids(filter(d, S({ res: 4320, sim: true }))), 'f', '4304 px counts as 8K');
  assert.equal(ids(filter(d, S({ fps: 50 }))), 'ab');
  assert.equal(ids(filter(d, S({ hdr: true }))), 'b');
  assert.equal(ids(filter(d, S({ br: 20 }))), 'ab');
  assert.equal(ids(filter(d, S({ br: 40 }))), 'b');
  assert.equal(ids(filter(d, S({ yr: [2015, 2022] }))), 'acg');
  assert.equal(ids(filter(d, S({ views: 1_000_000 }))), 'a');
  assert.equal(ids(filter(d, S({ ch: ['B'] }))), 'c');
  assert.equal(ids(filter(d, S({ emb: true }))), 'abcg');
  assert.equal(ids(filter(d, S({ q: 'stelvio' }))), 'a');
  assert.equal(ids(filter(d, S({ q: 'alpen' }))), 'abc', 'German region names are searchable');
});

test('filters combine with AND', () => {
  assert.equal(ids(filter(data(), S({ c: ['IT', 'FR', 'CH'], res: 2160, fps: 50, km: [20, null] }))), 'ab');
  assert.equal(ids(filter(data(), S({ c: ['IT'], hdr: true }))), '');
});

test('viewport filter: result vs. map', () => {
  const d = data();
  const r = compute(d, S({ view: true }), { bbox: [0, 40.5, 20, 50] });
  assert.equal(ids(r.result), 'abc', 'g is outside, d is outside');
  assert.equal(ids(r.mapped), 'abcdg', 'the map still shows everything else that matches');
  assert.equal(ids(compute(d, S({ view: false }), { bbox: [0, 40.5, 20, 50] }).result), 'abcdg');
});

test('facets count each option with all other filters applied', () => {
  const d = data();
  const { result, facets } = compute(d, S({ c: ['IT'], res: 2160 }));
  assert.equal(ids(result), 'a');
  // Country facet ignores the country filter but keeps res=4K: a (IT), b (FR), g (null)
  assert.equal(facets.c.get('IT'), 1);
  assert.equal(facets.c.get('FR'), 1);
  assert.equal(facets.c.get('CH'), undefined);
  assert.equal(facets.c.get(null), 1);
  // Resolution facet ignores res but keeps country IT (and hides 360): only a
  assert.deepEqual(facets.res, { 0: 1, 1080: 1, 1440: 1, 2160: 1, 4320: 0 });
  // Quick chip counts come from the facets
  assert.equal(QUICK.find((q) => q.id === '4k').count(facets), 1);
  assert.equal(facets.hdr, 0);
  assert.deepEqual(facets.fps, { 0: 1, 50: 1 });
  assert.equal(facets.loc[5], 1);
  assert.equal(facets.loc[3], 0);
  // vr facet: how many 360° videos would be added (e is IT, but only 1080p) -> 0
  assert.equal(facets.vr, 0);

  const g = compute(d, defaults()).facets;
  assert.equal(g.vr, 1);
  assert.equal(g.sim, 1);
  assert.equal(g.c.get('IT'), 1);
  assert.equal(g.c.get('FR'), 1, 'f is a simulator video and hidden');
  assert.equal(g.tp.get('Tour de France'), 1);
  assert.equal(g.reg.get('Alps'), 3);
  assert.deepEqual(g.views, { 0: 5, 10000: 1, 100000: 1, 1000000: 1 });
  assert.deepEqual(g.br, { 0: 5, 10: 2, 20: 2, 40: 1 });
  assert.equal(g.loc[7], 5);
  assert.equal(g.km, 2);
});

test('facets match brute force on random states', () => {
  const d = data();
  const rnd = (xs) => xs[Math.floor(Math.random() * xs.length)];
  for (let i = 0; i < 200; i++) {
    const s = S({ c: rnd([[], ['IT'], ['FR', 'CH']]), res: rnd([0, 1080, 2160]), loc: rnd([3, 5, 7]), hdr: rnd([false, true]),
      vr: rnd([false, true]), sim: rnd([false, true]), km: rnd([[null, null], [20, null]]), emb: rnd([false, true]) });
    const { result, facets } = compute(d, s);
    assert.equal(ids(result), ids(filter(d, s)));
    for (const cc of ['IT', 'FR', 'CH', 'US']) {
      assert.equal(facets.c.get(cc) ?? 0, filter(d, { ...s, c: [cc] }).length, `country ${cc} in ${JSON.stringify(s)}`);
    }
    for (const r of [0, 1080, 2160, 4320]) assert.equal(facets.res[r], filter(d, { ...s, res: r }).length);
    for (const l of [3, 5, 7]) assert.equal(facets.loc[l], filter(d, { ...s, loc: l }).length);
    assert.equal(facets.hdr, filter(d, { ...s, hdr: true }).length);
    assert.equal(facets.fps[0], filter(d, { ...s, fps: 0 }).length);
    assert.equal(facets.fps[50], filter(d, { ...s, fps: 50 }).length);
    assert.equal(facets.emb, filter(d, { ...s, emb: true }).length);
  }
});

test('URL round trip; defaults are not written', () => {
  assert.equal(toQuery(defaults()), '');
  assert.ok(isDefault(defaults()));
  const s = S({ q: 'stelvio pass', c: ['IT', 'FR'], reg: 'Spain & Portugal', tp: ["Giro d'Italia", 'Tour de France'], loc: 3,
    km: [20, 80], dur: [60, null], res: 2160, fps: 50, hdr: true, br: 20, yr: [null, 2020], views: 100000,
    ch: ['Foo, Bar & Co', 'Ünïcödé'], emb: true, stars: 4, pick: true, vr: true, sim: true, view: true });
  const qs = toQuery(s);
  assert.match(qs, /^\?q=stelvio\+pass&c=IT,FR&/);
  assert.match(qs, /km=20-80/);
  assert.match(qs, /dur=60-(&|$)/);
  assert.match(qs, /yr=-2020/);
  assert.match(qs, /map=1/);
  assert.deepEqual(fromQuery(qs), s);
  assert.deepEqual(fromQuery(toQuery(S({ res: 2160 }))), S({ res: 2160 }));
  assert.equal(toQuery(S({ res: 2160, km: [20, 80], c: ['IT'] })), '?c=IT&res=2160&km=20-80');
});

test('URL parsing is forgiving', () => {
  assert.deepEqual(fromQuery(''), defaults());
  assert.deepEqual(fromQuery('?loc=99&res=abc&km=80-20&c=it,XYZ,fr&hdr=0&%E0%A4%A=1'), S({ km: [20, 80], c: ['IT', 'FR'] }));
});

test('active chips remove exactly their filter', () => {
  const s = S({ c: ['IT', 'FR'], res: 2160, km: [20, 80] });
  const chips = activeChips(s, { IT: 'Italien', FR: 'Frankreich' });
  assert.deepEqual(chips.map((c) => c.label), ['Italien', 'Frankreich', '20–80 km', '4K+']);
  assert.deepEqual({ ...s, ...chips[0].patch }.c, ['FR']);
  assert.deepEqual({ ...s, ...chips[2].patch }.km, [null, null]);
  assert.deepEqual(activeChips(S({ km: [100, 300] })).map((c) => c.label), ['ab 100 km']);
});

test('presets and flags', () => {
  for (const p of PRESETS) assert.ok(!isDefault({ ...defaults(), ...p.patch }), p.label);
  assert.equal(flag('IT'), '🇮🇹');
  assert.equal(flag(null), '');
});

test('compute over 10k videos stays under 50 ms', () => {
  const base = data();
  const big = prepare(Array.from({ length: 10000 }, (_, i) => ({ ...base[i % base.length], id: String(i),
    channel: `ch${i % 580}`, country: ['IT', 'FR', 'DE', 'US', 'CH', 'JP'][i % 6], views: i * 37 })));
  const s = S({ c: ['IT', 'FR'], res: 2160, fps: 50, km: [20, null], q: 'p', yr: [2015, null] });
  compute(big, s); // warm up
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) compute(big, s, { bbox: [0, 40, 20, 50] });
  const ms = (performance.now() - t0) / 10;
  console.log(`compute over 10,000 videos: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 50, `${ms} ms`);
});

test('channel filter uses the channel id when present, not the name', () => {
  const vs = prepare([
    { id: 'x', title: 't', channel: 'Same Name', cid: 'UC1', lat: 1, lon: 1, topics: [] },
    { id: 'y', title: 't', channel: 'Same Name', cid: 'UC2', lat: 1, lon: 1, topics: [] },
  ]);
  assert.equal(filter(vs, { ...defaults(), ch: ['UC2'] }).map((v) => v.id).join(), 'y');
  assert.equal(compute(vs, defaults()).facets.ch.get('UC1'), 1);
});

test('ascent range: open top, videos without elevation drop out, URL round trip', () => {
  const vs = prepare([
    { id: 'a', title: 't', lat: 1, lon: 1, topics: [], asc: 400 },
    { id: 'b', title: 't', lat: 1, lon: 1, topics: [], asc: 3500 },
    { id: 'c', title: 't', lat: 1, lon: 1, topics: [] },
  ]);
  const s = { ...defaults(), asc: [1000, 3000] }; // 3000 = slider max = "and more"
  assert.equal(filter(vs, s).map((v) => v.id).join(), 'b');
  assert.deepEqual(fromQuery(toQuery(s)).asc, [1000, 3000]);
  assert.equal(compute(vs, s).facets.asc, 2);
});

test('road class and surface filters with facets and URL', () => {
  const vs = prepare([
    { id: 'a', title: 't', lat: 1, lon: 1, topics: [], road: 'minor', unp: 0 },
    { id: 'b', title: 't', lat: 1, lon: 1, topics: [], road: 'minor', unp: 0.3 },
    { id: 'c', title: 't', lat: 1, lon: 1, topics: [], road: 'motorway', unp: 0 },
    { id: 'd', title: 't', lat: 1, lon: 1, topics: [] },
  ]);
  const ids = (s) => filter(vs, { ...defaults(), ...s }).map((v) => v.id).join();
  assert.equal(ids({ road: ['minor'] }), 'a,b');
  assert.equal(ids({ unp: 1 }), 'a,c');
  assert.equal(ids({ unp: 2 }), 'b');
  const { facets } = compute(vs, { ...defaults(), road: ['minor'], unp: 1 });
  assert.equal(facets.road.get('motorway'), 1); // with unp=1 applied, not road
  assert.deepEqual(facets.unp, { 0: 2, 1: 1, 2: 1 }); // with road=minor applied, not unp
  const s = { ...defaults(), road: ['minor', 'track'], unp: 2 };
  const back = fromQuery(toQuery(s));
  assert.deepEqual([back.road, back.unp], [['minor', 'track'], 2]);
});
