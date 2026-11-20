// The ridrs Scenic round trip (docs/FEATURE_atlas.md; contract: pov-atlas VIDEO2GPX-INTEGRATION.md section 8).
// Pure functions, no DOM and no api: a job file (<id>.v2g.json) becomes the hints of a new project, the "ridrs Scenic" checklist of the
// Export stage is computed from the result, and the payload <id>.scenic.json is built from it. Tested in tests/atlas/atlas.test.ts
// against the example job and payload the atlas tests use too (tests/atlas/fixtures/, byte-identical copies).
import type { Bbox, RoutePoint, Vehicle, Verdict } from "./types";

/** a box as the atlas writes it */
export interface AtlasBox { south: number; west: number; north: number; east: number }
/** the job of one atlas video (contract 8.1): exactly these fields */
export interface AtlasJob {
  video_id: string; url: string; title: string | null; channel: string | null; duration_s: number | null; fps: number | null;
  country: string | null; vehicle: string | null;
  /** URL of the atlas route (OSM geometry) or null */
  route_gpx: string | null;
  /** 4 = route confirmed, 5 = approximate, null without a route */
  route_level: 4 | 5 | null;
  bbox: AtlasBox | null; start_bbox: AtlasBox | null; end_bbox: AtlasBox | null;
  atlas: { base: string; video_id: string };
}

export type AtlasCheckId = "verdict" | "coverage" | "route_agreement" | "cuts" | "intro_outro" | "viewed";
/** what the user did in the Atlas panel (kept in app.json, so ticks and notes survive a restart) */
export interface AtlasQcState {
  /** the result the list was filled in for (resultSig of route_points.json): a new result starts the list fresh */
  result: string | null;
  t_start: number | null; t_end: number | null;
  /** an explicit override per check: the note why it is fine anyway */
  overrides: Partial<Record<AtlasCheckId, string>>;
  /** start times of the pieces between scene cuts that were checked in the Analyse stage */
  cuts_checked: number[];
  viewed: { start: boolean; turn: boolean; end: boolean };
  /** a note for the atlas (qc.note) */
  note: string;
}
/** app.json `atlas`: the job the project was created from, and the state of the checklist */
export interface AtlasLink { base: string; video_id: string; job: AtlasJob; qc?: AtlasQcState | null; written?: { path: string; at: number } | null }

/** route hint corridor by atlas route level (plan section 2): 300 m for a confirmed route, 1 km for an approximate one */
export const HINT_BUFFER_M: Record<4 | 5, number> = { 4: 300, 5: 1000 };
/** coverage rule (plan section 3) */
export const MIN_COVERAGE = 0.9;
export const MAX_GAP_S = 60;
/** route agreement: shown green up to this median distance, never blocking */
export const ROUTE_AGREE_M = 50;
/** fastest plausible step between two points (m/s, 252 km/h): ridrs Scenic refuses a faster one unless a cut lies within 1 s of it */
export const MAX_SPEED_MS = 70;
const AGREEMENT_SAMPLES = 600;
const M_PER_DEG = 111320;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

function box(x: unknown, name: string): AtlasBox | null {
  if (x == null) return null;
  const b = x as AtlasBox;
  if (typeof x !== "object" || ![b.south, b.west, b.north, b.east].every(isNum) || !(b.south < b.north && b.west < b.east) || Math.abs(b.south) > 90 || Math.abs(b.north) > 90 || Math.abs(b.west) > 180 || Math.abs(b.east) > 180)
    throw new Error(`Die Job-Datei hat einen ungültigen Rahmen (${name}).`);
  return { south: b.south, west: b.west, north: b.north, east: b.east };
}

