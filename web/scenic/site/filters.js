// SPDX-License-Identifier: AGPL-3.0-or-later
// Filter state, URL (de)serialisation, predicates and facet counts (FILTER-PLAN.md).
// Pure functions without DOM access, so they run in the browser and under `node --test` (test/filters.test.mjs).
// Labels come from site/i18n.js in the interface language.
import { t, num, regionName, topicName } from './i18n.js';
//
// One pass over all videos computes, per video, a bit mask of the filters it fails. A video with no failing
// filter is in the result; a video failing only filter d still counts for d's facet ("what would this option
// leave, with all other filters applied"). That gives every facet in O(videos × filters).

export const norm = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

// Range limits of the sliders. The upper end of km and dur means "and more" (open).
export const RANGES = {
  km: { min: 0, max: 300, step: 5, unit: 'km' },
  dur: { min: 0, max: 240, step: 5, unit: 'min' },
  asc: { min: 0, max: 3000, step: 100, unit: 'm' },
  yr: { min: 2010, max: new Date().getFullYear(), step: 1, unit: '' },
};
export const RES_OPTIONS = [0, 1080, 1440, 2160, 4320];
export const resLabel = (r) => (r ? { 1080: '1080p', 1440: '1440p', 2160: '4K', 4320: '8K' }[r] ?? `${r}p` : t('common.all'));
const RES_TOLERANCE = 0.93; // 2026 px portrait or 4304 px uploads still count as 4K or 8K
export const BR_OPTIONS = [0, 10, 20, 40]; // Mbit/s
export const VIEWS_OPTIONS = [0, 10_000, 100_000, 1_000_000];
export const LOC_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
export const STARS_OPTIONS = [0, 3, 4, 5];

// Main road class of a route (largest share, from OSM via Valhalla) and the surface filter options.
export const ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'minor', 'residential', 'track', 'path', 'ferry'];
export const roadName = (r) => t(`road.${r}`);
export const UNP_OPTIONS = [0, 1, 2];
export const unpLabel = (u) => (u ? t(`unp.${u}`) : t('common.all'));

export function defaults() {
  return {
    q: '', c: [], reg: '', tp: [],
    loc: 7, km: [null, null], dur: [null, null], asc: [null, null], road: [], unp: 0,
    res: 0, fps: 0, hdr: false, br: 0,
    yr: [null, null], views: 0, ch: [], emb: false, stars: 0, pick: false,
    vr: false, sim: false,
    ride: false, // only entries rideable in the ridrs app (a ride package, migrations/0007)
    view: false, // only the map viewport (the viewport itself is passed as ctx.bbox, not part of the URL)
  };
}

// Order defines the bit of each filter. 'q' and 'view' are filters without a facet.
export const DIMS = ['q', 'c', 'reg', 'tp', 'loc', 'km', 'dur', 'asc', 'road', 'unp', 'res', 'fps', 'hdr', 'br', 'yr', 'views', 'ch', 'emb', 'stars', 'pick', 'vr', 'sim', 'ride', 'view'];
const BIT = Object.fromEntries(DIMS.map((d, i) => [d, 1 << i]));

/** Adds derived fields once after loading: search text (with region, topic and country names in the interface language), year.
 *  countryNames: {code: name} in the interface language. */
export function prepare(videos, countryNames = {}) {
  for (const v of videos) {
    v.search = norm(`${v.title ?? ''} ${v.place ?? ''} ${v.region ?? ''} ${regionName(v.region)} ${v.channel ?? ''} ${countryNames[v.country] ?? ''} ${(v.topics ?? []).map(topicName).join(' ')}`);
    v.year = v.published ? +v.published.slice(0, 4) : null;
    v.topics ??= [];
  }
  return videos;
}

// Channel filter key: the stable YouTube channel id (names change and can repeat); tests without ids use the name.
export const chKey = (v) => v.cid ?? v.channel ?? null;

const inRange = (x, [lo, hi], openTop) => x != null && (lo == null || x >= lo) && (hi == null || (openTop != null && hi >= openTop) || x <= hi);

