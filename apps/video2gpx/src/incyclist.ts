// "Für Incyclist": clean, scannable export card — essentials upfront, details & preview image in a tidy disclosure (and WCAG-clean dropzone!).
import { api } from "./api";
import { routePath } from "./app/router";
import { S, bus, saveCur, toast } from "./state";
import type { IncyclistDone, IncyclistInfo, IncyclistOptions, IncyclistProgress } from "./types";
import { banner, btn, disclosure, field, progressBar, segmented, stepList, toneIcon } from "./ui/components";
import { icon } from "./ui/icons";
import { debounce, el, fmtBytes } from "./util";
import { revealLabel } from "./app/platform";

const STEP_LABELS = ["Höhendaten prüfen", "GPX mit Höhen", "Video vorbereiten", "ZIP schreiben"];
const TECH = /^(?:[0-9]{3,4}p(?:[0-9]{2})?|[2-8]k(?:[0-9]{2})?|hdr(?:10\+?)?|uhd|fhd|hd|sdr|[0-9]{2,3}fps|fps|pov|asmr|dolby|vision|4k60|4k30)$/i;

export function cleanTitle(t: string): string {
  let s = t.replace(/\[[A-Za-z0-9_-]{6,}\]/g, " ").replace(/\((?:[0-9]{3,4}p|4k|hdr|uhd)[^)]*\)/gi, " ");
  s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, " ");
  s = s.split(/\s+/).filter((w) => w && !TECH.test(w.replace(/[|,;:]/g, ""))).join(" ");
  return s.replace(/\s*[|]\s*/g, " – ").replace(/\s{2,}/g, " ").replace(/^[\s\-–|:,]+|[\s\-–|:,]+$/g, "").trim();
}

const FOLD: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss", æ: "ae", œ: "oe", ø: "o", Ø: "O", ł: "l", Ł: "L" };
export function safeName(s: string): string {
  const f = s.replace(/[äöüÄÖÜßæœøØłŁ]/g, (c) => FOLD[c]).normalize("NFD").replace(/[̀-ͯ]/g, "");
  return f.replace(/[^A-Za-z0-9]+/g, (m) => (m === "-" ? "-" : "_")).replace(/^[_-]+|[_-]+$/g, "").slice(0, 60).replace(/[_-]+$/, "") || "video2gpx_route";
}

export const urlValid = (u: string) => { const t = u.trim(); return !t || (/^https?:\/\/\S+$/i.test(t) && t.length <= 2000); };

function defaults(): IncyclistOptions {
  const app = S.cur!.app;
  const title = cleanTitle(app.probe?.title ?? app.name) || app.name;
  const place = app.suggestion?.query && app.suggestion.found ? app.suggestion.query : title;
  return { title, name: safeName(place), country: "", drop_audio: true, sdr: false, max_height: null, folder: false, start_time: app.start_time ?? null, source_url: null, convert: true };
}

const inc: { project: string | null; running: boolean; prog: IncyclistProgress | null; done: IncyclistDone | null } = { project: null, running: false, prog: null, done: null };
export function wireIncyclistEvents() {
  void api.onIncyclistProgress((p) => { Object.assign(inc, { project: p.project, running: true, prog: p, done: null }); bus.emit("incyclist"); });
  void api.onIncyclistDone((r) => { Object.assign(inc, { project: r.project, running: false, done: r }); bus.emit("incyclist"); if (S.cur?.app.id !== r.project) toast(r.ok ? "Paket für Incyclist gespeichert." : r.cancelled ? "Export für Incyclist abgebrochen." : `Export für Incyclist fehlgeschlagen: ${r.error}`, r.ok || r.cancelled ? "info" : "error"); });
}
export const incyclistRunning = () => inc.running;

