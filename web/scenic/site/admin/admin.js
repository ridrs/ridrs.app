// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin UI (CLOUDFLARE-KONZEPT.md 3.5, phase 4 "Redaktion"): videos (editorial fields, location, route,
// anchors, Prüfmodus, preview images, change log with undo), collections, channel opt-out, global log.
// Talks only to /api/admin/* (403 without a Cloudflare Access identity, see src/auth.js).
// The synced player is site/player.js; route geometry, sync rules and review logic are site/lib/route-sync.js.
import { Map as MapGL, NavigationControl, Marker, LngLatBounds, Popup } from '../vendor/maplibre-gl/maplibre-gl.mjs';
import { decodeLine } from '../lib/lines.js';
import { mountPlayer } from '../player.js';
// The admin is German only (editors); the shared player texts follow it.
import { setLocale } from '../i18n.js';
import de from '../locales/de.js';
import { kmAlong, project, trackAt, checkPoints, evaluateReview, LOC_RULES } from '../lib/route-sync.js';
setLocale('de', de);

const STYLE = 'https://tiles.openfreemap.org/styles/positron'; // light map, dark interface (as the public page)
const LEVELS = { 1: 'Verifiziert', 2: 'Verankert', 3: 'Geschätzt synchron', 4: 'Route bestätigt', 5: 'Route ungefähr', 6: 'Punkt', 7: 'Region' };
const RIGHTS = { own: 'eigenes Bild', cc0: 'CC0', cc_by: 'CC BY (Namensnennung)', licensed: 'lizenziert' };
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const num = (n) => (n ?? 0).toLocaleString('de-DE');
const fmt = (s) => { if (s == null) return '–'; s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60), d = Math.round((s % 1) * 10);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}${d ? `,${d}` : ''}`; };
const parseTime = (str) => { const p = String(str).trim().replace(',', '.').split(':').map(Number); if (p.some((x) => !Number.isFinite(x))) return null;
  return p.reduce((a, x) => a * 60 + x, 0); };
const lvl = (l) => `<span class="lvl" style="--c:var(--l${l ?? 7})">${l ?? 7} · ${LEVELS[l ?? 7]}</span>`;

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(`../api/admin/${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}
let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast(e.message, true); } };

let me = null, collectionsCache = [];


