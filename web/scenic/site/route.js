// SPDX-License-Identifier: AGPL-3.0-or-later
// Route dialog (ROUTE-PLAYER-PLAN.md): a published route (GET api/tracks/:id) in the same dialog as a video, with its whole
// elevation profile, and played from start to end on one clock (site/lib/route-play.js). Where an editor assigned a playable
// video, it plays in sync with a pointer on the route; elsewhere the slot is black and the pointer moves on the speed model.
// Two stacked players (site/route-deck.js) hand over from one video to the next without a visible change. The map pointer, the
// profile, the coverage bar, the buttons and the list all seek through seekKm().
// app.js passes its map and dialog helpers in `ctx` (no import back into app.js, which has top-level await).
import { Marker } from './vendor/maplibre-gl/maplibre-gl.mjs';
import { t, num as fmtNum } from './i18n.js';
import { loadYouTubeApi, YTS } from './player.js';
import { mountDeck } from './route-deck.js';
import { eleAt } from './lib/route-sync.js';
import { climb, projectNear, sliceLine } from './lib/track-cover.js';
import { PLAY, buildTimeline, segAtKm, sAtKm, kmAtS, clockAtKm, videoTimeAtKm, pointAtKm, deckPlan, startAt } from './lib/route-play.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const km1 = (x) => fmtNum(x, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const num = (x) => fmtNum(Math.round(x));
const pct = (x) => fmtNum(x, { style: 'percent', maximumFractionDigits: 0 });
const clockFmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; };
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
};
const GAP_RATE_KEY = 'ridrs-scenic.gapRate';

/** YouTube consent for this page view: null = not asked, 'yes', 'no' (route without videos). */
let consent = null;

/**
 * Opens route `id` at km in the dialog body. Returns a controller {id, destroy(), km()} or null when the route is gone.
 * ctx: {map, body, mountProfile, drawRoute, padding, fitSheet, openVideo(id, start, {route}), lvlTag, isCurrent()}
 */
