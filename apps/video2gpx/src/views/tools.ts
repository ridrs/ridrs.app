// Werkzeuge: clean status overview of required & optional tools, concise copyable install command, own paths.
import { api } from "../api";
import { go, routePath } from "../app/router";
import { pipelineReady, toolsReady } from "../features/run";
import { settingsOf } from "../features/import";
import { S, bus } from "../state";
import type { EnvCheck, Settings, ToolCheck } from "../types";
import { banner, btn, setBtnLabel, codeWell, disclosure, field, statusRow, type Tone } from "../ui/components";
import { el } from "../util";
import { isMac, thisComputer } from "../app/platform";

let summaryEl: HTMLElement, rowsEl: HTMLElement, installEl: HTMLElement, actionsEl: HTMLElement, root: HTMLElement;
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
  summaryEl = el("div", {});
  rowsEl = el("div", { class: "tool-rows" });
  installEl = el("div", { class: "stack" });
  actionsEl = el("div", { class: "row end wrap" });
  r.append(el("div", { class: "page narrow" },
    el("div", { class: "stack-xs" },
      el("h1", {}, "Werkzeuge"),
      el("p", { class: "lead" }, `Zum Lesen von Videos braucht video2gpx ffmpeg und ffprobe auf ${thisComputer}. yt-dlp ist optional für eigene Import-Vorlagen.`)),
    summaryEl,
    el("div", { class: "panel stack" }, rowsEl, installEl, actionsEl)));
  bus.on("env", render);
  let last = 0;
  const onFocus = () => { if (document.visibilityState === "visible" && Date.now() - last > 3000) { last = Date.now(); void recheck(); } };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  render();
}

function toolRow(name: string, need: string, c: ToolCheck | undefined, optional: boolean, note = ""): HTMLElement {
  if (checking && !c) return statusRow("run", name, "wird geprüft …");
  const tone: Tone = c?.ok ? "ok" : optional ? "off" : "bad";
  const text = c?.ok ? [c.version ? `Version ${c.version}` : "gefunden", c.path ?? null, c.warning].filter(Boolean).join(" · ") : `nicht gefunden${note ? ` (${note})` : ""}`;
  return statusRow(tone, el("span", {}, el("b", {}, name), " ", el("span", { class: "muted small" }, need)), text);
}

function pathFields(): HTMLElement {
  const s = { ...(S.settings as Settings) };
  const st = settingsOf(s);
  const mk = (key: "ffmpeg" | "ffprobe" | "ytdlp", label: string) => {
    const inp = el("input", { type: "text", class: "mono", value: key === "ytdlp" ? st.ytdlp : s[key], placeholder: "leer = automatisch", spellcheck: false,
      onchange: async () => { (s as any)[key] = inp.value.trim(); await api.settingsSet(s); S.settings = { ...s }; void recheck(); } });
    return el("div", { class: "row end-align" }, field(label, inp, undefined, "grow").el, btn("Wählen …", async () => { const p = await api.pickFile(`${label} wählen`); if (p) { inp.value = p; inp.dispatchEvent(new Event("change")); } }, { size: "sm" }));
  };
  return el("div", { class: "stack" }, mk("ffmpeg", "Pfad zu ffmpeg"), mk("ffprobe", "Pfad zu ffprobe"), mk("ytdlp", "Pfad zu yt-dlp"), el("div", { class: "help" }, "Pfade werden beim Verlassen des Felds gespeichert und geprüft."));
}

let pathsDisc: HTMLDetailsElement | null = null, brewDisc: HTMLDetailsElement | null = null;
function render() {
  if (!root) return;
  const e: EnvCheck | null = S.env;
  const pipeOk = pipelineReady(e);
  const ready = toolsReady(e);
  const p = e?.pipeline;

  summaryEl.replaceChildren();
  if (e && ready) summaryEl.append(banner("info", "Alle erforderlichen Werkzeuge sind bereit."));
  else if (e && !ready && pipeOk) summaryEl.append(banner("warn", "Ohne ffmpeg und ffprobe kann nichts berechnet werden. Vorhandene Projekte lassen sich weiterhin öffnen und als GPX exportieren."));

  rowsEl.replaceChildren(
    !e ? statusRow("run", "Berechnung (eingebaut)", "wird geprüft …") : pipeOk
      ? statusRow("ok", el("b", {}, e.dev_mode ? "Berechnung (externes Python)" : "Berechnung (eingebaut)"), `Version ${p?.version ?? "unbekannt"}`, p?.code_hash ? `Code-Hash: ${p.code_hash}` : undefined)
      : statusRow("bad", el("b", {}, "Berechnung"), e.dev_mode ? (e.python.message ?? e.rsm.message ?? "Python oder Pipeline-Ordner nicht gefunden (Einstellungen › Entwickler).") : "In dieser App fehlt die eingebaute Berechnung. Bitte aus dem Release-Paket neu installieren."),
    toolRow("ffmpeg", "erforderlich", e?.ffmpeg, false),
    toolRow("ffprobe", "erforderlich", e?.ffprobe, false, "kommt mit ffmpeg"),
    toolRow("yt-dlp", "optional", e?.ytdlp, true, "nur für eigene Import-Vorlagen"));

  const needFf = !!e && (!e.ffmpeg.ok || !e.ffprobe.ok), needYt = !!e && !e.ytdlp?.ok;
  installEl.replaceChildren();
  if (e && (needFf || needYt)) {
    const mac = !e.os || e.os === "macos";
    const cmd = mac ? "brew install" : e.install_cmd;
    const pkgs = [needFf ? "ffmpeg" : null, needYt ? "yt-dlp" : null].filter(Boolean).join(" ");
    installEl.append(el("h2", {}, needFf ? `Installation${mac ? " per Homebrew" : ""}` : `yt-dlp nachinstallieren (optional)`),
      cmd ? codeWell(`${cmd} ${pkgs}`, { label: "Befehl zum Installieren" }).el : el("p", {}, `Bitte ${pkgs} mit dem Paketmanager des Systems installieren.`),
      el("p", { class: "help" }, `Im Terminal ausführen und danach hier „Erneut prüfen“ klicken. video2gpx installiert nichts selbst.`));
    if (mac) {
      brewDisc ??= disclosure("Homebrew ist nicht installiert?", el("p", {}, "Anleitung für den Mac-Paketmanager Homebrew:"), codeWell("https://brew.sh", { label: "Adresse von Homebrew" }).el);
      if (e.brew && !e.brew.ok) brewDisc.open = true;
      installEl.append(brewDisc);
    }
  }
  pathsDisc ??= disclosure(isMac ? "Ohne Homebrew: Pfade selbst angeben" : "Pfade selbst angeben", pathFields());
  installEl.append(pathsDisc);

  againBtn ??= btn("Erneut prüfen", () => void recheck());
  setBtnLabel(againBtn, checking ? "Prüfe …" : "Erneut prüfen");
  actionsEl.replaceChildren(againBtn, ready
    ? btn(needYt ? "Weiter ohne yt-dlp" : "Weiter", () => go(routePath.start), { kind: "primary", attrs: { "data-primary": "" } })
    : el("a", { href: routePath.start }, "Trotzdem zur Startseite"));
}
