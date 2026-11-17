// Speed and the local elevation profile (about ±100 m around the current position) under the video, following playback.
import { E, loadDem, loadElevation, missingBytes } from "./elevation";
import { S, bus } from "./state";
import type { ElevationProfile, RoutePoint } from "./types";
import { token } from "./app/theme";
import { el, pointAt } from "./util";

const HALF_M = 100;         // the profile shows this many metres before and after the position
const MIN_SPAN_M = 12;      // vertical scale at least this many metres, so a flat road looks flat
const GRADE_M = 20;         // grade over ±this many metres

let root: HTMLElement, speedEl: HTMLElement, gradeEl: HTMLElement, eleEl: HTMLElement, canvas: HTMLCanvasElement, graphEl: HTMLElement;
let profile: ElevationProfile | null = null;
/** why there is no profile (shown in the elevation track of the timeline). The elevation data are loaded in the Höhe stage; the note links there.
 *  `extra`: a profile exists, but more detailed national / regional elevation data could be loaded for the route */
export interface ProfileNote { text: string; bytes?: number; busy?: boolean; extra?: boolean }
let note: ProfileNote | null = null;
export const rideState = () => ({ profile, note });
let lastT = -1;
let lastResult: unknown = null;

export function initRidePanel(container: HTMLElement) {
  root = container;
  speedEl = el("div", { class: "ride-v mono" }, "–");
  gradeEl = el("div", { class: "ride-v mono" }, "–");
  eleEl = el("div", { class: "ride-v mono" }, "–");
  canvas = el("canvas", { class: "ride-profile", height: 64, role: "img", "aria-label": "Höhenprofil 100 m vor und hinter der Position" });
  const box = (v: HTMLElement, label: string) => el("div", { class: "ride-box" }, v, el("div", { class: "ride-l" }, label));
  root.append(el("div", { class: "ride-vals" }, box(speedEl, "km/h"), box(gradeEl, "Steigung"), box(eleEl, "Höhe")),
    graphEl = el("div", { class: "ride-graph" }, canvas));
  root.hidden = true;
  bus.on("result", () => { if (S.result !== lastResult) { lastResult = S.result; void load(); } else sync(); });
  bus.on("project", () => { lastResult = null; profile = null; note = null; root.hidden = true; lastT = -1; bus.emit("profile"); });
  bus.on("elevation", sync);
  window.addEventListener("themechange", () => draw(lastT < 0 ? 0 : lastT));
  bus.on("time", (t: number) => { if (Math.abs(t - lastT) > 0.05) { lastT = t; draw(t); } });
  new ResizeObserver(() => draw(lastT < 0 ? 0 : lastT)).observe(canvas);
}

/** the profile of the open result (computed when the Copernicus tiles are there); more detailed sources are only offered, never loaded here */
async function load() {
  if (!S.cur || !S.result?.points.length) { sync(); return; }
  await loadElevation();
  if (E.state === "ready" && !E.dem) await loadDem(false);
}

/** the playback panel and the timeline follow the shared elevation state (elevation.ts) */
function sync() {
  if (!S.cur || !S.result?.points.length) { root.hidden = true; profile = null; setNote(null); return; }
  root.hidden = false;
  profile = E.profile;
  if (E.state === "computing" || E.state === "loading" || E.state === "idle") setNote({ text: "Höhenprofil wird berechnet …", busy: true });
  else if (E.state === "missing") setNote({ text: "Höhendaten fehlen", bytes: missingBytes() });
  else if (E.state === "error") setNote({ text: `Höhenprofil nicht verfügbar${E.error ? `: ${E.error}` : ""}` });
  else {
    const x = E.dem?.extras;
    const names = x?.missing_blocks ? Object.values(x.sources).filter((s) => s.kind !== "mask" && s.missing > 0).map((s) => s.title.replace(/ \(.*\)$/, "")) : [];
    setNote(names.length && !E.dl.running ? { text: `Genauere Höhendaten verfügbar: ${names.join(", ")}`, bytes: x!.missing_bytes, extra: true } : null);
  }
}

function setNote(n: ProfileNote | null) {
  note = n;
  graphEl.hidden = !profile;
  bus.emit("profile");
  draw(lastT < 0 ? 0 : lastT);
}

/** arc length (m along the route) at time t; NaN outside the recognised part */
function arcAt(pts: RoutePoint[], t: number): number {
  const p = pointAt(pts, t);
  return p.extrapolated || p.arc_m === undefined ? NaN : p.arc_m;
}