/** Reads a job file. Throws an Error with a German message when it is not an atlas job. */
export function parseJob(text: string): AtlasJob {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error("Die Datei ist kein JSON."); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("Das ist keine Job-Datei von ridrs Scenic.");
  if (typeof j.video_id !== "string" || !/^[\w-]{11}$/.test(j.video_id)) throw new Error("Die Job-Datei hat keine gültige Video-ID.");
  if (typeof j.url !== "string" || !/^https:\/\/[^\s]+$/.test(j.url)) throw new Error("Die Job-Datei hat keine Videoadresse.");
  const link = j.scenic ?? j.atlas; // "atlas" = jobs written before the rename
  if (!link || typeof link.base !== "string" || !/^https?:\/\/[^\s/]+/.test(link.base) || link.video_id !== j.video_id) throw new Error("Die Job-Datei hat keinen Verweis auf ridrs Scenic.");
  const level = j.route_level == null ? null : j.route_level === 4 || j.route_level === 5 ? j.route_level : NaN;
  if (Number.isNaN(level)) throw new Error("Die Job-Datei hat eine unbekannte Routenstufe.");
  if (j.route_gpx != null && (typeof j.route_gpx !== "string" || !/^https?:\/\/[^\s]+$/.test(j.route_gpx))) throw new Error("Die Job-Datei hat eine ungültige Routenadresse.");
  const s = (x: unknown) => (typeof x === "string" ? x : null), n = (x: unknown) => (isNum(x) ? x : null);
  return {
    video_id: j.video_id, url: j.url, title: s(j.title), channel: s(j.channel), duration_s: n(j.duration_s), fps: n(j.fps), country: s(j.country), vehicle: s(j.vehicle),
    route_gpx: s(j.route_gpx), route_level: j.route_gpx ? (level as 4 | 5 | null) ?? 5 : null,
    bbox: box(j.bbox, "bbox"), start_bbox: box(j.start_bbox, "start_bbox"), end_bbox: box(j.end_bbox, "end_bbox"),
    atlas: { base: link.base.replace(/\/+$/, ""), video_id: j.video_id }, // internal name; the file says "scenic"
  };
}

export const toBbox = (b: AtlasBox): Bbox => [b.south, b.west, b.north, b.east];
const inside = (a: Bbox, b: Bbox) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

/** the atlas vehicle as the app's soft prior (P4): car, motorcycle and bike as they are, everything else automatic */
export function jobVehicle(v: string | null): Vehicle {
  const x = (v ?? "").toLowerCase();
  if (x === "car") return "car";
  if (["motorcycle", "motorbike", "moto"].includes(x)) return "motorcycle";
  if (["bike", "bicycle", "cycling"].includes(x)) return "bike";
  return "auto";
}

/** what a job sets in a new project: the hints the app already has (P9), the vehicle, the atlas link */
export interface JobPlan {
  name: string; url: string; bbox: Bbox | null; start_frame: Bbox | null; end_frame: Bbox | null; vehicle: Vehicle;
  /** route hint to download; null without an atlas route */
  hint: { url: string; name: string; buffer_m: number } | null;
  atlas: AtlasLink;
}
export function jobPlan(job: AtlasJob): JobPlan {
  const bbox = job.bbox ? toBbox(job.bbox) : null;
  // start / end frames only for a confirmed route (level 4), and only inside the search frame (the setup rule)
  const frame = (b: AtlasBox | null) => (job.route_level === 4 && b && bbox && inside(toBbox(b), bbox) ? toBbox(b) : null);
  return {
    name: job.title ?? job.video_id, url: job.url, bbox, start_frame: frame(job.start_bbox), end_frame: frame(job.end_bbox), vehicle: jobVehicle(job.vehicle),
    hint: job.route_gpx && job.route_level ? { url: job.route_gpx, name: `${job.video_id}.gpx`, buffer_m: HINT_BUFFER_M[job.route_level] } : null,
    atlas: { base: job.atlas.base, video_id: job.video_id, job, qc: null, written: null },
  };
}

// ---------------------------------------------------------------- checklist

/** RoutePoint plus what route_points.json carries per point */
export type AtlasPoint = RoutePoint & { motion_state?: string };
/** first and last driving second: the first and last decoded (not extrapolated) point after the intro */
export function defaultSpan(points: AtlasPoint[], introEnd: number | null): { t_start: number | null; t_end: number | null } {
  const ok = points.filter((p) => !p.extrapolated && (introEnd == null || p.t > introEnd));
  return { t_start: ok[0]?.t ?? null, t_end: ok.at(-1)?.t ?? null };
}
export const freshQc = (points: AtlasPoint[], introEnd: number | null, result: string | null = null): AtlasQcState => ({ result, ...defaultSpan(points, introEnd), overrides: {}, cuts_checked: [], viewed: { start: false, turn: false, end: false }, note: "" });