/** Predicates for the active filters only: [[dim, fn(v) -> bool], …]. */
export function predicates(s, ctx = {}) {
  const P = [];
  const terms = norm(s.q).split(/\s+/).filter(Boolean);
  if (terms.length) P.push(['q', (v) => terms.every((t) => v.search.includes(t))]);
  if (s.c.length) { const set = new Set(s.c); P.push(['c', (v) => set.has(v.country)]); }
  if (s.reg) P.push(['reg', (v) => v.region === s.reg]);
  if (s.tp.length) P.push(['tp', (v) => v.topics.some((t) => s.tp.includes(t))]);
  if (s.loc < 7) P.push(['loc', (v) => (v.loc ?? 7) <= s.loc]);
  if (s.km[0] != null || s.km[1] != null) P.push(['km', (v) => inRange(v.km, s.km, RANGES.km.max)]);
  if (s.asc[0] != null || s.asc[1] != null) P.push(['asc', (v) => inRange(v.asc, s.asc, RANGES.asc.max)]);
  if (s.road.length) { const set = new Set(s.road); P.push(['road', (v) => set.has(v.road)]); }
  if (s.unp === 1) P.push(['unp', (v) => v.unp != null && v.unp < 0.02]);
  if (s.unp === 2) P.push(['unp', (v) => (v.unp ?? 0) >= 0.05]);
  if (s.dur[0] != null || s.dur[1] != null) P.push(['dur', (v) => inRange(v.dur == null ? null : v.dur / 60, s.dur, RANGES.dur.max)]);
  if (s.res) P.push(['res', (v) => (v.height ?? 0) >= s.res * RES_TOLERANCE]);
  if (s.fps) P.push(['fps', (v) => (v.fps ?? 0) >= s.fps - 1]);
  if (s.hdr) P.push(['hdr', (v) => !!v.hdr]);
  if (s.br) P.push(['br', (v) => (v.kbps ?? 0) >= s.br * 1000]);
  if (s.yr[0] != null || s.yr[1] != null) P.push(['yr', (v) => inRange(v.year, s.yr)]);
  if (s.views) P.push(['views', (v) => (v.views ?? 0) >= s.views]);
  if (s.ch.length) { const set = new Set(s.ch); P.push(['ch', (v) => set.has(chKey(v))]); }
  if (s.emb) P.push(['emb', (v) => !!v.embeddable]);
  if (s.stars) P.push(['stars', (v) => (v.stars ?? 0) >= s.stars]);
  if (s.pick) P.push(['pick', (v) => !!v.pick]);
  if (s.ride) P.push(['ride', (v) => !!v.ride]);
  if (!s.vr) P.push(['vr', (v) => v.projection !== '360']);
  if (!s.sim) P.push(['sim', (v) => (v.footage ?? 'real') === 'real']);
  if (s.view && ctx.bbox) {
    const [w, so, e, n] = ctx.bbox;
    P.push(['view', (v) => v.lat >= so && v.lat <= n && (w <= e ? v.lon >= w && v.lon <= e : v.lon >= w || v.lon <= e)]);
  }
  return P;
}

/** Simple filter (for tests and callers that need no facets). */
export function filter(videos, s, ctx) {
  const P = predicates(s, ctx).map((p) => p[1]);
  return videos.filter((v) => P.every((f) => f(v)));
}

const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * One pass: the result, the result without the viewport filter (what the map shows), and facet counts.
 * facets[dim] holds counts over "all filters except dim":
 *   c, reg, ch, tp: Map value -> count;  loc, res, br, views, stars: {option: count} for "at least";
 *   fps: {0: all, 50: at least 50 fps};  hdr, emb, pick, ride: count with the flag;  vr, sim: count of 360° / non-real videos it would add;
 *   km, dur, yr: count of videos that have a value at all (base for the range).
 */
