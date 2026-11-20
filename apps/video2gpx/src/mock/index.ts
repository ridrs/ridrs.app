// Browser stand-in for the Tauri command layer (development and screenshots only). Same interface as src/tauri.ts.
// Not part of the production build (dynamic import; dist/mock is removed). Scenarios: ./scenarios.ts.
import type { Api, RunParams } from "../api";
import { frozen } from "../app/theme";
import type {
  DemFile, DownloadProgress, EnvCheck, ImportProgress, ImportResolved, ImportTemplate, IncyclistInfo, IncyclistOptions, OpenProject,
  PipelineEvent, ProjectApp, Settings, ToolCheck,
} from "../types";
import { wait } from "../util";
import type { AtlasJob } from "../atlas";
import { CENTER, DEM_TILE, PBFS, PROBE, ROUTE, STEP_IDS, VIDEO_S, hintText, resultEvents, statuses, stepsDone } from "./fixtures";
import * as AN from "./analyse";
import * as EL from "./elevation";
import { SC, qp } from "./scenarios";

const VERDICT = SC.result ?? "confident";
const ST = statuses(VERDICT, !!SC.difficult);
const now = Date.now();
const day = 86400e3;

// ---------------------------------------------------------------- settings, environment
const MY_YTDLP: ImportTemplate = { id: "user-ytdlp", name: "Mein yt-dlp", template: 'yt-dlp -f "bv*[ext=mp4]/bv*" --no-playlist -o {out}/%(title)s.%(ext)s {input}', builtin: false, accepts: "url", tool: "yt-dlp" };
const settings: Settings = {
  dev_mode: !!SC.dev,
  python: "/Users/demo/route-shape-matching/.venv/bin/python", rsm_dir: "/Users/demo/route-shape-matching", sidecar: "", ffmpeg: "", ffprobe: "",
  linked_pbfs: [PBFS[0].path], import_history: ['cp ~/Movies/ride.mp4 "$OUT"'], last_project: null, suggest_online: true,
  ytdlp: "", import_templates: SC.notemplate ? [] : [MY_YTDLP], import_default_url: SC.notemplate ? "" : MY_YTDLP.id, import_default_copy: "cp",
};
const BUILTIN: ImportTemplate[] = [{ id: "cp", name: "Kopieren (cp)", template: "cp -- {input} {out}/", builtin: true, accepts: "path", tool: null }];

function env(): EnvCheck {
  const e = SC.env ?? "ok";
  const ok = (path: string, version?: string): ToolCheck => ({ ok: true, path, version });
  const missing = (name: string): ToolCheck => ({ ok: false, message: `${name} nicht gefunden.` });
  const pipe = e !== "nopipeline";
  return {
    python: pipe ? ok(settings.dev_mode ? settings.python : "/Applications/video2gpx.app/Contents/MacOS/rsm-pipeline", settings.dev_mode ? "3.14.0" : undefined) : { ok: false, message: "Die eingebaute Pipeline fehlt in dieser App." },
    rsm: { ok: pipe, dir: settings.rsm_dir, message: pipe ? undefined : "Die eingebaute Pipeline fehlt in dieser App." },
    ffmpeg: e === "noff" ? missing("ffmpeg") : ok("/opt/homebrew/bin/ffmpeg", "7.1"),
    ffprobe: e === "noff" ? missing("ffprobe") : ok("/opt/homebrew/bin/ffprobe", "7.1"),
    ytdlp: e === "noff" || e === "noytdlp" ? missing("yt-dlp") : ok("/opt/homebrew/bin/yt-dlp", "2026.10.22"),
    brew: ok("/opt/homebrew/bin/brew"),
    pipeline: { mode: settings.dev_mode ? "python" : "sidecar", version: "1.0", code_hash: "0123456789abcdef" }, dev_mode: settings.dev_mode,
    data_dir: "/Users/demo/Library/Application Support/org.video2gpx.app", cache_dir: "/Users/demo/Library/Application Support/org.video2gpx.app/cache",
  };
}