// --- router: #videos, #v=<id>, #collections, #optout, #log ---
const VIEW_KEY = 'ridrs-scenic.admin.view';
let listState = { q: '', only: '', loc: '', offset: 0, view: (() => { try { return localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'list'; } catch { return 'list'; } })(), camera: null };
// Map of the video page (view "Karte"); removed when the page changes.
let listMap = null;
// Route lines of every video (../api/admin/lines.json), loaded with the map and kept for filter changes; null until loaded.
let listLines = null, listVids = [];
function dropListMap() {
  if (!listMap) return;
  listLines = null;
  listState.camera = { center: listMap.getCenter(), zoom: listMap.getZoom() };
  listMap.remove(); listMap = null;
  $('#view').classList.remove('mapmode');
}
function route() {
  const h = location.hash.slice(1);
  const tab = h.startsWith('v=') ? 'videos' : (h || 'videos');
  for (const a of document.querySelectorAll('.tabs a')) { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  if (h.startsWith('v=')) { dropListMap(); return openVideo(h.slice(2)); }
  closeEditor();
  if (tab !== 'videos') dropListMap();
  if (tab === 'collections') return renderCollections();
  if (tab === 'optout') return renderOptout();
  if (tab === 'log') return renderLog();
  return renderList();
}
addEventListener('hashchange', guard(route));

// --- video list ---
async function renderList() {
  const v = $('#view');
  if (!$('#list-q', v)) {
    v.innerHTML = `<div class="list-tools">
      <input id="list-q" type="search" placeholder="Titel, Ort, Kanal oder Video-ID" aria-label="Suchen" value="${esc(listState.q)}">
      <select id="list-only" aria-label="Nur">
        <option value="">alle Videos</option><option value="site_published">veröffentlicht</option><option value="unpublished">nicht veröffentlicht</option><option value="pick">Editor's Pick</option><option value="stars">mit Sternen</option><option value="note">mit Notiz</option>
        <option value="hidden">ausgeblendet</option><option value="manual">von Hand geändert</option><option value="anchors">mit Ankern</option>
        <option value="review">Stufe 2 (zu prüfen)</option><option value="noimage">Stufe 1–2 ohne Vorschaubild</option><option value="route">mit Route</option><option value="optout">Kanal mit Opt-out</option></select>
      <select id="list-loc" aria-label="Lokalisierungsstufe"><option value="">jede Stufe</option>${[1, 2, 3, 4, 5, 6].map((l) => `<option value="${l}">Stufe ≤ ${l}</option>`).join('')}</select>
      <span class="viewtoggle" role="group" aria-label="Ansicht"><button type="button" class="btn small" data-view="list">Liste</button><button type="button" class="btn small" data-view="map">Karte</button></span>
    </div><div class="wrap" id="list-body"></div>`;
    $('.viewtoggle', v).addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]'); if (!b || b.dataset.view === listState.view) return;
      listState = { ...listState, view: b.dataset.view };
      try { localStorage.setItem(VIEW_KEY, listState.view); } catch { /* storage blocked */ }
      guard(loadList)();
    });
    $('#list-only', v).value = listState.only; $('#list-loc', v).value = listState.loc;
    let timer = 0;
    $('#list-q', v).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { listState = { ...listState, q: $('#list-q').value, offset: 0 }; guard(loadList)(); }, 250); });
    $('#list-only', v).addEventListener('change', () => { listState = { ...listState, only: $('#list-only').value, offset: 0 }; guard(loadList)(); });
    $('#list-loc', v).addEventListener('change', () => { listState = { ...listState, loc: $('#list-loc').value, offset: 0 }; guard(loadList)(); });
  }
  await loadList();
  $('#list-q')?.focus({ preventScroll: true });
}
async function loadList() {
  for (const b of document.querySelectorAll('.viewtoggle [data-view]')) b.classList.toggle('on', b.dataset.view === listState.view);
  if (listState.view === 'map') return loadMap();
  dropListMap();
  const p = new URLSearchParams({ q: listState.q, only: listState.only, loc: listState.loc, offset: listState.offset });
  const { rows, more, offset } = await api('GET', `videos?${p}`);
  const body = $('#list-body');
  if (!body) return;
  body.innerHTML = `<table class="adm"><thead><tr><th>Video</th><th>Ort</th><th>Stufe</th><th>Redaktion</th><th>Dauer</th><th>Views</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="click" data-id="${r.video_id}" tabindex="0"><td><span class="t">${esc(r.title || r.video_id)}</span><br><span class="meta">${esc(r.channel || '')} · <span class="mono">${r.video_id}</span></span></td>
      <td>${esc(r.place || '')}${r.country ? ` (${esc(r.country)})` : ''}${r.distance_km ? `<br><span class="meta">${r.distance_km} km</span>` : ''}</td>
      <td>${lvl(r.loc_level)}${r.synced ? '<br><span class="tag hi">synchron</span>' : ''}${r.anchors ? ` <span class="tag">${r.anchors} Anker</span>` : ''}</td>
      <td><span class="tags">${r.site_published ? '<span class="tag ok">öffentlich</span>' : ''}${r.stars ? `<span class="tag hi">${'★'.repeat(r.stars)}</span>` : ''}${r.editors_pick ? '<span class="tag hi">Pick</span>' : ''}${r.hidden ? '<span class="tag warn">ausgeblendet</span>' : ''}${r.optout ? '<span class="tag warn">Opt-out</span>' : ''}</span></td>
      <td class="mono">${fmt(r.duration_s)}</td><td class="mono">${num(r.view_count)}</td></tr>`).join('')}</tbody></table>
    ${!rows.length ? '<p class="meta">Nichts gefunden.</p>' : ''}
    <p class="row">${offset ? '<button class="btn small" data-page="-1">Zurück</button>' : ''}${more ? '<button class="btn small" data-page="1">Weiter</button>' : ''}
      <span class="meta">${offset + 1}–${offset + rows.length}</span></p>`;
  body.onclick = (e) => {
    const tr = e.target.closest('tr[data-id]'); if (tr) { location.hash = `v=${tr.dataset.id}`; return; }
    const b = e.target.closest('[data-page]'); if (b) { listState.offset = Math.max(0, listState.offset + 100 * +b.dataset.page); guard(loadList)(); }
  };
  body.onkeydown = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr && e.key === 'Enter') location.hash = `v=${tr.dataset.id}`; };
}

// --- video map (view "Karte"): every video matching the filters, published or not; a click opens the editor ---
async function loadMap() {
  const p = new URLSearchParams({ q: listState.q, only: listState.only, loc: listState.loc, map: '1' });
  const { fields, rows } = await api('GET', `videos?${p}`);
  const body = $('#list-body');
  if (!body || listState.view !== 'map') return;
  const vids = rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
  const data = { type: 'FeatureCollection', features: vids.map((x) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lon, x.lat] },
    properties: { id: x.id, title: x.title || x.id, loc: x.loc, pub: x.pub && !x.hidden && !x.optout ? 1 : 0 } })) };
  const nPub = data.features.filter((f) => f.properties.pub).length;
  listVids = vids;
  if (listMap) {
    listMap.getSource('vids')?.setData(data);
    setListLines();
    $('#lmap-count').textContent = `${num(vids.length)} Videos · ${num(nPub)} öffentlich`;
    return;
  }
  $('#view').classList.add('mapmode');
  body.innerHTML = `<div id="lmap"></div><p class="lmap-legend meta"><span id="lmap-count">${num(vids.length)} Videos · ${num(nPub)} öffentlich</span>
    <span><i class="dot pub"></i>veröffentlicht</span><span><i class="dot draft"></i>nicht veröffentlicht</span><span>Routen ab Zoom 5</span></p>`;
  const cam = listState.camera ?? { center: [10, 45], zoom: 3.2 };
  const map = listMap = new MapGL({ container: 'lmap', style: STYLE, center: cam.center, zoom: cam.zoom, attributionControl: false });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  api('GET', 'lines.json').then((raw) => {
    if (listMap !== map) return;
    listLines = new Map(Object.entries(raw).map(([id, f]) => [id, decodeLine(f)]));
    setListLines();
  }).catch((e) => toast(`Routen: ${e.message}`, true));
  map.on('load', () => {
    const level = ['match', ['get', 'loc'], 1, css('--l1'), 2, css('--l2'), 3, css('--l3'), 4, css('--l4'), 5, css('--l5'), 6, css('--l6'), css('--l7')];
    // Routes of the filtered videos under the points, from zoom 5 on (as the public map); not published: thinner and paler.
    map.addSource('lines', { type: 'geojson', data: fc([]), promoteId: 'id', tolerance: 0.5 });
    map.addLayer({ id: 'lines', type: 'line', source: 'lines', minzoom: 5, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': level, 'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, ['==', ['get', 'pub'], 1], 0.8, 0.5],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['boolean', ['feature-state', 'hover'], false], 3, 1.2],
          10, ['case', ['boolean', ['feature-state', 'hover'], false], 5, 2.2], 14, ['case', ['boolean', ['feature-state', 'hover'], false], 7, 3.5]] } });
    // Invisible, wider twin for hover and click: thin lines are hard to hit.
    map.addLayer({ id: 'lines-hit', type: 'line', source: 'lines', minzoom: 5, paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 12 } });
    setListLines();
    map.addSource('vids', { type: 'geojson', data, cluster: true, clusterMaxZoom: 11, clusterRadius: 40, clusterProperties: { pub: ['+', ['get', 'pub']] } });
    map.addLayer({ id: 'cl', type: 'circle', source: 'vids', filter: ['has', 'point_count'],
      paint: { 'circle-color': css('--surface-raised'), 'circle-opacity': 0.92, 'circle-stroke-color': ['case', ['>', ['get', 'pub'], 0], css('--l2'), css('--cyan')], 'circle-stroke-width': 1.5,
        'circle-radius': ['step', ['get', 'point_count'], 12, 50, 16, 250, 21, 1000, 27] } });
    map.addLayer({ id: 'cl-n', type: 'symbol', source: 'vids', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': css('--text') } });
    // Published: filled in the level colour; not published: white with a ring in the level colour.
    map.addLayer({ id: 'pt', type: 'circle', source: 'vids', filter: ['!', ['has', 'point_count']],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4.5, 12, 8], 'circle-color': ['case', ['==', ['get', 'pub'], 1], level, '#ffffff'],
        'circle-stroke-color': ['case', ['==', ['get', 'pub'], 1], css('--map-point-stroke'), level], 'circle-stroke-width': ['case', ['==', ['get', 'pub'], 1], 1.2, 2.2] } });
    if (!listState.camera && vids.length) {
      const b = vids.reduce((bb, x) => bb.extend([x.lon, x.lat]), new LngLatBounds([vids[0].lon, vids[0].lat], [vids[0].lon, vids[0].lat]));
      map.fitBounds(b, { padding: 50, maxZoom: 9, duration: 0 });
    }
  });
  map.on('click', 'cl', async (e) => {
    const f = e.features[0];
    map.easeTo({ center: f.geometry.coordinates, zoom: await map.getSource('vids').getClusterExpansionZoom(f.properties.cluster_id) });
  });
  // Several videos at the same point: a short list to choose from.
  map.on('click', 'pt', (e) => {
    const fs = map.queryRenderedFeatures(e.point, { layers: ['pt'] });
    if (fs.length === 1) { location.hash = `v=${fs[0].properties.id}`; return; }
    new Popup({ maxWidth: '320px' }).setLngLat(e.lngLat).setHTML(`<ul class="lmap-pick">${fs.slice(0, 20).map((f) => `<li><a href="#v=${f.properties.id}">${lvl(f.properties.loc)} ${esc(f.properties.title)}${f.properties.pub ? '' : ' <span class="tag">nicht veröffentlicht</span>'}</a></li>`).join('')}</ul>`).addTo(map);
  });
  const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'lmap-tip' });
  map.on('mousemove', 'pt', (e) => { const f = e.features[0].properties; tip.setLngLat(e.lngLat).setHTML(`${esc(f.title)}${f.pub ? '' : ' · <em>nicht veröffentlicht</em>'}`).addTo(map); });
  map.on('mouseleave', 'pt', () => tip.remove());
  let hoverId = null;
  const setHover = (id) => {
    if (hoverId != null && map.getSource('lines')) map.setFeatureState({ source: 'lines', id: hoverId }, { hover: false });
    hoverId = id;
    if (id != null) map.setFeatureState({ source: 'lines', id }, { hover: true });
  };
  const onPoint = (e) => map.queryRenderedFeatures(e.point, { layers: ['pt', 'cl'] }).length > 0; // the point wins
  map.on('click', 'lines-hit', (e) => { if (!onPoint(e)) location.hash = `v=${e.features[0].properties.id}`; });
  map.on('mousemove', 'lines-hit', (e) => {
    if (onPoint(e)) return setHover(null);
    const f = e.features[0]; setHover(f.id);
    tip.setLngLat(e.lngLat).setHTML(`${esc(f.properties.title)}${f.properties.pub ? '' : ' · <em>nicht veröffentlicht</em>'}`).addTo(map);
  });
  map.on('mouseleave', 'lines-hit', () => { setHover(null); tip.remove(); });
  for (const l of ['cl', 'pt', 'lines-hit']) {
    map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
  }
}

// The lines of the videos on the map now (listVids), once both the lines and the map's source are there.
function setListLines() {
  const src = listMap?.getSource('lines');
  if (!src || !listLines) return;
  src.setData(fc(listVids.filter((x) => listLines.has(x.id)).map((x) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: listLines.get(x.id) },
    properties: { id: x.id, title: x.title || x.id, loc: x.loc, pub: x.pub && !x.hidden && !x.optout ? 1 : 0 } }))));
}

// --- video editor ---
// ed: {id, D (detail), map, player, track, mode, markers, via, preview, review}
let ed = null;
function closeEditor() {
  if (!ed) return;
  ed.player?.destroy(); ed.map?.remove();
  document.removeEventListener('keydown', ed.onKey);
  ed = null;
}

async function openVideo(id) {
  if (ed?.id === id) return;
  closeEditor();
  const D = await api('GET', `videos/${id}`);
  collectionsCache = await api('GET', 'collections');
  $('#view').innerHTML = `<div class="ed">
    <div class="ed-side">
      <p class="row"><a href="#videos" class="link">← Videos</a><span class="grow"></span>
        <a class="link" href="../#v=${id}" target="_blank" rel="noopener">öffentlich</a> · <a class="link" href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">YouTube</a></p>
      <h1>${esc(D.title || id)}</h1>
      <p class="meta">${esc(D.channel.name || '')} · <span class="mono">${id}</span> · ${fmt(D.duration_s)}${D.status && D.status !== 'public' ? ` · <span class="bad">${esc(D.status)}</span>` : ''}</p>
      <div class="video" id="slot"></div>
      <div class="readout" id="readout"></div>
      <div id="sections"></div>
    </div>
    <div class="ed-map"><div id="amap"></div><p class="mode-banner" id="banner" hidden></p></div>
  </div>`;
  ed = { id, D, mode: null, markers: [], via: null, preview: null, review: null, pendingPin: null };
  ed.map = new MapGL({ container: 'amap', style: STYLE, center: [D.lon ?? 10, D.lat ?? 45], zoom: D.lat != null ? 9 : 3 });
  ed.map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  ed.map.on('load', () => { addLayers(); drawMap(true); });
  ed.map.on('click', guard(onMapClick));
  ed.track = await api('GET', `videos/${id}/track`).catch(() => null);
  if (D.embeddable) {
    ed.player = mountPlayer(ed.map, $('#slot'), { videoId: id, track: ed.track, consent: false, readout: $('#readout') });
  } else {
    $('#slot').innerHTML = '<div class="consent"><p>Einbetten nicht erlaubt: Videozeit für Anker unten von Hand eintragen.</p></div>';
  }
  ed.onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (ed.review) return reviewKey(e);
    if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); armAnchor(); }
    if (e.key === 'Escape') setMode(null);
  };
  document.addEventListener('keydown', ed.onKey);
  renderSections();
}

async function refresh({ track = false } = {}) {
  if (!ed) return;
  ed.D = await api('GET', `videos/${ed.id}`);
  if (track) {
    ed.track = await api('GET', `videos/${ed.id}/track`).catch(() => null);
    ed.player?.setTrack(ed.track);
  }
  if (!ed.review) renderSections();
  drawMap(false);
}

// Map layers.
const fc = (features) => ({ type: 'FeatureCollection', features });
function addLayers() {
  const m = ed.map;
  m.addSource('route', { type: 'geojson', data: fc([]) });
  m.addSource('preview', { type: 'geojson', data: fc([]) });
  m.addSource('anchors', { type: 'geojson', data: fc([]) });
  m.addLayer({ id: 'route-casing', type: 'line', source: 'route', paint: { 'line-color': css('--map-casing'), 'line-width': 8 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
  m.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': css('--map-route'), 'line-width': 4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
  m.addLayer({ id: 'preview-line', type: 'line', source: 'preview', paint: { 'line-color': css('--map-preview'), 'line-width': 4, 'line-dasharray': [2, 1.5] }, layout: { 'line-join': 'round' } });
  m.addLayer({ id: 'anchor-dot', type: 'circle', source: 'anchors', paint: { 'circle-radius': 7, 'circle-color': css('--lime'), 'circle-stroke-color': css('--map-text'), 'circle-stroke-width': 2 } });
  m.addLayer({ id: 'anchor-label', type: 'symbol', source: 'anchors', layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-font': ['Noto Sans Bold'] },
    paint: { 'text-color': css('--map-text'), 'text-halo-color': css('--map-casing'), 'text-halo-width': 1.5 } });
}
function drawMap(fit) {
  const m = ed?.map; if (!m?.getSource('route')) return;
  const D = ed.D, line = D.route?.line;
  m.getSource('route').setData(fc(line?.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} }] : []));
  m.getSource('preview').setData(fc(ed.preview?.line ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: ed.preview.line }, properties: {} }] : []));
  m.getSource('anchors').setData(fc(D.anchors.map((a) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lon, a.lat] }, properties: { label: fmt(a.t) } }))));
  for (const mk of ed.markers) mk.remove();
  ed.markers = [];
  if (D.lat != null) {
    const el = document.createElement('div'); el.className = 'pin-marker'; el.title = 'Pin';
    const mk = new Marker({ element: el, draggable: ed.mode === 'pin' }).setLngLat(ed.pendingPin ?? [D.lon, D.lat]).addTo(m);
    mk.on('dragend', () => { ed.pendingPin = mk.getLngLat().toArray(); renderSections(); });
    ed.markers.push(mk);
  }
  if (ed.via) ed.via.forEach((p, i) => {
    const el = document.createElement('div'); el.className = 'via-marker'; el.textContent = i === 0 ? 'S' : i === ed.via.length - 1 ? 'Z' : String(i);
    const mk = new Marker({ element: el, draggable: true }).setLngLat(p).addTo(m);
    mk.on('dragend', () => { ed.via[i] = mk.getLngLat().toArray(); ed.preview = null; renderSections(); drawMap(false); });
    ed.markers.push(mk);
  });
  if (fit) {
    const pts = line?.length > 1 ? line : D.lat != null ? [[D.lon, D.lat]] : null;
    if (pts?.length > 1) m.fitBounds(pts.reduce((b, c) => b.extend(c), new LngLatBounds(pts[0], pts[0])), { padding: 50, maxZoom: 14, duration: 0 });
  }
}

function setMode(mode, text = '') {
  if (!ed) return;
  ed.mode = mode;
  const b = $('#banner'); b.hidden = !mode; b.textContent = text;
  $('.ed-map')?.classList.toggle('armed', !!mode);
  drawMap(false);
  renderSections();
}
async function onMapClick(e) {
  if (!ed?.mode) return;
  const p = [Math.round(e.lngLat.lng * 1e6) / 1e6, Math.round(e.lngLat.lat * 1e6) / 1e6];
  if (ed.mode === 'anchor') {
    const t = ed.anchorT;
    setMode(null);
    const r = await api('POST', `videos/${ed.id}/anchors`, { t, lon: p[0], lat: p[1] });
    toast(`Anker bei ${fmt(r.anchor.t)}, km ${r.anchor.km.toFixed(2)} gesetzt${syncText(r.sync)}`);
    await refresh({ track: true });
  } else if (ed.mode === 'pin') {
    ed.pendingPin = p; drawMap(false); renderSections();
  } else if (ed.mode === 'via') {
    ed.via.push(p); ed.preview = null; drawMap(false); renderSections();
  }
}
const syncText = (s) => (!s ? '' : s.status === 'built' ? ` · Track neu berechnet, Stufe ${s.level}` : s.status === 'pipeline_track'
  ? ' · Pipeline-Track bleibt (Anker für den nächsten video2gpx-Lauf)' : s.status === 'no_route' ? ' · keine Route' : '');

function currentTime() {
  if (ed.player) return Math.round(ed.player.time() * 10) / 10;
  return parseTime($('#anchor-t')?.value ?? '');
}
function armAnchor() {
  if (!ed?.D.route) return toast('Ohne Route keine Anker: zuerst eine Route setzen', true);
  ed.player?.pause();
  const typed = $('#anchor-t')?.value.trim();
  const t = typed ? parseTime(typed) : currentTime();
  if (t == null) return toast('Videozeit fehlt', true);
  ed.anchorT = t;
  setMode('anchor', `Klicke auf die Stelle, an der die Kamera bei ${fmt(t)} ist (Esc bricht ab)`);
}

// --- sections of the editor ---
function renderSections() {
  if (!ed || ed.review) return;
  const D = ed.D, box = $('#sections');
  const loc = D.localization, level = loc?.loc_level ?? 7;
  const manual = new Set(D.manual.map((m) => m.field));
  const mtag = (f) => (manual.has(f) ? ' <span class="tag hi" title="Von Hand gesetzt: der Import überschreibt das nicht">manuell</span>' : '');
  const kms = D.anchors.map((a) => a.km ?? 0), routeKm = D.route?.km ?? 0, tol = D.rules.end_tolerance_km;
  const hasStart = D.route && kms.some((k) => k <= tol), hasEnd = D.route && kms.some((k) => k >= routeKm - tol);
  const pipelineTrack = D.sync && D.sync.method !== 'anchors';
  const pin = ed.pendingPin ?? [D.lon, D.lat];
  box.innerHTML = `
  <section class="card"><h2>Redaktion</h2>
    <label class="chk publish"><input type="checkbox" id="f-published" ${D.site_published ? 'checked' : ''}> Veröffentlicht (auf der öffentlichen Seite sichtbar)</label>
    <div class="field"><span>Sterne</span><div class="stars" id="f-stars">${[0, 1, 2, 3, 4, 5].map((n) => `<label class="${n && n <= (D.stars ?? 0) ? 'on' : ''}" title="${n ? `${n} Sterne` : 'keine'}">
      <input type="radio" name="stars" value="${n}" ${(D.stars ?? 0) === n ? 'checked' : ''}>${n ? '★' : '∅'}</label>`).join('')}</div></div>
    <label class="chk"><input type="checkbox" id="f-pick" ${D.editors_pick ? 'checked' : ''}> Editor's Pick</label>
    ${D.hidden ? '<label class="chk"><input type="checkbox" id="f-hidden" checked> Ausgeblendet (sperrt das Video auch wenn veröffentlicht)</label>' : ''}
    <label class="field"><span>Notiz der Redaktion</span><textarea id="f-note" maxlength="2000">${esc(D.editor_note ?? '')}</textarea></label>
    <button type="button" class="btn btn-primary" id="save-ed">Speichern</button>
    <div class="field" style="margin-top:.6rem"><span>Sammlungen</span>
      ${collectionsCache.length ? collectionsCache.map((c) => `<label class="chk"><input type="checkbox" data-col="${c.collection_id}" ${D.collections.some((x) => x.collection_id === c.collection_id) ? 'checked' : ''}> ${esc(c.title)}</label>`).join('')
        : '<span class="meta">Noch keine Sammlung (<a href="#collections">anlegen</a>).</span>'}</div>
    ${D.channel.optout ? '<p class="hint-box warn">Der Kanal hat Opt-out: das Video ist öffentlich nicht sichtbar und fällt beim nächsten Import heraus.</p>' : ''}
  </section>
  <section class="card"><h2>Verortung</h2>
    <label class="field"><span>Ort${mtag('place')}</span><input type="text" id="f-place" value="${esc(D.place ?? '')}" maxlength="200"></label>
    <label class="field"><span>Region${mtag('region')}</span><input type="text" id="f-region" list="regions" value="${esc(D.region ?? '')}" maxlength="80">
      <datalist id="regions">${(me?.regions ?? []).map((r) => `<option value="${esc(r)}">`).join('')}</datalist></label>
    <div class="row field"><span>Land${mtag('country')}</span><input type="text" id="f-cc" value="${esc(D.country ?? '')}" maxlength="2" size="3" list="ccs" aria-label="Ländercode">
      <datalist id="ccs">${(me?.countries ?? []).map((c) => `<option value="${esc(c.country)}">${esc(c.name)}</option>`).join('')}</datalist>
      <input type="text" id="f-cn" value="${esc(D.country_name ?? '')}" class="grow" aria-label="Ländername" placeholder="Name (deutsch)"></div>
    <div class="field"><span>Pin${mtag('lat')}</span><span class="mono">${pin[1] != null ? `${(+pin[1]).toFixed(5)}, ${(+pin[0]).toFixed(5)}` : '–'}${ed.pendingPin ? ' <span class="tag hi">neu, noch nicht gespeichert</span>' : ''}</span>
      <span class="row"><button type="button" class="btn small ${ed.mode === 'pin' ? 'on' : ''}" id="pin-mode">${ed.mode === 'pin' ? 'Pin setzen: Klick auf die Karte …' : 'Pin verschieben'}</button>
      ${D.route?.line ? '<button type="button" class="btn small" id="pin-start">auf Routenstart</button>' : ''}</span></div>
    <button type="button" class="btn btn-primary" id="save-loc">Speichern</button>
  </section>
  <section class="card"><h2>Route ${mtag('route')}</h2>
    ${D.route ? `<p class="meta">${D.route.distance_km} km · ${esc(D.route.method)}${D.route.via ? ` · ${D.route.via.length} Punkte` : ''}${D.route.profile ? '' : ' · ohne Höhenprofil (kommt mit dem nächsten Pipeline-Lauf)'}</p>` : '<p class="meta">Keine Route.</p>'}
    ${ed.via ? `<div class="hint-box">Klick auf die Karte hängt einen Punkt an (erster = Start, letzter = Ziel); Punkte lassen sich ziehen. Routing: OSRM, Auto, höchstens 1 Anfrage/s.</div>
      <table class="mini"><tbody>${ed.via.map((p, i) => `<tr><td>${i === 0 ? 'Start' : i === ed.via.length - 1 ? 'Ziel' : `Via ${i}`}</td><td class="mono">${p[1].toFixed(5)}, ${p[0].toFixed(5)}</td>
        <td><button type="button" class="btn small" data-via-up="${i}" ${i ? '' : 'disabled'} aria-label="nach oben">↑</button><button type="button" class="btn small danger" data-via-del="${i}" aria-label="entfernen">✕</button></td></tr>`).join('')}</tbody></table>
      <p class="row"><button type="button" class="btn small" id="via-from">Start/Ziel der Route</button><button type="button" class="btn small" id="via-clear">Leeren</button></p>
      <p class="row"><button type="button" class="btn" id="via-route" ${ed.via.length >= 2 ? '' : 'disabled'}>Neu routen (OSRM)</button>
        <button type="button" class="btn btn-primary" id="via-save" ${ed.preview ? '' : 'disabled'}>Übernehmen${ed.preview ? ` (${ed.preview.distance_km} km)` : ''}</button>
        <button type="button" class="btn" id="via-cancel">Abbrechen</button></p>`
    : `<p class="row"><button type="button" class="btn" id="route-edit">${D.route ? 'Route bearbeiten' : 'Route setzen'}</button>
      ${D.route ? '<button type="button" class="btn" id="route-reverse">Richtung umdrehen</button><button type="button" class="btn danger" id="route-discard">Route verwerfen</button>' : ''}</p>`}
  </section>
  <section class="card"><h2>Synchronisierung <span>${lvl(level)}</span></h2>
    ${pipelineTrack ? `<p class="hint-box">Track aus der Pipeline (${esc(D.sync.method)}). Anker werden gespeichert und gehen mit dem Export an den nächsten video2gpx-Lauf, ersetzen diesen Track aber nicht.</p>` : ''}
    ${D.route ? `<p class="meta">Stufe 2 braucht Anker am Start und am Ziel (je ± ${tol?.toFixed(1)} km) und mindestens ${D.rules.need} Anker (im Mittel 1 je ${LOC_RULES.kmPerAnchor} km), sonst Stufe 3. Route muss Stufe 4 oder besser sein.
      Stand: ${D.anchors.length} Anker · Start <b class="${hasStart ? 'ok' : 'bad'}">${hasStart ? 'ja' : 'nein'}</b> · Ziel <b class="${hasEnd ? 'ok' : 'bad'}">${hasEnd ? 'ja' : 'nein'}</b></p>` : '<p class="meta">Ohne Route keine Anker.</p>'}
    <div class="row"><label class="row">Videozeit <input type="text" id="anchor-t" size="8" placeholder="${ed.player ? 'Player' : 'mm:ss'}" title="Leer = aktuelle Zeit des Players"></label>
      <button type="button" class="btn btn-primary" id="anchor-arm" ${D.route ? '' : 'disabled'}>Anker setzen <span class="kbd">A</span></button></div>
    <p class="meta">Video an eine erkennbare Stelle spulen (Ortseingang, Passhöhe, Kreuzung), „Anker setzen“, dann auf die Karte klicken. Der Punkt rastet auf der Route ein.</p>
    ${D.anchors.length ? `<table class="mini"><thead><tr><th>Zeit</th><th>km</th><th>Quelle</th><th></th></tr></thead><tbody>${D.anchors.map((a) => `<tr>
      <td><button type="button" class="link mono" data-seek="${a.t}">${fmt(a.t)}</button></td><td class="mono">${a.km != null ? a.km.toFixed(2) : '–'}</td><td>${esc(a.source)}</td>
      <td><button type="button" class="btn small danger" data-anchor-del="${a.t}" aria-label="Anker löschen">✕</button></td></tr>`).join('')}</tbody></table>` : ''}
    ${loc?.verified_at ? `<p class="meta">Geprüft von ${esc(loc.verified_by)} am ${esc(loc.verified_at.slice(0, 10))} · Abweichung Median ${loc.err_along_med_m ?? '–'} m, max. ${loc.err_along_max_m ?? '–'} m</p>` : ''}
    ${D.sync && level <= 3 ? `<p><button type="button" class="btn" id="review-start">Prüfmodus (Stufe 1) starten</button></p>` : D.sync ? '<p class="meta">Prüfmodus ab Stufe 3 (Route bestätigt und synchron).</p>' : ''}
    ${v2gBox(D)}
  </section>
  <section class="card"><h2>Vorschaubilder</h2>
    ${me?.images === false ? '<p class="hint-box warn">R2-Binding IMAGES fehlt.</p>' : ''}
    <div class="thumbs">${D.images.map((im) => `<div class="thumb ${im.is_primary ? 'primary' : ''}" data-img="${im.image_id}">
      <img src="../api/admin/images/${im.image_id}/raw" alt="" loading="lazy">
      <div><p class="meta">${im.width ?? '?'}×${im.height ?? '?'} · ${Math.round(im.bytes / 1024)} KB · ${esc(im.uploaded_by)}${im.is_primary ? ' · <b class="ok">Hauptbild</b>' : ''}</p>
        <div class="row"><select data-k="rights" aria-label="Rechte">${Object.entries(RIGHTS).map(([k, v]) => `<option value="${k}" ${im.rights === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input type="text" data-k="credit" value="${esc(im.credit ?? '')}" placeholder="Namensnennung" class="grow" aria-label="Namensnennung"></div>
        <div class="row"><button type="button" class="btn small" data-img-save>Speichern</button>${im.is_primary ? '' : '<button type="button" class="btn small" data-img-primary>Hauptbild</button>'}
        <button type="button" class="btn small danger" data-img-del>Löschen</button></div></div></div>`).join('')}</div>
    <form id="upload" class="field" style="margin-top:.6rem">
      <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required aria-label="Bilddatei">
      <div class="row"><select name="rights" aria-label="Rechte">${Object.entries(RIGHTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <input type="text" name="credit" placeholder="Namensnennung (bei CC BY / Lizenz Pflicht)" class="grow" aria-label="Namensnennung"></div>
      <label class="chk"><input type="checkbox" name="primary" value="1"> als Hauptbild</label>
      <p class="meta">JPG, PNG oder WebP, höchstens 10 MB. Nur Bilder, an denen wir die Rechte haben: kein Standbild aus fremden Videos.</p>
      <div><button class="btn btn-primary">Hochladen</button></div>
    </form>
  </section>
  <section class="card"><h2>Änderungen</h2>${logRows(D.log)}</section>`;
  bindSections();
}

// video2gpx round trip (VIDEO2GPX-INTEGRATION.md steps A/B): job file out, result file in.
const v2gUploaded = (D) => D.sync?.method === 'video2gpx' && D.sync.path?.startsWith('api/sync/');
function v2gBox(D) {
  const g = D.localization?.gates, meta = g?.video2gpx, agree = g?.route_agreement;
  const offer = v2gUploaded(D) && D.route?.method !== 'video2gpx_track' && (!agree || agree.median_m > 50);
  const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(1).replace('.', ',')} %`);
  return `<div class="field" style="margin-top:.6rem"><span>video2gpx</span>
    <p class="meta">Job-Datei für die Desktop-App video2gpx (Suchrahmen, Start/Ziel, Route als Hinweis). Das Ergebnis (<span class="mono">${esc(D.id)}.scenic.json</span>) hier hochladen: es wird geprüft und als Track mit Stufe 2 gespeichert; der Prüfmodus hebt es auf Stufe 1.</p>
    <p class="row"><button type="button" class="btn small" id="v2g-job">Job-Datei laden</button>
      <button type="button" class="btn small" id="v2g-upload">video2gpx-Ergebnis hochladen</button>
      <input type="file" id="v2g-file" accept=".json,application/json" hidden aria-label="video2gpx-Ergebnis"></p>
    ${v2gUploaded(D) && meta ? `<p class="meta">Hochgeladen: ${esc(meta.verdict)} · Abdeckung ${pct(meta.coverage)} · ${meta.route_km ?? '–'} km · Pipeline <span class="mono">${esc(meta.pipeline_hash)}</span>
      · App ${esc(meta.app_version ?? '–')} · geprüft von ${esc(meta.qc?.checked_by ?? '–')}${agree ? ` · Abstand zur Scenic-Route Median ${agree.median_m} m, max. ${Math.round(agree.max_m)} m` : ' · keine Scenic-Route zum Vergleich'}
      ${meta.qc?.checks?.some((x) => x.overridden) ? `<br>Übergangen: ${meta.qc.checks.filter((x) => x.overridden).map((x) => `${esc(x.id)} („${esc(x.note)}“)`).join(', ')}` : ''}${meta.qc?.note ? `<br>Notiz: ${esc(meta.qc.note)}` : ''}</p>` : ''}
    ${offer ? `<p class="hint-box warn">${agree ? `Die video2gpx-Linie weicht im Median ${agree.median_m} m von der Scenic-Route ab.` : 'Das Video hat keine Scenic-Route.'} Die Scenic-Route bleibt, bis du sie ersetzt.
      <br><button type="button" class="btn small" id="v2g-route">Route aus video2gpx übernehmen</button></p>` : ''}
  </div>`;
}

function short(v) {
  if (v == null) return '–';
  if (typeof v !== 'object') return String(v);
  if ('value' in v) return v.value && typeof v.value === 'object' ? Object.values(v.value).join(', ') : String(v.value ?? '–');
  if ('route' in v) return v.route ? `${v.route.method} · ${v.route.distance_km} km` : 'keine Route';
  if ('sync' in v) return v.sync ? `${v.sync.method} · Stufe ${v.localization?.loc_level ?? '–'}` : 'kein Track';
  if ('localization' in v) return v.localization ? `Stufe ${v.localization.loc_level}` : '–';
  if ('lon' in v && 'lat' in v) return `${(+v.lat).toFixed(5)}, ${(+v.lon).toFixed(5)}`;
  if ('collection' in v) return v.collection.title;
  if (Array.isArray(v)) return `${v.length} Einträge`;
  if (v.image_id) return `${v.mime ?? ''} ${v.rights ?? ''}`;
  return JSON.stringify(v).slice(0, 80);
}
const ENTITY = { video: '', anchor: 'Anker', route: 'Route', localization: 'Prüfung', sync: 'Track', collection: 'Sammlung', collection_item: 'Sammlung', collection_order: 'Reihenfolge', optout: 'Opt-out', image: 'Bild' };
function logRows(rows) {
  if (!rows.length) return '<p class="meta">Noch keine Änderungen.</p>';
  return rows.map((e) => `<div class="logrow ${e.undone_by ? 'undone' : ''}"><div class="what"><b>${esc(ENTITY[e.entity] ?? e.entity)} ${esc(e.entity === 'anchor' ? fmt(+e.field) : e.field)}</b>
    ${e.title && !ed ? ` · <a href="#v=${e.video_id}">${esc(e.title)}</a>` : ''}: ${esc(short(e.old))} → ${esc(short(e.new))}
    <br><span class="meta">${esc(e.who)} · ${esc(e.at.replace('T', ' ').slice(0, 16))}${e.undo_of ? ` · Rücknahme von #${e.undo_of}` : ''}${e.undone_by ? ` · zurückgenommen (#${e.undone_by})` : ''}</span></div>
    <div>${!e.undone_by && e.entity !== 'image' ? `<button type="button" class="btn small" data-undo="${e.id}">Zurücknehmen</button>` : ''}</div></div>`).join('');
}
async function doUndo(id) {
  await api('POST', `log/${id}/undo`);
  toast('Zurückgenommen');
  if (ed) await refresh({ track: true }); else route();
}

function bindSections() {
  const box = $('#sections'), D = ed.D;
  box.querySelectorAll('#f-stars input').forEach((r) => r.addEventListener('change', () => {
    box.querySelectorAll('#f-stars label').forEach((l, i) => l.classList.toggle('on', i > 0 && i <= +r.value));
  }));
  $('#save-ed').onclick = guard(async () => {
    const stars = +box.querySelector('#f-stars input:checked')?.value || null;
    const patch = {};
    if (stars !== (D.stars ?? null)) patch.stars = stars;
    if ($('#f-pick').checked !== D.editors_pick) patch.editors_pick = $('#f-pick').checked;
    if ($('#f-published').checked !== D.site_published) patch.site_published = $('#f-published').checked;
    if ($('#f-hidden') && $('#f-hidden').checked !== D.hidden) patch.hidden = $('#f-hidden').checked;
    if ($('#f-note').value.trim() !== (D.editor_note ?? '')) patch.editor_note = $('#f-note').value;
    if (!Object.keys(patch).length) return toast('Nichts geändert');
    await api('PATCH', `videos/${ed.id}`, patch); toast('Gespeichert'); await refresh();
  });
  box.querySelectorAll('[data-col]').forEach((cb) => cb.addEventListener('change', guard(async () => {
    const cid = cb.dataset.col;
    if (cb.checked) await api('POST', `collections/${cid}/items`, { video_id: ed.id }); else await api('DELETE', `collections/${cid}/items/${ed.id}`);
    collectionsCache = await api('GET', 'collections'); toast(cb.checked ? 'Zur Sammlung hinzugefügt' : 'Aus der Sammlung entfernt'); await refresh();
  })));
  $('#pin-mode').onclick = () => setMode(ed.mode === 'pin' ? null : 'pin', 'Klicke auf die Karte, um den Pin zu setzen; der Pin lässt sich ziehen');
  if ($('#pin-start')) $('#pin-start').onclick = () => { ed.pendingPin = D.route.line[0]; drawMap(false); renderSections(); };
  $('#save-loc').onclick = guard(async () => {
    const patch = {};
    const place = $('#f-place').value.trim(), region = $('#f-region').value.trim(), cc = $('#f-cc').value.trim().toUpperCase(), cn = $('#f-cn').value.trim();
    if (place !== (D.place ?? '')) patch.place = place;
    if (region !== (D.region ?? '')) patch.region = region;
    if (cc !== (D.country ?? '') || cn !== (D.country_name ?? '')) patch.country = { country: cc || null, country_name: cn || me?.countries.find((c) => c.country === cc)?.name || null };
    if (ed.pendingPin) patch.pin = { lon: ed.pendingPin[0], lat: ed.pendingPin[1] };
    if (!Object.keys(patch).length) return toast('Nichts geändert');
    await api('PATCH', `videos/${ed.id}`, patch);
    ed.pendingPin = null; ed.mode = null; $('#banner').hidden = true; toast('Verortung gespeichert'); await refresh();
  });
  // Route
  if ($('#route-edit')) $('#route-edit').onclick = () => {
    const l = D.route?.line; ed.via = D.route?.via ? [...D.route.via] : l ? [l[0], l.at(-1)] : [];
    ed.preview = null; setMode('via', 'Klick auf die Karte: Punkt anhängen · Esc beendet das Klicken');
  };
  if ($('#route-reverse')) $('#route-reverse').onclick = guard(async () => {
    if (!confirm('Richtung der Route umdrehen? Anker werden neu eingerastet.')) return;
    const r = await api('PUT', `videos/${ed.id}/route`, { action: 'reverse' }); toast(`Richtung umgedreht${syncText(r.sync)}`); await refresh({ track: true });
  });
  if ($('#route-discard')) $('#route-discard').onclick = guard(async () => {
    if (!confirm('Route verwerfen? Das Video fällt auf Stufe 6 oder 7; rückgängig über „Änderungen“.')) return;
    await api('PUT', `videos/${ed.id}/route`, { action: 'discard' }); toast('Route verworfen'); await refresh({ track: true });
  });
  box.querySelectorAll('[data-via-del]').forEach((b) => { b.onclick = () => { ed.via.splice(+b.dataset.viaDel, 1); ed.preview = null; drawMap(false); renderSections(); }; });
  box.querySelectorAll('[data-via-up]').forEach((b) => { b.onclick = () => { const i = +b.dataset.viaUp; [ed.via[i - 1], ed.via[i]] = [ed.via[i], ed.via[i - 1]]; ed.preview = null; drawMap(false); renderSections(); }; });
  if ($('#via-from')) $('#via-from').onclick = () => { const l = D.route?.line; if (l) { ed.via = [l[0], l.at(-1)]; ed.preview = null; drawMap(false); renderSections(); } };
  if ($('#via-clear')) $('#via-clear').onclick = () => { ed.via = []; ed.preview = null; drawMap(false); renderSections(); };
  if ($('#via-cancel')) $('#via-cancel').onclick = () => { ed.via = null; ed.preview = null; setMode(null); };
  if ($('#via-route')) $('#via-route').onclick = guard(async () => {
    $('#via-route').disabled = true; $('#via-route').textContent = 'Route wird berechnet …';
    try { ed.preview = await api('POST', 'osrm', { points: ed.via }); } finally { renderSections(); }
    drawMap(false); toast(`OSRM: ${ed.preview.distance_km} km`);
  });
  if ($('#via-save')) $('#via-save').onclick = guard(async () => {
    const r = await api('PUT', `videos/${ed.id}/route`, { action: 'set', line: ed.preview.line, via: ed.via });
    ed.via = null; ed.preview = null; ed.mode = null; $('#banner').hidden = true;
    toast(`Route gespeichert (Stufe 4)${syncText(r.sync)}`); await refresh({ track: true }); drawMap(true);
  });
  // Anchors
  $('#anchor-arm').onclick = armAnchor;
  box.querySelectorAll('[data-seek]').forEach((b) => { b.onclick = () => ed.player?.seek(+b.dataset.seek); });
  box.querySelectorAll('[data-anchor-del]').forEach((b) => { b.onclick = guard(async () => {
    const r = await api('DELETE', `videos/${ed.id}/anchors/${b.dataset.anchorDel}`); toast(`Anker gelöscht${syncText(r.sync)}`); await refresh({ track: true });
  }); });
  if ($('#review-start')) $('#review-start').onclick = guard(startReview);
  // video2gpx: job file out, result in, optional route from the result
  $('#v2g-job').onclick = guard(async () => {
    const res = await fetch(`../api/admin/videos/${ed.id}/video2gpx-job.json`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob()); a.download = `${ed.id}.v2g.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`${ed.id}.v2g.json gespeichert: in video2gpx öffnen (Start: ablegen oder „Scenic-Job öffnen“)`);
  });
  $('#v2g-upload').onclick = () => $('#v2g-file').click();
  $('#v2g-file').onchange = guard(async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) throw new Error('Höchstens 1,5 MB');
    let body;
    try { body = JSON.parse(await file.text()); } catch { throw new Error('Die Datei ist kein JSON'); }
    const r = await api('POST', `videos/${ed.id}/video2gpx`, body);
    toast(!r.changed ? 'Dieses Ergebnis ist schon gespeichert' : `video2gpx-Track gespeichert: ${r.points} Punkte, Stufe ${r.level}${r.route_agreement ? ` · Abstand zur Scenic-Route Median ${r.route_agreement.median_m} m` : ''}${r.route_offer ? ' · Route prüfen' : ''}`);
    await refresh({ track: true });
  });
  if ($('#v2g-route')) $('#v2g-route').onclick = guard(async () => {
    if (!confirm('Die Scenic-Route durch die video2gpx-Linie ersetzen? Die Stufe bleibt; rückgängig über „Änderungen“.')) return;
    await api('PUT', `videos/${ed.id}/route`, { action: 'from_track' }); toast('Route aus video2gpx übernommen'); await refresh({ track: true }); drawMap(true);
  });
  // Images
  box.querySelectorAll('[data-img]').forEach((card) => {
    const iid = card.dataset.img;
    card.querySelector('[data-img-save]').onclick = guard(async () => {
      await api('PATCH', `images/${iid}`, { rights: card.querySelector('[data-k=rights]').value, credit: card.querySelector('[data-k=credit]').value }); toast('Bild gespeichert'); await refresh();
    });
    const pr = card.querySelector('[data-img-primary]');
    if (pr) pr.onclick = guard(async () => { await api('PATCH', `images/${iid}`, { is_primary: true }); toast('Hauptbild gesetzt'); await refresh(); });
    card.querySelector('[data-img-del]').onclick = guard(async () => {
      if (!confirm('Bild endgültig löschen? Das lässt sich nicht zurücknehmen.')) return;
      await api('DELETE', `images/${iid}`); toast('Bild gelöscht'); await refresh();
    });
  });
  $('#upload').onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), file = f.get('file');
    if (file?.size > 10 * 1024 * 1024) throw new Error('Höchstens 10 MB');
    await api('POST', `videos/${ed.id}/images`, f); toast('Bild hochgeladen'); await refresh();
  });
  box.querySelectorAll('[data-undo]').forEach((b) => { b.onclick = guard(() => doUndo(b.dataset.undo)); });
}