/** signature of a result: SHA-256 (hex) of the text of route_points.json */
export async function resultSig(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** the checklist for this result: the saved one when it was filled in for the same result, else a fresh one (span from the result, no
 *  overrides, nothing ticked), so ticks of an earlier result never pass a new one. Only the free note for the atlas is carried over. */
export function qcFor(prev: AtlasQcState | null | undefined, result: string, points: AtlasPoint[], introEnd: number | null): AtlasQcState {
  if (prev && prev.result === result) return prev;
  return { ...freshQc(points, introEnd, result), note: prev?.note ?? "" };
}

/** the points that go to the atlas: one per video second between t_start and t_end, without extrapolated ones */
export const payloadPoints = (points: AtlasPoint[], t0: number, t1: number) => points.filter((p) => p.t >= t0 && p.t <= t1 && !p.extrapolated);

const inStill = (t: number, st: [number, number][]) => st.some(([a, b]) => t >= a && t <= b);
/** share of the driving seconds (outside sure standstills) with a measured position (not in a gap), and the longest run without one */
export function coverageOf(points: AtlasPoint[], standstills: [number, number][]): { share: number; max_gap_s: number; driving_s: number } {
  let driving = 0, have = 0, gap = 0, maxGap = 0;
  for (const p of points) {
    if (p.motion_state === "standstill" || inStill(p.t, standstills)) continue;
    driving++;
    if (!p.in_gap && !p.extrapolated) { have++; gap = 0; } else { gap++; maxGap = Math.max(maxGap, gap); }
  }
  return { share: driving ? r(have / driving, 4) : 0, max_gap_s: maxGap, driving_s: driving };
}

const distM = (a: [number, number], b: [number, number]) => { const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180); return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG; };
/** distance of p [lon, lat] to a line [[lon, lat], …] in metres */
function lineDist(line: [number, number][], p: [number, number]): number {
  let best = Infinity;
  const k = Math.cos((p[1] * Math.PI) / 180);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const ax = (b[0] - a[0]) * k, ay = b[1] - a[1], px = (p[0] - a[0]) * k, py = p[1] - a[1];
    const l2 = ax * ax + ay * ay, f = l2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - f * ax, py - f * ay) * M_PER_DEG);
  }
  return best;
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
/** median and max distance of the driving line c [[lon, lat]] to the atlas route (hint lines [lat, lon]); the atlas computes it the same way */
export function routeAgreement(c: [number, number][], hintLines: [number, number][][] | null): { median_m: number; max_m: number } | null {
  const lines = (hintLines ?? []).filter((l) => l.length > 1).map((l) => l.map(([la, lo]) => [lo, la] as [number, number]));
  if (!lines.length || !c.length) return null;
  const step = Math.max(1, c.length / AGREEMENT_SAMPLES), d: number[] = [];
  for (let i = 0; i < c.length; i += step) { const p = c[Math.floor(i)]; d.push(Math.min(...lines.map((l) => lineDist(l, p)))); }
  return { median_m: r(median(d), 1), max_m: r(Math.max(...d), 1) };
}
/** the pieces between the scene cuts inside the span: [start, end] in video seconds */
export function cutPieces(cutTimes: number[], t0: number, t1: number): [number, number][] {
  const cuts = cutTimes.filter((c) => c > t0 && c < t1).sort((a, b) => a - b);
  const edges = [t0, ...cuts, t1];
  return edges.slice(1).map((b, i) => [edges[i], b]);
}

/** a step faster than MAX_SPEED_MS with no detected cut within 1 s: a cut the scene detection missed, marked at the middle of the step */
export interface JumpCut { t: number; from: number; to: number; m: number }
const nearCut = (cuts: number[], a: number, b: number) => cuts.some((x) => x >= a - 1 && x <= b + 1);
/** the jumps of the payload track between t0 and t1 (the points rounded as the payload writes them, measured as ridrs Scenic measures) */
export function jumpCuts(points: AtlasPoint[], cutTimes: number[], t0: number, t1: number): JumpCut[] {
  const pts = payloadPoints(points, t0, t1).map((p) => ({ t: r(p.t, 3), c: [r(p.lon, 6), r(p.lat, 6)] as [number, number] }));
  const out: JumpCut[] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], m = distM(a.c, b.c);
    if (m / (b.t - a.t) > MAX_SPEED_MS && !nearCut(cutTimes, a.t, b.t)) out.push({ t: r((a.t + b.t) / 2, 3), from: a.t, to: b.t, m: Math.round(m) });
  }
  return out;
}

