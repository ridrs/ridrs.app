// Werkzeuge: which programs the app needs on this Mac (ffmpeg, ffprobe; yt-dlp optional), how to install them, own paths.
import { api } from "../api";
import { go, routePath } from "../app/router";
import { pipelineReady, toolsReady } from "../features/run";
import { settingsOf } from "../features/import";
import { S, bus } from "../state";
import type { EnvCheck, Settings, ToolCheck } from "../types";
import { banner, btn, setBtnLabel, codeWell, disclosure, field, statusRow, type Tone } from "../ui/components";
import { el } from "../util";

let rowsEl: HTMLElement, installEl: HTMLElement, actionsEl: HTMLElement, root: HTMLElement;
let checking = false;
let againBtn: HTMLButtonElement;

export async function recheck() {
  if (checking) return;
  checking = true; render();
  try { S.env = await api.envCheck(); } catch { /* keep the old state */ }
  checking = false;
  bus.emit("env");
}

export function mountTools(r: HTMLElement) {
  root = r;
  rowsEl = el("div", { class: "tool-rows" });
  installEl = el("div", { class: "stack" });
  actionsEl = el("div", { class: "row end wrap" });
  r.append(el("div", { class: "page narrow" },
    el("h1", {}, "Werkzeuge"),
    el("p", { class: "lead" }, "video2gpx bringt die Berechnung mit. Zum Lesen der Videos braucht es zwei Programme, die auf diesem Mac installiert sein müssen: ffmpeg und ffprobe. yt-dlp ist nur nötig, wenn eine deiner Import-Vorlagen es verwendet."),
    el("div", { class: "panel stack" }, rowsEl, installEl, actionsEl)));
  bus.on("env", render);
  // returning from the Terminal updates the list without a click
  let last = 0;
  const onFocus = () => { if (document.visibilityState === "visible" && Date.now() - last > 3000) { last = Date.now(); void recheck(); } };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  render();
}

function toolRow(name: string, need: string, c: ToolCheck | undefined, optional: boolean, note = ""): HTMLElement {
  if (checking && !c) return statusRow("run", name, "wird geprüft …");
  const tone: Tone = c?.ok ? "ok" : optional ? "off" : "bad";
  const text = c?.ok ? [`gefunden: ${c.path ?? ""}`, c.version ? `Version ${c.version}` : null, c.warning].filter(Boolean).join(" · ") : `nicht gefunden${note ? ` (${note})` : ""}`;
  return statusRow(tone, el("span", {}, el("b", {}, name), " ", el("span", { class: "muted" }, need)), text);
}

function pathFields(): HTMLElement {
  const s = { ...(S.settings as Settings) };
  const st = settingsOf(s);
  const mk = (key: "ffmpeg" | "ffprobe" | "ytdlp", label: string) => {
    const inp = el("input", { type: "text", class: "mono", value: key === "ytdlp" ? st.ytdlp : s[key], placeholder: "leer = automatisch (PATH, Homebrew)", spellcheck: false,
      onchange: async () => { (s as any)[key] = inp.value.trim(); await api.settingsSet(s); S.settings = { ...s }; void recheck(); } });
    return el("div", { class: "row" }, field(label, inp, undefined, "grow").el, btn("Wählen …", async () => { const p = await api.pickFile(`${label} wählen`); if (p) { inp.value = p; inp.dispatchEvent(new Event("change")); } }, { size: "sm" }));
  };
  return el("div", { class: "stack" }, mk("ffmpeg", "Pfad zu ffmpeg"), mk("ffprobe", "Pfad zu ffprobe"), mk("ytdlp", "Pfad zu yt-dlp"), el("div", { class: "help" }, "Die Pfade werden beim Verlassen des Felds gespeichert und geprüft."));
}

let pathsDisc: HTMLDetailsElement | null = null, brewDisc: HTMLDetailsElement | null = null;
function render() {
  if (!root) return;
  const e: EnvCheck | null = S.env;
  const pipeOk = pipelineReady(e);
  const p = e?.pipeline;
  rowsEl.replaceChildren(
    !e ? statusRow("run", "Berechnung (eingebaut)", "wird geprüft …") : pipeOk
      ? statusRow("ok", el("b", {}, e.dev_mode ? "Berechnung (Entwicklermodus, externes Python)" : "Berechnung (eingebaut)"), `Version ${p?.version ?? "unbekannt"} · ${p?.code_hash ?? "ohne Code-Hash"}`)
      : statusRow("bad", el("b", {}, "Berechnung"), e.dev_mode ? (e.python.message ?? e.rsm.message ?? "Python oder Pipeline-Ordner nicht gefunden (Einstellungen › Entwickler).") : "In dieser App fehlt die eingebaute Berechnung. Bitte die App neu aus dem Release-Paket installieren."),
    toolRow("ffmpeg", "erforderlich", e?.ffmpeg, false),
    toolRow("ffprobe", "erforderlich", e?.ffprobe, false, "wird mit ffmpeg installiert"),
    toolRow("yt-dlp", "optional", e?.ytdlp, true, "nur für eigene Import-Vorlagen, die es aufrufen"));
  const needFf = !!e && (!e.ffmpeg.ok || !e.ffprobe.ok), needYt = !!e && !e.ytdlp?.ok;
  installEl.replaceChildren();
  if (e && (needFf || needYt)) {
    const line = `brew install ${[needFf ? "ffmpeg" : null, needYt ? "yt-dlp" : null].filter(Boolean).join(" ")}`;
    installEl.append(el("h2", {}, needFf ? "So installieren (Homebrew)" : "yt-dlp installieren (optional, Homebrew)"), codeWell(line, { label: "Befehl zum Installieren" }).el,
      el("p", { class: "help" }, "Im Programm „Terminal“ einfügen und Eingabe drücken. Danach hier „Erneut prüfen“. video2gpx installiert nichts selbst."));
    brewDisc ??= disclosure("Homebrew ist nicht installiert?", el("p", {}, "Homebrew ist ein Paketmanager für den Mac. Die Anleitung steht auf dieser Seite (die App öffnet sie nicht selbst):"), codeWell("https://brew.sh", { label: "Adresse von Homebrew" }).el);
    if (e.brew && !e.brew.ok) brewDisc.open = true;
    installEl.append(brewDisc);
  }
  pathsDisc ??= disclosure("Ohne Homebrew: Pfad selbst angeben", pathFields());
  installEl.append(pathsDisc);
  if (e && !toolsReady(e) && pipeOk) installEl.prepend(banner("warn", "Ohne ffmpeg und ffprobe kann nichts berechnet werden. Vorhandene Projekte lassen sich öffnen und als GPX exportieren."));
  againBtn ??= btn("Erneut prüfen", () => void recheck());
  setBtnLabel(againBtn, checking ? "Prüfe …" : "Erneut prüfen");
  const again = againBtn;
  const ready = toolsReady(e);
  actionsEl.replaceChildren(again, ready
    ? btn(needYt ? "Weiter ohne yt-dlp" : "Weiter", () => go(routePath.start), { kind: "primary", attrs: { "data-primary": "" } })
    : el("a", { href: routePath.start }, "Trotzdem zur Startseite"));
}
