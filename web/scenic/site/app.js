// SPDX-License-Identifier: AGPL-3.0-or-later
// ridrs Scenic front end: full-screen map, search mask top centre (with suggestions and filters),
// and a dialog on the left with the YouTube video and the route information. No route list.
import { Map as MapGL, NavigationControl, LngLatBounds, Marker } from './vendor/maplibre-gl/maplibre-gl.mjs';
import { mountPlayer } from './player.js';
import { prepare, compute, fromQuery, toQuery, ROADS, roadName, flag } from './filters.js';
import { mountPanel } from './panel.js';
import { decodeLine } from './lib/lines.js';
import { initI18n, t, num as fmtNum, date, countryName, regionName, getLang, translateDom, mountLangMenu } from './i18n.js';

// Interface language first (browser language, else English): everything below renders text.
await initI18n();
translateDom();
mountLangMenu($lang());
function $lang() { return document.querySelector('#lang'); }

// The base map is always light (OpenFreeMap positron); the interface around it is always dark.
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const SUGGEST = 8;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const narrow = () => matchMedia('(max-width: 760px)').matches;
// Display width of a ride's picture for srcset: the sheet's width on phones, the dialog's default width (--detail-w) otherwise.
const PICTURE_SIZES = '(max-width: 760px) 100vw, 440px';

// Lokalisierungsstufe (concept 2.5): [name, description] in the interface language
export const LEVELS = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((l) => [l, [t(`level.${l}.name`), t(`level.${l}.desc`)]]));
const METHOD = (m) => {
  if (!m) return '';
  const src = { komoot: 'Komoot', rwgps: 'Ride with GPS', mymaps: 'Google My Maps' }[m.split('_')[1]];
  if (m === 'osrm_waypoints') return t('method.osrm_waypoints');
  if (m === 'creator_gpx') return t('method.creator_gpx');
  if (m.startsWith('mapmatched_')) return t('method.mapmatched', { src });
  if (m.startsWith('routed_')) return t('method.routed', { src });
  return m;
};
const SYNC_METHOD = (m) => ({ video2gpx: t('sync.video2gpx'), anchors: t('sync.anchors') }[m] ?? m);
// Incyclist package (concept 4.7): from Lokalisierungsstufe 3 on, otherwise greyed out with a note below.
// A ride (Van Gestel) has its original package without video instead (src/rides.js).
const incyclistButton = (v) => (!v.incyclist ? '' : v.incyclist.package
  ? `<a class="btn" href="${esc(v.incyclist.url)}" download title="${esc(t('detail.package_title'))}">${t('detail.package')}</a>`
  : v.incyclist.available
  ? `<a class="btn" href="${esc(v.incyclist.url)}" download title="${esc(t('incyclist.title'))}">${t('incyclist.label')}</a>`
  : `<button type="button" class="btn" disabled title="${esc(t('incyclist.disabled_title'))}">${t('incyclist.label')}</button>`);
// What a ride (a video with a ride package) adds to the dialog: tour, difficulty, climbs, the size of the original download.
const climbText = (c) => `${c.name ? `${esc(c.name)} – ` : ''}${esc(t('detail.climb', { cat: c.category, km: km1((c.end - c.start) / 1000), g: km1(c.grade) }))}`;
const rideRows = (r) => !r ? '' : `${r.tour ? `<dt>${t('dt.tour')}</dt><dd>${esc(t('detail.tour', { name: r.tour.name, part: r.tour.part }))}</dd>` : ''}
  ${r.level ? `<dt>${t('dt.difficulty')}</dt><dd>${esc(t(`difficulty.${r.level}`) === `difficulty.${r.level}` ? r.level : t(`difficulty.${r.level}`))}</dd>` : ''}
  ${r.climbs?.length ? `<dt>${t('dt.climbs')}</dt><dd>${r.climbs.map(climbText).join('<br>')}</dd>` : ''}`;
const credits = (v) => (!v.source?.license ? '' : `<p class="meta">${esc(t('detail.credits', { author: v.source.author, source: v.source.name, license: '\u0000' }))
  .replace('\u0000', `<a href="${esc(v.source.license.url)}" target="_blank" rel="noopener license">${esc(v.source.license.name)}</a>`)}</p>`);
