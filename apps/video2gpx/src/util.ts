import type { Bbox, RoutePoint } from "./types";

type Child = Node | string | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, any> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") (e as any).value = v;
    else if (k in e && k !== "list" && k !== "style") (e as any)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(c));
  return e;
}

export const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export function fmtDur(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(x).padStart(2, "0");
}

export function fmtEta(s?: number): string {
  if (s === undefined || !isFinite(s)) return "";
  if (s < 90) return `noch ca. ${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `noch ca. ${Math.round(s / 60)} Min.`;
  return `noch ca. ${(s / 3600).toFixed(1).replace(".", ",")} Std.`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return "?";
  if (b < 1e6) return `${Math.round(b / 1e3)} kB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0).replace(".", ",")} MB`;
  return `${(b / 1e9).toFixed(2).replace(".", ",")} GB`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const KM_PER_DEG = 111.32;

export function bboxSizeKm(b: Bbox): { w: number; h: number; diag: number } {
  const lat = (b[0] + b[2]) / 2;
  const h = (b[2] - b[0]) * 111.2;
  const w = (b[3] - b[1]) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  return { w, h, diag: Math.hypot(w, h) };
}

export function fmtSize(b: Bbox): string {
  const { w, h } = bboxSizeKm(b);
  const f = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x))).replace(".", ",");
  return `${f(w)} × ${f(h)} km`;
}

export function squareAround(lat: number, lon: number, halfKm: number): Bbox {
  const dLat = halfKm / 111.2;
  const dLon = halfKm / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

export function bboxCovers(outer: Bbox, inner: Bbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

/** Position and heading at video second t (linear interpolation, heading along the short way). */
export function pointAt(pts: RoutePoint[], t: number): RoutePoint {
  if (t <= pts[0].t) return pts[0];
  const last = pts[pts.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  let dh = ((b.heading - a.heading + 540) % 360) - 180;
  return {
    ...a, t, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f,
    heading: (a.heading + dh * f + 360) % 360, confidence: a.confidence + (b.confidence - a.confidence) * f,
  };
}

/** The route point at arc length s (m along the route, linear between the per-second points); null before the first or after the last decoded point. */
export function pointAtArc(pts: RoutePoint[], s: number): RoutePoint | null {
  let lo = -1, hi = -1;
  for (let i = 0; i < pts.length; i++) if (!pts[i].extrapolated && pts[i].arc_m !== undefined) { if (lo < 0) lo = i; hi = i; }
  if (lo < 0 || s < pts[lo].arc_m! || s > pts[hi].arc_m!) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const m = pts[mid];
    if (m.arc_m === undefined || m.extrapolated) { hi = mid; continue; } // (extrapolated points only sit at the ends)
    if (m.arc_m <= s) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const f = b.arc_m! > a.arc_m! ? (s - a.arc_m!) / (b.arc_m! - a.arc_m!) : 0;
  return { ...a, t: a.t + (b.t - a.t) * f, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, arc_m: s };
}

/** Nearest route point to a lat/lon (equirectangular). */
export function nearestPoint(pts: RoutePoint[], lat: number, lon: number): { p: RoutePoint; dM: number } {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = pts[0], bd = Infinity;
  for (const p of pts) {
    const dx = (p.lon - lon) * kx, dy = p.lat - lat, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = p; }
  }
  return { p: best, dM: Math.sqrt(bd) * 111200 };
}

export type ConfClass = "high" | "mid" | "low" | "none";
export const CONF_COLORS: Record<ConfClass, string> = { high: "#2563eb", mid: "#e0a100", low: "#8d8d87", none: "#bdbdb6" };
export function confClass(p: { confidence: number; extrapolated?: boolean }): ConfClass {
  if (p.extrapolated) return "none";
  return p.confidence >= 0.9 ? "high" : p.confidence >= 0.5 ? "mid" : "low";
}

export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(+d)) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(+d) ? null : d.toISOString().replace(/\.\d+Z$/, "Z");
}

export function debounce<A extends any[]>(fn: (...a: A) => void, ms: number) {
  let t: any;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const VIDEO_EXT = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "ts", "mpg", "mpeg"];
export const isImagePath = (p: string) => /\.(png|jpe?g|webp|heic|gif|bmp|tiff?)$/i.test(p);
export const isVideoPath = (p: string) => VIDEO_EXT.includes(p.split(".").pop()?.toLowerCase() ?? "");

/** "heute 08:12", else "08.11." (this year) or "08.11.2025" */
export function fmtDay(ms: number): string {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return `heute ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString("de-DE", d.getFullYear() === now.getFullYear() ? { day: "2-digit", month: "2-digit" } : { day: "2-digit", month: "2-digit", year: "numeric" });
}

export const fmtKm = (km: number) => `${km.toFixed(1).replace(".", ",")} km`;

/** Clipboard with a fallback for web views without the async clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = el("textarea", { value: text, style: "position:fixed;opacity:0", "aria-hidden": "true", tabIndex: -1 });
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
