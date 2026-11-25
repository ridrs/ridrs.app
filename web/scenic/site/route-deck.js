// SPDX-License-Identifier: AGPL-3.0-or-later
// Two-player deck of the route player (ROUTE-PLAYER-PLAN.md, "Seamless handover"): two YouTube players stacked in the video slot,
// the visible one plays, the hidden one has the next video buffered at its start second. handover() starts the hidden one and
// changes the visible layer (picture and sound crossfade) only once it really plays, so the change of video is not seen as a
// black frame or a spinner. A black layer covers both in a gap. No route logic here: site/route.js tells the deck what to show.
// The hidden player is never display:none (YouTube would not buffer and would pick a low quality): opacity 0, below the visible one.
import { ytPlayer, YTS } from './player.js';

const FADE_MS = 250;
/** A buffered player counts as ready for a second within this many seconds of the one asked for. */
const NEAR_S = 1.5;

/**
 * @param {HTMLElement} slot the .video box
 * @param {{onState?: (s: number) => void, onSwap?: (videoId: string) => void, onMuted?: (muted: boolean) => void, log?: (e: object) => void}} o
 *   onState: state changes of the visible player caused by the user (its own controls), not by the deck;
 *   onSwap: a handover finished, the new video is visible and playing; onMuted: the visible player plays without sound (iOS);
 *   log: one entry per handover with its timing, for the check in the plan.
 */
