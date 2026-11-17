import { api } from "./api";
import type { Bbox, EnvCheck, Level, OpenProject, PbfInfo, PipelineEvent, ProjectApp, ResultData, Settings, StepId, StepState, Verdict } from "./types";
import { bboxCovers } from "./util";

export const STEPS: { id: StepId; label: string; short: string }[] = [
  { id: "motion", label: "Videobewegung", short: "Bewegung" },
  { id: "rotation", label: "Rotation", short: "Rotation" },
  { id: "map", label: "Karte", short: "Karte" },
  { id: "route_search", label: "Routensuche", short: "Routensuche" },
  { id: "plausibility", label: "Plausibilitätsprüfung", short: "Prüfung" },
  { id: "refine", label: "Verfeinerung", short: "Verfeinerung" },
  { id: "gpx", label: "GPX", short: "GPX" },
];

export interface StepInfo { state: StepState; pct: number; eta?: number; /** waits for more of a video that is still being imported */ waiting?: boolean; /** seconds the step took */ seconds?: number; /** reused from an earlier run (resume) */ reused?: boolean }
export interface StatusInfo { key: string; signal: string; level: Level; value?: number; message: string }
export interface RunState {
  steps: Record<StepId, StepInfo>;
  statuses: StatusInfo[];
  logs: { level: string; message: string }[];
  verdict: Verdict | null;
  running: boolean;
  exit: { code: number | null; cancelled: boolean } | null;
  started: boolean;
  error: string | null;
  /** the input video while it is still being imported (run started during the import) */
  input: { state: "growing" | "complete"; pct: number | null; bytes: number; total: number | null } | null;
  /** overall progress as the pipeline reports it; null: computed from the steps (overallPct) */
  progress: { pct: number; eta?: number } | null;
}

export function freshRun(): RunState {
  const steps = {} as Record<StepId, StepInfo>;
  for (const s of STEPS) steps[s.id] = { state: "pending", pct: 0 };
  return { steps, statuses: [], logs: [], verdict: null, running: false, exit: null, started: false, error: null, input: null, progress: null };
}

/** Applies one pipeline event. Steps are independent: several may be running at the same time. */
export function reduce(r: RunState, ev: PipelineEvent): void {
  r.started = true;
  switch (ev.type) {
    case "step": {
      if (!r.steps[ev.id]) break; // a step this app version does not know
      r.steps[ev.id] = { state: ev.state, pct: ev.pct ?? (ev.state === "done" || ev.state === "skipped" ? 100 : r.steps[ev.id].pct), eta: ev.eta_s, waiting: ev.state === "running" && !!ev.waiting_for_input, seconds: ev.seconds, reused: !!ev.reused };
      if (ev.state === "failed") r.error = `Schritt „${STEPS.find((s) => s.id === ev.id)?.label}“ ist fehlgeschlagen.`;
      break;
    }
    case "input":
      r.input = { state: ev.state, pct: ev.pct, bytes: ev.bytes, total: ev.total };
      break;
    case "progress":
      r.progress = { pct: ev.pct, eta: ev.eta_s };
      break;
    case "status": {
      const key = ev.signal + (ev.signal === "area_size" && /within 300 m/.test(ev.message) ? "_route" : "");
      const info: StatusInfo = { key, signal: ev.signal, level: ev.level, value: ev.value, message: ev.message };
      const i = r.statuses.findIndex((s) => s.key === key);
      if (i >= 0) r.statuses[i] = info; else r.statuses.push(info);
      break;
    }
    case "log":
      r.logs.push({ level: ev.level, message: ev.message });
      if (r.logs.length > 600) r.logs.splice(0, r.logs.length - 600);
      if (ev.level === "error") r.error = ev.message;
      break;
    case "result":
      r.verdict = ev.verdict;
      break;
    case "exit":
      r.running = false;
      r.exit = { code: ev.code, cancelled: ev.cancelled };
      break;
  }
}

/** rough share of the whole run per step, for the overall bar when the pipeline sends no "progress" event */
const WEIGHT: Record<StepId, number> = { motion: 30, rotation: 8, map: 8, route_search: 34, plausibility: 30, refine: 14, gpx: 6 };
export function overallPct(r: RunState): number {
  if (r.progress) return r.progress.pct;
  let sum = 0, all = 0;
  for (const s of STEPS) {
    const i = r.steps[s.id];
    if (i.state === "skipped") continue;
    all += WEIGHT[s.id];
    sum += (WEIGHT[s.id] * (i.state === "done" ? 100 : i.pct)) / 100;
  }
  return all ? (100 * sum) / all : 0;
}
export const runningSteps = (r: RunState): StepId[] => STEPS.filter((s) => r.steps[s.id].state === "running").map((s) => s.id);
export const finishedSteps = (r: RunState): number => STEPS.filter((s) => ["done", "skipped"].includes(r.steps[s.id].state)).length;

export interface Store {
  env: EnvCheck | null;
  settings: Settings | null;
  projects: ProjectApp[];
  cur: OpenProject | null;
  pbfs: PbfInfo[];
  /** the search frame */
  bbox: Bbox | null;
  startFrame: Bbox | null;
  endFrame: Bbox | null;
  /** route hint polylines (lat, lon) */
  hint: { name: string; lines: [number, number][][] } | null;
  run: RunState;
  result: ResultData | null;
  showRoute: boolean;
  /** the project's video file was not found (moved or deleted) */
  videoMissing: boolean;
}

export const S: Store = { env: null, settings: null, projects: [], cur: null, pbfs: [], bbox: null, startFrame: null, endFrame: null, hint: null, run: freshRun(), result: null, showRoute: true, videoMissing: false };

type Fn = (...a: any[]) => void;
const handlers: Record<string, Fn[]> = {};
export const bus = {
  on(name: string, fn: Fn) { (handlers[name] ??= []).push(fn); },
  off(name: string, fn: Fn) { const h = handlers[name]; const i = h ? h.indexOf(fn) : -1; if (i >= 0) h.splice(i, 1); },
  emit(name: string, ...a: any[]) { (handlers[name] ?? []).slice().forEach((f) => f(...a)); },
};

/** Persist the current project's app.json (debounced by callers where needed). */
export async function saveCur(patch: Partial<ProjectApp> = {}): Promise<void> {
  if (!S.cur) return;
  Object.assign(S.cur.app, patch);
  await api.projectSave(S.cur.app.id, S.cur.app);
}

/** Local extracts whose header bbox contains the bbox, the smallest file first. */
export function coveringPbfs(bbox: Bbox | null): PbfInfo[] {
  if (!bbox) return [];
  return S.pbfs.filter((p) => !p.missing && p.bbox && bboxCovers(p.bbox, bbox)).sort((a, b) => a.bytes - b.bytes);
}

export function effectivePbf(bbox: Bbox | null): PbfInfo | null {
  const cov = coveringPbfs(bbox);
  const chosen = S.cur?.app.pbf ? cov.find((p) => p.path === S.cur!.app.pbf) : undefined;
  return chosen ?? cov[0] ?? null;
}

export async function refreshPbfs() {
  S.pbfs = await api.pbfList();
  bus.emit("pbfs");
}

export function toast(msg: string, kind: "info" | "error" = "info") {
  bus.emit("toast", msg, kind);
}
