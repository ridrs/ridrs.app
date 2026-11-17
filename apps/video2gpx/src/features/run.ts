// The run of the pipeline: preconditions, start (also while the video is still being imported), cancel, resume, result.
// One run at a time on this Mac; it keeps running when its project is left (active.*).
import { api } from "../api";
import { S, bus, effectivePbf, freshRun, reduce, saveCur, toast, type RunState } from "../state";
import type { BikePaths, EnvCheck, PipelineEvent, ResultData, RoutePoint, RunParamsSaved, StepId, Vehicle, Verdict } from "../types";
import { anchorsParam, rerunArgs } from "../anchors";
import { introParam } from "../intro";
import { importPct, importingFor } from "./import";

/** the running job: the project it belongs to and its state (the same object as S.run while that project is open) */
export const active: { project: string | null; state: RunState | null; /** state saw the run from its start */ full: boolean } = { project: null, state: null, full: false };

export const activeName = () => { const p = S.projects.find((x) => x.id === active.project); return p ? p.probe?.title ?? p.name : S.cur?.app.id === active.project ? S.cur!.app.name : "anderes Projekt"; };
export const pipelineReady = (e: EnvCheck | null) => !!e && e.python.ok && e.rsm.ok;
export const toolsReady = (e: EnvCheck | null) => pipelineReady(e) && e!.ffmpeg.ok && e!.ffprobe.ok;

const EXIT: Record<number, string> = {
  1: "Interner Fehler in der Pipeline (Einzelheiten in logs/ im Projektordner).",
  2: "Ungültige Eingaben oder fehlende Dateien (Video, Karte, Ausschnitt).",
  3: "Zu wenig Arbeitsspeicher für diesen Ausschnitt (oder zu wenig freier Speicher beim Start). Bitte einen kleineren Ausschnitt wählen oder andere Programme schließen.",
  4: "Datenproblem: Der Ausschnitt liegt nicht in der Kartendatei oder enthält keine Straßen.",
  130: "Abgebrochen. Mit „Fortsetzen“ geht es beim letzten fertigen Schritt weiter.",
};
export function exitMessage(code: number | null, cancelled: boolean, detail: string | null): string {
  if (cancelled || code === 130) return EXIT[130];
  const base = code !== null && EXIT[code] ? EXIT[code] : `Die Pipeline wurde unerwartet beendet (Code ${code}).`;
  return detail && !base.includes(detail) ? `${base} Meldung: ${detail}` : base;
}

function stateFor(project: string): RunState | null {
  if (active.project === project && active.state) return active.state;
  return S.cur?.app.id === project ? S.run : null;
}

export function initRun() {
  void api.onPipelineEvent((project, ev) => {
    const st = stateFor(project);
    if (!st) return;
    reduce(st, ev);
    st.running = active.project === project;
    bus.emit("runtick", project, ev);
  });
  void api.onPipelineExit((project, code, cancelled) => {
    const st = stateFor(project);
    const name = active.project === project ? activeName() : project;
    if (active.project === project) { active.project = null; active.state = null; }
    if (st) {
      reduce(st, { type: "exit", code, cancelled });
      if (code !== 0) st.error = exitMessage(code, cancelled, st.error);
    }
    const isCur = S.cur?.app.id === project;
    if (code === 0) {
      const p = S.projects.find((x) => x.id === project);
      if (p) p.has_result = true;
      if (isCur) void loadResult().then(() => bus.emit("run-finished", project));
      else toast(`Berechnung fertig: ${name}`);
    } else if (!isCur) toast(cancelled ? `Berechnung abgebrochen: ${name}` : `Berechnung fehlgeschlagen: ${name}`, cancelled ? "info" : "error");
    bus.emit("run"); bus.emit("projects");
  });
  // a run that was started before this web view (re)loaded
  void api.pipelineStatus().then((id) => {
    if (!id || active.project) return;
    active.project = id; active.full = false;
    active.state = S.cur?.app.id === id ? S.run : freshRun();
    active.state.running = true; active.state.started = true; active.state.exit = null;
    bus.emit("run"); bus.emit("projects");
  }, () => {});
}

