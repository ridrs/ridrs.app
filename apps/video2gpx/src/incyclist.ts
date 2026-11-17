// "Für Incyclist speichern …": the card of the Export stage (docs/FEATURE_incyclist_export.md, section 7): options, progress, result.
import { api } from "./api";
import { routePath } from "./app/router";
import { S, bus, saveCur, toast } from "./state";
import type { IncyclistDone, IncyclistInfo, IncyclistOptions, IncyclistProgress } from "./types";
import { banner, btn, field, progressBar, segmented, stepList, toneIcon } from "./ui/components";
import { icon } from "./ui/icons";
import { debounce, el, fmtBytes } from "./util";

const STEP_LABELS = ["Höhendaten prüfen", "GPX mit Höhen", "Video vorbereiten", "ZIP schreiben"];
const TECH = /^(?:[0-9]{3,4}p(?:[0-9]{2})?|[2-8]k(?:[0-9]{2})?|hdr(?:10\+?)?|uhd|fhd|hd|sdr|[0-9]{2,3}fps|fps|pov|asmr|dolby|vision|4k60|4k30)$/i;

/** the video title without IDs, emojis and technical tags ("Route du Col de la Madone 4K HDR 🇫🇷 Dramatic … [aBcDeFgHiJk]" -> "Route du Col de la Madone Dramatic …") */
export function cleanTitle(t: string): string {
  let s = t.replace(/\[[A-Za-z0-9_-]{6,}\]/g, " ").replace(/\((?:[0-9]{3,4}p|4k|hdr|uhd)[^)]*\)/gi, " ");
  s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, " ");
  s = s.split(/\s+/).filter((w) => w && !TECH.test(w.replace(/[|,;:]/g, ""))).join(" ");
  return s.replace(/\s*[|]\s*/g, " – ").replace(/\s{2,}/g, " ").replace(/^[\s\-–|:,]+|[\s\-–|:,]+$/g, "").trim();
}

const FOLD: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss", æ: "ae", œ: "oe", ø: "o", Ø: "O", ł: "l", Ł: "L" };
/** ASCII-safe file name, as the Rust side does it (safe_name) */
export function safeName(s: string): string {
  const f = s.replace(/[äöüÄÖÜßæœøØłŁ]/g, (c) => FOLD[c]).normalize("NFD").replace(/[̀-ͯ]/g, "");
  return f.replace(/[^A-Za-z0-9]+/g, (m) => (m === "-" ? "-" : "_")).replace(/^[_-]+|[_-]+$/g, "").slice(0, 60).replace(/[_-]+$/, "") || "video2gpx_route";
}

/** empty, or http(s) with a host and no spaces (the backend checks the same: incyclist::effective_link) */
export const urlValid = (u: string) => { const t = u.trim(); return !t || (/^https?:\/\/\S+$/i.test(t) && t.length <= 2000); };

function defaults(): IncyclistOptions {
  const app = S.cur!.app;
  const title = cleanTitle(app.probe?.title ?? app.name) || app.name;
  const place = app.suggestion?.query && app.suggestion.found ? app.suggestion.query : title;
  return { title, name: safeName(place), country: "", drop_audio: true, sdr: false, max_height: null, folder: false, start_time: app.start_time ?? null, source_url: null, convert: true };
}


// ---------------------------------------------------------------- export state (kept across views: the export goes on in the background)
const inc: { project: string | null; running: boolean; prog: IncyclistProgress | null; done: IncyclistDone | null } = { project: null, running: false, prog: null, done: null };
export function wireIncyclistEvents() {
  void api.onIncyclistProgress((p) => { Object.assign(inc, { project: p.project, running: true, prog: p, done: null }); bus.emit("incyclist"); });
  void api.onIncyclistDone((r) => { Object.assign(inc, { project: r.project, running: false, done: r }); bus.emit("incyclist"); if (S.cur?.app.id !== r.project) toast(r.ok ? "Paket für Incyclist gespeichert." : r.cancelled ? "Export für Incyclist abgebrochen." : `Export für Incyclist fehlgeschlagen: ${r.error}`, r.ok || r.cancelled ? "info" : "error"); });
}
export const incyclistRunning = () => inc.running;