const lvlTag = (l) => `<span class="lvl" style="--c:var(--l${l})">${l} · ${LEVELS[l]?.[0] ?? ''}</span>`;
const dur = (s) => (s >= 3600 ? t('dur.hm', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) }) : t('dur.m', { m: Math.round((s || 0) / 60) }));
const num = (n) => fmtNum(n);
const km1 = (x) => fmtNum(x, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// Elevation profile (route.elevation.profile: [[km, ele], …]) as an inline SVG area chart.
const PW = 400, PH = 96, PAD = { l: 46, r: 6, t: 8, b: 16 };
function profileSvg(p) {
  const kmMax = p.at(-1)[0] || 1, lo = Math.min(...p.map((x) => x[1])), hi = Math.max(...p.map((x) => x[1]));
  const span = Math.max(100, hi - lo), base = Math.floor((lo - span * 0.08) / 50) * 50, top = Math.ceil((hi + span * 0.05) / 50) * 50;
  const X = (k) => PAD.l + (k / kmMax) * (PW - PAD.l - PAD.r), Y = (e) => PAD.t + (1 - (e - base) / (top - base)) * (PH - PAD.t - PAD.b);
  const line = p.map(([k, e], i) => `${i ? 'L' : 'M'}${X(k).toFixed(1)},${Y(e).toFixed(1)}`).join('');
  const area = `${line}L${X(kmMax).toFixed(1)},${PH - PAD.b}L${X(0)},${PH - PAD.b}Z`;
  return { kmMax, X, Y, svg: `<svg class="profile" viewBox="0 0 ${PW} ${PH}" role="img" aria-label="${esc(t('profile.aria', { lo: num(lo), hi: num(hi) }))}">
    <path class="area" d="${area}"/><path class="ln" d="${line}"/>
    <text x="${PAD.l - 4}" y="${Y(hi) + 3}" text-anchor="end">${num(hi)} m</text><text x="${PAD.l - 4}" y="${Y(lo) + 3}" text-anchor="end">${num(lo)} m</text>
    <text x="${PAD.l}" y="${PH - 3}">0</text><text x="${PW - PAD.r}" y="${PH - 3}" text-anchor="end">${num(Math.round(kmMax))} km</text>
    <line class="cur" x1="0" x2="0" y1="${PAD.t}" y2="${PH - PAD.b}" visibility="hidden"/><line class="hov" x1="0" x2="0" y1="${PAD.t}" y2="${PH - PAD.b}" visibility="hidden"/>
    <rect class="hit" x="${PAD.l}" y="0" width="${PW - PAD.l - PAD.r}" height="${PH}"/></svg>` };
}
// Position on the drawn route at km (for the profile hover dot).
function pointAtKm(line, km) {
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]], k = Math.cos((a[1] * Math.PI) / 180);
    const d = Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111.32;
    if (acc + d >= km) { const f = d ? (km - acc) / d : 0; return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]; }
    acc += d;
  }
  return line.at(-1);
}
let profileCtl = null;
const hoverDot = (() => { let m = null; return (lngLat) => {
  if (!lngLat) { m?.remove(); m = null; return; }
  if (!m) { const el = document.createElement('div'); el.className = 'profile-dot'; m = new Marker({ element: el }); }
  m.setLngLat(lngLat).addTo(map);
}; })();
// Categorised climbs (ADR 0070) as a small circle with the category above each summit; the name and the figures as its tooltip.
// HTML over the SVG, so the circles keep their size however wide the dialog draws the chart.
const climbMarks = (climbs, X, Y) => climbs.map((c) => {
  const label = climbText(c);
  return `<span class="climb-mark" role="img" title="${label}" aria-label="${label}" style="left:${((X(c.end / 1000) / PW) * 100).toFixed(2)}%;top:${((Y(c.summit) / PH) * 100).toFixed(2)}%">${esc(c.category)}</span>`;
}).join('');
function mountProfile(box, p, line, climbs = []) {
  const { kmMax, X, Y, svg } = profileSvg(p);
  // Summits beyond the chart (a climb measured on another track) are left out rather than drawn at its edge.
  const shown = climbs.filter((c) => c.end / 1000 <= kmMax * 1.01);
  box.classList.toggle('has-climbs', shown.length > 0);
  box.innerHTML = `<div class="profile-plot">${svg}${climbMarks(shown, (k) => X(Math.min(kmMax, k)), Y)}</div><p class="meta profile-read" aria-live="off"></p>`;
  const el = box.querySelector('svg'), cur = el.querySelector('.cur'), hov = el.querySelector('.hov'), read = box.querySelector('.profile-read');
  const eleAt = (k) => { let i = p.findIndex((x) => x[0] >= k); if (i <= 0) return p[Math.max(0, i)][1];
    const [a, b] = [p[i - 1], p[i]]; return a[1] + ((k - a[0]) / (b[0] - a[0] || 1)) * (b[1] - a[1]); };
  const kmOf = (ev) => { const r = el.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * PW;
    return Math.max(0, Math.min(kmMax, ((x - PAD.l) / (PW - PAD.l - PAD.r)) * kmMax)); };
  el.addEventListener('pointermove', (ev) => {
    const k = kmOf(ev), x = X(k).toFixed(1);
    hov.setAttribute('x1', x); hov.setAttribute('x2', x); hov.setAttribute('visibility', 'visible');
    read.textContent = `km ${km1(k)} · ${num(Math.round(eleAt(k)))} m`;
    if (line) hoverDot(pointAtKm(line, (k / kmMax) * lineKm(line)));
  });
  el.addEventListener('pointerleave', () => { hov.setAttribute('visibility', 'hidden'); read.textContent = ''; hoverDot(null); });
  return { // video position (km along the synced track, scaled to the route length)
    at(km, total) { const k = total ? (km / total) * kmMax : km, x = X(Math.min(kmMax, k)).toFixed(1);
      cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.setAttribute('visibility', 'visible'); },
  };
}
const lineKm = (line) => { let s = 0; for (let i = 1; i < line.length; i++) { const k = Math.cos((line[i][1] * Math.PI) / 180);
  s += Math.hypot((line[i][0] - line[i - 1][0]) * k, line[i][1] - line[i - 1][1]) * 111.32; } return s; };