export function mountDeck(slot, { onState = () => {}, onSwap = () => {}, onMuted = () => {}, log = () => {} } = {}) {
  slot.classList.add('deck');
  slot.innerHTML = '<div class="deck-layer"></div><div class="deck-layer"></div><div class="deck-black"></div>';
  const layers = [...slot.querySelectorAll('.deck-layer')], black = slot.querySelector('.deck-black');
  /** @type {({yt, layer, vid, at, buffered, buffering, quietUntil}|null)[]} */
  const P = [null, null];
  let a = 0, alive = true, swap = null, latency = null, fadeTimer = 0, volume = 100;

  const hidden = () => 1 - a;
  const setVisible = (i) => { layers[i].classList.add('on'); layers[1 - i].classList.remove('on'); };

  function make(i, vid, at, { muted }) {
    P[i]?.yt.destroy();
    const host = document.createElement('div');
    layers[i].replaceChildren(host);
    const p = { vid, at, buffered: false, buffering: false, quietUntil: 0, layer: layers[i], yt: null };
    p.yt = ytPlayer(host, { videoId: vid, start: at, muted, pollMs: 100, onState: (s) => state(i, s) });
    P[i] = p;
    return p;
  }

  // State changes for a while after the deck's own actions (buffering, handover, pause, load) are not reported as the user's.
  const quiet = (p) => { p.quietUntil = performance.now() + 1500; };
  function state(i, s) {
    const p = P[i];
    if (!p || !alive) return;
    if (p.buffering && s === YTS.PLAYING) {
      // buffered: back to the start second, paused, silent until the handover
      p.buffering = false; p.buffered = true;
      p.yt.pause(); p.yt.seek(p.at);
      return;
    }
    if (swap && i === swap.to && s === YTS.PLAYING) { finishSwap(); return; }
    if (i === a && !swap && !p.buffering) {
      if (performance.now() < p.quietUntil) return;
      onState(s);
    }
  }

  /** Buffers video `vid` at second `at` in the hidden player (nothing if it already is). */
  function prepare(vid, at) {
    if (!alive || swap) return;
    const i = hidden(), p = P[i];
    if (p && p.vid === vid && Math.abs(p.at - at) < NEAR_S && (p.buffered || p.buffering)) return;
    const q = p ?? make(i, vid, at, { muted: true }); // an existing hidden player is reused (cue), not rebuilt
    q.vid = vid; q.at = at; q.buffered = false; q.buffering = true;
    q.yt.ready.then(() => {
      if (P[i] !== q || !q.buffering) return;
      q.yt.mute();
      if (q.yt.videoId !== vid) q.yt.cue(vid, at); else q.yt.seek(at);
      q.yt.play();
    }).catch(() => { q.buffering = false; });
  }

  /** Is the hidden player buffered at (vid, at)? */
  const ready = (vid, at) => { const p = P[hidden()]; return !!(p && p.buffered && p.vid === vid && Math.abs(p.at - at) < NEAR_S); };

  /**
   * Starts the hidden player (buffered or not) at (vid, at) and changes over as soon as it plays. The visible player plays on until
   * then; from a gap the black layer stays until then.
   */
  function handover(vid, at) {
    if (!alive || swap) return;
    const to = hidden(), buffered = ready(vid, at);
    if (!P[to]) make(to, vid, at, { muted: true });
    const p = P[to];
    p.vid = vid; p.at = at; p.buffering = false;
    swap = { to, vid, at, asked: performance.now(), buffered, from: P[a]?.vid ?? null, fromBlack: !black.hidden };
    p.yt.ready.then(() => {
      if (!swap || swap.to !== to) return;
      p.yt.setVolume(0); p.yt.unMute();
      if (buffered || p.yt.videoId === vid) { if (!buffered) p.yt.seek(at); p.yt.play(); }
      else p.yt.load(vid, at);
    });
  }

  function finishSwap() {
    const s = swap, from = a, p = P[s.to], q = P[from];
    swap = null;
    const ms = performance.now() - s.asked;
    if (s.buffered) latency = latency == null ? ms / 1000 : latency * 0.7 + (ms / 1000) * 0.3;
    a = s.to;
    p.buffered = false;
    setVisible(a);
    const wasBlack = !black.hidden;
    black.hidden = true;
    // sound crossfade; the old player stops once the picture has faded over
    clearInterval(fadeTimer);
    const t0 = performance.now();
    fadeTimer = setInterval(() => {
      const f = Math.min(1, (performance.now() - t0) / FADE_MS);
      p.yt.setVolume(Math.round(volume * f));
      if (q && !wasBlack) q.yt.setVolume(Math.round(volume * (1 - f)));
      if (f >= 1) {
        clearInterval(fadeTimer);
        if (q && q.yt.state() === YTS.PLAYING) { quiet(q); q.yt.pause(); }
        q?.yt.setVolume(volume);
        if (q) q.buffered = false;
      }
    }, 30);
    log({ from: s.from, to: s.vid, at: s.at, buffered: s.buffered, start_ms: Math.round(ms), from_black: s.fromBlack, latency_s: latency });
    onSwap(s.vid);
    setTimeout(() => { if (alive && P[a] === p) onMuted(p.yt.isMuted()); }, 600);
  }

  /** Shows (vid, at) at once in the visible player (a seek): the buffered hidden one if it fits, else the visible one loads it. */
  function show(vid, at, { play = false } = {}) {
    if (!alive) return;
    if (swap) { const p = P[swap.to]; swap = null; quiet(p); p.yt.pause(); }
    black.hidden = true;
    if (ready(vid, at)) {
      const old = P[a];
      a = hidden(); setVisible(a);
      const p = P[a];
      p.buffered = false; p.yt.unMute(); p.yt.setVolume(volume); p.yt.seek(at);
      if (play) p.yt.play();
      if (old?.yt.state() === YTS.PLAYING) { quiet(old); old.yt.pause(); }
      return;
    }
    let p = P[a];
    if (!p) { p = make(a, vid, at, { muted: false }); setVisible(a); }
    p.vid = vid; p.at = at;
    p.yt.ready.then(() => {
      if (P[a] !== p) return;
      p.yt.unMute(); p.yt.setVolume(volume);
      if (p.yt.videoId !== vid) { quiet(p); if (play) p.yt.load(vid, at); else p.yt.cue(vid, at); }
      else { p.yt.seek(at); if (play) { quiet(p); p.yt.play(); } }
    });
    setVisible(a);
  }

  /** Gap: both players paused under the black layer. */
  function setBlack(on) {
    if (on && swap) return; // a handover out of the gap is under way; it lifts the black layer itself
    black.hidden = !on;
    if (on) for (const p of P) if (p && !p.buffering && p.yt.state() === YTS.PLAYING) { quiet(p); p.yt.pause(); }
  }

  const vis = () => P[a];
  return {
    prepare, ready, handover, show,
    black: setBlack,
    isBlack: () => !black.hidden,
    swapping: () => !!swap,
    latency: () => latency,
    /** The visible player's video id and time, or null. */
    current: () => (vis() ? { vid: vis().vid, t: vis().yt.time(), state: vis().yt.state() } : null),
    play: () => { const p = vis(); if (p && black.hidden) { quiet(p); p.yt.unMute(); p.yt.play(); } },
    pause: () => { for (const p of P) if (p && !p.buffering && p.yt.state() === YTS.PLAYING) { quiet(p); p.yt.pause(); } if (swap) swap = null; },
    unMute: () => vis()?.yt.unMute(),
    /** Called inside a user gesture (the first play): lets both players start with sound later where the browser asks for one (iOS). */
    unlock: () => { for (const p of P) if (p && p !== vis() && !p.buffering) { p.yt.play(); quiet(p); p.yt.pause(); } },
    destroy() { alive = false; clearInterval(fadeTimer); for (const p of P) p?.yt.destroy(); slot.classList.remove('deck'); },
  };
}