// --- Prüfmodus (concept 2.5, 3.5) ---
async function startReview() {
  if (!ed.track) throw new Error('Kein synchroner Track');
  if (!ed.player) throw new Error('Prüfmodus braucht den eingebetteten Player');
  const line = ed.D.route?.line?.length > 1 ? ed.D.route.line : ed.track.c;
  const pts = checkPoints(ed.track, line);
  ed.review = { line, cum: kmAlong(line), pts, results: pts.map((t) => ({ t })), i: 0, hash: ed.D.sync?.hash, done: false };
  setMode(null);
  const el = document.createElement('div'); el.className = 'check-marker'; el.title = 'Prüfzeiger: an die richtige Stelle ziehen';
  ed.review.marker = new Marker({ element: el, draggable: true });
  ed.review.marker.on('dragend', () => {
    const r = ed.review, p = project(r.line, r.cum, r.marker.getLngLat().toArray());
    r.marker.setLngLat(p.point);
    r.results[r.i] = { t: r.pts[r.i], lon: Math.round(p.point[0] * 1e6) / 1e6, lat: Math.round(p.point[1] * 1e6) / 1e6 };
    renderReview();
  });
  reviewStep();
}
function reviewStep() {
  const r = ed.review, t = r.pts[r.i];
  ed.player.seek(t); ed.player.pause();
  const res = r.results[r.i], pos = res.lon != null ? [res.lon, res.lat] : trackAt(ed.track, t);
  r.marker.setLngLat(pos).addTo(ed.map);
  ed.map.easeTo({ center: pos, zoom: Math.max(ed.map.getZoom(), 15), duration: 400 });
  renderReview();
}
function devOf(res) {
  if (res.lon == null) return 0;
  const r = ed.review, at = project(r.line, r.cum, trackAt(ed.track, res.t)).km, c = project(r.line, r.cum, [res.lon, res.lat]).km;
  return Math.abs(at - c) * 1000;
}
function renderReview() {
  const r = ed.review, box = $('#sections');
  if (r.done) {
    const ev = evaluateReview({ line: r.line, track: ed.track, points: r.results });
    box.innerHTML = `<section class="card"><h2>Prüfergebnis</h2>
      <p class="hint-box ${ev.passed ? '' : 'warn'}"><b class="${ev.passed ? 'ok' : 'bad'}">${ev.passed ? 'Bestanden: Stufe 1 (verifiziert)' : 'Nicht bestanden: bleibt auf Stufe 2'}</b><br>
        ${ev.points.length} Prüfpunkte · Abweichung Median ${ev.err_med_m?.toFixed(1)} m, max. ${ev.err_max_m?.toFixed(1)} m (Grenze ${LOC_RULES.reviewMaxDevM} m)
        ${ev.passed ? '' : '<br>Korrekturen werden als manuelle Anker gespeichert.'}</p>
      <table class="mini"><thead><tr><th>#</th><th>Zeit</th><th>Abweichung</th><th></th></tr></thead><tbody>${ev.points.map((p, i) => `<tr>
        <td>${i + 1}</td><td><button type="button" class="link mono" data-go="${i}">${fmt(p.t)}</button></td><td class="mono">${p.wrong_road ? 'falsche Straße' : `${p.dev_m.toFixed(1)} m`}</td>
        <td class="${p.ok ? 'ok' : 'bad'}">${p.ok ? '✓' : '✗'}</td></tr>`).join('')}</tbody></table>
      <p class="row"><button type="button" class="btn btn-primary" id="rv-save">Ergebnis speichern</button><button type="button" class="btn" id="rv-back">Zurück zu den Punkten</button>
        <button type="button" class="btn" id="rv-cancel">Verwerfen</button></p></section>`;
    box.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { r.done = false; r.i = +b.dataset.go; reviewStep(); }; });
    $('#rv-back').onclick = () => { r.done = false; reviewStep(); };
    $('#rv-cancel').onclick = endReview;
    $('#rv-save').onclick = guard(async () => {
      const res = await api('POST', `videos/${ed.id}/review`, { hash: r.hash, points: r.results });
      toast(res.passed ? 'Geprüft: Stufe 1' : `Nicht bestanden${res.anchors_added.length ? `, ${res.anchors_added.length} Korrekturanker` : ''}`);
      endReview(); await refresh({ track: true });
    });
    return;
  }
  const res = r.results[r.i], dev = devOf(res), moved = res.lon != null;
  box.innerHTML = `<section class="card"><h2>Prüfmodus <span class="review-step">${r.i + 1} / ${r.pts.length}</span></h2>
    <p>Video bei <b class="mono">${fmt(r.pts[r.i])}</b>. Stimmt der orange Prüfzeiger mit dem Videobild überein? Sonst den Zeiger an die richtige Stelle der Straße ziehen.</p>
    <p class="hint-box ${res.wrong_road || dev > LOC_RULES.reviewMaxDevM ? 'warn' : ''}">${res.wrong_road ? 'Als <b>falsche Straße</b> markiert.'
      : moved ? `Korrigiert: <b>${dev.toFixed(1)} m</b> entlang der Straße (${dev <= LOC_RULES.reviewMaxDevM ? 'innerhalb' : 'außerhalb'} der ${LOC_RULES.reviewMaxDevM} m)` : 'Position wie berechnet.'}</p>
    <p class="row"><button type="button" class="btn btn-primary" id="rv-ok">Bestätigen <span class="kbd">⏎</span></button>
      <button type="button" class="btn danger" id="rv-wrong">Falsche Straße <span class="kbd">F</span></button>
      <button type="button" class="btn" id="rv-reset" ${moved || res.wrong_road ? '' : 'disabled'}>Zurücksetzen</button></p>
    <p class="row"><button type="button" class="btn small" id="rv-prev" ${r.i ? '' : 'disabled'}>← Zurück</button>
      <button type="button" class="btn small" id="rv-play">Ab hier abspielen <span class="kbd">Leertaste</span></button>
      <button type="button" class="btn small" id="rv-cancel">Abbrechen</button></p>
    <p class="meta">Prüfpunkte gleichmäßig über die Fahrt, dazu Kehren. Bestanden, wenn alle Punkte auf der richtigen Straße liegen und höchstens ${LOC_RULES.reviewMaxDevM} m abweichen.</p></section>`;
  $('#rv-ok').onclick = () => reviewNext();
  $('#rv-wrong').onclick = () => { r.results[r.i] = { t: r.pts[r.i], wrong_road: true }; reviewNext(); };
  $('#rv-reset').onclick = () => { r.results[r.i] = { t: r.pts[r.i] }; reviewStep(); };
  $('#rv-prev').onclick = () => { if (r.i) { r.i--; reviewStep(); } };
  $('#rv-play').onclick = () => ed.player.play();
  $('#rv-cancel').onclick = endReview;
}
function reviewNext() {
  const r = ed.review;
  if (r.i < r.pts.length - 1) { r.i++; reviewStep(); } else { r.done = true; r.marker.remove(); renderReview(); }
}
function reviewKey(e) {
  const r = ed.review;
  if (r.done) return;
  if (e.key === 'Enter') { e.preventDefault(); reviewNext(); }
  else if (e.key === 'f' || e.key === 'F') { r.results[r.i] = { t: r.pts[r.i], wrong_road: true }; reviewNext(); }
  else if (e.key === 'ArrowLeft' && r.i) { r.i--; reviewStep(); }
  else if (e.key === ' ') { e.preventDefault(); ed.player.play(); }
  else if (e.key === 'Escape') endReview();
}
function endReview() { ed.review?.marker.remove(); ed.review = null; renderSections(); drawMap(false); }

