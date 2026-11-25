// SPDX-License-Identifier: AGPL-3.0-or-later
// Route editor of the admin (#t=<track id>): a route uploaded as GPX (tab „Routen“, src/tracks.js) with its elevation profile and a
// position to seek from start to end. At every position it lists the videos that ride there in the route's direction (from the
// video lines of ../api/admin/lines.json, site/lib/track-cover.js), and one of them can be set to play from there on. The
// assignments (table track_video) let the whole route be played later with a fitting video at every point; the player below the
// profile already does that here: it follows the video along the route and changes to the next video at each assignment.
import { Map as MapGL, NavigationControl, Marker, LngLatBounds } from '../vendor/maplibre-gl/maplibre-gl.mjs';
import { decodeLine } from '../lib/lines.js';
import { mountPlayer } from '../player.js';
import { kmAlong, pointAt, eleAt, trackAt } from '../lib/route-sync.js';
import { joinSegments, coverage, coverLine, samples, videosAt, timeAt, timeAtKm, headingAt, projectNear, sliceLine, assignFrom, removeAt, segmentsOf, segmentAt, climb, autoAssign } from '../lib/track-cover.js';

const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#c2255c', '#5c940d', '#4263eb', '#d6336c'];
const W = 1000, PH = 120, BAND_Y = 126, BAND_H = 12, COV_Y = 142, COV_H = 8, H = 152;
/** CSS height of the profile (admin.css .rte-prof svg). */
const SVG_PX = 150;
const km1 = (x) => (x ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const km2 = (x) => (x ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (x) => Math.round(x ?? 0).toLocaleString('de-DE');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The video lines of the admin map, loaded once per page (all videos, a few MB).
let linesPromise = null;

let re = null;
/** Closes the editor (map, player, keys). */
export function closeRouteEditor() {
  if (!re) return;
  re.player?.handle.destroy(); re.map?.remove();
  document.removeEventListener('keydown', re.onKey);
  clearTimeout(re.seekTimer);
  re = null;
}

/**
 * Opens the editor of route `id` in #view. `d` holds the admin's helpers: {api, toast, guard, esc, fmt, lvl, STYLE}.
 */
export async function openRouteEditor(id, d) {
  if (re?.id === id) return;
  closeRouteEditor();
  const { api, esc, STYLE } = d;
  const T = await api('GET', `tracks/${id}`);
  const line = joinSegments(T.line), cum = kmAlong(line), total = cum.at(-1);
  const r = re = { id, d, T, line, cum, total, km: 0, segs: T.segments.map(({ from_km, video_id }) => ({ from_km, video_id })), times: T.segments,
    meta: new Map(T.videos.map((v) => [v.video_id, v])), cov: null, vlines: {}, sync: new Map(), preview: null, player: null, lastS: null };
  $view().innerHTML = `<div class="ed rte">
    <div class="ed-side">
      <p class="row"><a href="#tracks" class="link">← Routen</a><span class="grow"></span><span class="meta mono">#${T.track_id}${T.published ? '' : ' · nicht veröffentlicht'}</span></p>
      <h1><i class="swatch" style="background:${esc(T.color)}"></i>${esc(T.name)}</h1>
      <p class="meta" id="rte-sum"></p>
      <div class="rte-prof" id="rte-prof"></div>
      <div class="rte-seek">
        <button type="button" class="btn small" data-step="-1" aria-label="1 km zurück" title="1 km zurück (Umschalt+←)">«</button>
        <button type="button" class="btn small" data-step="-0.1" aria-label="100 m zurück" title="100 m zurück (←)">‹</button>
        <input type="range" id="rte-km" min="0" max="${total}" step="0.001" value="0" aria-label="Position auf der Route">
        <button type="button" class="btn small" data-step="0.1" aria-label="100 m vor" title="100 m vor (→)">›</button>
        <button type="button" class="btn small" data-step="1" aria-label="1 km vor" title="1 km vor (Umschalt+→)">»</button>
      </div>
      <div class="readout" id="rte-pos"></div>
      <div class="video" id="rte-slot"><div class="consent"><p>Hier läuft das Video, das an dieser Stelle zugeordnet ist (oder die Vorschau).</p></div></div>
      <div class="readout" id="rte-play"></div>
      <div class="card"><h2>Videos an dieser Stelle <span class="row"><button type="button" class="btn small" id="rte-none">Ab hier kein Video</button></span></h2>
        <div id="rte-cands"><p class="meta">Suche Videos entlang der Route …</p></div></div>
      <div class="card"><h2>Zuordnung <span class="row"><button type="button" class="btn small" id="rte-auto" disabled>Vorschlag erzeugen</button></span></h2>
        <div id="rte-segs"></div></div>
    </div>
    <div class="ed-map"><div id="amap"></div></div>
  </div>`;

  // --- map ---
  const map = r.map = new MapGL({ container: 'amap', style: STYLE, center: line[0], zoom: 10, attributionControl: false });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  const el = document.createElement('div'); el.className = 'rte-marker'; el.title = 'Position auf der Route (ziehen)';
  r.marker = new Marker({ element: el, draggable: true }).setLngLat(line[0]);
  r.marker.on('drag', () => { const p = projectNear(line, cum, r.marker.getLngLat().toArray()); setKm(p.km, { seek: false }); });
  r.marker.on('dragend', () => setKm(r.km));
  map.on('load', () => {
    const empty = { type: 'FeatureCollection', features: [] };
    map.addSource('rte-track', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } } });
    for (const s of ['rte-assign', 'rte-cands']) map.addSource(s, { type: 'geojson', data: empty });
    map.addLayer({ id: 'rte-cands', type: 'line', source: 'rte-cands', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#3b7ddd', 'line-width': ['case', ['==', ['get', 'hi'], 1], 5, 2], 'line-opacity': ['case', ['==', ['get', 'hi'], 1], 0.95, 0.45],
        'line-offset': 6 } });
    map.addLayer({ id: 'rte-casing', type: 'line', source: 'rte-track', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 8 } });
    map.addLayer({ id: 'rte-track', type: 'line', source: 'rte-track', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': T.color, 'line-width': 4, 'line-opacity': 0.5, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'rte-assign', type: 'line', source: 'rte-assign', layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 5 } });
    map.addLayer({ id: 'rte-hit', type: 'line', source: 'rte-track', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 } });
    map.on('click', 'rte-hit', (e) => setKm(projectNear(line, cum, e.lngLat.toArray()).km));
    map.on('mouseenter', 'rte-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'rte-hit', () => { map.getCanvas().style.cursor = ''; });
    const b = new LngLatBounds(); for (const c of line) b.extend(c);
    map.fitBounds(b, { padding: 50, duration: 0 });
    r.marker.addTo(map);
    drawAssign(); drawCands();
  });

  // --- controls ---
  const side = $view().querySelector('.ed-side');
  side.querySelector('#rte-km').addEventListener('input', (e) => setKm(+e.target.value));
  side.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => setKm(r.km + +b.dataset.step); });
  side.querySelector('#rte-none').onclick = d.guard(() => save(assignFrom(r.segs, r.km, null), `Ab km ${km2(r.km)} kein Video`));
  side.querySelector('#rte-auto').onclick = d.guard(async () => {
    if (r.segs.length && !confirm('Die bisherige Zuordnung durch einen Vorschlag ersetzen? (Synchrone Videos zuerst, sonst das, das am weitesten fährt.)')) return;
    const rank = (vid) => { const m = r.meta.get(vid); return (m?.synced ? 2 : 0) + (m?.embeddable !== false ? 1 : 0); };
    await save(autoAssign(r.cov, total, rank), 'Vorschlag gespeichert');
  });
  r.onKey = (e) => {
    if (e.target.closest('input:not([type=range]), textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setKm(r.km + (e.key === 'ArrowLeft' ? -step : step)); }
    else if (e.key === 'Home') { e.preventDefault(); setKm(0); }
    else if (e.key === 'End') { e.preventDefault(); setKm(total); }
  };
  document.addEventListener('keydown', r.onKey);

  renderProfile(); renderSegs(); setKm(0);

  // --- videos along the route ---
  linesPromise ??= api('GET', 'lines.json').catch((err) => { linesPromise = null; throw err; });
  const lines = await linesPromise;
  if (re !== r) return;
  await new Promise((ok) => setTimeout(ok, 0)); // let the page paint before the matching
  const near = {};
  for (const [vid, flat] of Object.entries(lines)) near[vid] = decodeLine(flat);
  r.cov = coverage(line, near);
  for (const c of r.cov) r.vlines[c.id] = near[c.id];
  const ids = [...new Set([...r.cov.map((c) => c.id), ...r.segs.map((s) => s.video_id).filter(Boolean)])];
  if (ids.length) for (const v of await api('POST', `tracks/${id}/candidates`, { ids })) r.meta.set(v.video_id, v);
  if (re !== r) return;
  // synced videos: their track is what the camera drove (detours included), more exact than the simplified route line
  const synced = r.cov.filter((c) => r.meta.get(c.id)?.synced).slice(0, 30), smp = r.smp = samples(line, cum);
  await Promise.all(synced.map(async (c) => {
    const tr = await syncOf(c.id);
    if (tr?.c?.length > 1) { Object.assign(c, coverLine(smp, tr.c) ?? { intervals: [], km: 0, vkm: null }, { onTrack: true }); r.vlines[c.id] = tr.c; }
  }));
  if (re !== r) return;
  r.cov = r.cov.filter((c) => c.intervals.length).sort((a, b) => b.km - a.km);
  side.querySelector('#rte-auto').disabled = !r.cov.length;
  renderProfile(); renderSegs(); renderCands(); drawCands();
  // Video times are computed on save; an assignment saved before its video was synced has none, and the route player shows it as a
  // gap. Fill them in now (same assignment, only the times).
  const missing = r.times.some((t) => t.video_id && r.meta.get(t.video_id)?.synced && (t.t_from_s == null || t.t_to_s == null));
  if (missing) await d.guard(() => save(r.segs, 'Videozeiten nachgerechnet'))();
}

const $view = () => document.getElementById('view');

// --- position ---

function setKm(km, { seek = true, fromPlayer = false } = {}) {
  const r = re; if (!r) return;
  r.km = Math.max(0, Math.min(r.total, km));
  const p = pointAt(r.line, r.cum, r.km);
  r.marker.setLngLat(p);
  const slider = document.getElementById('rte-km'); if (slider && +slider.value !== r.km) slider.value = r.km;
  const x = (r.km / (r.total || 1)) * W;
  document.getElementById('rte-cursor')?.setAttribute('transform', `translate(${x} 0)`);
  const ele = eleAt(r.T.profile, r.km), e1 = eleAt(r.T.profile, Math.max(0, r.km - 0.1)), e2 = eleAt(r.T.profile, Math.min(r.total, r.km + 0.1));
  const grade = ele == null ? null : ((e2 - e1) / (Math.min(r.total, r.km + 0.1) - Math.max(0, r.km - 0.1) || 1)) / 10;
  const seg = segmentAt(segmentsOf(r.segs, r.total), r.km);
  document.getElementById('rte-pos').innerHTML = `<span>km <b>${km2(r.km)}</b> von ${km1(r.total)}</span>`
    + (ele != null ? `<span>Höhe <b>${num(ele)} m</b></span><span>Steigung <b>${grade.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</b></span>` : '')
    + `<span>${seg?.video_id ? `Video <b style="color:${colorOf(seg.video_id)}">${r.d.esc(title(seg.video_id))}</b>` : 'kein Video zugeordnet'}</span>`;
  if (!fromPlayer && r.preview && !videosAt(r.cov ?? [], r.km).some((v) => v.id === r.preview)) r.preview = null;
  renderCands(); drawCands();
  if (!fromPlayer) { clearTimeout(r.seekTimer); r.seekTimer = setTimeout(() => d_(() => syncPlayer(seek)), seek ? 250 : 600); }
}
const d_ = (fn) => re?.d.guard(fn)();

// --- assignments ---

const colorOf = (vid) => { const order = [...new Set(re.segs.map((s) => s.video_id).filter(Boolean))]; const i = order.indexOf(vid); return i < 0 ? '#3b7ddd' : PALETTE[i % PALETTE.length]; };
const title = (vid) => re.meta.get(vid)?.title || vid;

/** The synced track of a video ({t, c}), cached; null when it has none. */
function syncOf(vid) {
  const r = re, m = r.meta.get(vid);
  if (!m?.synced) return Promise.resolve(null);
  if (!r.sync.has(vid)) r.sync.set(vid, r.d.api('GET', `videos/${vid}/track`).catch(() => null));
  return r.sync.get(vid);
}
/** Video second of `vid` at route km, or null: along the continuous pass found by the coverage, else the nearest pass. */
async function videoTime(vid, km, nearT = null) {
  const tr = await syncOf(vid); if (!tr || !re) return null;
  const k = Math.max(0, Math.min(re.total, km)), c = re.cov?.find((x) => x.id === vid);
  if (c?.onTrack && c.vkm) { const t = timeAtKm(tr, c.vkm, re.smp, k); if (t != null) return t; }
  return timeAt(tr, pointAt(re.line, re.cum, k), headingAt(re.line, re.cum, k), { nearT })?.t ?? null;
}

async function save(list, msg) {
  const r = re;
  const segs = segmentsOf(list, r.total);
  const out = await Promise.all(segs.map(async (s) => {
    if (!s.video_id) return { ...s, t_from_s: null, t_to_s: null };
    const a = await videoTime(s.video_id, s.from_km);
    return { ...s, t_from_s: a, t_to_s: await videoTime(s.video_id, s.to_km - 0.01, a) };
  }));
  const res = await r.d.api('PUT', `tracks/${r.id}/videos`, { segments: out.map(({ from_km, video_id, t_from_s, t_to_s }) => ({ from_km, video_id, t_from_s, t_to_s })) });
  if (re !== r) return;
  r.segs = res.segments.map(({ from_km, video_id }) => ({ from_km, video_id })); r.times = res.segments;
  r.d.toast(msg);
  renderProfile(); renderSegs(); setKm(r.km);
}

// --- rendering ---

function renderProfile() {
  const r = re, { esc } = r.d, prof = r.T.profile, segs = segmentsOf(r.segs, r.total), X = (km) => (km / (r.total || 1)) * W;
  let area = '', grid = '';
  if (prof?.length > 1) {
    const lo = Math.min(...prof.map((p) => p[1])), hi = Math.max(...prof.map((p) => p[1])), span = Math.max(50, hi - lo), base = lo - span * 0.08;
    const Y = (e) => PH - ((e - base) / (span * 1.12)) * PH;
    area = `<path class="rte-area" d="M0 ${PH} ${prof.map(([k, e]) => `L${X(k).toFixed(1)} ${Y(e).toFixed(1)}`).join(' ')} L${W} ${PH} Z"/>`;
    grid = `<span class="rte-ylab hi" style="top:${(Y(hi) / H) * SVG_PX}px">${num(hi)} m</span><span class="rte-ylab lo" style="top:${(Y(lo) / H) * SVG_PX}px">${num(lo)} m</span>`;
  }
  const bands = segs.map((s) => `<rect x="${X(s.from_km)}" y="${BAND_Y}" width="${Math.max(0.5, X(s.to_km) - X(s.from_km))}" height="${BAND_H}" fill="${s.video_id ? colorOf(s.video_id) : 'transparent'}"><title>${esc(s.video_id ? title(s.video_id) : 'kein Video')}: km ${km2(s.from_km)}–${km2(s.to_km)}</title></rect>`).join('');
  // how many videos ride each stretch (200 bins); amber where none
  let cov = '';
  if (r.cov) {
    const n = 200;
    for (let i = 0; i < n; i++) {
      const k = ((i + 0.5) / n) * r.total, c = videosAt(r.cov, k).length;
      cov += `<rect x="${(i / n) * W}" y="${COV_Y}" width="${W / n + 0.3}" height="${COV_H}" fill="${c ? 'var(--l2)' : 'var(--amber)'}" opacity="${c ? Math.min(1, 0.3 + c * 0.2) : 0.35}"/>`;
    }
  }
  const c = climb(prof), sum = document.getElementById('rte-sum');
  sum.innerHTML = `${km1(r.total)} km${prof ? ` · ↑ ${num(c.up)} m ↓ ${num(c.down)} m` : ''} · ${plural(r.segs.filter((s) => s.video_id).length, 'Abschnitt', 'Abschnitte')} mit Video`
    + (r.cov ? ` · ${r.cov.length} Videos fahren hier in Richtung der Route` : '');
  document.getElementById('rte-prof').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="slider" tabindex="0" aria-label="Höhenprofil: Position wählen"
      aria-valuemin="0" aria-valuemax="${r.total.toFixed(2)}" aria-valuenow="${r.km.toFixed(2)}">
      ${area}<line x1="0" x2="${W}" y1="${PH}" y2="${PH}" class="rte-base"/>${bands}${cov}
      <g id="rte-cursor" transform="translate(${X(r.km)} 0)"><line x1="0" x2="0" y1="0" y2="${H}"/></g></svg>${grid}
    ${prof?.length > 1 ? '' : `<p class="rte-noele">Die GPX-Datei hat keine Höhen. <button type="button" class="btn small" id="rte-ele">Höhen nachschlagen (Open-Meteo)</button></p>`}
    <div class="rte-legend meta"><span><i class="lg band"></i>zugeordnet</span><span><i class="lg cov"></i>Videos vorhanden</span><span><i class="lg gap"></i>kein Video in dieser Richtung</span></div>`;
  const svg = document.querySelector('#rte-prof svg');
  const at = (e) => { const b = svg.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * r.total; };
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId); setKm(at(e), { seek: false });
    svg.onpointermove = (ev) => setKm(at(ev), { seek: false });
    svg.onpointerup = (ev) => { svg.onpointermove = svg.onpointerup = null; setKm(at(ev)); };
  });
  const btn = document.getElementById('rte-ele');
  if (btn) btn.onclick = r.d.guard(async () => {
    btn.disabled = true;
    try { const res = await r.d.api('POST', `tracks/${r.id}/elevation`, {}); r.T.profile = res.profile; r.d.toast('Höhen von Open-Meteo übernommen'); renderProfile(); setKm(r.km); }
    finally { btn.disabled = false; }
  });
  drawAssign();
}

function renderSegs() {
  const r = re, { esc } = r.d, segs = segmentsOf(r.segs, r.total), box = document.getElementById('rte-segs');
  if (!segs.length) { box.innerHTML = '<p class="meta">Noch kein Video zugeordnet. Position wählen und bei einem Video „Ab hier“ drücken, oder einen Vorschlag erzeugen.</p>'; return; }
  const rows = [];
  if (segs[0].from_km > 0) rows.push(`<tr class="gap"><td class="mono">0–${km2(segs[0].from_km)}</td><td colspan="3" class="meta">kein Video</td></tr>`);
  for (const s of segs) {
    const m = r.meta.get(s.video_id), t = r.times.find((x) => Math.abs(x.from_km - s.from_km) < 0.001);
    let warn = '';
    if (s.video_id && r.cov) {
      const c = r.cov.find((x) => x.id === s.video_id), iv = c?.intervals.find((x) => x.from_km - 0.06 <= s.from_km && s.from_km < x.to_km);
      if (!iv) warn = 'fährt hier nicht in Richtung der Route';
      else if (iv.to_km < s.to_km - 0.1) warn = `endet bei km ${km2(iv.to_km)}`;
    }
    rows.push(`<tr class="${s.video_id ? '' : 'gap'}" data-km="${s.from_km}">
      <td class="mono"><button type="button" class="link" data-seek="${s.from_km}">${km2(s.from_km)}–${km2(s.to_km)}</button></td>
      <td>${s.video_id ? `<i class="swatch" style="background:${colorOf(s.video_id)}"></i><a href="#v=${esc(s.video_id)}">${esc(title(s.video_id))}</a>
        ${m ? `<br><span class="meta">${esc(m.channel || '')}</span>` : ''}${warn ? `<br><span class="tag warn">${esc(warn)}</span>` : ''}` : '<span class="meta">kein Video</span>'}</td>
      <td class="mono">${t?.t_from_s != null ? `${r.d.fmt(t.t_from_s)}–${r.d.fmt(t.t_to_s)}` : s.video_id ? '<span class="meta">ohne Sync</span>' : ''}</td>
      <td><button type="button" class="btn small danger" data-del="${s.from_km}" aria-label="Zuordnung ab km ${km2(s.from_km)} entfernen">✕</button></td></tr>`);
  }
  box.innerHTML = `<table class="mini"><thead><tr><th>km</th><th>Video</th><th>Zeit</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  box.onclick = (e) => {
    const s = e.target.closest('[data-seek]'); if (s) setKm(+s.dataset.seek + 0.0005);
    const x = e.target.closest('[data-del]'); if (x) r.d.guard(() => save(removeAt(r.segs, +x.dataset.del), 'Zuordnung entfernt'))();
  };
}

function candidatesHere() {
  const r = re; if (!r.cov) return [];
  const seg = segmentAt(segmentsOf(r.segs, r.total), r.km);
  return videosAt(r.cov, r.km).map((v) => ({ ...v, m: r.meta.get(v.id), on: seg?.video_id === v.id }))
    .sort((a, b) => b.on - a.on || (b.m?.synced ?? 0) - (a.m?.synced ?? 0) || (a.m?.loc_level ?? 7) - (b.m?.loc_level ?? 7) || b.iv.to_km - a.iv.to_km);
}

function renderCands() {
  const r = re, box = document.getElementById('rte-cands'); if (!box || !r.cov) return;
  const { esc, lvl, fmt } = r.d, list = candidatesHere();
  const key = `${list.map((c) => `${c.id}${c.on ? '*' : ''}`).join()}|${r.preview}|${Math.round(r.km * 20)}`;
  if (key === r.candKey) return;
  r.candKey = key;
  box.innerHTML = list.length ? list.map(({ id, iv, m, on }) => `<div class="cand ${on ? 'on' : ''} ${r.preview === id ? 'pv' : ''}" data-id="${esc(id)}">
      <div class="t">${on ? `<i class="swatch" style="background:${colorOf(id)}"></i>` : ''}${esc(m?.title || id)}</div>
      <div class="meta">${esc(m?.channel || '')}${m?.duration_s ? ` · ${fmt(m.duration_s)}` : ''} · <span class="mono">${esc(id)}</span></div>
      <div class="row">${lvl(m?.loc_level)}${m?.synced ? '<span class="tag hi">synchron</span>' : '<span class="tag warn">ohne Sync</span>'}
        ${m?.embeddable === false ? '<span class="tag warn">nicht einbettbar</span>' : ''}${m && !m.site_published ? '<span class="tag">nicht veröffentlicht</span>' : ''}
        <span class="meta">fährt km ${km1(iv.from_km)}–${km1(iv.to_km)}</span><span class="mono" data-time="${esc(id)}"></span></div>
      <div class="row">${on ? '<span class="tag ok">zugeordnet</span>' : `<button type="button" class="btn small btn-primary" data-assign="${esc(id)}">Ab hier zuordnen</button>`}
        <button type="button" class="btn small ${r.preview === id ? 'on' : ''}" data-preview="${esc(id)}">Vorschau</button></div></div>`).join('')
    : '<p class="meta">Hier fährt kein Video in Richtung der Route.</p>';
  for (const { id, m } of list) if (m?.synced) videoTime(id, r.km).then((t) => { const el = box.querySelector(`[data-time="${CSS.escape(id)}"]`); if (el && t != null) el.textContent = `Video ${fmt(t)}`; });
  box.onclick = (e) => {
    const a = e.target.closest('[data-assign]');
    if (a) return r.d.guard(() => save(assignFrom(r.segs, r.km, a.dataset.assign), `„${title(a.dataset.assign)}“ ab km ${km2(r.km)}`))();
    const p = e.target.closest('[data-preview]');
    if (p) { r.preview = r.preview === p.dataset.preview ? null : p.dataset.preview; r.candKey = null; renderCands(); r.d.guard(() => syncPlayer(true))(); }
  };
  box.onpointerover = (e) => { const c = e.target.closest('.cand'); r.hover = c?.dataset.id ?? null; drawCands(); };
  box.onpointerleave = () => { r.hover = null; drawCands(); };
}

function drawAssign() {
  const r = re, src = r?.map?.getSource?.('rte-assign'); if (!src) return;
  src.setData({ type: 'FeatureCollection', features: segmentsOf(r.segs, r.total).filter((s) => s.video_id && s.to_km > s.from_km)
    .map((s) => ({ type: 'Feature', properties: { color: colorOf(s.video_id) }, geometry: { type: 'LineString', coordinates: sliceLine(r.line, r.cum, s.from_km, s.to_km) } })) });
}
function drawCands() {
  const r = re, src = r?.map?.getSource?.('rte-cands'); if (!src || !r.cov) return;
  const ids = new Set(videosAt(r.cov, r.km).map((v) => v.id)); if (r.hover) ids.add(r.hover);
  src.setData({ type: 'FeatureCollection', features: [...ids].filter((vid) => r.vlines[vid])
    .map((vid) => ({ type: 'Feature', properties: { id: vid, hi: vid === r.hover || vid === r.preview ? 1 : 0 }, geometry: { type: 'LineString', coordinates: r.vlines[vid] } })) });
}

// --- player: the video at the position; while it plays, the position follows it and changes video at each assignment ---

async function syncPlayer(seek, autoplay = false) {
  const r = re; if (!r) return;
  const seg = segmentAt(segmentsOf(r.segs, r.total), r.km), vid = r.preview ?? seg?.video_id ?? null;
  const out = document.getElementById('rte-play');
  if (!vid) {
    if (r.player) { r.player.handle.destroy(); r.player = null; }
    document.getElementById('rte-slot').innerHTML = '<div class="consent"><p>An dieser Stelle ist kein Video zugeordnet.</p></div>';
    out.innerHTML = ''; return;
  }
  const m = r.meta.get(vid), t = await videoTime(vid, r.km);
  if (re !== r) return;
  out.innerHTML = `<span>${r.preview ? 'Vorschau' : 'Zugeordnet'}: <b>${r.d.esc(title(vid))}</b></span>${t != null ? `<span>Video <b>${r.d.fmt(t)}</b></span>` : '<span>ohne Sync: Zeit von Hand suchen</span>'}`;
  if (m?.embeddable === false) {
    if (r.player) { r.player.handle.destroy(); r.player = null; }
    document.getElementById('rte-slot').innerHTML = `<div class="consent"><p>Einbetten nicht erlaubt.</p><a href="https://www.youtube.com/watch?v=${encodeURIComponent(vid)}${t != null ? `&t=${Math.floor(t)}s` : ''}" target="_blank" rel="noopener">Auf YouTube öffnen</a></div>`;
    return;
  }
  if (r.player?.vid === vid) { if (seek && t != null) { r.player.handle.seek(t); r.lastS = null; } if (autoplay) r.player.handle.play(); return; }
  r.player?.handle.destroy();
  const track = await syncOf(vid);
  if (re !== r) return;
  r.lastS = null;
  const handle = mountPlayer(r.map, document.getElementById('rte-slot'), { videoId: vid, track, consent: false, start: t ?? 0,
    onTime: (s) => follow(vid, s), onReady: () => { if (autoplay) handle.play(); } });
  r.player = { vid, handle, track };
}

/** While the video plays (its time moves on in small steps), the position follows it; at the end of its stretch the next one starts. */
function follow(vid, s) {
  const r = re; if (!r || r.player?.vid !== vid || !r.player.track) return;
  const ds = r.lastS == null ? 0 : s - r.lastS; r.lastS = s;
  if (!(ds > 0 && ds < 1.5) || r.preview) return;
  const p = projectNear(r.line, r.cum, trackAt(r.player.track, s), r.km, 0.5);
  if (p.dist_m > 200) return;
  const segs = segmentsOf(r.segs, r.total), seg = segmentAt(segs, r.km);
  if (seg && seg.video_id === vid && p.km >= seg.to_km - 0.005) {
    const next = segs[segs.indexOf(seg) + 1];
    if (!next?.video_id) { r.player.handle.pause(); setKm(seg.to_km, { fromPlayer: true }); r.d.toast(next ? 'Ende des Abschnitts: danach kein Video' : 'Ende der Route'); return; }
    r.km = next.from_km + 0.0005; setKm(r.km, { fromPlayer: true });
    r.d.guard(() => syncPlayer(true, true))();
    return;
  }
  if (p.km > r.km) setKm(p.km, { fromPlayer: true });
}