export function compute(videos, s, ctx = {}) {
  const P = predicates(s, ctx);
  const bits = P.map(([d]) => BIT[d]);
  const fns = P.map((p) => p[1]);
  const n = fns.length;
  const viewBit = BIT.view;
  const result = [], mapped = [];
  const f = {
    c: new Map(), reg: new Map(), ch: new Map(), tp: new Map(), road: new Map(), unp: [0, 0, 0],
    loc: new Array(8).fill(0), res: new Map(), br: new Map(), views: new Map(), stars: new Array(6).fill(0),
    hdr: 0, fps: 0, fpsBase: 0, emb: 0, pick: 0, ride: 0, vr: 0, sim: 0, km: 0, dur: 0, asc: 0, yr: 0,
  };
  const all = (v) => {
    inc(f.c, v.country ?? null); inc(f.reg, v.region ?? null); inc(f.ch, chKey(v));
    for (const t of v.topics) inc(f.tp, t);
    f.loc[v.loc ?? 7]++; inc(f.res, v.height ?? 0); inc(f.br, v.kbps ?? 0); inc(f.views, v.views ?? 0); f.stars[v.stars ?? 0]++;
    if (v.hdr) f.hdr++;
    if ((v.fps ?? 0) >= 49) f.fps++;
    f.fpsBase++;
    if (v.embeddable) f.emb++;
    if (v.pick) f.pick++;
    if (v.ride) f.ride++;
    if (v.projection === '360') f.vr++;
    if ((v.footage ?? 'real') !== 'real') f.sim++;
    if (v.km != null) f.km++;
    if (v.road) inc(f.road, v.road);
    unpCount(v);
    if (v.asc != null) f.asc++;
    if (v.dur != null) f.dur++;
    if (v.year != null) f.yr++;
  };
  function unpCount(v) { f.unp[0]++; if (v.unp != null && v.unp < 0.02) f.unp[1]++; if ((v.unp ?? 0) >= 0.05) f.unp[2]++; }
  const one = {
    road: (v) => { if (v.road) inc(f.road, v.road); }, unp: unpCount,
    c: (v) => inc(f.c, v.country ?? null), reg: (v) => inc(f.reg, v.region ?? null), ch: (v) => inc(f.ch, chKey(v)),
    tp: (v) => { for (const t of v.topics) inc(f.tp, t); },
    loc: (v) => { f.loc[v.loc ?? 7]++; }, res: (v) => inc(f.res, v.height ?? 0), br: (v) => inc(f.br, v.kbps ?? 0),
    views: (v) => inc(f.views, v.views ?? 0), stars: (v) => { f.stars[v.stars ?? 0]++; },
    hdr: (v) => { if (v.hdr) f.hdr++; }, fps: (v) => { f.fpsBase++; if ((v.fps ?? 0) >= 49) f.fps++; }, emb: (v) => { if (v.embeddable) f.emb++; },
    pick: (v) => { if (v.pick) f.pick++; }, ride: (v) => { if (v.ride) f.ride++; }, vr: (v) => { if (v.projection === '360') f.vr++; },
    sim: (v) => { if ((v.footage ?? 'real') !== 'real') f.sim++; },
    km: (v) => { if (v.km != null) f.km++; }, asc: (v) => { if (v.asc != null) f.asc++; }, dur: (v) => { if (v.dur != null) f.dur++; }, yr: (v) => { if (v.year != null) f.yr++; },
  };
  const byBit = new Map(DIMS.map((d) => [BIT[d], one[d]]));
  for (const v of videos) {
    let mask = 0, fails = 0;
    for (let i = 0; i < n; i++) if (!fns[i](v)) { mask |= bits[i]; if (++fails > 1) break; }
    if (fails === 0) { result.push(v); mapped.push(v); all(v); }
    else if (fails === 1) {
      if (mask === viewBit) mapped.push(v);
      byBit.get(mask)?.(v);
    }
  }
  // "At least" options: cumulate the per-value counts.
  const atLeast = (m, opts, test) => Object.fromEntries(opts.map((o) => [o, [...m].reduce((a, [k, c]) => a + (test(k, o) ? c : 0), 0)]));
  const facets = {
    ...f,
    loc: Object.fromEntries(LOC_OPTIONS.map((o) => [o, f.loc.slice(0, o + 1).reduce((a, b) => a + b, 0)])),
    res: atLeast(f.res, RES_OPTIONS, (h, o) => h >= o * RES_TOLERANCE),
    br: atLeast(f.br, BR_OPTIONS, (k, o) => k >= o * 1000),
    views: atLeast(f.views, VIEWS_OPTIONS, (k, o) => k >= o),
    fps: { 0: f.fpsBase, 50: f.fps },
    unp: { 0: f.unp[0], 1: f.unp[1], 2: f.unp[2] },
    stars: Object.fromEntries(STARS_OPTIONS.map((o) => [o, f.stars.slice(o).reduce((a, b) => a + b, 0)])),
  };
  return { result, mapped, facets };
}