/** after a project was opened: its run state from the stored events, the live state when its run is active, and its result */
export async function afterOpen() {
  const cur = S.cur;
  if (!cur) return;
  const id = cur.app.id;
  if (active.project === id && active.state && active.full) S.run = active.state;
  else {
    const st = freshRun();
    for (const ev of cur.events) reduce(st, ev as PipelineEvent);
    if (!active.project) { const run = await api.pipelineStatus().catch(() => null); if (run && !active.project) { active.project = run; active.full = false; active.state = null; } }
    if (S.cur !== cur) return;
    if (active.project === id) { st.running = true; st.exit = null; st.error = null; active.state = st; }
    else if (st.exit && st.exit.code !== 0) st.error = exitMessage(st.exit.code, st.exit.cancelled, st.error);
    S.run = st;
  }
  if (cur.has_result && !S.run.running) await loadResult();
  if (S.cur === cur) bus.emit("run");
}

export async function loadResult() {
  const cur = S.cur;
  if (!cur) return;
  try {
    const r = await api.resultLoad(cur.app.id);
    if (S.cur !== cur) return;
    const rp = JSON.parse(r.route_points);
    const pj = JSON.parse(r.project);
    const pts: RoutePoint[] = (rp.points as RoutePoint[]).slice().sort((a, b) => a.t - b.t);
    const res: ResultData = {
      points: pts, verdict: (rp.verdict ?? pj.verdict) as Verdict, verdict_basis: rp.verdict_basis ?? pj.verdict_basis ?? "",
      reasons: pj.verdict_detail?.reasons ?? [], project: pj, gpx: r.gpx, gpx_bytes: r.gpx_bytes,
      intro_end: typeof rp.cuts?.intro_end === "number" ? rp.cuts.intro_end : null,
    };
    S.result = res;
    S.showRoute = res.verdict !== "no_route";
    if (pj.effective?.start_time && !cur.app.start_time && pj.effective.start_time !== "2000-01-01T00:00:00Z") cur.app.start_time = pj.effective.start_time;
    cur.has_result = true; cur.app.has_result = true;
    if (cur.app.verdict !== res.verdict) void saveCur({ verdict: res.verdict });
    bus.emit("result");
  } catch (e) {
    S.result = null;
    S.run.error = `Ergebnis konnte nicht geladen werden: ${e}`;
    bus.emit("result"); bus.emit("run");
  }
}

export type CheckId = "video" | "frame" | "map" | "tools";
export interface Check { id: CheckId; label: string; ok: boolean }
/** the preconditions of a start, shown next to the start button */
export function checklist(): Check[] {
  const app = S.cur?.app;
  if (!app) return [];
  const loading = importingFor(app.id);
  const pct = importPct();
  const e = S.env;
  const missing = e ? [!pipelineReady(e) ? "Berechnung" : null, !e.ffmpeg.ok ? "ffmpeg" : null, !e.ffprobe.ok ? "ffprobe" : null].filter(Boolean) : [];
  return [
    { id: "video", label: app.video ? (S.videoMissing ? "Video nicht gefunden" : "Video") : loading ? `Video lädt${pct !== null ? ` (${Math.round(pct)} %)` : ""}` : "Video", ok: (!!app.video && !S.videoMissing) || loading },
    { id: "frame", label: "Suchrahmen", ok: !!S.bbox },
    { id: "map", label: "Karte", ok: !!S.bbox && !!effectivePbf(S.bbox) },
    { id: "tools", label: !e ? "Werkzeuge werden geprüft" : missing.length ? `${missing.join(", ")} fehlt` : "ffmpeg", ok: toolsReady(e) },
  ];
}

export const canResume = () => { const r = S.run, app = S.cur?.app; return !!app && !r.running && !active.project && !!app.last_run && r.started && r.exit !== null && r.exit.code !== 0 && r.steps.gpx.state !== "done"; };

