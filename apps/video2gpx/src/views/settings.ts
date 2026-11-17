// Einstellungen: Import-Vorlagen, Werkzeuge, Darstellung, Ortssuche, Entwickler, Über.
import { api } from "../api";
import { routePath } from "../app/router";
import { getTheme, setTheme, type Theme } from "../app/theme";
import { loadTemplates, settingsOf, templates, templatesFor, toolOf } from "../features/import";
import { S, bus, toast } from "../state";
import type { ImportTemplate, Settings, ToolId } from "../types";
import { banner, btn, codeWell, disclosure, field, segmented, statusRow, toneIcon, uid } from "../ui/components";
import { debounce, el } from "../util";
import { isMac } from "../app/platform";

const RESPONSIBILITY = "Die App lädt nichts von sich aus. Was der Befehl tut und ob du das Video verwenden darfst, liegt bei dir.";
const SAMPLE = { url: "https://example.org/video", path: "/Users/ich/Movies/fahrt.mp4", any: "https://example.org/video" };
const ACCEPTS: readonly (readonly [ImportTemplate["accepts"], string])[] = [["url", "Adressen"], ["path", "Dateien"], ["any", "beides"]];

let root: HTMLElement, tplList: HTMLElement, defaultsEl: HTMLElement, editorHost: HTMLElement, historyEl: HTMLElement, aboutEl: HTMLElement, devEl: HTMLElement;

const settings = (): Settings => S.settings as Settings;
async function save(patch: Partial<Settings>) {
  const s = { ...settings(), ...patch };
  await api.settingsSet(s);
  S.settings = s;
}

export function mountSettings(r: HTMLElement) {
  root = r;
  tplList = el("ul", { class: "tpl-list" });
  defaultsEl = el("div", { class: "row wrap gap-l" });
  editorHost = el("div", {});
  historyEl = el("div", {});
  aboutEl = el("div", { class: "stack" });
  devEl = el("div", {});
  const theme = segmented<Theme>("Darstellung", [["system", "System"], ["light", "Hell"], ["dark", "Dunkel"]], getTheme(), (t) => setTheme(t));
  const suggest = el("input", { type: "checkbox", id: uid("sg"), onchange: (e: Event) => void save({ suggest_online: (e.target as HTMLInputElement).checked }) });
  r.append(el("div", { class: "page narrow" },
    el("h1", {}, "Einstellungen"),
    section("Import-Vorlagen",
      el("p", {}, "Eine Vorlage ist ein Befehl mit Platzhaltern. video2gpx setzt die Adresse oder den Pfad für ", ph("{input}"), " und den Import-Ordner des Projekts für ", ph("{out}"), " ein und führt den Befehl erst aus, wenn du auf „Importieren“ klickst."),
      el("p", { class: "help" }, RESPONSIBILITY),
      defaultsEl, tplList, el("div", {}, btn("Neue Vorlage …", () => openEditor(null), { icon: "edit" })), editorHost, historyEl),
    section("Werkzeuge", el("p", {}, "ffmpeg und ffprobe sind nötig, yt-dlp nur für Vorlagen, die es aufrufen. Prüfen, installieren und eigene Pfade: ", el("a", { href: routePath.tools }, "Werkzeuge öffnen"), ".")),
    section("Darstellung", el("div", { class: "field" }, el("div", { class: "label-text", id: "theme-l" }, "Farben"), theme.el), el("p", { class: "help" }, "„System“ folgt der Einstellung von macOS.")),
    section("Ortssuche", el("label", { class: "check" }, suggest, " Suchrahmen automatisch aus dem Videotitel vorschlagen"), el("p", { class: "help" }, "Schickt den Titel des Videos an Nominatim (OpenStreetMap, online), wenn ein Projekt noch keinen Suchrahmen hat.")),
    section("Entwickler", devEl),
    section("Über", aboutEl)));
  theme.el.setAttribute("aria-labelledby", "theme-l");
  window.addEventListener("themechange", () => theme.set(getTheme()));
  bus.on("templates", renderTemplates); bus.on("env", () => { renderTemplates(); renderAbout(); });
  const sync = () => { suggest.checked = !!S.settings?.suggest_online; };
  bus.on("settings", sync);
  sync();
}