const fmtMin = (s: number) => (s < 90 ? `ca. ${Math.max(1, Math.round(s))} s` : `ca. ${Math.round(s / 60)} Min.`);
function planText(info: IncyclistInfo): string {
  const p = info.plan;
  const what = p.mode === "original" ? "wird als Originaldatei übernommen, ohne Umwandlung" : p.mode === "copy" ? "wird unverändert übernommen" : p.mode === "remux" ? `wird umverpackt (${p.reasons.join(", ")})` : `wird neu kodiert (${p.reasons.join(", ")}, HEVC über VideoToolbox)`;
  return `Video ${what} · ${fmtBytes(p.est_bytes)} · ${fmtMin(p.est_seconds)}`;
}

/** the extension of the video in the package: mp4 after a conversion, else the source's own (as incyclist::video_ext) */
const videoExt = (o: IncyclistOptions, name: string) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(name); return o.convert === false && m ? m[1].toLowerCase() : "mp4"; };

/** The Incyclist card. Built for the open project (build() again after a project change); update() follows the export. */
export function incyclistCard(): { el: HTMLElement; build(): void; update(): void; refresh(): void } {
  const root = el("section", { class: "panel stack card", "aria-labelledby": "inc-h" });
  let o: IncyclistOptions, info: IncyclistInfo | null = null, projectId = "", video = "";
  const steps = stepList(STEP_LABELS, true);
  const bar = progressBar("Export für Incyclist");
  const progText = el("div", { class: "small tnum", "aria-live": "polite" });
  const progBox = el("div", { class: "stack", hidden: true }, steps.el, bar.el, progText);
  const resultBox = el("div", { class: "stack", hidden: true });
  const startBtn = btn("Für Incyclist speichern …", () => void start(), { kind: "primary", icon: "download" });
  const startWhy = el("div", { class: "small muted", id: "inc-why", hidden: true }, "Erst die Höhendaten in der Höhe-Stufe laden: ohne sie hätte das Paket keine Höhen.");
  startBtn.setAttribute("aria-describedby", "inc-why");
  const cancelBtn = btn("Abbrechen", () => void api.incyclistCancel(), { kind: "danger" });
  const formBox = el("div", { class: "stack" });
  const demBox = el("div", { class: "stack-s" }), videoBox = el("div", { class: "stack-s" }), planLine = el("div", { class: "small" }), estLine = el("div", { class: "small muted" });
  const save = debounce(() => void saveCur({ incyclist: { ...o } }), 300);
  let fillUrl = () => {};

  /** the preview image: a drop area (the window-wide drop lands here on this stage, main.ts) or the picker; kept in the project folder */
  let preview: string | null = null, previewRev = 0, previewBusy = false, previewLocked = false;
  const previewBox = el("div", { class: "stack-s" });
  const setPreview = async (path: string) => {
    if (!projectId || previewBusy || (inc.project === projectId && inc.running)) return;
    previewBusy = true; renderPreview();
    try { preview = await api.incyclistPreviewSet(projectId, path); previewRev++; }
    catch (e) { toast(String(e), "error"); }
    finally { previewBusy = false; renderPreview(); refreshEst(); }
  };
  const pickPreview = async () => { const p = await api.pickImage(); if (p) await setPreview(p); };
  const clearPreview = async () => {
    try { await api.incyclistPreviewClear(projectId); preview = null; } catch (e) { toast(String(e), "error"); }
    renderPreview(); refreshEst();
  };
  const renderPreview = () => {
    const running = inc.project === projectId && inc.running;
    const zone = el("div", { class: `preview-drop${preview ? " has-image" : ""}`, role: "button", tabindex: running ? -1 : 0, "aria-disabled": String(running || previewBusy),
      "aria-label": preview ? "Vorschaubild ersetzen: Bild hierher ziehen oder klicken" : "Vorschaubild: Bild hierher ziehen oder klicken",
      onclick: () => { if (!running && !previewBusy) void pickPreview(); },
      onkeydown: (e: KeyboardEvent) => { if ((e.key === "Enter" || e.key === " ") && !running && !previewBusy) { e.preventDefault(); void pickPreview(); } } });
    if (previewBusy) zone.append(el("span", { class: "small muted" }, "Prüfe das Bild …"));
    else if (preview) zone.append(el("img", { src: `${api.fileUrl(preview)}?v=${previewRev}`, alt: "Vorschaubild des Pakets" }));
    else zone.append(icon("image"), el("span", {}, "Bild hierher ziehen"), el("span", { class: "small muted" }, "oder klicken, um eins zu wählen · PNG oder JPEG"));
    previewBox.replaceChildren(zone,
      el("div", { class: "row wrap small" },
        el("span", { class: "muted grow" }, preview ? `Im Paket als ${safeName(o.name || o.title)}_preview.${preview.endsWith(".png") ? "png" : "jpg"}: Incyclist zeigt es in der Routenliste.` : "Optional. Ohne Bild erzeugt Incyclist selbst eines aus dem Video."),
        preview ? btn("Entfernen", () => void clearPreview(), { size: "sm", kind: "danger" }) : ""));
  };
  bus.on("preview-drop", (path: string) => void setPreview(path));
  bus.on("drag", (over: boolean) => previewBox.firstElementChild?.classList.toggle("over", over));

  /** the elevation: one line. The data are loaded and the profile is made in the Höhe stage; the export only uses them. */
  const renderDem = () => {
    demBox.replaceChildren();
    if (!info) { demBox.append(el("span", { class: "muted small" }, "Prüfe …")); return; }
    const p = info.profile, ready = info.dem.ready;
    const link = el("a", { href: routePath.project(projectId, "hoehe") }, "Zur Höhe");
    if (p?.state === "current") demBox.append(el("div", { class: "row wrap small" }, toneIcon("ok"), el("span", {}, `Höhenprofil: aktuell (${p.source ?? "Copernicus DEM GLO-30"})`), link));
    else {
      demBox.append(el("div", { class: "row wrap small" }, toneIcon("warn"), el("span", {}, p?.state === "stale" ? "Höhenprofil veraltet" : "Höhenprofil fehlt"), link),
        el("div", { class: "small muted" }, ready ? "Der Export berechnet die Höhen aus den vorhandenen Daten. Mit dem Profil aus der Höhe-Stufe sind sie dieselben wie dort." : "Die Copernicus-Höhendaten fehlen. Ohne sie fährt Incyclist die Strecke flach: erst in der Höhe-Stufe laden."));
    }
  };
  const renderVideo = () => {
    videoBox.replaceChildren();
    if (!info) return;
    const v = info.video, row = el("div", { class: "row wrap" });
    videoBox.append(el("div", { class: "small muted wrap-any" }, `${v.name} · ${v.codec.toUpperCase()} ${v.width}×${v.height} · ${v.r_frame_rate.replace("/1", "")} fps · ${fmtBytes(v.bytes)}${v.hdr ? " · HDR" : ""}${v.audio ? ` · Ton (${v.audio})` : ""}`));
    const check = (label: string, key: "drop_audio" | "sdr" | "convert") => { const c = el("input", { type: "checkbox", checked: o[key] !== false, onchange: () => { o[key] = c.checked; if (key === "convert") renderVideo(); void refresh(false); save(); } }); return el("label", { class: "check" }, c, ` ${label}`); };
    const convertHelp = o.convert === false
      ? `Die Datei kommt so, wie sie ist, ins Paket (${safeName(o.name || o.title)}.${videoExt(o, v.name)}): schnell, ohne Qualitätsverlust. Incyclist spielt aber nicht jedes Format ab (sicher: MP4 mit H.264/HEVC).`
      : "Das Video wird, wo nötig, nach MP4 umverpackt oder neu kodiert, damit Incyclist es sicher abspielt.";
    videoBox.append(el("div", { class: "stack-s" }, check("In MP4 umwandeln", "convert"), el("div", { class: "help" }, convertHelp)));
    if (o.convert === false) return;
    if (v.audio) row.append(check("Ton weglassen", "drop_audio"));
    if (v.hdr) row.append(check("In SDR umwandeln (empfohlen für HDR)", "sdr"));
    const heights = [1440, 1080].filter((h) => h < v.height);
    if (heights.length) {
      const s = el("select", { onchange: () => { o.max_height = s.value ? Number(s.value) : null; void refresh(false); save(); } }, el("option", { value: "", selected: o.max_height === null }, `Original (${v.height}p)`), ...heights.map((h) => el("option", { value: String(h), selected: o.max_height === h }, `${h}p (neu kodieren, viel kleiner)`)));
      row.append(field("Auflösung", s).el);
    }
    videoBox.append(row);
  };
  const refreshEst = () => { if (!info) return; planLine.textContent = planText(info); estLine.textContent = `Geschätzte Größe: ${fmtBytes(info.est_bytes)} · Dateien: ${safeName(o.name || o.title)}.xml, .${videoExt(o, info.video.name)}, .gpx${preview ? `, _preview.${preview.endsWith(".png") ? "png" : "jpg"}` : ""}, video2gpx.json, LIESMICH.txt`; };
  const refresh = async (online: boolean) => {
    const pid = projectId;
    try { const i = await api.incyclistInfo(pid, video, o, online); if (pid !== projectId) return; info = i; fillUrl(); if (!previewBusy && (i.preview ?? null) !== preview) { preview = i.preview ?? null; previewRev++; renderPreview(); } renderDem(); renderVideo(); refreshEst(); update(); } catch (e) { planLine.textContent = String(e); }
  };

  async function start() {
    o.name = safeName(o.name || o.title);
    (formBox.querySelector("[data-k=name]") as HTMLInputElement).value = o.name;
    if (o.country && !/^[A-Za-z]{2}$/.test(o.country)) { toast("Land: bitte einen zweistelligen Code eingeben (z. B. FR).", "error"); return; }
    o.country = o.country.toUpperCase();
    if (o.source_url != null) { o.source_url = o.source_url.trim(); if (!urlValid(o.source_url)) { toast("Quelle: bitte eine vollständige Adresse mit http:// oder https:// eingeben.", "error"); return; } }
    await saveCur({ incyclist: { ...o } });
    const dest = await api.pickSavePackage(o.name, o.folder);
    if (!dest) return;
    Object.assign(inc, { project: projectId, running: true, prog: null, done: null }); update();
    try { await api.incyclistExport(projectId, video, o, dest); }
    catch (e) { Object.assign(inc, { running: false, done: { project: projectId, ok: false, error: String(e) } }); update(); }
  }

  function build() {
    const cur = S.cur;
    root.replaceChildren(el("h2", { id: "inc-h" }, "Für Incyclist"));
    info = null; preview = null;
    if (!cur?.app.video) { root.append(el("p", { class: "muted" }, "Für das Paket braucht es das Video des Projekts.")); return; }
    projectId = cur.app.id; video = cur.app.video;
    o = { ...defaults(), ...(cur.app.incyclist ?? {}), start_time: cur.app.start_time ?? null };
    const inp = (key: "title" | "name" | "country", attrs: Record<string, any>) => el("input", { type: "text", value: o[key], "data-k": key, ...attrs, oninput: (e: Event) => { (o as any)[key] = (e.target as HTMLInputElement).value; refreshEst(); save(); } });
    const nameIn = inp("name", { class: "mono", spellcheck: false });
    nameIn.addEventListener("change", () => { o.name = safeName(o.name); nameIn.value = o.name; save(); });
    const countryIn = inp("country", { class: "narrow mono", maxLength: 2, placeholder: "FR" });
    countryIn.addEventListener("change", () => { o.country = o.country.toUpperCase(); countryIn.value = o.country; save(); });
    const countryHelp = "ISO-Ländercode mit zwei Buchstaben.";
    // the source URL: typed, or (null) the YouTube link from the file name, filled in once info is there
    const urlIn = el("input", { type: "url", value: o.source_url ?? "", "data-k": "source_url", placeholder: "https://…", spellcheck: false, autocomplete: "off",
      oninput: () => { o.source_url = urlIn.value; urlCheck(); save(); } }) as HTMLInputElement;
    const urlHelp = "Adresse des Originalvideos. Steht im GPX (Link), in LIESMICH.txt und video2gpx.json. Leer lassen für keine.";
    const fUrl = field("Quelle (URL)", urlIn, urlHelp);
    const urlCheck = () => fUrl.setError(urlValid(urlIn.value) ? null : "Bitte eine vollständige Adresse mit http:// oder https:// eingeben (ohne Leerzeichen).");
    fillUrl = () => { if (o.source_url == null && info) { urlIn.value = info.link ?? ""; fUrl.setHelp(info.link ? "Aus dem Dateinamen erkannt (YouTube-ID). " + urlHelp : urlHelp); } };
    const fCountry = field("Land", countryIn, countryHelp);
    const targetHelp = () => o.folder
      ? "Dieselben Dateien in einem neuen Ordner, ohne ZIP: zum Kopieren in den Video-Ordner von Incyclist. Im Dialog danach gibst du den Namen des neuen Ordners ein."
      : "Eine einzelne .zip-Datei mit allen Dateien, praktisch zum Weitergeben. Incyclist kann sie direkt importieren.";
    const targetHelpEl = el("div", { class: "help", id: "inc-tgt-h" }, targetHelp());
    const target = segmented<"zip" | "folder">("Speichern als", [["zip", "ZIP-Datei"], ["folder", "Ordner"]], o.folder ? "folder" : "zip", (v) => { o.folder = v === "folder"; targetHelpEl.textContent = targetHelp(); save(); });
    target.el.setAttribute("aria-describedby", "inc-tgt-h");
    const fTarget = { el: el("div", { class: "field" }, el("div", { class: "label-text" }, "Speichern als"), target.el, targetHelpEl) };
    formBox.replaceChildren(
      field("Titel (in Incyclist)", inp("title", {})).el,
      el("div", { class: "row wrap top-align" }, field("Name (Dateinamen)", nameIn, "Nur Buchstaben, Ziffern, _ und -.", "grow").el, fCountry.el),
      fUrl.el,
      el("h3", {}, "Höhendaten"), demBox, el("h3", {}, "Video"), videoBox, planLine,
      el("h3", {}, "Vorschaubild"), previewBox,
      fTarget.el, estLine);
    root.append(el("p", { class: "small muted" }, "Video (als MP4 oder im Original), GPX mit einem Punkt pro Videosekunde und Höhen, Steuerdatei (Incyclist: „Eigenes Video“). Die Position ist aus dem Video rekonstruiert, nicht per GPS gemessen. Die Rechte am Video bleiben bei seiner Urheberin oder seinem Urheber."),
      formBox, el("div", { class: "row wrap" }, startBtn, cancelBtn), startWhy, progBox, resultBox);
    renderDem(); renderPreview();
    void refresh(true).then(async () => {
      const st = info?.start;
      if (o.country || !st || st.lat == null || st.lon == null) return;
      fCountry.setHelp("wird aus der Karte ermittelt …");
      try {
        const c = await api.geoCountry(st.lat, st.lon);
        if (c && !o.country) { o.country = c; countryIn.value = c; save(); }
        fCountry.setHelp(c ? "aus der Karte (OSM/Nominatim)" : "unbekannt, bitte eingeben");
      } catch { fCountry.setHelp("offline: bitte eingeben"); }
      if (o.name && !/^[A-Z]{2}_/.test(o.name) && o.country) { o.name = `${o.country}_${o.name}`; nameIn.value = o.name; save(); }
    });
    update();
  }

  function update() {
    const mine = inc.project === projectId && !!projectId;
    const running = mine && inc.running;
    const noDem = !!info && !info.dem.ready;
    startBtn.hidden = running; cancelBtn.hidden = !running;
    startBtn.disabled = noDem; startWhy.hidden = !noDem || running;
    formBox.querySelectorAll<HTMLInputElement>("input,select,button").forEach((x) => (x.disabled = running));
    if (projectId && !previewBusy && running !== previewLocked) { previewLocked = running; renderPreview(); }
    progBox.hidden = !(mine && (inc.running || inc.done));
    resultBox.hidden = !(mine && inc.done);
    if (!mine) return;
    const p = inc.prog, d = inc.done;
    const cur = d?.ok ? 5 : p?.step ?? 1, pct = p?.pct ?? 0;
    STEP_LABELS.forEach((_, i) => { const n = i + 1; steps.set(i, n < cur ? { tone: "ok", text: "fertig" } : n === cur ? (d && !d.ok ? { tone: d.cancelled ? "off" : "bad", text: d.cancelled ? "abgebrochen" : "fehlgeschlagen" } : { tone: "run", text: `${Math.round(pct)} %` }) : { tone: "wait", text: "wartet" }); });
    bar.set(d?.ok ? 100 : Math.max(0, Math.min(100, ((cur - 1) * 100 + pct) / 4)));
    progText.textContent = d ? (d.ok ? `Fertig in ${fmtMin(d.result!.seconds)}.` : d.cancelled ? "Abgebrochen. Es wurde nichts gespeichert." : `Fehler: ${d.error}`) : p ? `Schritt ${p.step} von 4: ${p.label}, ${Math.round(p.pct)} %${p.message ? ` · ${p.message}` : ""}` : "Starte …";
    resultBox.replaceChildren();
    if (d?.ok && d.result) {
      const x = d.result;
      resultBox.append(el("div", { class: "row ok-text" }, toneIcon("ok"), el("span", { class: "wrap-any" }, `${x.folder ? "Ordner" : "ZIP"} gespeichert: ${x.path}`)),
        el("div", { class: "small" }, [`Länge ${(x.length_m / 1000).toFixed(1).replace(".", ",")} km`, x.ascent_m !== null ? `Anstieg ${Math.round(x.ascent_m)} hm` : "ohne Höhen", fmtBytes(x.bytes), `Startbild ${x.start_frame}`].join(" · ")),
        x.note ? banner("warn", x.note) : "",
        el("div", {}, btn("Im Finder zeigen", () => void api.reveal(x.path), { size: "sm", icon: "folder" })));
    }
  }
  bus.on("incyclist", update);
  return { el: root, build, update, refresh: () => { if (info) void refresh(false); } };
}