// ---------------------------------------------------------------- projects
const lastRun = { video: "/mock/test.mp4", bbox: [44.4506, 4.9, 45.0506, 5.63] as [number, number, number, number], pbf: PBFS[0].path, vehicle: "auto" as const, offset_m: null, start_time: null, decoys: 0 };
const hasResult = !!SC.result;
const demo: ProjectApp = {
  id: "demo-1", name: PROBE.title, video: "/mock/test.mp4", created: now - day, updated: now - 3600e3, has_result: hasResult, verdict: SC.result ?? null,
  last_run: hasResult || SC.run ? lastRun : null, probe: PROBE, poster: "/mock/poster.jpg", bbox: lastRun.bbox, suggested: true, pbf: PBFS[0].path, vehicle: "auto", bike_paths: "off", align_mode: "posterior", decoys: 0,
};
switch (SC.project) {
  case "fresh": Object.assign(demo, { bbox: null, suggested: false }); break;
  case "nosuggest": Object.assign(demo, { bbox: null, suggested: false }); break;
  case "noframe": Object.assign(demo, { bbox: null, suggested: true, suggestion: null }); break;
  case "nomap": Object.assign(demo, { bbox: [60.1, 10.4, 60.5, 11.1], pbf: null }); break;
  case "novideo": Object.assign(demo, { video: null, probe: null, poster: null, name: "Neues Projekt", bbox: null }); break;
  case "videomissing": Object.assign(demo, { video: "/Volumes/Archiv/rousset.mp4" }); break;
}
const projects: ProjectApp[] = SC.empty ? [] : [
  demo,
  { id: "demo-2", name: "Amalfi Coast Drive", video: "/mock/amalfi.mkv", created: now - 5 * day, updated: now - 4 * day, has_result: true, verdict: "uncertain", probe: { ...PROBE, title: "Amalfi Coast Drive", duration: 1260 }, bbox: [40.5, 14.2, 40.8, 14.8] },
  { id: "demo-3", name: "Col de la Madone", video: "/mock/madone.webm", created: now - 9 * day, updated: now - 8 * day, has_result: false, probe: { ...PROBE, title: "Col de la Madone", duration: 3064 }, bbox: null },
];
if (SC.import && SC.run !== "stream") projects.unshift({ id: "demo-import", name: "Route des Grandes Alpes – Col de l'Iseran", video: null, created: now, updated: now });

const hints: Record<string, { name: string; path: string; text: string }> = {};
// a project from a ridrs Scenic job: the job's frames, its route as the hint (the mock route hint), the atlas link
const ATLAS_JOB: AtlasJob = {
  video_id: "aBcDeFgHiJk", url: "https://www.youtube.com/watch?v=aBcDeFgHiJk", title: PROBE.title, channel: "Demo-Kanal", duration_s: VIDEO_S, fps: 30, country: "FR", vehicle: null,
  route_gpx: "https://ridrs.example.org/scenic/gpx/aBcDeFgHiJk.gpx", route_level: 4,
  bbox: { south: 44.7, west: 5.2, north: 44.8, east: 5.33 }, start_bbox: { south: 44.742, west: 5.245, north: 44.754, east: 5.262 }, end_bbox: null,
  atlas: { base: "https://ridrs.example.org/scenic", video_id: "aBcDeFgHiJk" },
};
if (SC.atlas) {
  const h = hintText(false);
  hints["demo-1"] = { name: "aBcDeFgHiJk.gpx", path: "/mock/demo-1/hint/aBcDeFgHiJk.gpx", text: h.text };
  Object.assign(demo, { bbox: [44.7, 5.2, 44.8, 5.33], start_frame: [44.742, 5.245, 44.754, 5.262], hint: { name: "aBcDeFgHiJk.gpx", path: hints["demo-1"].path, buffer_m: 300 },
    atlas: { base: ATLAS_JOB.atlas.base, video_id: ATLAS_JOB.video_id, job: ATLAS_JOB, qc: null, written: null }, name: PROBE.title, suggested: true });
}
if (SC.hints) {
  const h = hintText(qp("hint") === "kml");
  hints["demo-1"] = { name: h.name, path: `/mock/demo-1/hint/${h.name}`, text: h.text };
  Object.assign(demo, { start_frame: [44.742, 5.245, 44.754, 5.262], bbox: [44.7, 5.2, 44.8, 5.33], hint: { name: h.name, path: hints["demo-1"].path, buffer_m: 300 } });
  if (SC.hints === "frames") demo.end_frame = [44.735, 5.292, 44.746, 5.308];
}

// ---------------------------------------------------------------- events
type Cb = (...a: any[]) => void;
const cbs: Record<string, Cb[]> = {};
const on = (n: string, cb: Cb) => { (cbs[n] ??= []).push(cb); return Promise.resolve(); };
const fire = (n: string, ...a: any[]) => (cbs[n] ?? []).forEach((c) => c(...a));
/** after the app has registered its listeners */
const later = (f: () => void, ms = 0) => setTimeout(f, ms);

// ---------------------------------------------------------------- runs
const runLog: Record<string, PipelineEvent[]> = {};
let runProject: string | null = null, cancelReq = false;
const send = (project: string, e: PipelineEvent) => { (runLog[project] ??= []).push(e); fire("pipeline", project, e); };
const step = (id: (typeof STEP_IDS)[number], state: "running" | "done" | "skipped" | "failed", pct?: number, extra: object = {}): PipelineEvent =>
  ({ type: "step", id, index: STEP_IDS.indexOf(id) + 1, of: 7, state, pct, ...extra }) as PipelineEvent;