export async function openRoute(ctx, id, startKm = 0) {
  const { map, body } = ctx;
  body.innerHTML = `<p class="meta">${t('detail.loading')}</p>`;
  const r = await fetch(`api/tracks/${encodeURIComponent(id)}`);
  if (!ctx.isCurrent()) return null;
  if (!r.ok) { body.innerHTML = `<p>${t('route.not_found')}</p>`; return null; }
  const R = await r.json();
  if (!ctx.isCurrent()) return null;
  // synced tracks of the playable videos (static assets, cached by the browser)
  const vmeta = new Map(R.videos.map((v) => [v.id, v]));
  const ids = [...new Set(R.segments.map((s) => s.video_id).filter(Boolean))];
  const tracks = new Map((await Promise.all(ids.map((vid) => fetch(vmeta.get(vid).sync.path).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    .then((tr) => [vid, tr])))).filter(([, tr]) => tr?.t?.length));
  if (!ctx.isCurrent()) return null;
  // a video whose track did not load cannot play in sync: its assignment becomes a gap
  const tl = buildTimeline({ line: R.line, profile: R.profile, segments: R.segments.map((s) => (s.video_id && !tracks.has(s.video_id) ? { ...s, video_id: null } : s)), tracks });
  const vsegs = tl.segs.filter((s) => s.video_id), videoKm = vsegs.reduce((x, s) => x + s.to_km - s.from_km, 0);
  const cl = R.profile?.length > 1 ? climb(R.profile) : null;
  const lo = R.profile?.length ? Math.min(...R.profile.map((p) => p[1])) : null, hi = R.profile?.length ? Math.max(...R.profile.map((p) => p[1])) : null;
  const notPlayable = R.videos.filter((v) => !vsegs.some((s) => s.video_id === v.id));

  body.innerHTML = `<p class="eyebrow">${t('route.eyebrow')}</p>
    <h2 id="detail-title" title="${esc(R.name)}"><i class="route-swatch" style="--c:${esc(R.color)}"></i>${esc(R.name)}</h2>
    ${R.description ? `<p class="meta">${esc(R.description)}</p>` : ''}
    <div class="video" id="slot"></div>
    <div class="route-ctl" role="group" aria-label="${esc(t('route.controls'))}">
      <button type="button" class="btn rp-play" aria-label="${esc(t('route.play'))}">${ICON.play}</button>
      <button type="button" class="btn small" data-step="-1" title="${esc(t('route.back_1km'))}" aria-label="${esc(t('route.back_1km'))}">«</button>
      <button type="button" class="btn small" data-step="-0.1" title="${esc(t('route.back_100m'))}" aria-label="${esc(t('route.back_100m'))}">‹</button>
      <button type="button" class="btn small" data-step="0.1" title="${esc(t('route.fwd_100m'))}" aria-label="${esc(t('route.fwd_100m'))}">›</button>
      <button type="button" class="btn small" data-step="1" title="${esc(t('route.fwd_1km'))}" aria-label="${esc(t('route.fwd_1km'))}">»</button>
      <span class="grow"></span>
      <label class="rp-rate" title="${esc(t('route.gap_rate_title'))}">${t('route.gap_rate')}
        <select>${PLAY.gapRates.map((x) => `<option value="${x}">${x}×</option>`).join('')}</select></label>
      <button type="button" class="btn small rp-sound" hidden>${t('route.sound_on')}</button>
    </div>
    <div class="readout" id="readout" aria-live="off"></div>
    ${R.profile?.length > 1 ? '<div class="profile-box" id="profile"></div>' : ''}
    <div class="rp-band" role="slider" tabindex="0" aria-label="${esc(t('route.position'))}" aria-valuemin="0" aria-valuemax="${tl.km.toFixed(2)}" aria-valuenow="0">
      ${tl.segs.map((s) => `<span class="${s.video_id ? 'on' : ''}" style="left:${((s.from_km / tl.km) * 100).toFixed(3)}%;width:${(((s.to_km - s.from_km) / tl.km) * 100).toFixed(3)}%"></span>`).join('')}
      <i class="cur"></i></div>
    <p class="meta rp-band-key"><span class="key on"></span>${t('route.with_video')} <span class="key"></span>${t('route.no_video')}</p>
    <dl>
      <dt>${t('dt.distance')}</dt><dd>${km1(R.distance_km ?? tl.km)} km</dd>
      ${cl ? `<dt>${t('dt.elevation')}</dt><dd>${esc(t('route.elevation', { up: num(cl.up), down: num(cl.down), lo: num(lo), hi: num(hi) }))}</dd>` : ''}
      <dt>${t('route.with_video')}</dt><dd>${esc(t('route.with_video_val', { km: km1(videoKm), share: pct(tl.km ? videoKm / tl.km : 0) }))}</dd>
    </dl>
    ${vsegs.length || notPlayable.length ? `<h3 class="rp-h">${t('route.videos')}</h3><ul class="stack rp-videos" role="list">
      ${vsegs.map((s) => { const v = vmeta.get(s.video_id); return `<li><button type="button" data-km="${s.from_km}">
        <span class="t">${esc(v.title || v.id)}</span>
        <span class="meta">${esc(t('route.km_range', { a: km1(s.from_km), b: km1(s.to_km) }))}${v.channel ? ` · ${esc(v.channel)}` : ''}</span> ${ctx.lvlTag(v.loc_level ?? 7)}</button>
        <a class="link rp-open" href="#v=${esc(v.id)}&t=${Math.floor(s.t_from)}" data-id="${esc(v.id)}" data-t="${s.t_from}">${t('route.open_video')}</a></li>`; }).join('')}
      ${notPlayable.map((v) => `<li class="rp-np"><span class="t">${esc(v.title || v.id)}</span>
        <span class="meta">${t('route.not_playable')} · <a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">${t('detail.youtube')}</a></span></li>`).join('')}
      </ul>` : ''}`;

  const slot = body.querySelector('#slot'), readout = body.querySelector('#readout'), band = body.querySelector('.rp-band'), bandCur = band.querySelector('.cur');
  const playBtn = body.querySelector('.rp-play'), soundBtn = body.querySelector('.rp-sound'), rateSel = body.querySelector('.rp-rate select');
  let rate = 1;
  try { rate = PLAY.gapRates.includes(+localStorage.getItem(GAP_RATE_KEY)) ? +localStorage.getItem(GAP_RATE_KEY) : 1; } catch { /* storage blocked */ }
  rateSel.value = String(rate);
  rateSel.addEventListener('change', () => { rate = +rateSel.value; try { localStorage.setItem(GAP_RATE_KEY, String(rate)); } catch { /* storage blocked */ } });

  // --- map: the route highlighted, its stretches with video on top, the draggable position pointer ---
  ctx.drawRoute(tl.line, true);
  const COVER = 'rp-cover';
  const coverData = { type: 'FeatureCollection', features: vsegs.map((s) => ({ type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: sliceLine(tl.line, tl.cum, s.from_km, s.to_km) } })) };
  if (map.getSource(COVER)) map.getSource(COVER).setData(coverData);
  else {
    map.addSource(COVER, { type: 'geojson', data: coverData });
    map.addLayer({ id: COVER, type: 'line', source: COVER, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': getComputedStyle(document.documentElement).getPropertyValue('--map-preview').trim() || '#5f8a00', 'line-width': 4 } });
  }
  const el = document.createElement('div');
  el.className = 'video-pointer';
  el.title = t('route.pointer_title');
  const pointer = new Marker({ element: el, draggable: true }).setLngLat(pointAtKm(tl, startKm)).addTo(map);

  // --- deck and consent ---
  const consentBox = document.createElement('div');
  consentBox.className = 'consent rp-consent';
  consentBox.hidden = true;
  consentBox.innerHTML = `<p>${t('player.consent')} (<a href="datenschutz.html" target="_blank">${t('player.privacy')}</a>).</p>
    <button type="button" class="btn" data-c="yes">${t('route.load_videos')}</button>
    <button type="button" class="link" data-c="no">${t('route.without_videos')}</button>`;
  let deck = null;
  const handovers = [];
  const ensureDeck = () => {
    if (deck) return deck;
    deck = mountDeck(slot, {
      onState: (st) => { if (st === YTS.PLAYING) setPlaying(true); else if (st === YTS.PAUSED) setPlaying(false); },
      onSwap: (vid) => { if (pending && pending.video_id === vid) enter(pending, { fromSwap: true }); },
      onMuted: (m) => { soundBtn.hidden = !m; },
      log: (e) => { handovers.push(e); console.debug('route handover', e); },
    });
    slot.append(consentBox);
    return deck;
  };
  ensureDeck();
  // without a decision the deck shows black; the consent box lies over it in a video stretch
  deck.black(true);
  consentBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    consent = b.dataset.c;
    consentBox.hidden = true;
    if (consent === 'yes') loadYouTubeApi().catch(() => { consent = 'no'; });
    enter(seg, { km: kmNow(), force: true });
    setPlaying(true);
  });
  soundBtn.addEventListener('click', () => { deck.unMute(); soundBtn.hidden = true; });

  // --- state: segment, clock (seconds on the route timeline), playing ---
  let seg = segAtKm(tl, startKm), clock = clockAtKm(tl, startKm), playing = false, pending = null, pendingAt = 0, dragging = false, alive = true, raf = 0, last = performance.now();
  const kmNow = () => kmAtS(seg, clock - seg.c0);
  const videoOn = (s) => !!s.video_id && consent === 'yes';

  function setPlaying(on) {
    playing = on;
    if (!on) pending = null;
    playBtn.innerHTML = on ? ICON.pause : ICON.play;
    playBtn.setAttribute('aria-label', t(on ? 'route.pause' : 'route.play'));
    if (!on) saveHash();
  }

  /** Makes s the current segment at km (or its start); fromSwap: the deck already shows it. */
  function enter(s, { km = s.from_km, fromSwap = false, force = false } = {}) {
    const changed = s !== seg || force;
    seg = s; pending = null;
    clock = s.c0 + sAtKm(s, km);
    consentBox.hidden = !(s.video_id && consent == null);
    if (s.video_id && consent == null) { deck.black(true); if (playing) setPlaying(false); return; }
    if (fromSwap) return;
    if (videoOn(s)) deck.show(s.video_id, videoTimeAtKm(s, km), { play: playing });
    else if (changed || !deck.isBlack()) deck.black(true);
  }

  function seekKm(km) {
    km = Math.max(0, Math.min(tl.km, km));
    enter(segAtKm(tl, km), { km, force: true });
    render(true);
    saveHash();
  }

  let hashTimer = 0;
  function saveHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      if (!alive) return;
      const k = kmNow(), h = `#r=${R.id}${k > 0.05 ? `&k=${k.toFixed(2)}` : ''}`;
      if (location.hash !== h) history.replaceState(null, '', h);
    }, 300);
  }

  // --- the step: clock from the video or the gap clock, handover timing, preloading. A timer (every 50 ms), not the frame loop:
  // requestAnimationFrame stops in a background tab, and the handover must still happen on time there. Drawing runs per frame. ---
  function step(now = performance.now()) {
    if (!alive) return;
    const dt = Math.min(0.5, (now - last) / 1000); last = now;
    const next = tl.segs[seg.i + 1] ?? null, end = seg.c0 + seg.dur;
    const latency = (deck.latency() ?? PLAY.latencyS);
    if (videoOn(seg) && !deck.isBlack()) {
      const c = deck.current();
      if (c && c.vid === seg.video_id) {
        const s = c.t - seg.t_from;
        clock = seg.c0 + Math.max(0, Math.min(seg.dur, s));
        if (playing && !dragging) {
          if (next && videoOn(next)) {
            if (!pending && clock >= startAt(next, latency)) handover(next);
          } else if (s >= seg.dur) {
            if (next) enter(next); else { setPlaying(false); deck.pause(); }
          }
        }
      }
    } else if (playing && !dragging) {
      clock += dt * (seg.video_id ? 1 : rate);
      if (next && videoOn(next) && !pending && clock >= startAt(next, latency * (seg.video_id ? 1 : rate))) handover(next);
      if (clock >= end) {
        clock = end;
        if (!pending) { if (next) enter(next); else setPlaying(false); }
      }
    }
    // the next player never came (blocked, removed video): change the hard way, with its own loading time
    if (pending && now - pendingAt > 8000) enter(pending, { force: true });
    if (consent === 'yes' && !pending) {
      const { preload } = deckPlan(tl, clock);
      if (preload) deck.prepare(preload.video_id, preload.t_from);
    }
  }
  function frame() {
    if (!alive) return;
    render();
    raf = requestAnimationFrame(frame);
  }

  function handover(next) { pending = next; pendingAt = performance.now(); deck.handover(next.video_id, next.t_from); }

  let lastText = 0, profileCtl = null;
  function render(force = false, km = kmNow()) {
    if (!dragging) pointer.setLngLat(pointAtKm(tl, km));
    bandCur.style.left = `${((km / tl.km) * 100).toFixed(3)}%`;
    profileCtl?.at(km, tl.km);
    const now = performance.now();
    if (!force && now - lastText < 200) return;
    lastText = now;
    band.setAttribute('aria-valuenow', km.toFixed(2));
    const s = segAtKm(tl, km), parts = [`<span>${esc(t('route.km_of', { km: km1(km), total: km1(tl.km) }))}</span>`];
    if (R.profile?.length) {
      const e = eleAt(R.profile, km), a = Math.max(0, km - 0.1), b = Math.min(tl.km, km + 0.1);
      const g = ((eleAt(R.profile, b) - eleAt(R.profile, a)) / ((b - a) * 1000 || 1)) * 100;
      parts.push(`<span>${t('route.height')} <b>${num(e)} m</b></span><span>${t('route.grade')} <b>${fmtNum(g, { maximumFractionDigits: 1 })} %</b></span>`);
    }
    if (s.video_id) {
      const v = vmeta.get(s.video_id), vt = videoTimeAtKm(s, km);
      parts.push(`<span>${t('player.video')} <b>${clockFmt(vt)}</b> <a href="#v=${esc(v.id)}&t=${Math.floor(vt)}" class="rp-open" data-id="${esc(v.id)}" data-t="${vt}">${esc(v.title || v.id)}</a></span>`);
    } else {
      const nx = tl.segs[s.i + 1];
      parts.push(`<span class="meta">${esc(nx ? t('route.no_video_until', { km: km1(s.to_km) }) : t('route.no_video_to_end'))}</span>`);
    }
    if (km >= tl.km - 1e-3 && !playing) parts.push(`<span>${t('route.end')}</span>`);
    readout.innerHTML = parts.join('');
  }

  // --- inputs ---
  playBtn.addEventListener('click', () => {
    if (playing) { setPlaying(false); deck.pause(); return; }
    if (kmNow() >= tl.km - 1e-3) seekKm(0);
    if (seg.video_id && consent == null) { consentBox.hidden = false; return; }
    setPlaying(true);
    deck.unlock();
    if (videoOn(seg)) { if (deck.isBlack() || deck.current()?.vid !== seg.video_id) enter(seg, { km: kmNow(), force: true }); else deck.play(); }
  });
  body.querySelector('.route-ctl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (b) seekKm(kmNow() + +b.dataset.step);
  });
  body.addEventListener('click', (e) => {
    const o = e.target.closest('.rp-open');
    if (o) { e.preventDefault(); ctx.openVideo(o.dataset.id, +o.dataset.t || 0, { route: { id: R.id, name: R.name, km: kmNow() } }); return; }
    const k = e.target.closest('.rp-videos button[data-km]');
    if (k) seekKm(+k.dataset.km + 1e-4);
  });
  // coverage bar: click or drag
  const bandKm = (ev) => { const r = band.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * tl.km; };
  let bandDown = false;
  band.addEventListener('pointerdown', (ev) => { bandDown = true; dragging = true; band.setPointerCapture(ev.pointerId); render(true, bandKm(ev)); });
  band.addEventListener('pointermove', (ev) => { if (bandDown) render(true, bandKm(ev)); });
  const bandUp = (ev) => { if (!bandDown) return; bandDown = false; dragging = false; seekKm(bandKm(ev)); };
  band.addEventListener('pointerup', bandUp); band.addEventListener('pointercancel', bandUp);
  band.addEventListener('keydown', (ev) => {
    const d = { ArrowLeft: -0.1, ArrowRight: 0.1, PageDown: -1, PageUp: 1 }[ev.key] ?? (ev.key === 'Home' ? -Infinity : ev.key === 'End' ? Infinity : null);
    if (d == null) return;
    ev.preventDefault();
    seekKm(Number.isFinite(d) ? kmNow() + d * (ev.shiftKey ? 10 : 1) : d < 0 ? 0 : tl.km);
  });
  // map pointer: drag along the route, seek on release
  pointer.on('dragstart', () => { dragging = true; });
  pointer.on('drag', () => { const p = projectNear(tl.line, tl.cum, pointer.getLngLat().toArray()); pointer.setLngLat(pointAtKm(tl, p.km)); render(true, p.km); });
  pointer.on('dragend', () => { dragging = false; seekKm(projectNear(tl.line, tl.cum, pointer.getLngLat().toArray()).km); });
  // keys in the dialog (not while typing): space play/pause, arrows ±100 m, with Shift ±1 km
  const onKey = (ev) => {
    if (ev.target.closest('input, select, textarea, .rp-band') || ev.altKey || ev.metaKey || ev.ctrlKey) return;
    if (ev.key === ' ') { ev.preventDefault(); playBtn.click(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); seekKm(kmNow() + (ev.key === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 1 : 0.1)); }
  };
  ctx.dialog.addEventListener('keydown', onKey);

  const pbox = body.querySelector('#profile');
  if (pbox) profileCtl = ctx.mountProfile(pbox, R.profile, tl.line, [], {
    onSeek: (k, kmMax, done) => { const km = (k / (kmMax || 1)) * tl.km; if (done) { dragging = false; seekKm(km); } else { dragging = true; render(true, km); } },
  });

  enter(seg, { km: startKm, force: true });
  render(true);
  ctx.fitSheet();
  raf = requestAnimationFrame(frame);
  const stepTimer = setInterval(step, 50);

  return {
    id: R.id,
    name: R.name,
    km: kmNow,
    /** Handover timings of this dialog (the plan's check). */
    handovers: () => handovers,
    destroy() {
      alive = false;
      cancelAnimationFrame(raf); clearInterval(stepTimer); clearTimeout(hashTimer);
      ctx.dialog.removeEventListener('keydown', onKey);
      pointer.remove();
      deck?.destroy();
      if (map.getLayer(COVER)) map.removeLayer(COVER);
      if (map.getSource(COVER)) map.removeSource(COVER);
    },
  };
}
