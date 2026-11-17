// The Analyse stage as shared state: the per-second series of the open result, the overlay switches ("Bewegung", "Rotation", remembered) and the
// overlay frame (the points tracked at one video time). The stage (views/analyse.ts) shows and drives it; the stage bar (app/shell.ts) reads it.
import { api } from "./api";
import { S, bus } from "./state";
import type { InspectFrame, InspectSeries } from "./types";

export type AnState = "idle" | "loading" | "ready" | "missing" | "error";
const KEY = "v2g.analyseOverlay";

export const A = {
  project: "",
  state: "idle" as AnState,
  series: null as InspectSeries | null,
  error: null as string | null,
  /** the overlay switches */
  motion: false,
  rotation: false,
  /** the last overlay frame and the time it was asked for */
  frame: null as InspectFrame | null,
  frameFor: -1,
  frameBusy: false,
  frameError: null as string | null,
};

const changed = () => bus.emit("analyse");
let token = 0, fseq = 0;

export const analyseBusy = () => A.state === "loading";
export const analyseReady = () => A.state === "ready" && !!A.series;

export function loadSwitches() {
  try { const o = JSON.parse(localStorage.getItem(KEY) ?? "{}"); A.motion = !!o.motion; A.rotation = !!o.rotation; } catch { /* the defaults: off */ }
}
export function setSwitch(k: "motion" | "rotation", on: boolean) {
  A[k] = on;
  try { localStorage.setItem(KEY, JSON.stringify({ motion: A.motion, rotation: A.rotation })); } catch { /* private mode */ }
  if (!A.motion && !A.rotation) { fseq++; A.frame = null; A.frameFor = -1; A.frameBusy = false; A.frameError = null; }
  changed();
}
export const overlayOn = () => A.motion || A.rotation;

export function resetAnalyse() {
  token++; fseq++;
  Object.assign(A, { project: S.cur?.app.id ?? "", state: "idle", series: null, error: null, frame: null, frameFor: -1, frameBusy: false, frameError: null });
  changed();
}

/** the series of the open result (cached by the backend; made in a second or two the first time) */
export async function loadSeries(): Promise<void> {
  const cur = S.cur, my = ++token;
  if (!cur || !S.result?.points.length) { A.state = "idle"; A.series = null; changed(); return; }
  if (A.project !== cur.app.id) resetAnalyse();
  if (A.state === "ready" && A.series) return;
  A.state = "loading"; A.error = null;
  changed();
  try {
    const r = await api.inspectSeries(cur.app.id);
    if (my !== token) return;
    if (r.ready && r.series) { A.series = r.series; A.state = "ready"; }
    else if (r.reason === "no_result") { A.series = null; A.state = "missing"; }
    else { A.series = null; A.state = "error"; A.error = r.error ?? "unbekannter Fehler"; }
  } catch (e) {
    if (my !== token) return;
    A.series = null; A.state = "error"; A.error = String(e);
  }
  changed();
}
/** a new result: the series is made again */
export function invalidateSeries() { if (A.series) { A.series = null; A.state = "idle"; changed(); } }

/** the overlay data for video time t: asks for what is switched on; a newer request wins (the backend ends an older one), an older answer is dropped */
export async function requestFrame(t: number): Promise<void> {
  const cur = S.cur;
  if (!cur || !overlayOn()) return;
  const my = ++fseq;
  A.frameBusy = true; A.frameError = null;
  changed();
  try {
    const what = [A.motion ? "motion" : "", A.rotation ? "rotation" : ""].filter(Boolean).join(",");
    const r = await api.inspectFrame(cur.app.id, t, cur.app.video, what);
    if (my !== fseq) return;
    if (r.superseded) return;
    if (r.ready === false) { A.frame = null; A.frameError = r.error ?? "unbekannter Fehler"; }
    else { A.frame = r; A.frameFor = t; }
  } catch (e) {
    if (my !== fseq) return;
    A.frame = null; A.frameError = String(e);
  }
  A.frameBusy = false;
  changed();
}
export const frameStale = () => { fseq++; };

export function initAnalyse() {
  loadSwitches();
  bus.on("project", () => resetAnalyse());
  bus.on("result", () => invalidateSeries());
}
