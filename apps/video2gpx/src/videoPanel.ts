import { api } from "./api";
import { initRidePanel } from "./ridePanel";
import { S, bus } from "./state";
import type { ProjectApp } from "./types";
import { el } from "./util";

export interface Player {
  readonly time: number; readonly duration: number; readonly playing: boolean; readonly kind: "video" | "frames";
  play(): void; pause(): void; seek(t: number): void; destroy(): void;
}

class VideoPlayer implements Player {
  kind = "video" as const;
  constructor(private v: HTMLVideoElement) { v.addEventListener("seeked", this.onSeeked); }
  get time() { return this.pending ?? this.v.currentTime; }
  get duration() { return isFinite(this.v.duration) ? this.v.duration : 0; }
  get playing() { return !this.v.paused && !this.v.ended; }
  play() { void this.v.play().catch(() => {}); }
  pause() { this.v.pause(); }
  // one seek at a time, the newest target wins: dragging on a seek bar asks for dozens per second
  private pending: number | null = null;
  private onSeeked = () => { if (this.pending != null) { const t = this.pending; this.pending = null; this.v.currentTime = t; } };
  seek(t: number) {
    t = Math.max(0, Math.min(this.duration || t, t));
    if (this.v.seeking) { this.pending = t; return; }
    this.v.currentTime = t;
  }
  destroy() { this.v.removeEventListener("seeked", this.onSeeked); this.pending = null; this.v.pause(); this.v.removeAttribute("src"); this.v.load(); }
}

/** Fallback for formats the web view cannot decode: JPEG frames extracted with ffmpeg, played on a wall clock. */
class FramePlayer implements Player {
  kind = "frames" as const;
  private t = 0; private on = false; private last = 0; private idx = -1;
  constructor(private img: HTMLImageElement, private urls: string[], private times: number[], public duration: number) {
    this.seek(0);
  }
  get time() {
    if (this.on) {
      const now = performance.now();
      this.t = Math.min(this.duration, this.t + (now - this.last) / 1000);
      this.last = now;
      if (this.t >= this.duration) this.on = false;
      this.show();
    }
    return this.t;
  }
  get playing() { return this.on; }
  play() { this.last = performance.now(); this.on = true; }
  pause() { this.time; this.on = false; }
  seek(t: number) { this.t = Math.max(0, Math.min(this.duration, t)); this.last = performance.now(); this.show(); }
  private show() {
    let lo = 0, hi = this.times.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.times[m] <= this.t) lo = m; else hi = m - 1; }
    if (lo !== this.idx) { this.idx = lo; this.img.src = this.urls[lo]; }
  }
  destroy() { this.on = false; }
}

let player: Player | null = null;
export const getPlayer = () => player;

let stage: HTMLElement, msgEl: HTMLElement;
let loadToken = 0;

/** Builds the video region of the project workspace once: the player (or the frame fallback), its message and the ride readouts. */
export function initVideoPanel(root: HTMLElement) {
  stage = el("div", { class: "stage" });
  msgEl = el("div", { class: "banner warn vmsg", hidden: true });
  const rideEl = el("div", { class: "ride" });
  root.append(stage, msgEl, rideEl);
  initRidePanel(rideEl);
  bus.on("project", (app: ProjectApp | null) => void loadVideo(app));
  bus.on("video", (app: ProjectApp | null) => void loadVideo(app));
  bus.on("seek", (t: number) => { player?.seek(t); });
  requestAnimationFrame(tick);
}

/** length of the video in seconds (player, else the probe, else the last route point) */
export const videoDuration = () => player?.duration || S.cur?.app.probe?.duration || S.result?.points.at(-1)?.t || 0;

export function togglePlay() {
  if (!player) return;
  if (player.playing) player.pause(); else player.play();
}
export function seekTo(t: number) {
  if (!player) return;
  player.seek(t);
  bus.emit("seeked");
}