// --- URL: ?c=IT,FR&res=2160&km=20-80 … Only non-default values are written. ---
const LIST = ['c', 'tp', 'ch', 'road'], RANGE = ['km', 'dur', 'asc', 'yr'], NUM = ['loc', 'res', 'fps', 'br', 'views', 'stars', 'unp'], BOOL = ['hdr', 'emb', 'pick', 'ride', 'vr', 'sim', 'view'];
const enc = (x) => encodeURIComponent(x).replace(/%20/g, '+');
const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return ''; } };
const URL_KEY = { view: 'map' };
const keyOf = (d) => URL_KEY[d] ?? d;

export function toQuery(s) {
  const d = defaults(), out = [];
  if (s.q.trim()) out.push(`q=${enc(s.q.trim())}`);
  for (const k of LIST) if (s[k].length) out.push(`${k}=${s[k].map(enc).join(',')}`);
  if (s.reg) out.push(`reg=${enc(s.reg)}`);
  for (const k of NUM) if (s[k] !== d[k]) out.push(`${k}=${s[k]}`);
  for (const k of RANGE) if (s[k][0] != null || s[k][1] != null) out.push(`${k}=${s[k][0] ?? ''}-${s[k][1] ?? ''}`);
  for (const k of BOOL) if (s[k]) out.push(`${keyOf(k)}=1`);
  return out.length ? `?${out.join('&')}` : '';
}

export function fromQuery(search) {
  const s = defaults();
  const p = new Map(String(search || '').replace(/^\?/, '').split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  }));
  const num = (x) => (x === '' || x == null || !Number.isFinite(+x) ? null : +x);
  if (p.has('q')) s.q = dec(p.get('q'));
  for (const k of LIST) if (p.get(k)) s[k] = [...new Set(p.get(k).split(',').map(dec).filter(Boolean))];
  s.c = s.c.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  if (p.get('reg')) s.reg = dec(p.get('reg'));
  for (const k of NUM) { const x = num(p.get(k)); if (x != null) s[k] = x; }
  if (!LOC_OPTIONS.includes(s.loc)) s.loc = 7;
  if (!UNP_OPTIONS.includes(s.unp)) s.unp = 0;
  for (const k of RANGE) {
    const m = /^(-?[\d.]*)-([\d.]*)$/.exec(p.get(k) ?? '');
    if (m) { const r = [num(m[1]), num(m[2])]; if (r[0] != null && r[1] != null && r[0] > r[1]) r.reverse(); s[k] = r; }
  }
  for (const k of BOOL) if (p.get(keyOf(k)) === '1') s[k] = true;
  return s;
}

export const isDefault = (s) => toQuery({ ...s, q: '', view: false }) === '';

// --- Active filter chips (label, and the patch that removes the filter) ---
export const unitLabel = (k) => ({ km: t('unit.km'), dur: t('unit.min'), asc: t('unit.ascent') }[k] ?? '');
const rangeLabel = (k, [lo, hi]) => {
  const u = unitLabel(k) ? ` ${unitLabel(k)}` : '';
  const top = k === 'yr' ? null : RANGES[k].max;
  const f = (x) => (k === 'yr' ? String(x) : num(x));
  if (lo != null && hi != null && !(top != null && hi >= top)) return t('range.between', { lo: f(lo), hi: f(hi), u });
  if (lo != null) return t('range.from', { x: `${f(lo)}${u}` });
  return t('range.to', { x: `${f(hi)}${u}` });
};