// Road class shares as one stacked bar, with a legend of the shares of at least 3 %.
const pct = (v) => fmtNum(v, { style: 'percent', maximumFractionDigits: 0 });
function roadBar(cs) {
  const parts = ROADS.filter((k) => cs[k] > 0).map((k) => [k, cs[k]]);
  return `<div class="roadbar" role="img" aria-label="${esc(t('roads.aria'))}">${parts.map(([k, v]) => `<span class="rc-${k}" style="flex:${v}" title="${esc(roadName(k))} ${pct(v)}"></span>`).join('')}</div>`
    + `<div class="roadleg">${parts.filter(([, v]) => v >= 0.03).map(([k, v]) => `<span><i class="rc-${k}"></i>${roadName(k)} ${pct(v)}</span>`).join('')}</div>`;
}
const surfaceText = (r) => Object.entries(r.surface_share).filter(([, v]) => v >= 0.02).map(([k, v]) => `${t(`surface.${k}`)} ${pct(v)}`).join(', ');

const res = (h) => (!h ? '' : h >= 4320 ? '8K' : h >= 2160 ? '4K' : h >= 1440 ? '1440p' : `${h}p`);

let videos = [], result = [], player = null, current = null, suggestions = [], active = -1;
let mapped = [], lineGeo = null, currentLine = null, hoverId = null;
// Videos with the very same position (region pins, place pins) form one map point: key -> videos.
let stacks = new Map(), openStackKey = null;
const stackKey = (v) => `${v.lon},${v.lat}`;
let state = fromQuery(location.search), panel = null, countryNames = {}, mapKey = null, frame = 0, inGesture = false;

// --- map ---
const map = new MapGL({ container: 'map', style: STYLE, center: [10, 45], zoom: 3.2, attributionControl: false });
map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
// Map credits are part of the bottom bar (index.html .mapfoot), always visible, instead of MapLibre's attribution box.
const mapReady = new Promise((r) => map.on('load', r));
// Place names on the base map in the interface language where OpenStreetMap has them (name:xx), else as the style shows them.
function localizeLabels() {
  const key = `name:${getLang()}`;
  for (const l of map.getStyle().layers) {
    const tf = l.type === 'symbol' && map.getLayoutProperty(l.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('"name')) map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', key], tf]);
  }
}
// The legend starts folded on small screens, where the map needs the room.
if (narrow()) $('#legend').open = false;
// The legend is static: filled at once, not only after the map has loaded.
$('#legend-items').innerHTML = Object.keys(LEVELS).map((l) => lvlTag(+l)).join('') + `<span class="meta">${t('legend.lines')}</span>`;
// Keep routes clear of the dialog (left on wide screens, bottom sheet on narrow ones).
// The top edge follows the search mask, which grows with the chip rows.
const padding = () => {
  const top = Math.round(Math.min($('#search .bar').getBoundingClientRect().bottom + 60, innerHeight * 0.3));
  return detailOpen()
    ? (narrow() ? { top: Math.min(top, 90), right: 30, bottom: Math.round(dialog.getBoundingClientRect().height) + 20, left: 30 } : { top, right: 60, bottom: 40, left: Math.round(dialog.getBoundingClientRect().right) + 28 })
    : { top, right: 60, bottom: 40, left: 60 };
};

// Sources and layers of the map.
function addLayers() {
  const levelColor = ['match', ['get', 'loc'], 1, css('--l1'), 2, css('--l2'), 3, css('--l3'), 4, css('--l4'), 5, css('--l5'), 6, css('--l6'), css('--l7')];
  // One feature per position; `n` is the number of videos there, summed up in clusters.
  map.addSource('videos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterMaxZoom: 8, clusterRadius: 40,
    clusterProperties: { n: ['+', ['get', 'n']] } });
  const count = ['case', ['>=', ['get', 'n'], 1000], ['concat', ['to-string', ['/', ['round', ['/', ['get', 'n'], 100]], 10]], 'k'], ['to-string', ['get', 'n']]];
  map.addLayer({ id: 'clusters', type: 'circle', source: 'videos', filter: ['has', 'point_count'],
    paint: { 'circle-color': css('--surface-raised'), 'circle-opacity': 0.92, 'circle-stroke-color': css('--cyan'), 'circle-stroke-width': 1.5,
      'circle-radius': ['step', ['get', 'n'], 12, 50, 16, 250, 21, 1000, 27] } });
  map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'videos', filter: ['has', 'point_count'],
    layout: { 'text-field': count, 'text-size': 12, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': css('--text') } });
  // A position with several videos: a ring in the level colour with the number inside.
  map.addLayer({ id: 'video', type: 'circle', source: 'videos', filter: ['!', ['has', 'point_count']],
    paint: { 'circle-color': ['case', ['>', ['get', 'n'], 1], css('--surface-raised'), levelColor],
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        4, ['case', ['>', ['get', 'n'], 1], ['step', ['get', 'n'], 10, 10, 12, 100, 15], 4],
        12, ['case', ['>', ['get', 'n'], 1], ['step', ['get', 'n'], 11, 10, 13, 100, 16], 7]],
      'circle-stroke-color': ['case', ['>', ['get', 'n'], 1], levelColor, css('--map-point-stroke')], 'circle-stroke-width': ['case', ['>', ['get', 'n'], 1], 2.5, 1.2],
      'circle-opacity': ['case', ['>', ['get', 'n'], 1], 0.95, ['>=', ['get', 'loc'], 7], 0.6, 0.95] } });
  map.addLayer({ id: 'stack-count', type: 'symbol', source: 'videos', filter: ['all', ['!', ['has', 'point_count']], ['>', ['get', 'n'], 1]],
    layout: { 'text-field': count, 'text-size': 11, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-color': css('--text') } });
  // All routes of the filtered videos as lines, under the points; from zoom 5 on, where they become readable.
  map.addSource('lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id', tolerance: 0.5 });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines', minzoom: 5, layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': levelColor, 'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.75],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1.2],
        10, ['case', ['boolean', ['feature-state', 'hover'], false], 5, 2.2], 14, ['case', ['boolean', ['feature-state', 'hover'], false], 7, 3.5]] } }, 'clusters');
  // Invisible, wider twin for hover and click: thin lines are hard to hit.
  map.addLayer({ id: 'lines-hit', type: 'line', source: 'lines', minzoom: 5, paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 12 } }, 'clusters');
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': css('--map-casing'), 'line-width': 8 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': css('--map-route'), 'line-width': 4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
}

