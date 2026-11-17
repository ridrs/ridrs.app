// Import by template: what the single field of the start page means, the templates, and the state of the running import.
import { api } from "../api";
import { S, bus, toast } from "../state";
import type { ImportDone, ImportProgress, ImportTemplate, Settings, ToolCheck } from "../types";
import { isVideoPath } from "../util";

export type Source =
  | { kind: "empty" }
  | { kind: "url"; input: string }
  | { kind: "file"; path: string; volume: boolean }
  | { kind: "unknown"; reason: "unknown" | "novideo" };

/** What the user typed or pasted: an address, a local video file, or neither. Pure; whether a path exists is checked by videoProbe. */
export function classifySource(raw: string): Source {
  let s = raw.trim();
  if (!s) return { kind: "empty" };
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s) || /^https?:\/\/(localhost|\[[0-9a-f:]+\])([:/][^\s]*)?$/i.test(s)) return { kind: "url", input: s };
  if (/^file:\/\//i.test(s)) { try { s = decodeURIComponent(s.replace(/^file:\/\/(localhost)?/i, "")); } catch { return { kind: "unknown", reason: "unknown" }; } }
  if (s.startsWith("/") || s.startsWith("~/")) {
    if (!isVideoPath(s)) return { kind: "unknown", reason: "novideo" };
    return { kind: "file", path: s, volume: s.startsWith("/Volumes/") };
  }
  return { kind: "unknown", reason: "unknown" };
}

/** the settings with the template fields filled (an older backend does not send them) */
export function settingsOf(s: Settings | null = S.settings): Required<Pick<Settings, "ytdlp" | "import_templates" | "import_default_url" | "import_default_copy">> {
  return { ytdlp: s?.ytdlp ?? "", import_templates: s?.import_templates ?? [], import_default_url: s?.import_default_url ?? "", import_default_copy: s?.import_default_copy ?? "" };
}

export let templates: ImportTemplate[] = [];
export async function loadTemplates(): Promise<ImportTemplate[]> {
  try { templates = await api.importTemplates(); } catch (e) { templates = []; toast(`Import-Vorlagen konnten nicht geladen werden: ${e}`, "error"); }
  bus.emit("templates");
  return templates;
}
export const templatesFor = (kind: "url" | "path") => templates.filter((t) => t.accepts === kind || t.accepts === "any");
/** the template chosen in the settings for this kind; without a choice: the only one that fits, else none */
export function defaultTemplate(kind: "url" | "path"): ImportTemplate | null {
  const st = settingsOf();
  const fit = templatesFor(kind);
  const id = kind === "url" ? st.import_default_url : st.import_default_copy;
  return fit.find((t) => t.id === id) ?? (kind === "path" ? fit.find((t) => t.builtin) : null) ?? (fit.length === 1 ? fit[0] : null);
}
/** the check of the tool a template needs (null: needs none, or the check has not run yet) */
export function toolOf(t: ImportTemplate | null): ToolCheck | null {
  const e = S.env;
  if (!t?.tool || !e) return null;
  return t.tool === "yt-dlp" ? e.ytdlp ?? null : e[t.tool];
}

export interface ImportState {
  project: string | null;
  /** name of the template, for "Wird geladen · <name>" */
  templateName: string; templateId: string; input: string;
  /** the exact line that runs */
  command: string;
  running: boolean;
  progress: ImportProgress | null;
  log: { stream: string; line: string }[];
  done: ImportDone | null;
}
export const imp: ImportState = { project: null, templateName: "", templateId: "", input: "", command: "", running: false, progress: null, log: [], done: null };

export const importPct = (): number | null => { const p = imp.progress; return !p ? null : p.bytes != null && p.total ? Math.min(100, (100 * p.bytes) / p.total) : p.pct ?? null; };
export const importingFor = (project: string | undefined | null) => !!project && imp.running && imp.project === project;

export async function startImport(project: string, t: ImportTemplate, input: string): Promise<boolean> {
  if (imp.running) { toast("Es läuft schon ein Import. Bitte abwarten oder abbrechen.", "error"); return false; }
  Object.assign(imp, { project, templateName: t.name, templateId: t.id, input, command: "", running: true, progress: null, log: [], done: null });
  bus.emit("import");
  try {
    const req = { template_id: t.id, input };
    const r = await api.importResolve(project, req);
    imp.command = r.display;
    if (r.errors.length) throw new Error(r.errors.join(" "));
    await api.importStart(project, req);
    return true;
  } catch (e) {
    imp.running = false;
    imp.done = { project, ok: false, error: e instanceof Error ? e.message : String(e) };
    bus.emit("import"); bus.emit("import-done", imp.done);
    return false;
  }
}

export async function retryImport(): Promise<boolean> {
  const t = templates.find((x) => x.id === imp.templateId);
  return !!t && !!imp.project && startImport(imp.project, t, imp.input);
}

export async function cancelImport() { await api.importCancel(); }

export function initImport() {
  void api.onImportProgress((p) => {
    if (!imp.running || imp.project !== p.project) Object.assign(imp, { project: p.project, running: true, done: null }); // an import this web view did not start (reload)
    const titleNew = !!p.title && p.title !== imp.progress?.title;
    imp.progress = p;
    bus.emit("import");
    if (titleNew) bus.emit("import-title", p.project, p.title);
  });
  void api.onImportLog((project, stream, line) => {
    if (project !== imp.project) return;
    imp.log.push({ stream, line });
    if (imp.log.length > 500) imp.log.splice(0, imp.log.length - 500);
    bus.emit("import-log");
  });
  void api.onImportDone((r) => {
    if (imp.project && r.project !== imp.project) return;
    imp.project ??= r.project;
    imp.running = false; imp.done = r;
    bus.emit("import"); bus.emit("import-done", r);
  });
  void api.importStatus().then((p) => { if (p && !imp.running) { Object.assign(imp, { project: p.project, running: true, progress: p, done: null }); bus.emit("import"); if (p.title) bus.emit("import-title", p.project, p.title); } }, () => {});
}

/** the German text of a finished import that did not deliver a video */
export function importErrorText(d: ImportDone): string {
  if (d.cancelled) return "Abgebrochen.";
  if (d.error) return d.code != null ? `Der Import ist fehlgeschlagen (Code ${d.code}). ${d.error}` : d.error;
  return d.code != null ? `Der Import ist fehlgeschlagen (Code ${d.code}).` : "Der Import ist fehlgeschlagen.";
}