const fmtMin = (s: number) => (s < 90 ? `ca. ${Math.max(1, Math.round(s))} s` : `ca. ${Math.round(s / 60)} Min.`);
function planText(info: IncyclistInfo): string {
  const p = info.plan;
  const what = p.mode === "original" ? "als Originaldatei ohne Umwandlung" : p.mode === "copy" ? "unverändert übernommen" : p.mode === "remux" ? `umverpackt (${p.reasons.join(", ")})` : `neu kodiert (${p.reasons.join(", ")}, HEVC)`;
  return `Video ${what} · ${fmtBytes(p.est_bytes)} · ${fmtMin(p.est_seconds)}`;
}

const videoExt = (o: IncyclistOptions, name: string) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(name); return o.convert === false && m ? m[1].toLowerCase() : "mp4"; };

export function incyclistCard(): { el: HTMLElement; build(): void; update(): void; refresh(): void } {
  const root = el("section", { class: "panel stack card", "aria-labelledby": "inc-h" });
  let o: IncyclistOptions, info: IncyclistInfo | null = null, projectId = "", video = "";
  const steps = stepList(STEP_LABELS, true);
  const bar = progressBar("Export für Incyclist");
  const progText = el("div", { class: "small tnum", "aria-live": "polite" });
  const progBox = el("div", { class: "stack", hidden: true }, steps.el, bar.el, progText);
  const resultBox = el("div", { class: "stack", hidden: true });
  const startBtn = btn("Für Incyclist speichern …", () => void start(), { kind: "primary", icon: "download" });
  const startWhy = el("div", { class: "small muted", id: "inc-why", hidden: true }, "Erst die Höhendaten in der Höhe-Ansicht laden.");
  startBtn.setAttribute("aria-describedby", "inc-why");
  const cancelBtn = btn("Abbrechen", () => void api.incyclistCancel(), { kind: "danger" });
  const formBox = el("div", { class: "stack" });
  const demBox = el("div", { class: "stack-s" }), videoBox = el("div", { class: "stack-s" }), planLine = el("div", { class: "small" }), estLine = el("div", { class: "small muted" });
  const save = debounce(() => void saveCur({ incyclist: { ...o } }), 300);
  let fillUrl = () => {};

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
    // WCAG label-content-name-mismatch fix: let visible text be the accessible name when empty; set aria-label only when image-only
    const attrs: Record<string, any> = {
      class: `preview-drop${preview ? " has-image" : ""}`,
      role: "button",
      tabindex: running ? -1 : 0,
      "aria-disabled": String(running || previewBusy),
      onclick: () => { if (!running && !previewBusy) void pickPreview(); },
      onkeydown: (e: KeyboardEvent) => { if ((e.key === "Enter" || e.key === " ") && !running && !previewBusy) { e.preventDefault(); void pickPreview(); } },
    };
    if (preview) attrs["aria-label"] = "Vorschaubild ersetzen";
    const zone = el("div", attrs);
    if (previewBusy) zone.append(el("span", { class: "small muted" }, "Prüfe das Bild …"));
    else if (preview) zone.append(el("img", { src: `${api.fileUrl(preview)}?v=${previewRev}`, alt: "" }));
    else zone.append(icon("image"), el("span", {}, "Vorschaubild hierher ziehen oder klicken"), el("span", { class: "small muted" }, "PNG oder JPEG · optional"));
    previewBox.replaceChildren(zone,
      el("div", { class: "row wrap small" },
        el("span", { class: "muted grow" }, preview ? `Als ${safeName(o.name || o.title)}_preview.${preview.endsWith(".png") ? "png" : "jpg"} im Paket.` : "Ohne Bild erzeugt Incyclist selbst ein Vorschaubild."),
        preview ? btn("Entfernen", () => void clearPreview(), { size: "sm", kind: "danger" }) : ""));
  };
  bus.on("preview-drop", (path: string) => void setPreview(path));
  bus.on("drag", (over: boolean) => previewBox.firstElementChild?.classList.toggle("over", over));

  const renderDem = () => {
    demBox.replaceChildren();
    if (!info) { demBox.append(el("span", { class: "muted small" }, "Prüfe Höhendaten …")); return; }
    const p = info.profile, ready = info.dem.ready;
    const link = el("a", { href: routePath.project(projectId, "hoehe"), class: "small" }, "Höhe öffnen");
    if (p?.state === "current") demBox.append(el("div", { class: "row wrap small" }, toneIcon("ok"), el("span", {}, `Höhenprofil aktuell (${p.source ?? "Copernicus DEM GLO-30"})`), link));
    else {
      demBox.append(el("div", { class: "row wrap small" }, toneIcon("warn"), el("span", {}, p?.state === "stale" ? "Höhenprofil veraltet" : "Höhenprofil fehlt"), link),
        el("div", { class: "small muted" }, ready ? "Der Export berechnet die Höhen automatisch." : "Copernicus-Höhendaten fehlen: erst unter Höhe laden."));
    }
  };
  const renderVideo = () => {
    videoBox.replaceChildren();
    if (!info) return;
    const v = info.video, row = el("div", { class: "row wrap" });
    videoBox.append(el("div", { class: "small muted wrap-any" }, `${v.name} · ${v.codec.toUpperCase()} ${v.width}×${v.height} · ${v.r_frame_rate.replace("/1", "")} fps · ${fmtBytes(v.bytes)}${v.hdr ? " · HDR" : ""}${v.audio ? ` · Ton (${v.audio})` : ""}`));
    const check = (label: string, key: "drop_audio" | "sdr" | "convert") => { const c = el("input", { type: "checkbox", checked: o[key] !== false, onchange: () => { o[key] = c.checked; if (key === "convert") renderVideo(); void refresh(false); save(); } }); return el("label", { class: "check small" }, c, ` ${label}`); };
    videoBox.append(check("In MP4 umwandeln (empfohlen für Incyclist)", "convert"));
    if (o.convert === false) {
      videoBox.append(el("div", { class: "help" }, `Originaldatei (${safeName(o.name || o.title)}.${videoExt(o, v.name)}) wird ohne Umwandlung übernommen.`));
      return;
    }
    if (v.audio) row.append(check("Ton weglassen", "drop_audio"));
    if (v.hdr) row.append(check("In SDR umwandeln (empfohlen)", "sdr"));
    const heights = [1440, 1080].filter((h) => h < v.height);
    if (heights.length) {
      const s = el("select", { "aria-label": "Auflösung", onchange: () => { o.max_height = s.value ? Number(s.value) : null; void refresh(false); save(); } },
        el("option", { value: "", selected: o.max_height === null }, `Original (${v.height}p)`),
        ...heights.map((h) => el("option", { value: String(h), selected: o.max_height === h }, `${h}p (kleiner)`)));
      row.append(s);
    }
    if (row.childNodes.length) videoBox.append(row);
  };
  const refreshEst = () => { if (!info) return; planLine.textContent = planText(info); estLine.textContent = `Geschätzte Größe: ${fmtBytes(info.est_bytes)} · Dateien: ${safeName(o.name || o.title)}.xml, .${videoExt(o, info.video.name)}, .gpx${preview ? `, _preview.${preview.endsWith(".png") ? "png" : "jpg"}` : ""}, video2gpx.json, LIESMICH.txt`; };
  const refresh = async (online: boolean) => {
    const pid = projectId;
    try { const i = await api.incyclistInfo(pid, video, o, online); if (pid !== projectId) return; info = i; fillUrl(); if (!previewBusy && (i.preview ?? null) !== preview) { preview = i.preview ?? null; previewRev++; renderPreview(); } renderDem(); renderVideo(); refreshEst(); update(); } catch (e) { planLine.textContent = String(e); }
  };

  async function start() {
    o.name = safeName(o.name || o.title);
    const nameInput = formBox.querySelector<HTMLInputElement>("[data-k=name]");
    if (nameInput) nameInput.value = o.name;
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
    root.replaceChildren(el("h2", { id: "inc-h" }, "Incyclist-Paket"));
    info = null; preview = null;
    if (!cur?.app.video) { root.append(el("p", { class: "muted" }, "Für das Paket braucht es das Video des Projekts.")); return; }
    projectId = cur.app.id; video = cur.app.video;
    o = { ...defaults(), ...(cur.app.incyclist ?? {}), start_time: cur.app.start_time ?? null };
    const inp = (key: "title" | "name" | "country", attrs: Record<string, any>) => el("input", { type: "text", value: o[key], "data-k": key, ...attrs, oninput: (e: Event) => { (o as any)[key] = (e.target as HTMLInputElement).value; refreshEst(); save(); } });
    const nameIn = inp("name", { class: "mono", spellcheck: false });
    nameIn.addEventListener("change", () => { o.name = safeName(o.name); nameIn.value = o.name; save(); });
    const countryIn = inp("country", { class: "narrow mono", maxLength: 2, placeholder: "FR" });
    countryIn.addEventListener("change", () => { o.country = o.country.toUpperCase(); countryIn.value = o.country; save(); });
    const urlIn = el("input", { type: "url", value: o.source_url ?? "", "data-k": "source_url", placeholder: "https://…", spellcheck: false, autocomplete: "off",
      oninput: () => { o.source_url = urlIn.value; urlCheck(); save(); } }) as HTMLInputElement;
    const urlHelp = "Adresse des Originalvideos (für GPX-Link & LIESMICH.txt).";
    const fUrl = field("Quelle (URL)", urlIn, urlHelp);
    const urlCheck = () => fUrl.setError(urlValid(urlIn.value) ? null : "Bitte eine vollständige Adresse mit http:// oder https:// eingeben.");
    fillUrl = () => { if (o.source_url == null && info) { urlIn.value = info.link ?? ""; fUrl.setHelp(info.link ? "Aus dem Dateinamen erkannt (YouTube-ID). " + urlHelp : urlHelp); } };
    const fCountry = field("Land", countryIn, "ISO-Code (2 Buchstaben)");
    const target = segmented<"zip" | "folder">("Speichern als", [["zip", "ZIP-Datei"], ["folder", "Ordner"]], o.folder ? "folder" : "zip", (v) => { o.folder = v === "folder"; save(); });
    target.el.classList.add("fill");

    const detailsDisc = disclosure("Dateiname, Land, Quelle & Vorschaubild",
      el("div", { class: "row wrap top-align" }, field("Name (Dateinamen)", nameIn, "Nur Buchstaben, Ziffern, _ und -.", "grow").el, fCountry.el),
      fUrl.el,
      el("div", { class: "field" }, el("div", { class: "label-text" }, "Vorschaubild"), previewBox));

    formBox.replaceChildren(
      field("Titel in Incyclist", inp("title", {})).el,
      el("div", { class: "field" }, el("div", { class: "label-text" }, "Format"), target.el),
      demBox,
      el("div", { class: "inc-sec stack-s" }, el("div", { class: "label" }, "Video"), videoBox, planLine),
      detailsDisc,
      estLine);
    root.append(
      el("p", { class: "small muted" }, "Video, GPX (5 Punkte/s mit Höhen) und Steuerdatei für Incyclist („Eigenes Video“)."),
      formBox, el("div", { class: "row wrap" }, startBtn, cancelBtn), startWhy, progBox, resultBox);
    renderDem(); renderPreview();
    void refresh(true).then(async () => {
      const st = info?.start;
      if (o.country || !st || st.lat == null || st.lon == null) return;
      fCountry.setHelp("wird ermittelt …");
      try {
        const c = await api.geoCountry(st.lat, st.lon);
        if (c && !o.country) { o.country = c; countryIn.value = c; save(); }
        fCountry.setHelp(c ? "aus OSM/Nominatim" : "bitte eingeben");
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
        el("div", {}, btn(revealLabel, () => void api.reveal(x.path), { size: "sm", icon: "folder" })));
    }
  }
  bus.on("incyclist", update);
  return { el: root, build, update, refresh: () => { if (info) void refresh(false); } };
}