// Layer events are kept by the map across style changes, so they are bound once.
function bindLayerEvents() {
  map.on('click', 'clusters', async (e) => {
    const f = e.features[0];
    const z = await map.getSource('videos').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom: z, padding: padding() });
  });
  map.on('click', 'video', (e) => {
    const p = e.features[0].properties;
    if (p.n > 1) openStack(p.k); else openVideo(p.id);
  });
  map.on('click', 'lines-hit', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ['video', 'clusters'] }).length) return; // the point wins
    openVideo(e.features[0].properties.id);
  });
  const setHover = (id) => {
    if (hoverId != null && map.getSource('lines')) map.setFeatureState({ source: 'lines', id: hoverId }, { hover: false });
    hoverId = id;
    if (id != null) map.setFeatureState({ source: 'lines', id }, { hover: true });
  };
  map.on('mousemove', 'lines-hit', (e) => setHover(e.features[0].id));
  map.on('mouseleave', 'lines-hit', () => setHover(null));
  for (const l of ['clusters', 'video', 'lines-hit']) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
}

// lines.json: {id: [lon0, lat0, dlon, dlat, …]} in 1e-5 degrees (site/lib/lines.js).
async function loadLines() {
  const raw = await fetch('lines.json').then((r) => (r.ok ? r.json() : {}));
  lineGeo = new Map(Object.entries(raw).map(([id, f]) => [id, decodeLine(f)]));
  setLines();
}
function setLines() {
  if (!lineGeo || !map.getSource('lines')) return;
  hoverId = null;
  map.getSource('lines').setData({ type: 'FeatureCollection', features: mapped.filter((v) => lineGeo.has(v.id)).map((v) => ({ type: 'Feature',
    geometry: { type: 'LineString', coordinates: lineGeo.get(v.id) }, properties: { id: v.id, loc: v.loc ?? 7 } })) });
}

function drawRoute(line, fit = true) {
  currentLine = line;
  map.getSource('route')?.setData({ type: 'FeatureCollection', features: line?.length > 1
    ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} }] : [] });
  // While the exact route of the open video is drawn, its coarse overview line would only show a second, slightly different line.
  const hide = line?.length > 1 && current ? ['!=', ['get', 'id'], current] : null;
  for (const l of ['lines', 'lines-hit']) if (map.getLayer(l)) map.setFilter(l, hide);
  if (fit && line?.length > 1) {
    const b = line.reduce((bb, c) => bb.extend(c), new LngLatBounds(line[0], line[0]));
    map.fitBounds(b, { padding: padding(), maxZoom: 14, duration: 600 });
  }
}

// --- data, filters, search (filter logic: filters.js, panel DOM: panel.js) ---
async function load() {
  const r = await fetch('api/points');
  if (!r.ok) throw new Error(`api/points ${r.status}`);
  const { fields, rows, countries } = await r.json();
  // Country names in the interface language (Intl); the API's German names are the fallback.
  countryNames = Object.fromEntries(Object.entries(countries ?? {}).map(([c, n]) => [c, countryName(c, n)]));
  videos = prepare(rows.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]]))), countryNames);
  panel = mountPanel({ panel: $('#filters'), quick: $('#quick'), active: $('#active'), toggle: $('#filter-toggle'), badge: $('#filter-n'),
    videos, countryNames, levels: LEVELS, onChange: setState, endGesture: () => { inGesture = false; }, onClose: () => showPanel(false) });
}

