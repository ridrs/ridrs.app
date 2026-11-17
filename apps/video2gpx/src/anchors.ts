// User anchors ("Ortsangaben"): at video time t the camera is inside a map frame. Pure data functions (storage in app.json, the run
// parameters, the step choice of a rerun, the German report); the pipeline side is rsm/pipeline/anchors.py (CLI --anchors).
// Only type imports here: the module also runs under `node --test` (tests/anchors.test.ts).
import type { Bbox, StepId } from "./types";

export interface Anchor { t: number; bbox: Bbox }

/** pipeline steps in order (the same as state.STEPS / rsm.pipeline.config.STEPS) */
export const STEP_IDS: StepId[] = ["motion", "rotation", "map", "route_search", "plausibility", "refine", "gpx"];

/** m:ss of a video time */
export const fmtT = (t: number): string => { const s = Math.max(0, Math.floor(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

const okBox = (b: unknown): b is Bbox =>
  Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === "number" && isFinite(x)) && b[0] < b[2] && b[1] < b[3] && b[0] >= -90 && b[2] <= 90 && b[1] >= -180 && b[3] <= 180;

/** the anchors stored in a project (app.json is free-form): valid entries only, sorted by time, times rounded to 0.1 s */
export function normalizeAnchors(raw: unknown): Anchor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Anchor => !!a && typeof a === "object" && typeof (a as Anchor).t === "number" && isFinite((a as Anchor).t) && (a as Anchor).t >= 0 && okBox((a as Anchor).bbox))
    .map((a) => ({ t: Math.round(a.t * 10) / 10, bbox: [a.bbox[0], a.bbox[1], a.bbox[2], a.bbox[3]] as Bbox }))
    .sort((a, b) => a.t - b.t);
}

/** a new anchor; one at (almost) the same time (within 0.5 s) is replaced */
export function addAnchor(list: Anchor[], t: number, bbox: Bbox): Anchor[] {
  if (!(t >= 0) || !okBox(bbox)) return normalizeAnchors(list);
  return normalizeAnchors([...list.filter((a) => Math.abs(a.t - t) >= 0.5), { t, bbox }]);
}

export const removeAnchor = (list: Anchor[], i: number): Anchor[] => list.filter((_, j) => j !== i);

/** the run parameter (null without anchors: the option is left out, the hashes stay as before) */
export const anchorsParam = (list: Anchor[] | null | undefined): Anchor[] | null => { const n = normalizeAnchors(list ?? []); return n.length ? n : null; };

/** the same anchors (for "has anything changed since the last run") */
export const sameAnchors = (a: Anchor[] | null | undefined, b: Anchor[] | null | undefined): boolean => JSON.stringify(anchorsParam(a)) === JSON.stringify(anchorsParam(b));

/** The pipeline options of a run started from the UI: every run resumes on the project's out dir (only steps whose inputs changed are
 *  computed again); "Ab Schritt … neu berechnen" adds --from-step: the steps before it are reused as they are, it and all later ones rerun
 *  (from "motion": everything is computed again). */
export function rerunArgs(fromStep: StepId | null): { resume: true; from_step: StepId | null } {
  if (fromStep && !STEP_IDS.includes(fromStep)) throw new Error(`unknown step ${fromStep}`);
  return { resume: true, from_step: fromStep ?? null };
}

/** the steps a rerun can start from: the first step always; a later one only if every step before it has a result to reuse */
export function rerunChoices(finished: Partial<Record<StepId, boolean>>): StepId[] {
  const out: StepId[] = ["motion"];
  for (let i = 1; i < STEP_IDS.length; i++) {
    if (!STEP_IDS.slice(0, i).every((s) => finished[s])) break;
    out.push(STEP_IDS[i]);
  }
  return out;
}

export interface AnchorReport { n: number; used: Anchor[]; dropped: number[] }
/** route_search's record (summary.anchors / route_search summary) -> what the result view shows */
export function anchorReport(raw: any): AnchorReport | null {
  if (!raw || typeof raw !== "object" || !raw.n) return null;
  const used = (Array.isArray(raw.used) ? raw.used : []).map((a: any) => ({ t: Number(a.t), bbox: a.bbox && !Array.isArray(a.bbox) ? [a.bbox.south, a.bbox.west, a.bbox.north, a.bbox.east] as Bbox : a.bbox }));
  const dropped = (Array.isArray(raw.dropped_t) ? raw.dropped_t : (raw.dropped ?? []).map((a: any) => a.t)).map(Number).filter((x: number) => isFinite(x));
  return { n: Number(raw.n), used, dropped };
}

/** German text of the report, e.g. "2 Ortsangaben berücksichtigt; nicht erfüllbar: 1:08" */
export function anchorReportDe(r: AnchorReport): string {
  const u = r.used.length;
  const head = `${u} von ${r.n} ${r.n === 1 ? "Ortsangabe" : "Ortsangaben"} berücksichtigt`;
  return r.dropped.length ? `${head}; nicht erfüllbar und ignoriert: ${r.dropped.map(fmtT).join(", ")}` : head;
}