// --- collections ---
async function renderCollections() {
  collectionsCache = await api('GET', 'collections');
  const v = $('#view');
  v.innerHTML = `<div class="cols">
    <form class="col row" id="col-new"><input type="text" name="title" placeholder="Neue Sammlung, z. B. „Die 20 schönsten Alpenpässe in 4K“" class="grow" required aria-label="Titel">
      <button class="btn btn-primary">Anlegen</button></form>
    ${collectionsCache.map((c, ci) => `<div class="col" data-cid="${c.collection_id}">
      <div class="row"><h3 class="grow">${esc(c.title)}</h3><span class="meta mono">/${esc(c.slug)} · ${c.items.length} Videos</span>
        <button type="button" class="btn small" data-move="-1" ${ci ? '' : 'disabled'} aria-label="Sammlung nach oben">↑</button><button type="button" class="btn small" data-move="1" ${ci < collectionsCache.length - 1 ? '' : 'disabled'} aria-label="Sammlung nach unten">↓</button></div>
      <div class="row"><input type="text" data-k="title" value="${esc(c.title)}" class="grow" aria-label="Titel"><input type="text" data-k="slug" value="${esc(c.slug)}" aria-label="Kurzname"></div>
      <textarea data-k="description" placeholder="Beschreibung" aria-label="Beschreibung">${esc(c.description ?? '')}</textarea>
      <p class="row"><button type="button" class="btn small" data-save>Speichern</button><button type="button" class="btn small danger" data-del>Löschen</button></p>
      <ol>${c.items.map((it, i) => `<li><div class="row"><a href="#v=${it.video_id}" class="grow">${esc(it.title || it.video_id)}</a>${lvl(it.loc_level)}
        <button type="button" class="btn small" data-up="${i}" ${i ? '' : 'disabled'} aria-label="nach oben">↑</button><button type="button" class="btn small" data-down="${i}" ${i < c.items.length - 1 ? '' : 'disabled'} aria-label="nach unten">↓</button>
        <button type="button" class="btn small danger" data-rm="${it.video_id}" aria-label="entfernen">✕</button></div></li>`).join('')}</ol>
      <form class="row" data-add><input type="text" name="video_id" placeholder="Video-ID (11 Zeichen)" pattern="[\\w-]{11}" required aria-label="Video-ID"><button class="btn small">Hinzufügen</button></form>
    </div>`).join('')}
    ${collectionsCache.length ? '' : '<p class="meta">Noch keine Sammlung.</p>'}</div>`;
  $('#col-new').onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', 'collections', { title: new FormData(e.target).get('title') }); toast('Sammlung angelegt'); await renderCollections(); });
  v.querySelectorAll('[data-cid]').forEach((card) => {
    const cid = +card.dataset.cid, c = collectionsCache.find((x) => x.collection_id === cid), order = c.items.map((i) => i.video_id);
    const reorder = guard(async (i, j) => { [order[i], order[j]] = [order[j], order[i]]; await api('PUT', `collections/${cid}/items`, { order }); await renderCollections(); });
    card.querySelector('[data-save]').onclick = guard(async () => {
      const val = (k) => card.querySelector(`[data-k=${k}]`).value;
      await api('PATCH', `collections/${cid}`, { title: val('title'), slug: val('slug'), description: val('description') }); toast('Gespeichert'); await renderCollections();
    });
    card.querySelector('[data-del]').onclick = guard(async () => { if (!confirm(`Sammlung „${c.title}“ löschen? Rückgängig über das Protokoll.`)) return; await api('DELETE', `collections/${cid}`); await renderCollections(); });
    card.querySelectorAll('[data-move]').forEach((b) => { b.onclick = guard(async () => {
      const ids = collectionsCache.map((x) => x.collection_id), i = ids.indexOf(cid), j = i + +b.dataset.move;
      [ids[i], ids[j]] = [ids[j], ids[i]]; await api('PUT', 'collections/order', { order: ids }); await renderCollections();
    }); });
    card.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => reorder(+b.dataset.up, +b.dataset.up - 1); });
    card.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => reorder(+b.dataset.down, +b.dataset.down + 1); });
    card.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = guard(async () => { await api('DELETE', `collections/${cid}/items/${b.dataset.rm}`); await renderCollections(); }); });
    card.querySelector('[data-add]').onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', `collections/${cid}/items`, { video_id: new FormData(e.target).get('video_id').trim() }); await renderCollections(); });
  });
}