// Filters live in the query string (?c=IT&res=2160 …), the open video in the hash (#v=…&t=…).
function setState(patch, mode = 'push') {
  state = { ...state, ...patch };
  const url = location.pathname + toQuery(state) + location.hash;
  if (url !== location.pathname + location.search + location.hash) {
    if (mode === 'push' || (mode === 'gesture' && !inGesture)) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }
  if (mode === 'gesture') inGesture = true;
  schedule();
}
// At most one update per frame; the timeout covers background tabs, where frames pause.
const schedule = () => {
  if (frame) return;
  frame = 1;
  const run = () => { if (frame) { frame = 0; applyFilters(); } };
  requestAnimationFrame(run); setTimeout(run, 50);
};

function bbox() {
  const b = map.getBounds(), w = b.getWest(), e = b.getEast();
  if (e - w >= 360) return [-180, b.getSouth(), 180, b.getNorth()];
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  return [wrap(w), b.getSouth(), wrap(e), b.getNorth()];
}

function applyFilters() {
  if ($('#q').value !== state.q && document.activeElement !== $('#q')) $('#q').value = state.q;
  const { result: res, mapped: m, facets } = compute(videos, state, { bbox: state.view ? bbox() : null });
  result = res; mapped = m;
  panel.sync(state, facets, result.length);
  fitPanel();
  // Phones get the short form; the long one does not fit next to the legend.
  $('#summary').textContent = state.view
    ? (narrow() ? t('summary.view_short', { a: num(result.length), b: num(mapped.length) }) : t('summary.view_long', { a: num(result.length), b: num(mapped.length), c: num(videos.length) }))
    : (narrow() ? t('summary.short', { a: num(mapped.length), b: num(videos.length) }) : t('summary.long', { a: num(mapped.length), b: num(videos.length) }));
  // The map source only changes with the filters, not with the viewport (re-clustering is the slow part).
  const key = toQuery({ ...state, view: false });
  if (key !== mapKey && map.getSource('videos')) {
    mapKey = key;
    stacks = new Map();
    for (const v of mapped) { const k = stackKey(v); if (!stacks.has(k)) stacks.set(k, []); stacks.get(k).push(v); }
    map.getSource('videos').setData({ type: 'FeatureCollection', features: [...stacks].map(([k, vs]) => ({ type: 'Feature',
      geometry: { type: 'Point', coordinates: [vs[0].lon, vs[0].lat] },
      properties: { id: vs[0].id, k, n: vs.length, loc: Math.min(...vs.map((v) => v.loc ?? 7)) } })) });
    if (openStackKey && !current) openStack(openStackKey, false); // the filters changed the list
    setLines();
  }
  renderSuggestions(!!state.q.trim() && document.activeElement === $('#q'));
}

// On wide screens the panel hangs below the chip rows; it may use the rest of the window height.
function fitPanel() {
  const f = $('#filters');
  f.style.maxHeight = narrow() || f.hidden ? '' : `${Math.max(240, innerHeight - f.getBoundingClientRect().top - 16)}px`;
}
addEventListener('resize', fitPanel);

function showPanel(show) {
  const f = $('#filters');
  f.hidden = !show;
  $('#filter-toggle').setAttribute('aria-expanded', String(show));
  document.body.classList.toggle('filters-open', show);
  if (show) { $('#suggest').hidden = true; fitPanel(); f.querySelector('summary, input, button')?.focus({ preventScroll: true }); }
  else if (narrow()) $('#filter-toggle').focus({ preventScroll: true });
}