export function activeChips(s, names = {}, chNames = {}) {
  const d = defaults(), out = [];
  for (const c of s.c) out.push({ label: names[c] ?? c, patch: { c: s.c.filter((x) => x !== c) } });
  if (s.reg) out.push({ label: regionName(s.reg), patch: { reg: '' } });
  for (const x of s.tp) out.push({ label: topicName(x), patch: { tp: s.tp.filter((y) => y !== x) } });
  if (s.loc < 7) out.push({ label: s.loc <= 6 ? t(`loc_short.${s.loc}`) : t('chip.level', { l: s.loc }), patch: { loc: 7 } });
  if (s.km[0] != null || s.km[1] != null) out.push({ label: rangeLabel('km', s.km), patch: { km: d.km } });
  if (s.dur[0] != null || s.dur[1] != null) out.push({ label: rangeLabel('dur', s.dur), patch: { dur: d.dur } });
  for (const r of s.road) out.push({ label: ROADS.includes(r) ? roadName(r) : r, patch: { road: s.road.filter((x) => x !== r) } });
  if (s.unp) out.push({ label: unpLabel(s.unp), patch: { unp: 0 } });
  if (s.asc[0] != null || s.asc[1] != null) out.push({ label: rangeLabel('asc', s.asc), patch: { asc: d.asc } });
  if (s.res) out.push({ label: `${resLabel(s.res)}+`, patch: { res: 0 } });
  if (s.fps) out.push({ label: '50/60 fps', patch: { fps: 0 } });
  if (s.hdr) out.push({ label: 'HDR', patch: { hdr: false } });
  if (s.br) out.push({ label: t('chip.bitrate', { x: num(s.br) }), patch: { br: 0 } });
  if (s.yr[0] != null || s.yr[1] != null) out.push({ label: rangeLabel('yr', s.yr), patch: { yr: d.yr } });
  if (s.views) out.push({ label: t('chip.views', { x: num(s.views) }), patch: { views: 0 } });
  for (const c of s.ch) out.push({ label: chNames[c] ?? c, patch: { ch: s.ch.filter((x) => x !== c) } });
  if (s.emb) out.push({ label: t('chip.emb'), patch: { emb: false } });
  if (s.stars) out.push({ label: t('chip.stars', { x: s.stars }), patch: { stars: 0 } });
  if (s.pick) out.push({ label: t('chip.pick'), patch: { pick: false } });
  if (s.ride) out.push({ label: t('chip.ride'), patch: { ride: false } });
  if (s.vr) out.push({ label: t('chip.vr'), patch: { vr: false } });
  if (s.sim) out.push({ label: t('chip.sim'), patch: { sim: false } });
  if (s.view) out.push({ label: t('chip.view'), patch: { view: false } });
  return out;
}

// --- Quick chips and presets: both just set fields of the state; labels are i18n keys ---
export const QUICK = [
  { id: 'sync', label: 'quick.sync', on: (s) => s.loc <= 3, set: (s, on) => ({ loc: on ? 3 : 7 }), count: (f) => f.loc[3] },
  { id: 'route', label: 'quick.route', on: (s) => s.loc <= 5, set: (s, on) => ({ loc: on ? 5 : 7 }), count: (f) => f.loc[5] },
  { id: '4k', label: null, text: '4K+', on: (s) => s.res >= 2160, set: (s, on) => ({ res: on ? 2160 : 0 }), count: (f) => f.res[2160] },
  { id: 'fps', label: null, text: '50/60 fps', on: (s) => s.fps >= 50, set: (s, on) => ({ fps: on ? 50 : 0 }), count: (f) => f.fps[50] },
  { id: 'hdr', label: null, text: 'HDR', on: (s) => s.hdr, set: (s, on) => ({ hdr: on }), count: (f) => f.hdr },
  { id: 'emb', label: 'chip.emb', on: (s) => s.emb, set: (s, on) => ({ emb: on }), count: (f) => f.emb },
  { id: 'ride', label: 'chip.ride', on: (s) => s.ride, set: (s, on) => ({ ride: on }), count: (f) => f.ride },
];

export const PRESETS = [
  { label: 'preset.alps4k', patch: { reg: 'Alps', res: 2160 } },
  { label: 'preset.long', patch: { dur: [60, null] } },
  { label: 'preset.sync', patch: { loc: 3 } },
  { label: 'preset.tdf', patch: { tp: ['Tour de France'] } },
];

/** Flag emoji from an ISO 3166-1 alpha-2 code. */
export const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '');