export function showSettings() {
  void loadTemplates();
  renderTemplates(); renderAbout(); renderDev();
  bus.emit("settings");
}

const section = (title: string, ...body: (Node | string)[]) => el("section", { class: "panel stack", "aria-labelledby": `set-${title}` }, el("h2", { id: `set-${title}` }, title), ...body);
const ph = (t: string) => el("span", { class: "ph mono" }, t);

// ---------------------------------------------------------------- templates
function renderTemplates() {
  if (!root || !S.settings) return;
  const st = settingsOf();
  const sel = (kind: "url" | "path", label: string) => {
    const opts = templatesFor(kind);
    const cur = kind === "url" ? st.import_default_url : st.import_default_copy;
    const s = el("select", { onchange: () => void save(kind === "url" ? { import_default_url: s.value } : { import_default_copy: s.value }).then(() => bus.emit("templates")) },
      el("option", { value: "", selected: !opts.some((t) => t.id === cur) }, opts.length ? "keine" : "keine passende Vorlage"), ...opts.map((t) => el("option", { value: t.id, selected: t.id === cur }, t.name)));
    return field(label, s).el;
  };
  defaultsEl.replaceChildren(sel("url", "Für Adressen (URLs)"), sel("path", "Für Dateien zum Kopieren"));
  tplList.replaceChildren(...templates.map(tplRow));
  if (!templates.length) tplList.append(el("li", { class: "muted" }, "Keine Vorlagen."));
  const hist = settings().import_history ?? [];
  historyEl.replaceChildren();
  if (hist.length) historyEl.append(disclosure(`Frühere Befehle (${hist.length})`,
    el("p", { class: "help" }, "Befehle aus dem früheren Import-Dialog. Übernimm einen als Vorlage und ersetze darin die Adresse oder den Pfad durch {input} und den Zielordner durch {out}."),
    el("ul", { class: "rows" }, ...hist.map((c) => el("li", { class: "data-row" }, el("code", { class: "mono grow wrap-any" }, c), btn("Als Vorlage übernehmen", () => openEditor({ id: "", name: "", template: c, builtin: false, accepts: "any", tool: null }), { size: "sm" }))))));
}

function tplRow(t: ImportTemplate): HTMLElement {
  const tool = toolOf(t);
  const status = t.tool ? (tool ? (tool.ok ? statusRow("ok", "", `${t.tool}${tool.version ? ` ${tool.version}` : ""} gefunden`) : el("span", { class: "row" }, statusRow("bad", "", `${t.tool} nicht gefunden`), el("a", { href: routePath.tools }, "Werkzeuge"))) : null) : null;
  const actions = t.builtin
    ? [btn("Als eigene Vorlage kopieren", () => openEditor({ ...t, id: "", name: `${t.name} (Kopie)`, builtin: false }), { size: "sm", icon: "copy" })]
    : [btn("Bearbeiten", () => openEditor(t), { size: "sm", icon: "edit", attrs: { "aria-label": `${t.name} bearbeiten` } }), btn("Löschen", () => void removeTpl(t), { size: "sm", kind: "danger", icon: "trash", attrs: { "aria-label": `${t.name} löschen` } })];
  return el("li", { class: "tpl" },
    el("div", { class: "tpl-head" }, el("b", {}, t.name), el("span", { class: "chip" }, t.builtin ? "mitgeliefert" : "eigene"), el("span", { class: "small muted" }, `für ${ACCEPTS.find((a) => a[0] === t.accepts)?.[1]}`), status, el("span", { class: "spacer" }), ...actions),
    codeWell(t.template, { marks: true, label: `Befehl der Vorlage ${t.name}` }).el);
}