/** speed in km/h, from the arc over ±1.5 s (positions are per second) */
export function speedAt(pts: RoutePoint[], t: number): number {
  const a = arcAt(pts, t - 1.5), b = arcAt(pts, t + 1.5);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 3) * 3.6 : NaN;
}

/** elevation at arc s from the profile (linear between samples) */
export function zAt(pr: ElevationProfile, s: number): number {
  const x = (s - pr.s0) / pr.ds;
  const i = Math.max(0, Math.min(pr.z.length - 2, Math.floor(x)));
  const f = Math.max(0, Math.min(1, x - i));
  return pr.z[i] * (1 - f) + pr.z[i + 1] * f;
}

function draw(t: number) {
  if (root.hidden) return;
  const pts = S.result?.points;
  if (!pts?.length) return;
  const v = speedAt(pts, t);
  speedEl.textContent = Number.isFinite(v) ? v.toFixed(0) : "–";
  const s = arcAt(pts, t);
  const pr = profile;
  const ok = !!pr && Number.isFinite(s);
  if (ok) {
    const z = zAt(pr!, s);
    const g = (zAt(pr!, s + GRADE_M) - zAt(pr!, s - GRADE_M)) / (2 * GRADE_M) * 100;
    eleEl.textContent = `${z.toFixed(0)} m`;
    gradeEl.textContent = `${g >= 0.5 ? "+" : ""}${g.toFixed(Math.abs(g) < 10 ? 1 : 0).replace(".", ",")} %`;
  } else {
    eleEl.textContent = "–"; gradeEl.textContent = "–";
  }
  // canvas
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(rect.width * dpr)), h = Math.round(64 * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext("2d")!;
  c.clearRect(0, 0, w, h);
  if (!ok) return;
  const fg = token("--c-text", "#222"), muted = token("--c-text-2", "#888"), accent = token("--c-accent", "#2a6fdb");
  const n = 80, xs: number[] = [], zs: number[] = [];
  const end = pr!.s0 + pr!.ds * (pr!.z.length - 1);
  for (let i = 0; i <= n; i++) {
    const si = s - HALF_M + (2 * HALF_M * i) / n;
    xs.push(si); zs.push(si < pr!.s0 || si > end ? NaN : zAt(pr!, si));
  }
  const fin = zs.filter(Number.isFinite);
  let lo = Math.min(...fin), hi = Math.max(...fin);
  if (hi - lo < MIN_SPAN_M) { const m = (hi + lo) / 2; lo = m - MIN_SPAN_M / 2; hi = m + MIN_SPAN_M / 2; }
  const pad = 6 * dpr, X = (i: number) => (i / n) * w, Y = (z: number) => h - pad - ((z - lo) / (hi - lo)) * (h - 2 * pad);
  // filled area: behind (muted) and ahead (accent)
  for (const [from, to, col] of [[0, n / 2, muted], [n / 2, n, accent]] as const) {
    c.beginPath();
    let started = false;
    for (let i = from; i <= to; i++) {
      if (!Number.isFinite(zs[i])) continue;
      if (!started) { c.moveTo(X(i), h); started = true; }
      c.lineTo(X(i), Y(zs[i]));
    }
    if (!started) continue;
    let last = to; while (last > from && !Number.isFinite(zs[last])) last--;
    c.lineTo(X(last), h); c.closePath();
    c.globalAlpha = 0.25; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
  }
  c.beginPath();
  let pen = false;
  for (let i = 0; i <= n; i++) {
    if (!Number.isFinite(zs[i])) { pen = false; continue; }
    if (!pen) { c.moveTo(X(i), Y(zs[i])); pen = true; } else c.lineTo(X(i), Y(zs[i]));
  }
  c.strokeStyle = fg; c.lineWidth = 1.5 * dpr; c.stroke();
  // current position
  c.fillStyle = accent;
  c.fillRect(Math.round(w / 2 - dpr), 0, 2 * dpr, h);
  c.beginPath(); c.arc(w / 2, Y(zs[n / 2]), 3.5 * dpr, 0, 2 * Math.PI); c.fill();
  // labels
  c.fillStyle = muted; c.font = `${10 * dpr}px system-ui, sans-serif`;
  c.textBaseline = "top"; c.fillText(`−${HALF_M} m`, 3 * dpr, 2 * dpr);
  c.textAlign = "right"; c.fillText(`+${HALF_M} m`, w - 3 * dpr, 2 * dpr);
  c.fillText(`${(hi - lo).toFixed(0)} m Höhe`, w - 3 * dpr, h - 13 * dpr); c.textAlign = "left";
}
