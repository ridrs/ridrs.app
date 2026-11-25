// SPDX-License-Identifier: AGPL-3.0-or-later
// YouTube player synced with a pointer on the route (concept 4.6).
// Based on catalog-web/site/video.js: the pointer follows playback, dragging it along the route seeks.
// Additions: two-click consent (nothing from YouTube loads before the click), smooth pointer between
// polls (requestAnimationFrame + playback rate), start time from deep links, km/position readout.
// Admin use (site/admin/admin.js): `consent: false` loads at once, `track` passes a track object instead of a
// URL, and the returned handle can swap the track (setTrack), read the time and pause.
// ytPlayer is the core without consent and pointer: one YouTube player in a host element with a smooth time between polls,
// used by mountPlayer and by the route player's two-player deck (site/route-deck.js).
// To be moved into a shared package with catalog-web once both are stable.
import { Marker } from './vendor/maplibre-gl/maplibre-gl.mjs';
import { t, num } from './i18n.js';

const km1 = (x) => num(x, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

let apiPromise = null;
export function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('YouTube API not reachable')); };
    document.head.append(s);
  });
  return apiPromise;
}

/** Index of the last track second at or before video time `s` (binary search). */
export function indexAt(t, s) {
  let lo = 0, hi = t.length - 1;
  if (s <= t[0]) return 0;
  if (s >= t[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= s) lo = mid; else hi = mid; }
  return lo;
}

/** Cumulative distance in km at each track point. */
export function cumulativeKm(c) {
  const out = [0];
  for (let i = 1; i < c.length; i++) {
    const k = Math.cos((c[i][1] * Math.PI) / 180);
    out.push(out[i - 1] + Math.hypot((c[i][0] - c[i - 1][0]) * k, c[i][1] - c[i - 1][1]) * 111.32);
  }
  return out;
}

/** Interpolated value of `arr` (numbers or [x, y]) at video time `s`. */
function at(t, arr, s) {
  const i = indexAt(t, s);
  if (i >= t.length - 1 || s <= t[0]) return arr[i];
  const f = (s - t[i]) / (t[i + 1] - t[i]);
  const a = arr[i], b = arr[i + 1];
  return Array.isArray(a) ? [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])] : a + f * (b - a);
}

function nearestIndex(c, [lon, lat]) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < c.length; i++) {
    const dx = (c[i][0] - lon) * k, dy = c[i][1] - lat, d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; };

/** YouTube player states (YT.PlayerState). */
export const YTS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/**
 * One YouTube player (youtube-nocookie.com) in `host` (replaced by the iframe). No consent here: load the API only after it.
 * time() runs smoothly between the polls (playback rate included). onState(state) for every state change.
 * @param {HTMLElement} host
 * @param {{videoId: string, start?: number, muted?: boolean, controls?: boolean, pollMs?: number, onReady?: () => void, onState?: (s:number) => void}} o
 */
export function ytPlayer(host, { videoId, start = 0, muted = false, controls = true, pollMs = 250, onReady = () => {}, onState = () => {} }) {
  let alive = true, player = null, timer = null, ready = false, state = YTS.UNSTARTED, vid = videoId;
  let last = { s: start, at: performance.now(), playing: false, rate: 1 };
  const poll = () => {
    if (!alive || !player?.getCurrentTime) return;
    state = player.getPlayerState?.() ?? state;
    last = { s: player.getCurrentTime(), at: performance.now(), playing: state === YTS.PLAYING, rate: player.getPlaybackRate?.() || 1 };
  };
  const whenReady = loadYouTubeApi().then((YT) => new Promise((resolve) => {
    if (!alive) return;
    player = new YT.Player(host, {
      host: 'https://www.youtube-nocookie.com', videoId, width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, start: Math.floor(start), controls: controls ? 1 : 0, mute: muted ? 1 : 0 },
      events: {
        onReady: () => { ready = true; if (muted) player.mute?.(); timer = setInterval(poll, pollMs); poll(); resolve(); onReady(); },
        onStateChange: (e) => { state = e.data; poll(); onState(e.data); },
        onPlaybackRateChange: poll,
      },
    });
  }));
  const call = (fn) => (...args) => { if (ready && alive) { const r = player[fn]?.(...args); poll(); return r; } return undefined; };
  return {
    ready: whenReady,
    get videoId() { return vid; },
    /** Smooth video time: the last poll plus the time since, while playing. */
    time: () => last.s + (last.playing ? ((performance.now() - last.at) / 1000) * last.rate : 0),
    state: () => state,
    playing: () => state === YTS.PLAYING,
    rate: () => last.rate,
    play: call('playVideo'),
    pause: call('pauseVideo'),
    seek: (s) => { if (!ready) return; player.seekTo?.(s, true); last = { ...last, s, at: performance.now() }; },
    /** Loads another video at s without playing (cue) or playing (load). */
    cue: (id, s = 0) => { vid = id; if (ready) { player.cueVideoById?.({ videoId: id, startSeconds: s }); last = { ...last, s, at: performance.now(), playing: false }; } },
    load: (id, s = 0) => { vid = id; if (ready) { player.loadVideoById?.({ videoId: id, startSeconds: s }); last = { ...last, s, at: performance.now() }; } },
    mute: call('mute'),
    unMute: call('unMute'),
    isMuted: () => (ready ? !!player.isMuted?.() : muted),
    setVolume: call('setVolume'),
    setRate: call('setPlaybackRate'),
    iframe: () => (ready ? player.getIframe?.() : null),
    destroy() { alive = false; clearInterval(timer); try { player?.destroy?.(); } catch { /* gone */ } },
  };
}