async function removeTpl(t: ImportTemplate) {
  if (!(await api.confirm(`Vorlage „${t.name}“ löschen?`))) return;
  const st = settingsOf();
  await save({ import_templates: st.import_templates.filter((x) => x.id !== t.id), ...(st.import_default_url === t.id ? { import_default_url: "" } : {}), ...(st.import_default_copy === t.id ? { import_default_copy: "cp" } : {}) });
  await loadTemplates();
}

const toolFor = (cmd: string): ToolId | null => { const p = cmd.trim().split(/\s+/)[0]?.split("/").pop() ?? ""; return p === "yt-dlp" || p === "ffmpeg" || p === "ffprobe" ? p : null; };

/** the editor: name, command with placeholder buttons, input kind, live preview from the backend (importPreview) */
function openEditor(t: ImportTemplate | null) {
  const editing = t && t.id ? t : null;
  const name = el("input", { type: "text", value: t?.name ?? "", autocomplete: "off" });
  const cmd = el("input", { type: "text", class: "mono", value: t?.template ?? "", spellcheck: false, autocomplete: "off", placeholder: "z. B. rsync --progress nas:{input} {out}/" });
  let accepts: ImportTemplate["accepts"] = t?.accepts ?? "url";
  const sample = el("input", { type: "text", class: "mono", value: SAMPLE[accepts], spellcheck: false });
  const acc = segmented("Gedacht für", ACCEPTS, accepts, (v) => { if (sample.value === SAMPLE[accepts]) sample.value = SAMPLE[v]; accepts = v; preview(); });
  const out = codeWell("", { label: "Vorschau des Befehls" });
  const errs = el("ul", { class: "errs", "aria-live": "polite" });
  const fName = field("Name", name), fCmd = field("Befehl", cmd, el("span", {}, "Platzhalter einfügen: ", ...["{input}", "{out}"].map((p) => btn(p, () => insert(p), { size: "sm", attrs: { class: "btn sm ph-btn mono" } }))));
  const insert = (p: string) => {
    const a = cmd.selectionStart ?? cmd.value.length, b = cmd.selectionEnd ?? a;
    cmd.setRangeText(p, a, b, "end"); cmd.focus(); preview();
  };
  let problems: string[] = [];
  const check = async () => {
    const r = await api.importPreview(cmd.value, sample.value).catch((e) => ({ display: "", errors: [String(e)], warnings: [], tool: null }));
    out.set(r.display);
    const dup = templates.some((x) => x.name.trim().toLowerCase() === name.value.trim().toLowerCase() && x.id !== editing?.id);
    // a missing program or a sample that does not fit do not make the template wrong: notes, not errors
    const soft = (e: string) => /Programm nicht gefunden|Adresse|Dateipfad|eingeben/.test(e);
    problems = [...(name.value.trim() ? [] : ["Bitte einen Namen eingeben."]), ...(dup ? ["Der Name ist schon vergeben."] : []), ...r.errors.filter((e) => !soft(e))];
    const notes = [...r.errors.filter(soft), ...(r.warnings ?? [])];
    errs.replaceChildren(...problems.map((p) => el("li", { class: "bad-text" }, toneIcon("bad"), p)), ...notes.map((w) => el("li", { class: "warn-text" }, toneIcon("warn"), w)));
  };
  const preview = debounce(() => void check(), 150);
  for (const i of [name, cmd, sample]) i.addEventListener("input", preview);
  const close = () => { editorHost.replaceChildren(); };
  const saveBtn = btn("Speichern", async () => {
    await check();
    if (problems.length) { errs.querySelector("li")?.scrollIntoView({ block: "nearest" }); cmd.focus(); return; }
    const st = settingsOf();
    const tpl: ImportTemplate = { id: editing?.id ?? `user-${Date.now().toString(36)}`, name: name.value.trim(), template: cmd.value.trim(), builtin: false, accepts, tool: toolFor(cmd.value) };
    const list = editing ? st.import_templates.map((x) => (x.id === tpl.id ? tpl : x)) : [...st.import_templates, tpl];
    await save({ import_templates: list, ...(!editing && accepts !== "path" && !st.import_default_url ? { import_default_url: tpl.id } : {}) });
    await loadTemplates();
    close();
    toast(`Vorlage „${tpl.name}“ gespeichert.`);
  }, { kind: "primary" });
  const box = el("div", { class: "panel inset stack editor", role: "group", "aria-label": editing ? "Vorlage bearbeiten" : "Neue Vorlage" },
    el("h3", {}, editing ? "Vorlage bearbeiten" : "Neue Vorlage"),
    fName.el, fCmd.el,
    el("div", { class: "field" }, el("div", { class: "label-text" }, "Gedacht für"), acc.el),
    field("Vorschau mit", sample).el, out.el, errs,
    el("div", { class: "row end" }, btn("Abbrechen", close), saveBtn));
  editorHost.replaceChildren(box);
  box.scrollIntoView({ block: "nearest" });
  name.focus();
  preview();
}