function renderSuggestions(show) {
  // Best matches first: more precise localization, then views.
  suggestions = show ? [...result].sort((a, b) => (a.loc ?? 7) - (b.loc ?? 7) || (b.views ?? 0) - (a.views ?? 0)).slice(0, SUGGEST) : [];
  active = -1;
  const ul = $('#suggest');
  ul.hidden = !suggestions.length || !show;
  $('#q').setAttribute('aria-expanded', String(!ul.hidden));
  ul.innerHTML = suggestions.map((v, i) => `<li role="option" id="sg-${i}" data-id="${v.id}" aria-selected="false">
    <span class="t">${esc(v.title || v.place || v.id)}</span>
    <span class="meta">${esc(v.place || regionName(v.region))} · ${dur(v.dur)}${v.km ? ` · ${num(v.km)} km` : ''}</span> ${lvlTag(v.loc ?? 7)}</li>`).join('');
}
function moveActive(d) {
  if (!suggestions.length) return;
  active = (active + d + suggestions.length) % suggestions.length;
  [...$('#suggest').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
  $('#q').setAttribute('aria-activedescendant', `sg-${active}`);
}
function pick(id) { $('#suggest').hidden = true; $('#q').setAttribute('aria-expanded', 'false'); openVideo(id); }

// --- dialog ---
const dialog = $('#detail');
const detailOpen = () => dialog.open;

// Phones: the route sheet is only as tall as its top down to the end of the video (or a ride's picture), so scrolled to
// the top the video is whole and the map keeps the rest; everything below scrolls inside the sheet. A list of videos at one
// point, or a video that has not loaded yet, keeps the sheet's default height (62vh, style.css). At most that height.
const SHEET_GAP = 12; // px below the video
function fitSheet() {
  const body = $('#detail-body'), slot = body.querySelector('#slot');
  if (!narrow() || !slot) { dialog.style.height = ''; return; }
  const end = slot.getBoundingClientRect().bottom - dialog.getBoundingClientRect().top + body.scrollTop + SHEET_GAP;
  dialog.style.height = `${Math.round(Math.min(end, innerHeight * 0.62))}px`;
}
addEventListener('resize', () => { if (dialog.open) fitSheet(); });

// Width of the dialog on wide screens: drag its right edge, or focus the handle and use the arrow keys (Shift: bigger steps,
// Home/End: narrowest/widest); a double click gives the default. Kept per browser; the map keeps at least about 400 px.
const DETAIL_W = { min: 320, def: 440, max: 900, key: 'scenic.detailWidth' };
const handle = dialog.querySelector('.resize-handle');
let detailW = DETAIL_W.def;
const maxDetailW = () => Math.max(DETAIL_W.min, Math.min(DETAIL_W.max, innerWidth - 420));
function setDetailWidth(w, save = false) {
  detailW = Math.round(Math.max(DETAIL_W.min, Math.min(maxDetailW(), w)));
  document.documentElement.style.setProperty('--detail-w', `${detailW}px`);
  handle.setAttribute('aria-valuemin', DETAIL_W.min); handle.setAttribute('aria-valuemax', maxDetailW()); handle.setAttribute('aria-valuenow', detailW);
  if (save) try { localStorage.setItem(DETAIL_W.key, String(detailW)); } catch { /* storage blocked: the width lasts this visit */ }
}
try { setDetailWidth(+localStorage.getItem(DETAIL_W.key) || DETAIL_W.def); } catch { setDetailWidth(DETAIL_W.def); }
addEventListener('resize', () => setDetailWidth(detailW));
handle.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  handle.setPointerCapture(ev.pointerId);
  document.body.classList.add('resizing');
  const left = dialog.getBoundingClientRect().left, grab = ev.clientX - dialog.getBoundingClientRect().right;
  const move = (e) => setDetailWidth(e.clientX - grab - left);
  const end = () => {
    handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
    document.body.classList.remove('resizing');
    setDetailWidth(detailW, true);
  };
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
});
handle.addEventListener('dblclick', () => setDetailWidth(DETAIL_W.def, true));
handle.addEventListener('keydown', (ev) => {
  const step = ev.shiftKey ? 80 : 20;
  const to = { ArrowLeft: detailW - step, ArrowRight: detailW + step, Home: DETAIL_W.min, End: maxDetailW() }[ev.key];
  if (to == null) return;
  ev.preventDefault();
  setDetailWidth(to, true);
});

// Several videos at one position: choose in the dialog (only these videos, no general route list).
function openStack(key, move = true) {
  const vs = [...(stacks.get(key) ?? [])].sort((a, b) => (a.loc ?? 7) - (b.loc ?? 7) || (b.views ?? 0) - (a.views ?? 0));
  if (!vs.length) { openStackKey = null; return; }
  if (vs.length === 1) { openVideo(vs[0].id); return; }
  player?.destroy(); player = null; profileCtl = null; hoverDot(null); current = null; drawRoute(null, false);
  openStackKey = key;
  if (location.hash) history.pushState(null, '', location.pathname + location.search);
  const v0 = vs[0], rough = vs.every((v) => (v.loc ?? 7) >= 7);
  $('#detail-body').innerHTML = `${v0.region ? `<p class="eyebrow">${esc(regionName(v0.region))}</p>` : ''}
    <h2 id="detail-title">${t('stack.title', { n: vs.length })}</h2>
    <p class="meta">${esc([v0.place, rough ? t('stack.rough') : ''].filter(Boolean).join(' · '))}</p>
    <ul class="stack" role="list">${vs.map((v) => `<li><button type="button" data-id="${v.id}">
      <span class="t">${esc(v.title || v.place || v.id)}</span>
      <span class="meta">${esc(v.channel || '')} · ${dur(v.dur)}${v.km ? ` · ${num(v.km)} km` : ''}${v.height ? ` · ${res(v.height)}` : ''} · ${t('views', { n: v.views ?? 0 })}</span> ${lvlTag(v.loc ?? 7)}</button></li>`).join('')}</ul>`;
  if (!dialog.open) dialog.show();
  document.body.classList.add('detail-open');
  $('#detail-body').scrollTop = 0;
  fitSheet();
  if (move) map.easeTo({ center: [v0.lon, v0.lat], zoom: Math.max(map.getZoom(), 9), padding: padding() });
}
$('#detail-body').addEventListener('click', (e) => {
  const b = e.target.closest('.stack button[data-id], button.back');
  if (!b) return;
  if (b.classList.contains('back')) openStack(b.dataset.k, false);
  else openVideo(b.dataset.id, 0, { stack: openStackKey });
});