function exit(project: string, code: number | null, cancelled: boolean) {
  runProject = null;
  runLog[project]?.push({ type: "exit", code, cancelled });
  fire("exit", project, code, cancelled);
}

/** a whole run, as after a click on "Abgleich starten" (frozen: done at once) */
async function simulate(project: string, resume: boolean) {
  runProject = project; cancelReq = false;
  if (!resume) runLog[project] = [];
  const tick = frozen ? 0 : 180;
  for (const id of STEP_IDS) {
    if (cancelReq) break;
    if (resume && runLog[project].some((e) => e.type === "step" && e.id === id && e.state === "done")) continue;
    if (id === "plausibility") { send(project, step(id, "skipped", 100)); continue; }
    for (let p = 0; p <= 100 && !cancelReq; p += id === "motion" ? 8 : 20) {
      send(project, step(id, "running", p, { eta_s: p >= 8 ? Math.round((150 * (100 - p)) / p) : undefined }));
      if (tick) await wait(tick);
    }
    if (cancelReq) break;
    send(project, step(id, "done", 100, { seconds: Math.round(20 + Math.random() * 40) }));
    if (id === "motion") { send(project, ST.motion); send(project, ST.area1); }
    if (id === "rotation") send(project, ST.rotation);
    if (id === "route_search") { send(project, ST.peak); send(project, ST.area2); }
  }
  if (cancelReq) { exit(project, 130, true); return; }
  send(project, resultEvents(VERDICT, !!SC.difficult, false).find((e) => e.type === "result")!);
  const p = projects.find((x) => x.id === project);
  if (p) p.has_result = true;
  exit(project, 0, false);
}

/** the run of the scenario, started at boot */
function bootRun() {
  const r = SC.run;
  if (!r) return;
  const id = "demo-1";
  if (r === "cancelled" || r === "failed") {
    runLog[id] = stepsDone(3, ST, false);
    if (r === "failed") runLog[id].push(step("route_search", "running", 34), { type: "log", level: "error", message: "MemoryError: the search area needs 9.6 GB, 6.1 GB are free" }, step("route_search", "failed"));
    runLog[id].push({ type: "exit", code: r === "failed" ? 3 : 130, cancelled: r === "cancelled" });
    return;
  }
  runProject = id; runLog[id] = [];
  if (r === "start") return;
  if (r === "stream") { later(() => send(id, { type: "input", state: "growing", pct: 58, bytes: 1_700_000_000, total: 2_930_000_000 })); return; }
  const at = Number(qp("at") ?? (r === "parallel" ? 41 : 63));
  if (r === "parallel") {
    // motion, rotation and map at the same time (goal 2)
    const tickPar = (p: number) => { send(id, step("motion", "running", p, { eta_s: 300 })); send(id, step("rotation", "running", Math.max(0, p - 3))); send(id, step("map", p >= 60 ? "done" : "running", Math.min(100, p * 1.6), p >= 60 ? { seconds: 48 } : {})); };
    later(() => { tickPar(at); if (!frozen) { let p = at; const t = setInterval(() => { if (runProject !== id) return clearInterval(t); p = Math.min(95, p + 1); tickPar(p); }, 1000); } });
    return;
  }
  later(() => {
    for (const e of stepsDone(3, ST, false)) send(id, e);
    send(id, step("plausibility", "skipped", 100));
    send(id, step("route_search", "running", at, { eta_s: Math.round((400 * (100 - at)) / 100) }));
    if (!frozen) { let p = at; const t = setInterval(() => { if (runProject !== id) return clearInterval(t); p = Math.min(97, p + 0.5); send(id, step("route_search", "running", p, { eta_s: Math.round(4 * (100 - p)) })); }, 700); }
  });
}