// ---------------------------------------------------------------- developer, about
function renderDev() {
  const s = { ...settings() };
  const f = (label: string, key: "python" | "rsm_dir" | "sidecar", help: string) => {
    const inp = el("input", { type: "text", class: "mono", value: s[key], spellcheck: false, onchange: () => void save({ [key]: inp.value.trim() } as Partial<Settings>).then(recheck) });
    return field(label, inp, help).el;
  };
  const fields = el("div", { class: "stack", hidden: !s.dev_mode },
    f("Python-Interpreter", "python", "Muss „rsm.pipeline“ importieren können. Standard: .venv des Forschungspakets."),
    f("Pipeline-Ordner (rsm)", "rsm_dir", "Ordner mit dem Paket „rsm“ (Arbeitsverzeichnis und PYTHONPATH)."),
    f("Anderes Sidecar (optional)", "sidecar", "Ausführbare Datei eines PyInstaller-Sidecars. Leer = Python."));
  const cb = el("input", { type: "checkbox", checked: s.dev_mode, onchange: async () => { fields.hidden = !cb.checked; await save({ dev_mode: cb.checked }); await recheck(); } });
  const d = disclosure("Entwicklermodus", el("label", { class: "check" }, cb, " Externes Python statt der eingebauten Pipeline (nur zum Entwickeln der Pipeline)"), fields);
  d.open = s.dev_mode;
  devEl.replaceChildren(d);
}
async function recheck() { S.env = await api.envCheck(); bus.emit("env"); }

function renderAbout() {
  if (!aboutEl) return;
  const e = S.env, p = e?.pipeline;
  aboutEl.replaceChildren(
    el("dl", { class: "facts" },
      el("dt", {}, "Berechnung"), el("dd", {}, p ? `${p.mode === "sidecar" ? "eingebaut" : "externes Python (Entwicklermodus)"} · Version ${p.version ?? "unbekannt"}` : "wird geprüft …"),
      el("dt", {}, "Code-Hash"), el("dd", { class: "mono" }, p?.code_hash ?? "–"),
      el("dt", {}, "Datenordner"), el("dd", { class: "mono wrap-any" }, e?.data_dir ?? "–")),
    el("div", { class: "row wrap" }, btn(isMac ? "Datenordner im Finder zeigen" : "Datenordner im Dateimanager zeigen", () => void api.reveal(e?.data_dir ?? ""), { size: "sm", icon: "folder", disabled: !e })),
    !e || (e.python.ok && e.rsm.ok) ? el("p", { class: "help" }, "Kartendaten © OpenStreetMap-Mitwirkende (ODbL). Höhendaten: Copernicus DEM GLO-30, wo geladen zusätzlich nationale und regionale Geländemodelle (IGN, INGV, Südtirol, swisstopo, BEV, Bayern, Hessen, NRW, NASADEM; Liste unter Kartendaten › Höhendaten). Lizenzen der mitgelieferten Bibliotheken: THIRD-PARTY-NOTICES im Programmpaket.")
      : banner("bad", "Die Berechnung ist nicht verfügbar. Einzelheiten unter Werkzeuge."));
}