let lastT = -1, lastPlaying = false;
function tick() {
  if (player) {
    const t = player.time;
    if (Math.abs(t - lastT) > 0.01) { lastT = t; bus.emit("time", t); }
    if (player.playing !== lastPlaying) { lastPlaying = player.playing; bus.emit("playstate", lastPlaying); }
  }
  requestAnimationFrame(tick);
}

function showMsg(text: string | null, kind: "warn" | "info" = "warn") {
  msgEl.hidden = !text;
  msgEl.className = `banner ${kind} vmsg`;
  msgEl.textContent = text ?? "";
}

async function loadVideo(app: ProjectApp | null) {
  const token = ++loadToken;
  player?.destroy(); player = null; lastT = -1;
  stage.replaceChildren(); showMsg(null);
  bus.emit("player");
  if (!app || !app.video) return;
  const p = app.probe;

  const v = el("video", { preload: "metadata", playsInline: true, controls: false, disablePictureInPicture: true, tabIndex: -1, "aria-label": "Video" });
  v.addEventListener("click", togglePlay);
  if (app.poster) v.poster = api.fileUrl(app.poster);
  stage.append(v);
  let settled = false;
  const fallback = (why: string) => {
    if (settled || token !== loadToken) return;
    settled = true;
    v.remove();
    void useFrames(app, why, token);
  };
  v.addEventListener("loadedmetadata", () => {
    if (settled || token !== loadToken) return;
    if (!v.videoWidth) return fallback("Das Video hat keine abspielbare Bildspur.");
    settled = true;
    player = new VideoPlayer(v); bus.emit("player");
  });
  v.addEventListener("error", () => fallback(`Das Videoformat (${[p?.container, p?.codec, p?.hdr ? "HDR" : null].filter(Boolean).join(", ") || "unbekannt"}) kann die App nicht abspielen.`));
  // WebM/MKV: played from a one-time MP4 copy (WebKit reads WebM whole into memory and the app hangs)
  const slow = setTimeout(() => { if (token === loadToken) showMsg("Das Video wird einmalig für die Wiedergabe vorbereitet (ohne Neukodierung, etwa 1 Minute pro 45 Minuten Video) …", "info"); }, 500);
  let file: string;
  try {
    file = await api.videoPlayback(app.id, app.video, p?.codec ?? "");
  } catch (e) {
    clearTimeout(slow);
    return fallback(String(e));
  }
  clearTimeout(slow);
  if (token !== loadToken) return;
  showMsg(null);
  setTimeout(() => { if (!settled) fallback("Das Video lässt sich nicht öffnen (Zeitüberschreitung)."); }, 10000);
  // served by the local media server, not asset://: asset responses are copied on the window's main thread
  // and freeze the app every few seconds with large videos
  api.mediaUrl(file).then((u) => { if (token === loadToken) v.src = u; }, (e) => fallback(String(e)));
}

async function useFrames(app: ProjectApp, why: string, token: number) {
  showMsg(`${why} Stattdessen werden Einzelbilder aus dem Video gezeigt (alle 5 s, mit ffmpeg erzeugt) …`, "warn");
  const img = el("img", { class: "frame", alt: "Videobild" });
  if (app.poster) img.src = api.fileUrl(app.poster);
  stage.append(img);
  try {
    const r = await api.videoFrames(app.id, app.video!, 5, !!app.probe?.hdr);
    if (token !== loadToken) return;
    const urls = r.times.map((_, i) => api.fileUrl(`${r.dir}/f${String(i + 1).padStart(5, "0")}.jpg`));
    const d = Math.max(app.probe?.duration ?? 0, r.times[r.times.length - 1] + 5);
    player = new FramePlayer(img, urls, r.times, d);
    showMsg(`${why} Es werden ${r.times.length} Einzelbilder (alle 5 s) gezeigt; Position und Karte bleiben synchron.`, "warn");
    bus.emit("player");
  } catch (e) {
    if (token !== loadToken) return;
    showMsg(`${why} Auch die Einzelbilder konnten nicht erzeugt werden (${e}). Es bleibt das Vorschaubild.`, "warn");
  }
}