export interface QcInput {
  verdict: Verdict; points: AtlasPoint[]; standstills: [number, number][]; cutTimes: number[]; hintLines: [number, number][][] | null;
  /** with an atlas route (job.route_gpx) */
  hasRoute: boolean; state: AtlasQcState;
}
export interface QcItem {
  id: AtlasCheckId; label: string; ok: boolean;
  /** false: shown, never holds back the file (route agreement) */
  blocking: boolean;
  /** an override with a note is allowed */
  overridable: boolean;
  overridden: boolean; note: string | null;
  /** the measured value, as it goes into the payload */
  value: unknown;
  /** German text of the value */
  detail: string;
}
const fmtS = (s: number) => { const m = Math.floor(s / 60), x = Math.round(s % 60); return `${m}:${String(x).padStart(2, "0")}`; };
const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")} %`;

/** the checklist of plan section 3; every blocking item must be green or overridden with a note before the file is written */
export function qcChecks(q: QcInput): QcItem[] {
  const st = q.state, t0 = st.t_start, t1 = st.t_end;
  const span = t0 != null && t1 != null && t0 < t1;
  const first = q.points.find((p) => !p.extrapolated)?.t, last = [...q.points].reverse().find((p) => !p.extrapolated)?.t;
  const spanOk = span && first != null && last != null && t0! >= first && t1! <= last;
  const pts = spanOk ? payloadPoints(q.points, t0!, t1!) : [];
  const cov = coverageOf(pts, q.standstills);
  const agree = routeAgreement(pts.map((p) => [p.lon, p.lat]), q.hasRoute ? q.hintLines : null);
  const pieces = spanOk ? cutPieces(q.cutTimes, t0!, t1!) : [];
  const jumps = spanOk ? jumpCuts(q.points, q.cutTimes, t0!, t1!) : [];
  const jumpText = jumps.length ? `; ${jumps.length === 1 ? "1 Sprung" : `${jumps.length} Sprünge`} ohne erkannten Schnitt als Schnitt eingetragen` : "";
  const v = st.viewed;
  const item = (id: AtlasCheckId, label: string, ok: boolean, value: unknown, detail: string, o: { blocking?: boolean; overridable?: boolean } = {}): QcItem => {
    const blocking = o.blocking ?? true, overridable = (o.overridable ?? true) && blocking;
    const note = (st.overrides[id] ?? "").trim();
    const overridden = !ok && overridable && !!note;
    return { id, label, ok, blocking, overridable, overridden, note: overridden ? note : null, value, detail };
  };
  return [
    item("verdict", "Ergebnis", q.verdict === "confident", q.verdict,
      q.verdict === "confident" ? "sicher" : q.verdict === "uncertain" ? "unsicher: nur mit Notiz" : "keine Route gefunden", { overridable: q.verdict === "uncertain" }),
    item("coverage", "Abdeckung", spanOk && cov.share >= MIN_COVERAGE && cov.max_gap_s <= MAX_GAP_S, { share: cov.share, max_gap_s: cov.max_gap_s },
      spanOk ? `${pct(cov.share)} der Fahrzeit mit Position (mindestens 90 %), längste Lücke ${cov.max_gap_s} s (höchstens 60 s)` : "erst Anfang und Ende setzen"),
    item("route_agreement", "Übereinstimmung mit der Scenic-Route", !agree || agree.median_m <= ROUTE_AGREE_M, agree,
      !q.hasRoute ? "keine Scenic-Route" : agree ? `Median ${agree.median_m.toFixed(1).replace(".", ",")} m, höchstens ${Math.round(agree.max_m)} m (Hinweis, kein Ausschlussgrund: die Scenic-Route kann die falsche sein)` : "–",
      { blocking: false }),
    item("cuts", "Schnitte", spanOk && (pieces.length === 1 || pieces.every(([a]) => st.cuts_checked.includes(a))),
      { times: pieces.slice(1).map(([a]) => a), checked: st.cuts_checked.filter((a) => pieces.length > 1 && pieces.some(([b]) => b === a)),
        ...(jumps.length ? { jumps: jumps.map(({ t, m }) => ({ t, m })) } : {}) },
      (!spanOk ? "erst Anfang und Ende setzen" : pieces.length === 1 ? "keine Schnitte" : `${pieces.length - 1} Schnitte, ${pieces.length} Stücke: jedes in der Analyse prüfen`) + jumpText),
    item("intro_outro", "Anfang und Ende", !!spanOk, { t_start: t0, t_end: t1 },
      spanOk ? `erste Fahrsekunde ${fmtS(t0!)}, letzte ${fmtS(t1!)}` : "Anfang und Ende der Fahrt im Ergebnis liegen nicht innerhalb der Route", { overridable: false }),
    item("viewed", "Angesehen", v.start && v.turn && v.end, { ...v }, "Anfang, eine Kehre oder Kreuzung und das Ende gegen die Karte abgespielt"),
  ];
}
/** all blocking items green or overridden with a note */
export const qcReady = (items: QcItem[]) => items.every((i) => !i.blocking || i.ok || i.overridden);