// --- channel opt-out ---
async function renderOptout() {
  const rows = await api('GET', 'optout');
  $('#view').innerHTML = `<div class="cols">
    <form class="col" id="opt-new"><h3>Opt-out eintragen</h3>
      <p class="meta">Videos des Kanals verschwinden sofort von der öffentlichen Seite; der nächste Import löscht ihre Pipeline-Daten.</p>
      <div class="row"><input type="text" name="channel_id" placeholder="Kanal-ID UC…" pattern="UC[\\w-]{22}" required aria-label="Kanal-ID">
        <input type="text" name="note" placeholder="Notiz (z. B. Anfrage per E-Mail vom …)" class="grow" aria-label="Notiz"><button class="btn btn-primary">Eintragen</button></div></form>
    <div class="col"><table class="adm"><thead><tr><th>Kanal</th><th>seit</th><th>Notiz</th><th>Videos</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.name || '')}<br><span class="mono meta">${esc(r.channel_id)}</span></td><td class="mono">${esc(r.requested_at || '')}</td><td>${esc(r.note || '')}</td>
        <td class="mono">${r.videos}</td><td><button type="button" class="btn small" data-rm="${esc(r.channel_id)}">Aufheben</button></td></tr>`).join('')}</tbody></table>
      ${rows.length ? '' : '<p class="meta">Kein Opt-out.</p>'}</div></div>`;
  $('#opt-new').onsubmit = guard(async (e) => { e.preventDefault(); const f = new FormData(e.target);
    await api('POST', 'optout', { channel_id: f.get('channel_id').trim(), note: f.get('note') }); toast('Opt-out eingetragen'); await renderOptout(); });
  document.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = guard(async () => { await api('DELETE', `optout/${b.dataset.rm}`); toast('Opt-out aufgehoben'); await renderOptout(); }); });
}

// --- global change log ---
async function renderLog(before) {
  const rows = await api('GET', `log${before ? `?before=${before}` : ''}`);
  const v = $('#view');
  const html = logRows(rows) + (rows.length === 100 ? `<p><button type="button" class="btn small" data-more="${rows.at(-1).id}">Ältere</button></p>` : '');
  if (before) { v.querySelector('[data-more]')?.parentElement.remove(); v.querySelector('.col').insertAdjacentHTML('beforeend', html); }
  else v.innerHTML = `<div class="cols"><div class="col"><p class="meta">Jede Änderung mit Person und Zeit. „Zurücknehmen“ schreibt den alten Wert zurück (selbst wieder protokolliert); Bilder lassen sich nicht zurücknehmen.
    Export für die Pipeline: <a href="../api/admin/export">manual.ndjson</a> (scripts/pull_manual.mjs).</p>${html}</div></div>`;
  v.onclick = (e) => {
    const u = e.target.closest('[data-undo]'); if (u) guard(doUndo)(u.dataset.undo);
    const m = e.target.closest('[data-more]'); if (m) guard(renderLog)(m.dataset.more);
  };
}

// --- start ---
try {
  me = await api('GET', 'me');
  $('#me').textContent = `${me.email}${me.via === 'dev' ? ' (lokal)' : ''}`;
  await route();
} catch (err) {
  console.error(err);
  $('#view').innerHTML = `<p class="pad">${err.message === 'forbidden' ? 'Kein Zugang: der Admin-Bereich braucht eine Cloudflare-Access-Anmeldung.' : `Fehler: ${esc(err.message)}`}</p>`;
}
