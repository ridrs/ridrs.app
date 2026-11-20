// Start: one field for an address or a file path, a file picker, the window as drop target, and the recent projects.
import { api } from "../api";
import { attachVideo, createFromFile, deleteProject, projectStatus, projectTitle, refreshProjects } from "../app/project";
import { go, routePath } from "../app/router";
import { classifySource, defaultTemplate, imp, startImport, templates, templatesFor, toolOf } from "../features/import";
import { S, bus, toast } from "../state";
import type { ImportTemplate, ProjectApp } from "../types";
import { btn, codeWell, disclosure, field, menu, setBtnLabel, setSoftDisabled, isSoftDisabled, toneIcon, uid } from "../ui/components";
import { icon } from "../ui/icons";
import { debounce, el, fmtDay, fmtDur, fmtSize, isVideoPath } from "../util";
import { revealLabel, thisComputer } from "../app/platform";
import { isJobPath, openJobFile } from "../features/atlasJob";

const RESPONSIBILITY = "Die App lädt nichts von sich aus. Was der Befehl tut und ob du das Video verwenden darfst, liegt bei dir.";
const RECENT = 6;
const DROP_TEXT = "… oder eine Videodatei oder Scenic-Job-Datei (.v2g.json) in dieses Fenster ziehen";
let input: HTMLInputElement, primary: HTMLButtonElement, lineEl: HTMLElement, listEl: HTMLElement, listHead: HTMLElement, dropText: HTMLElement, cardEl: HTMLElement;
let fld: ReturnType<typeof field>;
let tplSel: HTMLSelectElement, cmd: ReturnType<typeof codeWell>, cmdErr: HTMLElement, copyFirst: HTMLInputElement;
let showAll = false, busy = false, lastKind = "";

export function mountStart(root: HTMLElement) {
  input = el("input", { type: "text", class: "lg", placeholder: "https://… oder /Pfad/zum/video.mp4", spellcheck: false, autocomplete: "off", autocapitalize: "off",
    oninput: () => { fld.setError(null); update(); }, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } } });
  fld = field("Adresse oder Dateipfad", input);
  primary = btn("Öffnen", () => void submit(), { kind: "primary", size: "lg", attrs: { "data-primary": "" } });
  const reasonId = uid("why");
  primary.setAttribute("aria-describedby", reasonId);
  lineEl = el("div", { class: "src-line", id: reasonId, "aria-live": "polite" });
  tplSel = el("select", { "aria-label": "Import-Vorlage", onchange: () => update() });
  cmd = codeWell("", { label: "Genau dieser Befehl wird ausgeführt" });
  cmdErr = el("div", { class: "field-error", hidden: true });
  copyFirst = el("input", { type: "checkbox", onchange: () => update() });
  dropText = el("p", { class: "drop-text muted" }, DROP_TEXT);
  cardEl = el("div", { class: "panel start-card" },
    el("div", { class: "src-row" }, fld.el, btn("Datei wählen …", () => void pickVideo(), { size: "lg", icon: "folder" }), primary),
    lineEl, dropText,
    el("div", { class: "row wrap" }, btn("Scenic-Job öffnen …", () => void pickJob(), { size: "sm", icon: "map" }),
      el("span", { class: "small muted" }, "Job-Datei (.v2g.json) aus ridrs Scenic: Suchrahmen, Start, Ziel und Route sind dann schon gesetzt.")));
  listHead = el("div", { class: "list-head" });
  listEl = el("ul", { class: "projlist" });
  root.append(el("div", { class: "page narrow" },
    el("h1", { class: "display" }, "Video rein, GPX raus"),
    el("p", { class: "lead" }, `Ein Straßenvideo ohne GPS wird mit der OpenStreetMap-Karte abgeglichen. Heraus kommt eine GPX-Datei, deren Zeitstempel zum Video passen. Die Berechnung läuft auf ${thisComputer}.`),
    cardEl, el("section", { "aria-label": "Projekte" }, listHead, listEl)));
  for (const ev of ["projects", "run", "import"]) bus.on(ev, renderList);
  bus.on("templates", update); bus.on("env", update);
  bus.on("drag", (over: boolean) => { cardEl.classList.toggle("drop", over); dropText.textContent = over ? "Loslassen, um die Datei zu öffnen" : DROP_TEXT; });
  bus.on("pick-video", () => void pickVideo());
  update(); renderList();
}

export function showStart() {
  void refreshProjects();
  update();
  input.focus();
}