/**
 * Two-click player. Shows a consent box in `slot`; after the click it loads the YouTube IFrame API
 * (youtube-nocookie.com) and, when `syncUrl` is given, a draggable pointer on `map`.
 * @param {{videoId: string, syncUrl?: string, track?: {t:number[], c:number[][]}, start?: number, readout?: HTMLElement, consent?: boolean,
 *   onTime?: (s:number, km:number, totalKm:number)=>void, onReady?: () => void}} opts
 * @returns {{destroy: () => void, seek: (s:number) => void, setTrack: (tr: object|null) => void, time: () => number, pause: () => void, play: () => void}}
 */
export function mountPlayer(map, slot, { videoId, syncUrl, track: givenTrack = null, start = 0, readout, consent = true, onTime = () => {}, onReady = () => {} }) {
  let alive = true, yt = null, track = null, kms = null, dragging = false, raf = 0;
  const el = document.createElement('div');
  el.className = 'video-pointer';
  el.title = t('player.pointer_title');
  const pointer = new Marker({ element: el, draggable: true });

  slot.innerHTML = `<div class="consent">
    <p>${t('player.consent')} (<a href="datenschutz.html" target="_blank">${t('player.privacy')}</a>).</p>
    <button type="button" class="btn">${t('player.load')}</button>
    <a href="https://www.youtube.com/watch?v=${videoId}${start ? `&t=${Math.floor(start)}s` : ''}" target="_blank" rel="noopener">${t('player.or_youtube')}</a>
  </div>`;

  const show = (s) => {
    if (!track) return;
    pointer.setLngLat(at(track.t, track.c, s));
    const km = at(track.t, kms, s);
    if (readout) readout.innerHTML = `<span>${t('player.video')} <b>${fmt(s)}</b></span><span>${t('player.distance')} <b>${km1(km)} km</b> ${t('player.of', { total: km1(kms.at(-1)) })}</span>`
      + (s < track.t[0] ? `<span>${t('player.intro', { t: fmt(track.t[0]) })}</span>` : '')
      + (s > track.t.at(-1) ? `<span>${t('player.ended')}</span>` : '');
    onTime(s, km, kms.at(-1));
  };
  const time = () => (yt ? yt.time() : start);
  const frame = () => {
    if (!alive) return;
    if (!dragging) show(time());
    raf = requestAnimationFrame(frame);
  };
  const seek = (s) => yt?.seek(s);

  pointer.on('dragstart', () => { dragging = true; });
  pointer.on('drag', () => { const i = nearestIndex(track.c, pointer.getLngLat().toArray()); pointer.setLngLat(track.c[i]); show(track.t[i]); });
  pointer.on('dragend', () => { dragging = false; seek(track.t[nearestIndex(track.c, pointer.getLngLat().toArray())]); });

  let started = false;
  const setTrack = (tr) => {
    track = tr?.t?.length ? tr : null;
    if (!track) { pointer.remove(); cancelAnimationFrame(raf); raf = 0; return; }
    kms = cumulativeKm(track.c);
    pointer.setLngLat(at(track.t, track.c, time())).addTo(map);
    show(time());
    if (started && !raf) raf = requestAnimationFrame(frame);
  };
  const load = () => {
    const host = document.createElement('div');
    slot.replaceChildren(host);
    Promise.all([givenTrack ?? (syncUrl ? fetch(syncUrl).then((r) => r.json()) : null), loadYouTubeApi()])
      .then(([tr]) => {
        if (!alive) return;
        if (tr) setTrack(tr);
        yt = ytPlayer(host, { videoId, start, onReady: () => { started = true; if (track && !raf) raf = requestAnimationFrame(frame); onReady(); } });
      })
      .catch((err) => {
        if (!alive) return;
        console.warn(err);
        slot.innerHTML = `<div class="consent"><p>${t('player.failed')}</p>
          <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener">${t('detail.watch_youtube')}</a></div>`;
      });
  };
  if (consent) slot.querySelector('button').addEventListener('click', load);
  else load();

  return {
    seek, setTrack,
    time,
    pause: () => yt?.pause(),
    play: () => yt?.play(),
    destroy() { alive = false; cancelAnimationFrame(raf); pointer.remove(); yt?.destroy(); },
  };
}