async function launch(project: string, params: RunParamsSaved, resume: boolean, follow: boolean, fromStep: StepId | null) {
  const st = freshRun(); st.running = true; st.started = true;
  active.project = project; active.state = st; active.full = true;
  const isCur = () => S.cur?.app.id === project;
  if (isCur()) { S.run = st; if (!resume) { S.result = null; bus.emit("result"); } }
  bus.emit("run"); bus.emit("projects");
  try {
    // every run resumes on the project's out dir: steps whose inputs did not change are reused, not computed again (rerunArgs)
    await api.pipelineStart({ project, ...params, ...rerunArgs(fromStep), ...(follow ? { follow_import: true } : {}) });
    if (isCur()) await saveCur({ last_run: params });
    else { const o = await api.projectOpen(project); o.app.last_run = params; await api.projectSave(project, o.app); }
  } catch (e) {
    if (active.project === project) { active.project = null; active.state = null; }
    st.running = false; st.exit = { code: null, cancelled: false }; st.error = String(e);
    toast(String(e), "error");
    bus.emit("run"); bus.emit("projects");
  }
}

/** the pipeline option `--bike-paths` of a choice; only for a bike (explicit or estimated), off leaves the option out (roads only, as before) */
export function bikePathsArg(vehicle: Vehicle, choice: BikePaths): "on" | "fallback" | null {
  if (vehicle !== "auto" && vehicle !== "bike") return null;
  return choice === "on" ? "on" : choice === "auto" ? "fallback" : null;
}

/** Starts (or resumes) the run of the open project. False: nothing was started, the reason was shown.
 *  resume: with the parameters of the last run ("Fortsetzen"); otherwise with the current inputs. Either way only steps whose inputs changed
 *  are computed (the pipeline resumes on the same out dir); fromStep forces that step and all later ones ("Ab Schritt … neu berechnen"). */
export async function start(resume: boolean, fromStep: StepId | null = null): Promise<boolean> {
  const app = S.cur?.app;
  if (!app) return false;
  if (active.project) { toast(`Es läuft schon eine Berechnung: ${activeName()}.`, "error"); return false; }
  let params: RunParamsSaved;
  if (resume && app.last_run) params = { ...app.last_run, video: app.last_run.video || app.video || "" };
  else {
    try { S.env = await api.envCheck(); bus.emit("env"); } catch { /* the checklist shows the old state */ }
    const open = checklist().filter((c) => !c.ok);
    if (open.length) { toast(`Es fehlt noch: ${open.map((c) => c.label).join(", ")}`, "error"); return false; }
    const h = app.hint ?? null;
    params = {
      video: app.video ?? "", bbox: S.bbox!, pbf: effectivePbf(S.bbox)!.path, vehicle: (app.vehicle ?? "auto") as Vehicle,
      offset_m: app.offset_m ?? null, start_time: app.start_time ?? null, decoys: app.decoys ?? 0,
      start_bbox: S.startFrame, end_bbox: S.endFrame, hint: h?.path ?? null, hint_buffer_m: h ? h.buffer_m : null, hint_fallback: "auto",
      bike_paths: bikePathsArg((app.vehicle ?? "auto") as Vehicle, app.bike_paths ?? "off"),
      anchors: anchorsParam(app.anchors),
      intro_end: introParam(app.intro_end),
    };
  }
  // the video is still being imported: the backend keeps the run until the import has delivered the file
  // (follow_import; it reports the download as { type: "input" } events and starts with the complete file)
  const follow = !app.video && importingFor(app.id);
  await launch(app.id, { ...params, video: app.video ?? "" }, resume, follow, fromStep);
  return true;
}

export async function cancel() {
  await api.pipelineCancel();
  (active.state ?? S.run).logs.push({ level: "info", message: "Abbruch angefordert …" });
  bus.emit("runtick");
}