async function openVideo(id, start = 0, { stack = null } = {}) {
  if (current === id && !start) return;
  current = id;
  openStackKey = null;
  const back = stack && stacks.get(stack)?.length > 1
    ? `<button type="button" class="link back" data-k="${esc(stack)}">← ${t('stack.title', { n: stacks.get(stack).length })}</button>` : '';
  const hash = `#v=${id}${start ? `&t=${Math.floor(start)}` : ''}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  player?.destroy(); player = null; profileCtl = null; hoverDot(null);
  const body = $('#detail-body');
  body.innerHTML = `<p class="meta">${t('detail.loading')}</p>`;
  if (!dialog.open) dialog.show();
  document.body.classList.add('detail-open');
  const r = await fetch(`api/videos/${encodeURIComponent(id)}`);
  if (current !== id) return;
  if (!r.ok) { body.innerHTML = `<p>${t('detail.not_found')}</p>`; return; }
  const v = await r.json();
  const l = v.localization?.loc_level ?? 7;
  const tech = v.tech;
  const regionTxt = regionName(v.region);
  body.innerHTML = `${back}${v.region ? `<p class="eyebrow">${esc(regionTxt)}</p>` : ''}<h2 id="detail-title" title="${esc(v.title || v.place || id)}">${esc(v.title || v.place || id)}</h2>
    <p class="meta">${esc(v.channel.name)}${v.channel.country ? ` (${esc(v.channel.country)})` : ''}${v.published && !v.ride ? ` · ${date(v.published)}` : ''}</p>
    <div class="video" id="slot"></div>
    <div class="readout" id="readout"></div>
    ${v.route?.elevation?.profile?.length > 1 ? '<div class="profile-box" id="profile"></div>' : ''}
    <div class="loc-box" style="--c:var(--l${l})"><b>${t('detail.loc', { l, name: LEVELS[l][0] })}</b><br>${LEVELS[l][1]}
      ${v.sync ? `<br>${esc(t('detail.sync_source', { s: SYNC_METHOD(v.sync.method) }))}${l >= 3 ? ` ${t('detail.sync_rough')}` : ''}` : ''}</div>
    <dl>
      <dt>${t('dt.place')}</dt><dd>${esc([v.place, countryName(v.country, v.country_name), regionTxt].filter((x, i, a) => x && a.indexOf(x) === i).join(', '))} ${flag(v.country)}</dd>
      ${v.route ? `<dt>${t('dt.distance')}</dt><dd>${num(v.route.distance_km)} km</dd>` : ''}
      ${v.route?.elevation ? `<dt>${t('dt.elevation')}</dt><dd>↑ ${num(v.route.elevation.ascent_m)} m · ↓ ${num(v.route.elevation.descent_m)} m · ${num(v.route.elevation.min_ele_m)}–${num(v.route.elevation.max_ele_m)} m · ${t('detail.max_gradient', { g: num(v.route.elevation.max_gradient) })}</dd>` : ''}
      ${v.route?.roads ? `<dt>${t('dt.road')}</dt><dd>${roadBar(v.route.roads.class_share)}</dd>
        <dt>${t('dt.surface')}</dt><dd>${esc(surfaceText(v.route.roads))}${v.route.roads.tunnel_km >= 0.1 || v.route.roads.bridge_km >= 0.1 ? `<br><span class="meta">${[v.route.roads.tunnel_km >= 0.1 ? t('detail.tunnel', { km: km1(v.route.roads.tunnel_km) }) : '', v.route.roads.bridge_km >= 0.1 ? t('detail.bridges', { km: km1(v.route.roads.bridge_km) }) : ''].filter(Boolean).join(' · ')}</span>` : ''}</dd>` : ''}
      <dt>${t('dt.duration')}</dt><dd>${dur(v.duration_s)}</dd>
      ${rideRows(v.ride)}
      ${v.views != null ? `<dt>${t('dt.views')}</dt><dd>${num(v.views)}</dd>` : ''}
      ${v.ride && !tech ? '' : tech ? `<dt>${t('dt.picture')}</dt><dd>${res(tech.max_height)} (${tech.max_width}×${tech.max_height}), ${Math.round(tech.fps)} fps${tech.hdr ? ', HDR' : ''}${tech.bitrate_kbps ? `, ${km1(tech.bitrate_kbps / 1000)} Mbit/s` : ''}</dd>` : `<dt>${t('dt.picture')}</dt><dd class="meta">${t('detail.no_tech')}</dd>`}
      ${v.projection === '360' ? `<dt>${t('dt.format')}</dt><dd>${t('detail.vr')}</dd>` : ''}
      ${v.footage !== 'real' ? `<dt>${t('dt.footage')}</dt><dd>${t(v.footage === 'simulator' ? 'detail.simulator' : 'detail.game')}</dd>` : ''}
      ${v.route ? `<dt>${t('dt.route')}</dt><dd>${esc(METHOD(v.route.method))}.</dd>` : ''}
      ${v.route?.check ? `<dt>${t('dt.check')}</dt><dd lang="en">${esc(v.route.check.note)}</dd>` : ''}
    </dl>
    <p>${v.route?.gpx ? `<a class="btn btn-primary" href="${esc(v.route.gpx)}" download>${t('detail.gpx')}</a>` : ''}
      <a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener">${v.ride ? esc(t('detail.source_page', { author: v.channel.name })) : t('detail.youtube')}</a>
      ${incyclistButton(v)}</p>
    ${v.ride ? `<p class="meta">${esc(t('detail.ride_in_app'))} ${esc(t('detail.download', { gb: km1(v.ride.download_size / 1e9) }))}</p>` : ''}
    ${credits(v)}
    ${v.incyclist && !v.incyclist.available ? `<p class="meta">${t('incyclist.unavailable')}</p>`
      : v.incyclist?.warn ? `<p class="meta warn">${t('incyclist.warn')}</p>` : ''}
    ${v.image && !v.ride ? `<figure class="preview"><img src="${esc(v.image.url)}" alt="${esc(t('detail.preview_alt'))}" loading="lazy"${v.image.width ? ` width="${v.image.width}" height="${v.image.height}"` : ''}>
      ${v.image.credit ? `<figcaption class="meta">${esc(v.image.credit)}</figcaption>` : ''}</figure>` : ''}
    ${v.route?.creator_links?.length ? `<p class="meta">${t('detail.creator_route')} ${v.route.creator_links.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener nofollow">${t('detail.link', { i: i + 1 })}</a>`).join(', ')}</p>` : ''}`;
  const slot = body.querySelector('#slot');
  body.scrollTop = 0;
  fitSheet();
  if (v.ride) {
    // No player: the video is only in the original download. Its picture stands in the player's place.
    // Its small web versions (srcset) load fast; the original in full size is for the app only.
    slot.innerHTML = v.image ? `<img class="ride-picture" src="${esc(v.image.url)}"${v.image.srcset ? ` srcset="${esc(v.image.srcset)}" sizes="${PICTURE_SIZES}"` : ''} alt="${esc(t('detail.preview_alt'))}" decoding="async">` : '';
  } else if (v.embeddable) {
    player = mountPlayer(map, slot, { videoId: id, syncUrl: v.sync?.path, start, readout: body.querySelector('#readout'),
      onTime: (s, km, total) => profileCtl?.at(km, total) });
  } else {
    slot.innerHTML = `<div class="consent"><p>${t('detail.no_embed')}</p>
      <a href="${esc(v.url)}" target="_blank" rel="noopener">${t('detail.watch_youtube')}</a></div>`;
  }
  let line = v.route?.line?.map(([la, lo]) => [lo, la]);
  const pbox = body.querySelector('#profile');
  profileCtl = pbox ? mountProfile(pbox, v.route.elevation.profile, line, v.ride?.climbs ?? []) : null;
  if (!line && v.sync) line = (await fetch(v.sync.path).then((x) => x.json())).c;
  if (current !== id) return;
  if (line) drawRoute(line);
  else { drawRoute(null); map.easeTo({ center: [v.lon, v.lat], zoom: Math.max(map.getZoom(), v.position_exact ? 11 : 7), padding: padding() }); }
}