const chosenTemplate = (kind: "url" | "path"): ImportTemplate | null => templatesFor(kind).find((t) => t.id === tplSel.value) ?? defaultTemplate(kind);

const resolve = debounce(async (t: ImportTemplate, value: string) => {
  try {
    const r = await api.importResolve(null, { template_id: t.id, input: value });
    cmd.set(r.display);
    const notes = [...r.errors, ...(r.warnings ?? [])];
    cmdErr.hidden = !notes.length; cmdErr.textContent = notes.join(" ");
  } catch (e) { cmd.set(""); cmdErr.hidden = false; cmdErr.textContent = String(e); }
}, 150);

/** the line under the field: what was recognised, the template, the exact command; and the state of the primary button */
function update() {
  if (!input) return;
  const src = classifySource(input.value);
  let label = "Öffnen", block: string | null = null;
  const parts: (Node | string)[] = [];
  const kind = src.kind === "url" ? "url" : src.kind === "file" && src.volume && copyFirst.checked ? "path" : null;
  const key = `${src.kind}/${kind}/${templates.length}`;
  if (key !== lastKind) { // the template list only when the kind changes, so that the choice is kept while typing
    lastKind = key;
    if (kind) { const def = defaultTemplate(kind); tplSel.replaceChildren(...templatesFor(kind).map((t) => el("option", { value: t.id, selected: t.id === def?.id }, t.name))); }
  }
  if (src.kind === "empty") block = "";
  else if (src.kind === "url" || kind === "path") {
    label = "Importieren";
    const t = chosenTemplate(kind!);
    if (src.kind === "file") parts.push(el("label", { class: "check" }, copyFirst, " Zuerst in das Projekt kopieren"));
    if (!t) {
      block = src.kind === "url" ? "Für Adressen ist noch keine Import-Vorlage eingerichtet." : "Es gibt keine Vorlage zum Kopieren.";
      parts.push(el("div", { class: "row wrap" }, toneIcon("info"), el("span", {}, src.kind === "url" ? "Adresse erkannt. Für Adressen ist noch keine Import-Vorlage eingerichtet: Lege in den Einstellungen eine eigene Vorlage an (ein Befehl mit dem Platzhalter {input}). " : "Es gibt keine Vorlage zum Kopieren. "), el("a", { href: routePath.settings }, "Import-Vorlagen öffnen")));
    } else {
      const tool = toolOf(t);
      parts.push(el("div", { class: "row wrap" }, toneIcon("info"), el("span", {}, src.kind === "url" ? "Adresse erkannt · Vorlage: " : "Vorlage: "), tplSel));
      if (t.tool && tool && !tool.ok) {
        block = `Die Vorlage „${t.name}“ braucht das Programm ${t.tool}. Es ist nicht installiert.`;
        parts.push(el("div", { class: "row wrap bad-text" }, toneIcon("bad"), el("span", {}, block + " "), el("a", { href: routePath.tools }, "Werkzeuge öffnen")));
      }
      parts.push(disclosure("Befehl anzeigen", el("div", { class: "small muted" }, "Genau dieser Befehl wird ausgeführt:"), cmd.el, cmdErr, el("div", { class: "small muted" }, RESPONSIBILITY)));
      resolve(t, src.kind === "url" ? src.input : (src as { path: string }).path);
    }
  } else if (src.kind === "file") {
    parts.push(el("div", { class: "row wrap" }, toneIcon("ok"), el("span", {}, src.volume ? "Datei auf einem Netzlaufwerk oder Wechselmedium erkannt · " : "Datei erkannt"), src.volume ? el("label", { class: "check" }, copyFirst, " Zuerst in das Projekt kopieren") : null));
  }
  // keep the open state of the command disclosure and the focus while the line is rebuilt
  const wasOpen = !!lineEl.querySelector("details")?.open, focusSel = document.activeElement === tplSel, focusCopy = document.activeElement === copyFirst;
  lineEl.replaceChildren(...parts);
  const d = lineEl.querySelector("details"); if (d) d.open = wasOpen;
  if (focusSel && tplSel.isConnected) tplSel.focus();
  if (focusCopy && copyFirst.isConnected) copyFirst.focus();
  setBtnLabel(primary, busy ? "Einen Moment …" : label);
  setSoftDisabled(primary, block !== null || busy);
}