// ---------------------------------------------------------------- payload

/** <id>.scenic.json (contract 8.2): exactly these fields, in this order */
export interface AtlasPayload {
  video_id: string; pipeline_hash: string; app_version: string; vehicle: string; offset_m: number | null;
  t: number[]; c: [number, number][]; e?: number[];
  t_start: number; t_end: number; cuts: number[]; standstills: [number, number][];
  verdict: Verdict; verdict_basis: string; confidence_mean: number; coverage: number; route_km: number;
  qc: { checks: { id: AtlasCheckId; ok: boolean; blocking: boolean; overridden: boolean; note: string | null; value: unknown }[]; note: string | null; checked_by: null };
}
export interface PayloadInput {
  job: AtlasJob; verdict: Verdict; verdict_basis: string; points: AtlasPoint[]; standstills: [number, number][]; cutTimes: number[];
  pipeline_hash: string; vehicle: string; offset_m: number | null; app_version: string; state: AtlasQcState; items: QcItem[];
  /** height at an arc length of the route (the elevation profile, P13/P17), or null without a profile */
  eleAt?: ((arc_m: number) => number) | null;
}
export const payloadName = (job: AtlasJob) => `${job.video_id}.scenic.json`;

export function buildPayload(i: PayloadInput): AtlasPayload {
  const t0 = i.state.t_start, t1 = i.state.t_end;
  if (t0 == null || t1 == null || !(t0 < t1)) throw new Error("Anfang und Ende der Fahrt fehlen.");
  if (!qcReady(i.items)) throw new Error("Die Prüfliste ist noch nicht vollständig.");
  const pts = payloadPoints(i.points, t0, t1);
  if (pts.length < 2) throw new Error("Zu wenige Punkte zwischen Anfang und Ende.");
  const c = pts.map((p) => [r(p.lon, 6), r(p.lat, 6)] as [number, number]);
  let e: number[] | undefined;
  if (i.eleAt) {
    const z = pts.map((p) => (p.arc_m === undefined ? NaN : i.eleAt!(p.arc_m)));
    if (z.every(isNum)) e = z.map((x) => r(x, 1));
  }
  let km = 0;
  for (let k = 1; k < c.length; k++) km += distM(c[k - 1], c[k]);
  const cov = coverageOf(pts, i.standstills);
  return {
    video_id: i.job.video_id, pipeline_hash: i.pipeline_hash, app_version: i.app_version, vehicle: i.vehicle, offset_m: i.offset_m,
    t: pts.map((p) => r(p.t, 3)), c, ...(e ? { e } : {}),
    t_start: t0, t_end: t1,
    // the detected cuts and the jumps marked as cuts (jumpCuts), in time order
    cuts: [...i.cutTimes.filter((x) => x > t0 && x < t1).map((x) => r(x, 3)), ...jumpCuts(i.points, i.cutTimes, t0, t1).map((j) => j.t)].sort((a, b) => a - b),
    standstills: i.standstills.filter(([a, b]) => b >= t0 && a <= t1).map(([a, b]) => [r(a, 3), r(b, 3)] as [number, number]),
    verdict: i.verdict, verdict_basis: i.verdict_basis,
    confidence_mean: r(pts.reduce((s, p) => s + p.confidence, 0) / pts.length, 3), coverage: cov.share, route_km: r(km / 1000, 2),
    qc: { checks: i.items.map((x) => ({ id: x.id, ok: x.ok, blocking: x.blocking, overridden: x.overridden, note: x.note, value: x.value })), note: i.state.note.trim() || null, checked_by: null },
  };
}

/** the import template of plan section 2: at least 480p, video only, H.264 preferred (to copy into the settings; the app presets none, P2) */
export const YTDLP_480P = 'yt-dlp -f "bv*[height>=480]" -S "+res,vcodec:h264,fps" --no-playlist -P {out} -o "%(id)s_%(height)sp.%(ext)s" -- {url}';