function closeVideo() {
  player?.destroy(); player = null; current = null; profileCtl = null; hoverDot(null); openStackKey = null;
  drawRoute(null);
  if (dialog.open) dialog.close();
  document.body.classList.remove('detail-open');
  // fitBounds/easeTo keep their padding: without the dialog, the map centre goes back to the middle.
  map.easeTo({ padding: padding(), duration: 300 });
  if (location.hash) history.pushState(null, '', location.pathname + location.search);
}

function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const id = p.get('v');
  if (id) openVideo(id, +p.get('t') || 0); else if (current) closeVideo();
  else if (openStackKey && dialog.open) closeVideo();
}

// --- wiring ---
$('#q').value = state.q;
$('#q').addEventListener('input', () => setState({ q: $('#q').value }, 'gesture'));
$('#q').addEventListener('blur', () => { inGesture = false; });
$('#q').addEventListener('focus', () => renderSuggestions(!!$('#q').value.trim()));
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Enter' && suggestions.length) { e.preventDefault(); pick(suggestions[Math.max(active, 0)].id); }
  else if (e.key === 'Escape') { $('#suggest').hidden = true; $('#q').setAttribute('aria-expanded', 'false'); }
});
$('#suggest').addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-id]'); if (li) { e.preventDefault(); pick(li.dataset.id); } });
document.addEventListener('click', (e) => { if (!e.target.closest('#search')) { $('#suggest').hidden = true; $('#q').setAttribute('aria-expanded', 'false'); } });
$('#filter-toggle').addEventListener('click', () => showPanel($('#filters').hidden));
dialog.querySelector('.close').addEventListener('click', closeVideo);
// The dialog is non-modal on purpose: the map stays usable, so the video pointer can be dragged.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#filters').hidden && e.target.closest('#filters, #filter-toggle')) showPanel(false);
  else if (dialog.open && !e.target.closest('#search')) closeVideo();
});
// Back/forward restore the filters (query) and the video (hash).
window.addEventListener('popstate', () => {
  state = fromQuery(location.search);
  inGesture = false;
  if (panel) schedule();
  fromHash();
});
map.on('moveend', () => { if (state.view && panel) schedule(); });

try {
  await load();
  applyFilters(); // panel and counts work before the map has loaded
  await mapReady;
  localizeLabels();
  addLayers();
  bindLayerEvents();
  applyFilters();
  fromHash();
  loadLines().catch((err) => console.warn('lines.json', err));
} catch (err) {
  console.error(err);
  $('#notice').hidden = false;
  $('#notice').textContent = t('notice.load_failed');
}