async function submit() {
  if (busy) return;
  const src = classifySource(input.value);
  if (src.kind === "empty") { input.focus(); return; }
  if (src.kind === "unknown") {
    fld.setError(src.reason === "novideo" ? "Das ist keine Videodatei. Unterstützt: mp4, mov, m4v, mkv, webm, avi, mts, ts, mpg." : "Das ist weder eine Adresse (https://…) noch der Pfad einer Videodatei.");
    input.focus(); return;
  }
  if (isSoftDisabled(primary)) { lineEl.querySelector<HTMLElement>("a")?.focus(); return; }
  busy = true; update();
  try {
    if (src.kind === "file" && !(src.volume && copyFirst.checked)) {
      try { await api.videoProbe(src.path); } catch { fld.setError(`Diese Datei gibt es nicht oder sie lässt sich nicht lesen: ${src.path}`); input.focus(); return; }
      const id = await createFromFile(src.path);
      if (id) { input.value = ""; go(routePath.project(id, "einrichten")); }
      return;
    }
    const t = chosenTemplate(src.kind === "url" ? "url" : "path");
    if (!t) return;
    if (imp.running) { toast("Es läuft schon ein Import. Bitte abwarten oder abbrechen.", "error"); return; }
    const value = src.kind === "url" ? src.input : src.path;
    const p = await api.projectCreate("Neues Projekt", null);
    await refreshProjects();
    void startImport(p.id, t, value);
    input.value = "";
    go(routePath.project(p.id, "einrichten"));
  } finally { busy = false; update(); }
}

export async function pickVideo() {
  const f = await api.pickVideo();
  if (f) await openFile(f);
}

/** a local video from the picker or a drop: a new project, or the video of the open project that has none */
export async function openFile(path: string) {
  if (S.cur && !S.cur.app.video && !(imp.running && imp.project === S.cur.app.id)) { await attachVideo(S.cur.app.id, path); return; }
  const id = await createFromFile(path);
  if (id) go(routePath.project(id, "einrichten"));
}
export function handleDrop(paths: string[]) {
  const job = paths.find(isJobPath);
  if (job) { void openJob(job); return; }
  const v = paths.find(isVideoPath);
  if (v) void openFile(v); else toast("Bitte eine Videodatei oder eine Scenic-Job-Datei (.v2g.json) ablegen. Unterstützt: mp4, mov, m4v, mkv, webm, avi, mts, ts, mpg.", "error");
}

/** an atlas job file: a new project with its hints, then Einrichten (the video is imported from there) */
async function openJob(path: string) {
  const id = await openJobFile(path);
  if (id) go(routePath.project(id, "einrichten"));
}
async function pickJob() {
  const f = await api.pickJob();
  if (!f) return;
  if (!isJobPath(f)) { toast("Bitte eine Job-Datei von ridrs Scenic wählen (Endung .v2g.json).", "error"); return; }
  await openJob(f);
}

function row(p: ProjectApp): HTMLElement {
  const st = projectStatus(p);
  const meta = [p.probe?.duration ? fmtDur(p.probe.duration) : null, p.bbox ? fmtSize(p.bbox) : null].filter(Boolean).join(" · ");
  const poster = p.poster ? el("img", { class: "poster", src: api.fileUrl(p.poster), alt: "", loading: "lazy" }) : el("span", { class: "poster none" }, icon("film"));
  const items = [{ label: "Löschen", icon: "trash" as const, danger: true, onclick: () => void deleteProject(p) }];
  return el("li", { class: "proj" },
    el("a", { class: "proj-main", href: routePath.project(p.id) }, poster,
      el("span", { class: "proj-text" }, el("span", { class: "proj-name" }, projectTitle(p)), el("span", { class: "small muted" }, meta || "–")),
      el("span", { class: `proj-status ${st.tone}` }, toneIcon(st.tone), st.text),
      el("span", { class: "proj-date small muted" }, fmtDay(p.updated))),
    menu(`Aktionen für ${projectTitle(p)}`, p.video ? [{ label: revealLabel, icon: "folder" as const, onclick: () => void api.reveal(p.video!) }, ...items] : items));
}

function renderList() {
  if (!listEl) return;
  const all = S.projects;
  listHead.replaceChildren(el("h2", {}, "Zuletzt verwendet"),
    all.length > RECENT ? btn(showAll ? "Weniger zeigen" : `Alle Projekte (${all.length})`, () => { showAll = !showAll; renderList(); }, { size: "sm", attrs: { "aria-expanded": String(showAll) } }) : "");
  if (!all.length) { listEl.replaceChildren(el("li", { class: "muted empty-list" }, "Noch keine Projekte. Wähle oben ein Video.")); return; }
  listEl.replaceChildren(...(showAll ? all : all.slice(0, RECENT)).map(row));
}
