// Projects: list, open, create from a local file, attach the video of an import.
import { api } from "../api";
import { active, afterOpen } from "../features/run";
import { VERDICT } from "../features/gloss";
import { imp } from "../features/import";
import { S, bus, freshRun, toast } from "../state";
import type { ProjectApp, VideoProbe } from "../types";
import type { Tone } from "../ui/components";
import { isVideoPath } from "../util";

export const projectTitle = (p: ProjectApp) => p.probe?.title ?? p.name;

export async function refreshProjects() {
  S.projects = await api.projectList();
  bus.emit("projects");
}

export function projectStatus(p: ProjectApp): { tone: Tone; text: string } {
  if (active.project === p.id) return { tone: "run", text: "Berechnung läuft" };
  if (!p.video) return imp.running && imp.project === p.id ? { tone: "run", text: "Video lädt" } : { tone: "warn", text: "Video fehlt" };
  if (p.has_result) return p.verdict ? { tone: VERDICT[p.verdict].tone, text: VERDICT[p.verdict].short } : { tone: "ok", text: "Ergebnis vorhanden" };
  return { tone: "wait", text: "noch nicht berechnet" };
}

/** Starts the one-time MP4 playback copy of a WebM/MKV in the background, so opening the project does not wait for it
 *  (the backend does nothing for other files; opening the project while it runs waits for this copy). */
function preparePlayback(projectId: string, path: string, probe: VideoProbe) {
  api.videoPlayback(projectId, path, probe.codec ?? "").catch((e) => toast(`Wiedergabekopie nicht möglich: ${e}`, "error"));
}

async function ensurePoster(app: ProjectApp) {
  if (!app.video || app.poster) return;
  try {
    const d = app.probe?.duration ?? 0;
    app.poster = await api.videoPoster(app.id, app.video, Math.min(10, d * 0.05), !!app.probe?.hdr);
    await api.projectSave(app.id, app);
  } catch (e) {
    toast(`Vorschaubild nicht möglich: ${e}`, "error");
  }
}

let openToken = 0;
/** Loads a project into the workspace. A run in another project keeps running. */
export async function openProject(id: string): Promise<boolean> {
  if (S.cur?.app.id === id) return true;
  const token = ++openToken;
  try {
    const open = await api.projectOpen(id);
    if (token !== openToken) return false;
    S.cur = open; S.run = freshRun(); S.result = null; S.showRoute = false; S.videoMissing = false;
    S.bbox = open.app.bbox ?? null; S.startFrame = open.app.start_frame ?? null; S.endFrame = open.app.end_frame ?? null;
    if (S.settings) S.settings.last_project = id;
    bus.emit("project", open.app);
    void ensurePoster(open.app).then(() => { if (S.cur === open) bus.emit("poster"); });
    void checkVideo();
    await afterOpen();
    return S.cur === open;
  } catch (e) {
    toast(`Projekt konnte nicht geöffnet werden: ${e}`, "error");
    return false;
  }
}

/** is the video file still there? (moved or deleted files are shown with "Neu zuordnen") */
async function checkVideo() {
  const cur = S.cur;
  if (!cur?.app.video) return;
  let missing = false;
  try { await api.videoProbe(cur.app.video); } catch { missing = true; }
  if (S.cur === cur && S.videoMissing !== missing) { S.videoMissing = missing; bus.emit("video-state"); }
}

export function closeProject() {
  if (!S.cur) return;
  openToken++;
  S.cur = null; S.bbox = null; S.startFrame = null; S.endFrame = null; S.result = null; S.run = freshRun(); S.videoMissing = false;
  bus.emit("project", null);
  void refreshProjects();
}

/** A new project on a local video (the file stays where it is; nothing is copied). Returns the project id. */
export async function createFromFile(path: string): Promise<string | null> {
  if (!isVideoPath(path)) { toast("Das ist keine Videodatei. Unterstützt: mp4, mov, m4v, mkv, webm, avi, mts, ts, mpg.", "error"); return null; }
  let probe: VideoProbe;
  try { probe = await api.videoProbe(path); } catch (e) { toast(`Diese Datei lässt sich nicht öffnen: ${path} (${e})`, "error"); return null; }
  const p = await api.projectCreate(probe.title, path);
  p.probe = probe;
  await api.projectSave(p.id, p);
  await api.allowVideo(path);
  preparePlayback(p.id, path, probe);
  await refreshProjects();
  return p.id;
}

/** Sets or replaces the video of a project (after an import, or "Neu zuordnen"). Frames, hints and options stay. */
export async function attachVideo(projectId: string, path: string): Promise<boolean> {
  let probe: VideoProbe;
  try { probe = await api.videoProbe(path); } catch (e) { toast(String(e), "error"); return false; }
  const isCur = S.cur?.app.id === projectId;
  const app = isCur ? S.cur!.app : (await api.projectOpen(projectId)).app;
  Object.assign(app, { video: path, probe, name: probe.title, poster: null });
  await api.projectSave(app.id, app);
  await api.allowVideo(path);
  if (!isCur) preparePlayback(app.id, path, probe);
  if (isCur) {
    S.videoMissing = false;
    await ensurePoster(app);
    bus.emit("video", app);
  }
  await refreshProjects();
  return true;
}

export async function deleteProject(p: ProjectApp): Promise<boolean> {
  if (active.project === p.id) { toast("In diesem Projekt läuft eine Berechnung. Bitte zuerst abbrechen.", "error"); return false; }
  if (!(await api.confirm(`Projekt „${p.name}“ mit allen Ergebnissen löschen? Das Originalvideo bleibt erhalten.`))) return false;
  await api.projectDelete(p.id);
  if (S.cur?.app.id === p.id) closeProject();
  await refreshProjects();
  return true;
}