// ---------------------------------------------------------------- import
let impProgress: ImportProgress | null = null, impCancel = false;
const OUT = (project: string | null) => `/Users/demo/Library/Application Support/org.video2gpx.app/projects/${project ?? "Projekt"}/import`;
const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function resolve(template: string, accepts: ImportTemplate["accepts"] | null, input: string, project: string | null): ImportResolved {
  const errors: string[] = [], warnings: string[] = [];
  if (!template.includes("{input}")) errors.push("Der Platzhalter {input} fehlt.");
  if (!template.includes("{out}")) warnings.push("Der Platzhalter {out} fehlt: Der Befehl muss die Datei selbst in den Import-Ordner legen ($OUT).");
  const v = input.trim();
  const isUrl = /^https?:\/\//i.test(v), isPath = v.startsWith("/") || v.startsWith("~/");
  if (!v) errors.push("Bitte eine Adresse oder einen Dateipfad eingeben.");
  else if (!isUrl && !isPath) errors.push("Das ist weder eine Adresse (https://…) noch ein Dateipfad.");
  else if (accepts === "url" && !isUrl) errors.push("Diese Vorlage erwartet eine Adresse (URL), keinen Dateipfad.");
  else if (accepts === "path" && !isPath) errors.push("Diese Vorlage erwartet einen Dateipfad, keine Adresse (URL).");
  const words = template.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const program = (words[0] ?? "").replace(/^["']|["']$/g, "");
  let tool: ToolCheck | null = null;
  if (program === "yt-dlp") { tool = env().ytdlp ?? null; if (!tool?.ok) errors.push("Programm nicht gefunden: yt-dlp"); }
  const known = ["cp", "rsync", "curl", "yt-dlp", "scp", "wget"];
  if (program && !known.includes(program) && !program.startsWith("/")) errors.push(`Programm nicht gefunden: ${program}`);
  const out = OUT(project);
  const argv = [program === "yt-dlp" && tool?.ok ? tool.path! : program === "cp" ? "/bin/cp" : program,
    ...words.slice(1).map((w) => w.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").replace(/\{input\}/g, v.replace(/^~\//, "/Users/demo/")).replace(/\{out\}/g, out))];
  return { display: argv.map(shq).join(" "), errors, warnings, argv, tool };
}

function bootImport() {
  if (!SC.import) return;
  const unknown = qp("total") === "unknown";
  // running-stream: the run of demo-1 follows this import, so both report the same amount
  const pj = SC.run === "stream" ? "demo-1" : "demo-import", pct = SC.run === "stream" ? 58 : 42;
  impProgress = { project: pj, phase: "downloading", pct: unknown ? null : pct, bytes: SC.run === "stream" ? 1_700_000_000 : 1_230_000_000, total: unknown ? null : 2_930_000_000, rate: 11_000_000, eta_s: unknown ? null : 154,
    title: "Route des Grandes Alpes – Col de l'Iseran", file: `${OUT(pj)}/Route des Grandes Alpes.mp4.part`, processable: false };
  later(() => {
    fire("ip", { ...impProgress });
    ["[youtube] Extracting URL: https://example.org/watch?v=demo", "[info] Downloading 1 format(s): 399", `[download] Destination: ${impProgress!.file}`, "[download]  42.0% of    2.73GiB at   10.49MiB/s ETA 02:34"]
      .forEach((l) => fire("il", pj, "stdout", l));
    if (SC.import === "error") {
      fire("il", pj, "stderr", "ERROR: [youtube] demo: Requested format is not available.");
      impProgress = null;
      fire("id", { project: pj, ok: false, code: 1, error: "Der Befehl endete mit Code 1.", tail: ["[info] Downloading 1 format(s): 399", "[download]  42.0% of    2.73GiB at   10.49MiB/s ETA 02:34", "ERROR: [youtube] demo: Requested format is not available."] });
    }
  });
}

async function runImport(project: string, input: string) {
  impCancel = false;
  const total = 2_930_000_000, title = /^https?:/.test(input) ? "Route des Grandes Alpes – Col de l'Iseran" : input.split("/").pop()!.replace(/\.[^.]+$/, "");
  impProgress = { project, phase: "starting", pct: null, bytes: null, total: null, rate: null, eta_s: null, title: null, file: null, processable: false };
  fire("ip", { ...impProgress });
  fire("il", project, "stdout", `[info] ${input}`);
  await wait(300);
  for (let b = 0; b <= total && !impCancel; b += total / (frozen ? 1 : 24)) {
    impProgress = { ...impProgress, phase: "downloading", title, bytes: Math.round(b), total, pct: (100 * b) / total, rate: 48e6, eta_s: Math.round((total - b) / 48e6), file: `${OUT(project)}/${title}.mp4` };
    fire("ip", { ...impProgress });
    fire("il", project, "stdout", `[download] ${((100 * b) / total).toFixed(1)}% of 2.73GiB`);
    send(project, { type: "input", state: "growing", pct: impProgress.pct ?? null, bytes: impProgress.bytes ?? 0, total }); // only reaches a run that waits for it
    if (!frozen) await wait(250);
  }
  impProgress = null;
  if (impCancel) { fire("id", { project, ok: false, cancelled: true, error: "Abgebrochen", code: null, tail: [] }); queuedFail(project, true); return; }
  fire("id", { project, ok: true, file: "/mock/test.mp4", code: 0, tail: [] });
  if (queued?.project === project) { const q = queued; queued = null; send(project, { type: "input", state: "complete", pct: 100, bytes: total, total }); void simulate(q.project, false); }
}

/** a run started during the import (follow_import): it waits here until the import ends, as the backend does */
let queued: { project: string } | null = SC.run === "stream" ? { project: "demo-1" } : null;
function queuedFail(project: string, cancelled: boolean) {
  if (queued?.project !== project) return;
  queued = null; exit(project, null, cancelled);
}

// ---------------------------------------------------------------- Incyclist export and elevation
const demFiles: DemFile[] = EL.state.tile ? [{ name: DEM_TILE, sea: false, bytes: 43_277_344, path: `/app/dem/${DEM_TILE}.tif` }] : [];
const webm = qp("video") === "webm";
function mockInfo(o: IncyclistOptions): IncyclistInfo {
  const v = webm
    ? { path: "/mock/madone.webm", name: "Route du Col de la Madone 4K HDR [aBcDeFgHiJk].webm", bytes: 9_084_784_494, container: "matroska,webm", codec: "av1", width: 3840, height: 2160, r_frame_rate: "50/1", fps: 50, duration: 3064.7, nb_frames: null, transfer: "smpte2084", hdr: true, audio: "opus", start_time: 0 }
    : { path: "/mock/test.mp4", name: "test.mp4", bytes: 1_724_974_835, container: "mov,mp4,m4a,3gp,3g2,mj2", codec: "h264", width: 3840, height: 2160, r_frame_rate: "30/1", fps: 30, duration: VIDEO_S, nb_frames: 5400, transfer: "", hdr: false, audio: "aac", start_time: 0 };
  const enc = (o.sdr && v.hdr) || (o.max_height !== null && o.max_height < v.height);
  const remux = !enc && (webm || (!!v.audio && o.drop_audio));
  const outH = o.max_height !== null && o.max_height < v.height ? o.max_height : v.height;
  const plan = o.convert === false ? { mode: "original" as const, reasons: [`Originaldatei (.${webm ? "webm" : "mp4"}) wird unverändert übernommen, keine Umwandlung`], est_bytes: v.bytes, est_seconds: v.bytes / 400e6, out_height: v.height }
    : enc ? { mode: "encode" as const, reasons: [o.sdr && v.hdr ? "HDR → SDR" : "", outH < v.height ? `auf ${outH}p verkleinern` : ""].filter(Boolean), est_bytes: Math.round(((outH > 1440 ? 35 : outH > 1080 ? 20 : 10) * 1e6 / 8) * v.duration), est_seconds: v.duration * 1.5, out_height: outH }
    : remux ? { mode: "remux" as const, reasons: [webm ? "matroska → MP4 (Videospur unverändert)" : "ohne Ton"], est_bytes: v.bytes, est_seconds: v.bytes / 150e6, out_height: v.height }
    : { mode: "copy" as const, reasons: ["MP4 wird unverändert übernommen"], est_bytes: v.bytes, est_seconds: v.bytes / 400e6, out_height: v.height };
  return { video: v, plan, est_bytes: plan.est_bytes + 2e6, start: { lat: CENTER[0], lon: CENTER[1] }, link: null, dem: EL.dem(), profile: EL.profileStatus(), preview: mockPreview };
}
let mockPreview: string | null = null;
const OPTS: IncyclistOptions = { title: "", name: "", country: "", drop_audio: true, sdr: false, max_height: null, folder: false, start_time: null };
let incCancel = false;
const INC_LABELS = ["Höhendaten prüfen", "GPX mit Höhen", "Video vorbereiten", "ZIP schreiben"];
function incDone(project: string, o: IncyclistOptions, dest: string) {
  const info = mockInfo(o), ele = EL.state.tile;
  fire("incd", { project, ok: true, result: { path: dest, bytes: info.est_bytes, folder: o.folder, name: o.name || "FR_Pontaix", id: "video2gpx-0123456789abcdef", length_m: 1620, ascent_m: ele ? 67 : null, has_ele: ele, start_frame: 31, note: ele ? null : "Höhendaten fehlen; Export ohne Höhen (Incyclist fährt die Strecke flach)", seconds: 8.3, plan: info.plan, video: { mode: info.plan.mode } } });
}
async function mockExport(project: string, o: IncyclistOptions, dest: string) {
  incCancel = false;
  const info = mockInfo(o);
  const steps = [1, 6, info.plan.mode === "copy" || info.plan.mode === "original" ? 1 : info.plan.mode === "remux" ? 14 : 30, 12];
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k <= steps[i]; k++) {
      if (incCancel) { fire("incd", { project, ok: false, cancelled: true }); return; }
      fire("incp", { project, step: i + 1, of: 4, label: INC_LABELS[i], pct: (100 * k) / steps[i], message: i === 2 ? info.plan.reasons.join(", ") : "" });
      if (!frozen) await wait(120);
    }
  }
  incDone(project, o, dest);
}
function bootExport() {
  if (SC.export === "running") later(() => fire("incp", { project: "demo-1", step: 3, of: 4, label: INC_LABELS[2], pct: 62, message: "ohne Ton" }), 400);
  if (SC.export === "done") later(() => incDone("demo-1", { ...OPTS, name: "FR_Pontaix" }, "/Users/demo/Desktop/FR_Pontaix.zip"), 400);
}

// ---------------------------------------------------------------- the Api
export function createMockApi(): Api {
  if (SC.offline) (window as any).__v2gTiles = "http://127.0.0.1:9/{z}/{x}/{y}.png";
  bootRun(); bootImport(); bootExport();
  let dlTimer: any;
  return {
    mock: true,
    settingsGet: async () => structuredClone(settings),
    settingsSet: async (s) => { Object.assign(settings, structuredClone(s)); },
    envCheck: async () => { await wait(frozen ? 0 : 250); return env(); },
    projectList: async () => [...projects].sort((a, b) => b.updated - a.updated).map((p) => ({ ...p })),
    projectCreate: async (name, video) => { const p: ProjectApp = { id: "p" + Date.now(), name, video: video ?? null, created: Date.now(), updated: Date.now() }; projects.unshift(p); return { ...p }; },
    projectSave: async (id, data) => { const i = projects.findIndex((p) => p.id === id); if (i >= 0) projects[i] = { ...data, updated: Date.now() }; },
    projectDelete: async (id) => { const i = projects.findIndex((p) => p.id === id); if (i >= 0) projects.splice(i, 1); },
    projectOpen: async (id): Promise<OpenProject> => {
      const app = projects.find((p) => p.id === id);
      if (!app) throw new Error(`Projekt nicht gefunden: ${id}`);
      const has = !!app.has_result;
      const events = runLog[id]?.length ? runLog[id] : has ? resultEvents(id === "demo-1" ? VERDICT : app.verdict ?? "confident", !!SC.difficult, !!SC.hints) : [];
      return { app: { ...app }, dir: "/mock/" + id, import_dir: OUT(id), out_dir: "/mock/" + id + "/out", has_result: has, events: [...events] };
    },
    allowVideo: async () => {},
    mediaUrl: async (path) => (SC.frames || qp("video") === "frames" ? "/mock/does-not-play.mkv" : path.startsWith("/mock/") && path !== "/mock/test.mp4" ? "/mock/does-not-play.mkv" : "/mock/test.mp4"),
    videoProbe: async (path) => {
      if (path.startsWith("/Volumes/") && SC.project === "videomissing") throw new Error(`Datei nicht gefunden: ${path}`);
      if (path.includes("missing")) throw new Error(`Datei nicht gefunden: ${path}`);
      return { ...PROBE, path, title: path.startsWith("/mock/") ? PROBE.title : path.split("/").pop()!.replace(/\.[^.]+$/, "") };
    },
    videoPoster: async () => "/mock/poster.jpg",
    videoPlayback: async (_project, path) => path,
    videoFrames: async () => { await wait(200); return { dir: "/mock/frames", times: Array.from({ length: 36 }, (_, i) => i * 5) }; },
    pbfList: async () => PBFS.map((p) => ({ ...p })),
    pbfLink: async (path) => { const p = { path, name: path.split("/").pop()!, bytes: 4e8, bbox: [43, 6, 45, 8] as [number, number, number, number], linked: true, missing: false }; PBFS.push(p); return p; },
    pbfRemove: async (path) => { const i = PBFS.findIndex((p) => p.path === path); if (i >= 0) PBFS.splice(i, 1); },
    geofabrikCandidates: async () => { await wait(frozen ? 0 : 400); return [
      { id: "norway", name: "Norway", parent: "europe", url: "https://download.geofabrik.de/europe/norway-latest.osm.pbf", bytes: 1_310_000_000, file: "norway.osm.pbf" },
      { id: "europe", name: "Europe", parent: "", url: "https://download.geofabrik.de/europe-latest.osm.pbf", bytes: 31_000_000_000, file: "europe.osm.pbf" },
    ]; },
    pbfDownload: async (id) => {
      let b = 0; const total = 1_310_000_000; clearInterval(dlTimer);
      dlTimer = setInterval(() => {
        b += 60_000_000; const p: DownloadProgress = { id, bytes: Math.min(b, total), total, rate: 24e6 }; fire("dlp", p);
        if (b >= total) { clearInterval(dlTimer); PBFS.push({ path: `/app/osm/${id}.osm.pbf`, name: `${id}.osm.pbf`, bytes: total, bbox: [57.9, 4.5, 71.2, 31.1], linked: false, missing: false }); fire("dld", { id, ok: true }); }
      }, 300);
    },
    pbfDownloadCancel: async () => { clearInterval(dlTimer); fire("dld", { id: "x", ok: false, cancelled: true }); },
    geoSearch: async (q) => { await wait(frozen ? 0 : 300); return [{ name: `${q}, Drôme, Auvergne-Rhône-Alpes, France`, lat: CENTER[0], lon: CENTER[1], bbox: [CENTER[0] - 0.1, CENTER[1] - 0.15, CENTER[0] + 0.1, CENTER[1] + 0.15] }]; },
    geoSuggest: async (title) => {
      await wait(frozen ? 0 : 600);
      if (SC.project === "nosuggest") return { found: false, tried: [{ query: title, hits: 0 }] };
      return { found: true, query: "Pontaix", hit: { name: "Pontaix, Die, Drôme, Auvergne-Rhône-Alpes, France", lat: CENTER[0], lon: CENTER[1], bbox: null }, local_pbf: PBFS[0].path, tried: [{ query: title, hits: 0 }, { query: "Pontaix", hits: 1 }] };
    },
    pipelineStart: async (p: RunParams) => {
      if (runProject || queued) throw new Error("Es läuft bereits eine Berechnung");
      if (p.follow_import && impProgress?.project === p.project) { queued = { project: p.project }; runLog[p.project] = []; send(p.project, { type: "input", state: "growing", pct: impProgress.pct ?? null, bytes: impProgress.bytes ?? 0, total: impProgress.total }); return; }
      if (!p.video) throw new Error("Video nicht gefunden: ");
      void simulate(p.project, p.resume);
    },
    pipelineStatus: async () => runProject ?? queued?.project ?? null,
    pipelineCancel: async () => {
      if (queued) { const q = queued; queued = null; exit(q.project, null, true); return true; }
      if (!runProject) return false;
      if (SC.run && runProject === "demo-1" && !cancelReq) { cancelReq = true; later(() => exit("demo-1", 130, true), frozen ? 0 : 400); return true; }
      cancelReq = true; return true;
    },
    pipelineRetime: async (_p, t) => ({ type: "result", gpx: "/mock/out/route.gpx", start_time: t, points: ROUTE.length }),
    resultLoad: async () => ({
      route_points: JSON.stringify({ meta: "mock", verdict: VERDICT, verdict_basis: "without decoy check", points: ROUTE, cuts: { times: [20], intro_end: 20, breaks: [] } }),
      project: JSON.stringify({
        verdict: VERDICT, verdict_basis: "without decoy check",
        verdict_detail: { reasons: VERDICT === "uncertain" ? ["mean posterior 0.84 < 0.9", "18 % of the time with posterior < 0.5"] : VERDICT === "no_route" ? ["calibration peak at the edge of the scan and flat", "heading noise 3.9x the bike level"] : [] },
        effective: { vehicle: "bike", traffic_side: "right", offset_m: 1.5, start_time: "2000-01-01T00:00:00Z" }, steps: { refine: { summary: { path_km: 1.62 } } }, pipeline_hash: "0123456789abcdef",
        hints_used: SC.hints === "hints" ? { start_bbox: [44.742, 5.245, 44.754, 5.262], end_bbox: null, frames_applied: true, tol_m: 150, hint_file: "tour.gpx", buffer_m: 300, fallback_used: false, route_hint_applied: true } : null,
      }),
      gpx: "/mock/out/route.gpx", gpx_bytes: 262144,
    }),
    gpxExport: async (_p, _d, ele = true) => ({ bytes: ele ? 301000 : 262144, ele, note: null }),
    hintImport: async (project) => { const h = hintText(qp("hint") === "kml"); const r = { name: h.name, path: `/mock/${project}/hint/${h.name}`, text: h.text }; hints[project] = r; return r; },
    hintRead: async (project) => (hints[project] ?? { text: hintText(false).text }).text,
    hintRemove: async (project) => { delete hints[project]; },
    atlasJobRead: async () => JSON.stringify(ATLAS_JOB),
    atlasHintDownload: async (project, _url, name) => { const r = { name, path: `/mock/${project}/hint/${name}`, text: hintText(false).text }; hints[project] = r; return r; },
    atlasResultWrite: async (dest, text) => ({ path: dest, bytes: text.length }),
    appVersion: async () => "0.1.0",
    importTemplates: async () => [...BUILTIN, ...(settings.import_templates ?? []).map((t) => ({ ...t, builtin: false }))],
    importResolve: async (project, req) => {
      const t = [...BUILTIN, ...(settings.import_templates ?? [])].find((x) => x.id === req.template_id);
      return t ? resolve(t.template, t.accepts, req.input, project) : { display: "", errors: [`Die Import-Vorlage „${req.template_id}“ gibt es nicht (mehr).`], tool: null };
    },
    importPreview: async (template, input) => resolve(template, null, input, null),
    importStart: async (project, req) => {
      if (impProgress) throw new Error("Es läuft schon ein Import.");
      const t = [...BUILTIN, ...(settings.import_templates ?? [])].find((x) => x.id === req.template_id);
      const r = t ? resolve(t.template, t.accepts, req.input, project) : null;
      if (!r || r.errors.length) throw new Error(r?.errors.join(" ") ?? "Unbekannte Vorlage");
      void runImport(project, req.input);
    },
    importCancel: async () => { if (!impProgress) return false; impCancel = true; if (SC.import) { const pj = impProgress.project; impProgress = null; fire("id", { project: pj, ok: false, cancelled: true, error: "Abgebrochen", code: null, tail: [] }); queuedFail("demo-1", true); } return true; },
    importStatus: async () => (impProgress ? { ...impProgress } : null),
    onImportProgress: (cb) => on("ip", cb),
    reveal: async () => {},
    incyclistInfo: async (_p, _v, o) => { await wait(frozen ? 0 : 150); return mockInfo(o); },
    incyclistExport: async (p, _v, o, dest) => { void mockExport(p, o, dest); },
    incyclistCancel: async () => { incCancel = true; return true; },
    incyclistPreviewSet: async (_p, path) => { if (!/\.(png|jpe?g)$/i.test(path)) throw "Nur PNG- oder JPEG-Bilder: Incyclist liest keine anderen Formate."; mockPreview = "/mock/poster.jpg"; return mockPreview; },
    incyclistPreviewClear: async () => { mockPreview = null; },
    demStatus: async () => { await wait(frozen ? 0 : 120); return EL.dem(); },
    demDownload: async () => {
      if (EL.state.downloading) throw new Error("Es läuft bereits ein Download der Höhendaten");
      EL.download(fire, wait, frozen);
    },
    demCancel: async () => { EL.state.cancel = true; },
    profileLoad: async (_p, recompute) => { await wait(frozen ? 0 : recompute ? 700 : 300); const r = EL.load(!!recompute); if (r.ready && demFiles.length === 0) demFiles.push({ name: DEM_TILE, sea: false, bytes: 43_277_344, path: "/app/dem/x.tif" }); return r; },
    profileDiag: async () => { await wait(frozen ? 0 : 200); return EL.diag(); },
    inspectSeries: async () => { await wait(frozen ? 0 : 450); return { ready: true, series: AN.series(), cached: false }; },
    inspectFrame: async (_p, t, _v, what) => { await wait(frozen ? 0 : qp("frame") === "slow" ? 3000 : 700); return AN.frame(t, what); },
    demList: async () => demFiles.map((d) => ({ ...d })),
    demRemove: async (name) => { const i = demFiles.findIndex((d) => d.name === name); if (i >= 0) demFiles.splice(i, 1); },
    geoCountry: async () => { await wait(frozen ? 0 : 400); return "FR"; },
    onIncyclistProgress: (cb) => on("incp", cb),
    onIncyclistDone: (cb) => on("incd", cb),
    onDemProgress: (cb) => on("demp", cb),
    onDemDone: (cb) => on("demd", cb),
    fileUrl: (path) => (path.startsWith("/mock/frames/") ? "/mock/poster.jpg" : path),
    onPipelineEvent: (cb) => on("pipeline", cb),
    onPipelineExit: (cb) => on("exit", cb),
    onImportLog: (cb) => on("il", cb),
    onImportDone: (cb) => on("id", cb),
    onDownloadProgress: (cb) => on("dlp", cb),
    onDownloadDone: (cb) => on("dld", cb),
    // the DOM drop of the browser stands in for the native one: any dropped file becomes /mock/test.mp4
    onFileDrop: async (cb, hover) => {
      window.addEventListener("dragover", (e) => { e.preventDefault(); hover(true); });
      window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) hover(false); });
      window.addEventListener("drop", (e) => { e.preventDefault(); hover(false); const f = e.dataTransfer?.files?.[0]?.name ?? ""; cb([/\.(png|jpe?g|webp|heic|gif)$/i.test(f) ? `/Users/demo/Pictures/${f}` : "/mock/test.mp4"]); });
    },
    pickVideo: async () => "/mock/test.mp4",
    pickPbf: async () => "/Users/demo/osm/extra.osm.pbf",
    pickFile: async () => "/opt/homebrew/bin/ffmpeg",
    pickHint: async () => "/Users/demo/Downloads/tour.gpx",
    pickImage: async () => "/Users/demo/Pictures/madone.jpg",
    pickSave: async (n) => "/Users/demo/Desktop/" + n,
    pickJob: async () => "/Users/demo/Downloads/aBcDeFgHiJk.v2g.json",
    pickSaveAtlas: async (n) => "/Users/demo/Desktop/" + n,
    pickSavePackage: async (n, folder) => "/Users/demo/Desktop/" + n + (folder ? "" : ".zip"),
    confirm: async (m) => window.confirm(m),
  };
}
