// Einrichten: streamlined side panel next to the map. Video, Search Area & Map, Vehicle, collapsible Hints & Options, smart sticky footer.
import { api } from "../api";
import { attachVideo } from "../app/project";
import { go, routePath } from "../app/router";
import { active, canResume, checklist, start, type CheckId } from "../features/run";
import { defaultTemplate, imp as impState, importingFor, startImport } from "../features/import";
import { YTDLP_480P } from "../atlas";
import { canEditFrames, mapTools, sizeWarning, suggestFromTitle } from "../mapPanel";
import { S, bus, coveringPbfs, effectivePbf, saveCur } from "../state";
import type { AlignMode, BikePaths, Vehicle } from "../types";
import { banner, btn, chip, codeWell, disclosure, emptyState, field, iconBtn, isSoftDisabled, segmented, setBtnLabel, setSoftDisabled, toneIcon, uid } from "../ui/components";
import { icon } from "../ui/icons";
import { el, fmtBytes, fmtDur, fmtSize, fromLocalInput, toLocalInput } from "../util";
import { importBlock } from "./importDetails";
import { openMapData } from "./maps";
import { pickVideo } from "./start";

let side: HTMLElement, ws: HTMLElement;
let videoInfo: HTMLElement, videoEmpty: HTMLElement, videoMissing: HTMLElement, poster: HTMLElement, vTitle: HTMLElement, vMeta: HTMLElement, previewBtn: HTMLButtonElement;
let imp: ReturnType<typeof importBlock>;
let atlasBox: HTMLElement;
let frameSize: HTMLElement, drawBtn: HTMLButtonElement, viewBtn: HTMLButtonElement, delBtn: HTMLButtonElement, coverage: HTMLElement, sizeWarn: HTMLElement, pbfSel: HTMLSelectElement, mapBtn: HTMLButtonElement;
let hintsDisc: HTMLDetailsElement, hintsSummary: HTMLElement;
const hintRows = {} as Record<"start" | "end", { draw: HTMLButtonElement; del: HTMLButtonElement; val: HTMLElement }>;
let hintLoad: HTMLButtonElement, hintDel: HTMLButtonElement, hintName: HTMLElement, buf: HTMLInputElement, bufVal: HTMLElement, bufRow: HTMLElement;
let vehicle: ReturnType<typeof segmented<Vehicle>>, bikePaths: ReturnType<typeof segmented<BikePaths>>, bikePathsField: HTMLElement, alignMode: ReturnType<typeof segmented<AlignMode>>, offset: HTMLInputElement, startTime: HTMLInputElement, fromFile: HTMLButtonElement, decoys: HTMLSelectElement;
let checks: HTMLUListElement, readyRow: HTMLElement, startBtn: HTMLButtonElement, resumeBtn: HTMLButtonElement, runLink: HTMLAnchorElement, footNote: HTMLElement;

export function mountSetup(sideEl: HTMLElement, wsEl: HTMLElement) {
  side = sideEl; ws = wsEl;
  // ---- video
  poster = el("span", { class: "poster lg none" }, icon("film"));
  vTitle = el("div", { class: "v-title" });
  vMeta = el("div", { class: "small muted tnum" });
  previewBtn = btn("Vorschau", () => {
    const on = !ws.classList.contains("with-video");
    ws.classList.toggle("with-video", on);
    previewBtn.setAttribute("aria-expanded", String(on));
    setBtnLabel(previewBtn, on ? "Vorschau schließen" : "Vorschau");
  }, { size: "sm", icon: "play", attrs: { "aria-expanded": "false" } });
  videoInfo = el("div", { class: "v-info" }, poster, el("div", { class: "grow stack-xs" }, vTitle, vMeta, el("div", { class: "row" }, previewBtn)));
  videoEmpty = emptyState("film", "Kein Video", "Wähle eine Datei oder starte einen Import.",
    btn("Datei wählen …", () => void pickVideo(), { size: "sm", kind: "primary", icon: "folder" }),
    btn("Adresse eingeben", () => go(routePath.start), { size: "sm" }));
  videoMissing = el("div", {});
  imp = importBlock();
  atlasBox = el("div", { class: "stack-s" });

  // ---- 1. Search area & map
  frameSize = el("span", { class: "chip tnum nowrap", hidden: true });
  drawBtn = btn("Zeichnen", () => mapTools.toggleDraw("search"), { size: "sm", icon: "edit", attrs: { "aria-pressed": "false" } });
  viewBtn = btn("Sichtbarer Ausschnitt", () => mapTools.useView(), { size: "sm", icon: "map", title: "Den aktuell sichtbaren Kartenausschnitt als Suchrahmen übernehmen" });
  delBtn = iconBtn("trash", "Suchrahmen löschen", () => mapTools.remove("search"));
  coverage = el("div", { class: "coverage", "aria-live": "polite" });
  pbfSel = el("select", { "aria-label": "Karte für die Berechnung", onchange: () => void saveCur({ pbf: pbfSel.value }).then(update) });
  mapBtn = btn("Kartendaten laden …", () => openMapData(true), { size: "sm", kind: "primary", icon: "download" });
  sizeWarn = el("div", { class: "small warn-text", hidden: true });

  // ---- 2. Vehicle
  vehicle = segmented<Vehicle>("Fahrzeug", [["auto", "Auto."], ["bike", "Fahrrad"], ["motorcycle", "Motorrad"], ["car", "Auto"]], "auto", (v) => void saveCur({ vehicle: v }).then(update));
  vehicle.el.classList.add("fill");
  // Restore clear full label for "Automatisch" while keeping equal-width cells
  const autoSpan = vehicle.el.querySelector("span");
  if (autoSpan) autoSpan.textContent = "Automatisch";

  bikePaths = segmented<BikePaths>("Rad- und Waldwege einbeziehen", [["off", "Aus"], ["auto", "Automatisch"], ["on", "Ein"]], "off", (v) => void saveCur({ bike_paths: v }));
  bikePaths.el.classList.add("fill");
  const bpLabel = uid("bp-l"), bpHelp = uid("bp-h");
  bikePaths.el.removeAttribute("aria-label");
  bikePaths.el.setAttribute("aria-labelledby", bpLabel);
  bikePaths.el.setAttribute("aria-describedby", bpHelp);
  bikePathsField = el("div", { class: "field" },
    el("label", { id: bpLabel }, "Rad- und Waldwege"),
    bikePaths.el,
    el("div", { class: "help", id: bpHelp }, "Für Fahrräder: „Automatisch“ sucht bei unsicherer Straßenroute zusätzlich mit Rad- und Waldwegen."));

  // ---- Hints (optional, collapsed unless set)
  const hintRow = (k: "start" | "end", label: string, color: string) => {
    const lid = uid("hint-l"), bid = uid("hint-b");
    const r = {
      draw: btn("Zeichnen", () => mapTools.toggleDraw(k), { size: "sm", attrs: { id: bid, "aria-pressed": "false", "aria-labelledby": `${lid} ${bid}` } }),
      del: iconBtn("cross", `${label}rahmen löschen`, () => mapTools.remove(k)),
      val: el("span", { class: "small muted tnum" }),
    };
    hintRows[k] = r;
    return el("div", { class: "hint-row" }, el("span", { class: "hint-l" }, el("i", { class: "sw box", style: `--c:${color}` }), label, el("span", { id: lid, hidden: true }, `${label}rahmen`)), r.draw, r.val, r.del);
  };
  hintLoad = btn("GPX/KML …", () => void mapTools.loadHint(), { size: "sm", icon: "route", title: "Streckenhinweis als GPX- oder KML-Datei laden" });
  hintDel = iconBtn("cross", "Streckenhinweis entfernen", () => void mapTools.removeHint());
  hintName = el("span", { class: "small ellipsis" });
  bufVal = el("output", { class: "small tnum" });
  buf = el("input", { type: "range", min: "100", max: "1000", step: "50", "aria-label": "Korridor um den Streckenhinweis", oninput: () => { bufVal.textContent = `${buf.value} m`; mapTools.setBuffer(Number(buf.value), false); }, onchange: () => mapTools.setBuffer(Number(buf.value), true) });
  bufRow = el("div", { class: "hint-row" }, el("span", { class: "hint-l" }, "Korridor"), buf, bufVal);
  hintsSummary = el("span", { class: "muted small" });
  hintsDisc = el("details", { class: "disc" },
    el("summary", {}, icon("chevron"), el("span", { class: "sec-h" }, "Hinweise (optional)"), hintsSummary),
    el("div", { class: "disc-body stack-s" },
      hintRow("start", "Start", "var(--map-start)"), hintRow("end", "Ende", "var(--map-end)"),
      el("div", { class: "hint-row" }, el("span", { class: "hint-l" }, el("i", { class: "sw dash", style: "--c:var(--map-hint)" }), "Strecke"), hintLoad, hintName, hintDel),
      bufRow,
      el("p", { class: "help" }, "Start- und Endrahmen liegen im Suchrahmen. Eine GPX/KML-Datei grenzt die Suche auf einen Korridor ein.")));

  // ---- Advanced options (collapsed by default)
  alignMode = segmented<AlignMode>("Kurvenabgleich", [["posterior", "Fein"], ["turns", "Nur starke Kurven"]], "posterior", (v) => void saveCur({ align_mode: v }));
  alignMode.el.classList.add("fill");
  offset = el("input", { type: "number", step: "0.1", min: "-5", max: "5", placeholder: "Standard", class: "narrow", onchange: () => void saveCur({ offset_m: offset.value === "" ? null : Number(offset.value) }) });
  startTime = el("input", { type: "datetime-local", onchange: () => void saveCur({ start_time: fromLocalInput(startTime.value) }) });
  fromFile = btn("aus Video", () => { const ct = S.cur?.app.probe?.creation_time; if (ct) { startTime.value = toLocalInput(ct); void saveCur({ start_time: fromLocalInput(startTime.value) }); } }, { size: "sm" });
  decoys = el("select", { onchange: () => void saveCur({ decoys: Number(decoys.value) }) },
    ...([[0, "aus (Standard)"], [3, "3 Vergleichsstrecken"], [19, "19 (vollständig, dauert lange)"]] as const).map(([v, l]) => el("option", { value: String(v) }, l)));
  const alLabel = uid("al-l"), alHelp = uid("al-h");
  alignMode.el.removeAttribute("aria-label");
  alignMode.el.setAttribute("aria-labelledby", alLabel);
  alignMode.el.setAttribute("aria-describedby", alHelp);
  const alignField = el("div", { class: "field" }, el("label", { id: alLabel }, "Kurvenabgleich"), alignMode.el,
    el("div", { class: "help", id: alHelp }, "Fein gleicht überall dort an Kurven an, wo der Abgleich sicher ist. Ändert nur die Verfeinerung."));
  const opts = disclosure("Weitere Optionen",
    alignField,
    field("Fahrlinie (m rechts)", offset, "Abstand rechts von der Straßenmitte (Standard: 1,5–1,6 m).").el,
    el("div", { class: "row end-align" }, field("Startzeit", startTime, "Uhrzeit des ersten Videobilds. Später im Export änderbar.", "grow").el, fromFile),
    field("Plausibilitätstest", decoys, "Prüft gegen Vergleichsstrecken (ca. doppelte Rechenzeit).").el);

  // ---- Footer: only missing checks or crisp ready line + primary CTA
  checks = el("ul", { class: "checks", id: uid("checks"), "aria-label": "Voraussetzungen" });
  readyRow = el("div", { class: "row small ready-row", hidden: true });
  startBtn = btn("Abgleich starten", () => void onStart(), { kind: "primary", size: "lg", icon: "play", attrs: { "data-primary": "", "aria-describedby": checks.id } });
  resumeBtn = btn("Fortsetzen", () => void start(true).then((ok) => ok && go(routePath.project(S.cur!.app.id, "berechnung"))), { size: "lg" });
  runLink = el("a", { class: "btn lg", hidden: true }, "Zur Berechnung");
  footNote = el("p", { class: "small muted", hidden: true });

  const sec = (n: string, title: string, right: Node | null, ...body: (Node | null)[]) =>
    el("section", { class: "side-sec" },
      el("div", { class: "row between" }, el("h2", { class: "sec-h" }, n ? el("span", { class: "sec-n" }, n) : null, title), right),
      ...body);

  side.append(
    el("div", { class: "side-scroll" },
      el("section", { class: "side-sec" }, el("h2", { class: "sec-h" }, "Video"), atlasBox, videoMissing, videoInfo, videoEmpty, imp.el),
      sec("1", "Suchgebiet & Karte", frameSize,
        el("div", { class: "row setup-frame-bar" }, drawBtn, viewBtn, delBtn),
        coverage, sizeWarn),
      sec("2", "Fahrzeug", null, vehicle.el, bikePathsField),
      el("section", { class: "side-sec" }, hintsDisc, opts)),
    el("div", { class: "side-foot" }, checks, readyRow, el("div", { class: "row wrap" }, startBtn, resumeBtn, runLink), footNote));

  for (const ev of ["project", "bbox", "pbfs", "env", "run", "runtick", "import", "video", "video-state", "tool", "poster", "result", "import-title"]) bus.on(ev, schedule);
  bus.on("project", () => { ws.classList.remove("with-video"); previewBtn.setAttribute("aria-expanded", "false"); setBtnLabel(previewBtn, "Vorschau"); syncInputs(); });
  bus.on("stage", (s: string | null) => { if (s === "einrichten") { syncInputs(); update(); } });
}

let pending = false;
function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; update(); }); }

function syncInputs() {
  const app = S.cur?.app;
  if (!app) return;
  vehicle.set(app.vehicle ?? "auto");
  bikePaths.set(app.bike_paths ?? "off");
  alignMode.set(app.align_mode ?? "posterior");
  offset.value = app.offset_m == null ? "" : String(app.offset_m);
  startTime.value = toLocalInput(app.start_time);
  decoys.value = String(app.decoys ?? 0);
  buf.value = String(app.hint?.buffer_m ?? 300); bufVal.textContent = `${buf.value} m`;
  hintsDisc.open = !!(app.start_frame || app.end_frame || app.hint);
}

const CHECK_TARGET: Record<CheckId, () => void> = {
  video: () => (videoEmpty.hidden ? (imp.el.hidden ? videoInfo : imp.el) : videoEmpty).querySelector<HTMLElement>("button")?.focus(),
  frame: () => (S.bbox ? drawBtn : viewBtn).focus(),
  map: () => (mapBtn.isConnected ? mapBtn : drawBtn).focus(),
  tools: () => go(routePath.tools),
};

function update() {
  const cur = S.cur;
  if (!cur || side.closest(".ws")?.getAttribute("data-stage") !== "einrichten") return;
  const app = cur.app;
  const running = S.run.running || active.project === app.id;
  const loading = importingFor(app.id);
  const editable = canEditFrames();

  // video
  imp.update(app.id);
  renderAtlas(loading);
  videoInfo.hidden = !app.video || S.videoMissing;
  videoEmpty.hidden = !!app.video || loading || !imp.el.hidden || !!app.atlas;
  videoMissing.replaceChildren();
  if (app.video && S.videoMissing) videoMissing.append(banner("warn", el("div", {}, "Das Video wurde nicht gefunden: ", el("span", { class: "mono wrap-any" }, app.video)), el("div", { class: "row" }, btn("Neu zuordnen …", async () => { const f = await api.pickVideo(); if (f) await attachVideo(app.id, f); }, { size: "sm" }))));
  if (app.video) {
    const p = app.probe;
    vTitle.textContent = p?.title ?? app.name;
    vMeta.textContent = [p?.duration ? fmtDur(p.duration) : null, p?.width ? `${p.width}×${p.height}` : null, p?.codec?.toUpperCase(), p?.hdr ? "HDR" : null, p?.bytes ? fmtBytes(p.bytes) : null].filter(Boolean).join(" · ");
    if (app.poster && poster.tagName !== "IMG") { const img = el("img", { class: "poster lg", src: api.fileUrl(app.poster), alt: "" }); poster.replaceWith(img); poster = img; }
  }

  // search frame & map
  const b = S.bbox;
  frameSize.hidden = !b;
  frameSize.textContent = b ? fmtSize(b) : "";
  const tool = mapTools.active();
  drawBtn.setAttribute("aria-pressed", String(tool === "search"));
  setBtnLabel(drawBtn, tool === "search" ? "Beenden" : b ? "Neu zeichnen" : "Zeichnen");
  for (const x of [drawBtn, viewBtn]) x.disabled = !editable;
  delBtn.disabled = !editable || !b; delBtn.hidden = !b;
  const cov = coveringPbfs(b), pbf = effectivePbf(b);
  coverage.replaceChildren();
  if (!b) coverage.append(el("div", { class: "row small muted" }, toneIcon("wait"), el("span", {}, "Ort links suchen oder Suchrahmen zeichnen.")));
  else if (pbf) {
    coverage.append(el("div", { class: "row small" }, toneIcon("ok"), el("span", { class: "ellipsis" }, `Karte: ${pbf.name} (${fmtBytes(pbf.bytes)})`)));
    if (cov.length > 1) { if (pbfSel.options.length !== cov.length || pbfSel.value !== pbf.path) pbfSel.replaceChildren(...cov.map((p) => el("option", { value: p.path, selected: p.path === pbf.path }, `${p.name} · ${fmtBytes(p.bytes)}`))); pbfSel.disabled = running; coverage.append(pbfSel); }
  } else {
    coverage.append(banner("warn", el("div", { class: "small" }, "Keine lokale Karte deckt diesen Suchrahmen ab."), el("div", {}, mapBtn)));
  }
  const w = b ? sizeWarning(b) : null;
  sizeWarn.hidden = !w; sizeWarn.textContent = w ?? "";

  // hints
  const frames = { start: S.startFrame, end: S.endFrame };
  for (const k of ["start", "end"] as const) {
    const r = hintRows[k];
    r.draw.setAttribute("aria-pressed", String(tool === k));
    setBtnLabel(r.draw, tool === k ? "Beenden" : frames[k] ? "Neu" : "Zeichnen");
    r.draw.disabled = !editable || !b;
    r.val.textContent = frames[k] ? fmtSize(frames[k]!) : "–";
    r.del.hidden = !frames[k]; r.del.disabled = !editable;
  }
  const h = app.hint;
  hintName.textContent = h ? h.name : "";
  hintName.title = h?.name ?? "";
  hintDel.hidden = !h; hintLoad.disabled = !editable; hintDel.disabled = !editable;
  bufRow.hidden = !h; buf.disabled = !editable;
  const parts = [frames.start ? "Start" : null, frames.end ? "Ende" : null, h ? "Strecke" : null].filter(Boolean);
  hintsSummary.textContent = parts.length ? parts.join(", ") : "keine";

  // vehicle, options
  vehicle.setDisabled(running);
  bikePaths.setDisabled(running);
  alignMode.setDisabled(running);
  bikePathsField.hidden = app.vehicle === "motorcycle" || app.vehicle === "car";
  for (const x of [offset, startTime, decoys]) x.disabled = running;
  fromFile.hidden = !app.probe?.creation_time; fromFile.disabled = running;

  // smart footer: show missing items as actionable links, or a single clean ready line
  const list = checklist();
  const open = list.filter((c) => !c.ok);
  const sig = open.map((c) => `${c.id}:${c.label}`).join("|") + loading;
  if (checks.dataset.sig !== sig) {
    const f = checks.contains(document.activeElement) ? document.activeElement!.textContent : null;
    checks.dataset.sig = sig;
    checks.replaceChildren(...open.map((c) =>
      el("li", { class: "check-item open" }, toneIcon("bad"),
        el("a", { href: c.id === "tools" ? routePath.tools : "#", onclick: (e: Event) => { if (c.id !== "tools") { e.preventDefault(); CHECK_TARGET[c.id](); } } }, `Fehlt: ${c.label}`))));
    if (f) Array.from(checks.querySelectorAll("a")).find((a) => a.textContent === f)?.focus();
  }
  checks.hidden = !open.length;
  const runningHere = active.project === app.id;
  readyRow.hidden = open.length > 0 || runningHere;
  if (!readyRow.hidden) {
    const videoCheck = list.find((c) => c.id === "video");
    readyRow.replaceChildren(toneIcon(loading ? "run" : "ok"), el("span", { class: loading ? "" : "ok-text" }, loading ? `${videoCheck?.label ?? "Video lädt"} · startet danach automatisch` : "Alles bereit für den Abgleich"));
  }
  setSoftDisabled(startBtn, open.length > 0 || !!active.project);
  setBtnLabel(startBtn, S.result ? "Neu berechnen" : "Abgleich starten");
  startBtn.hidden = runningHere;
  resumeBtn.hidden = !canResume();
  runLink.hidden = !runningHere; runLink.href = routePath.project(app.id, "berechnung");
  footNote.hidden = !(active.project && !runningHere);
  footNote.textContent = "Es läuft schon eine Berechnung in einem anderen Projekt.";
}

function renderAtlas(loading: boolean) {
  const app = S.cur!.app, a = app.atlas;
  const t = defaultTemplate("url");
  const failed = !!impState.done && !impState.done.ok && impState.project === app.id;
  const sig = a ? `${app.id}|${!!app.video}|${loading}|${t?.id ?? ""}|${failed}` : "";
  if (atlasBox.dataset.sig === sig) return;
  atlasBox.dataset.sig = sig; atlasBox.hidden = !a;
  if (!a) { atlasBox.replaceChildren(); return; }
  const job = a.job;
  const head = el("div", { class: "row wrap" }, chip("ridrs Scenic", "hint"), el("span", { class: "small mono" }, job.video_id),
    el("span", { class: "small muted" }, job.route_level ? `Route Stufe ${job.route_level}` : "ohne Route"));
  const parts: Node[] = [head];
  if (!app.video && !loading && !failed) {
    parts.push(el("div", { class: "small mono wrap-any muted" }, job.url));
    if (t) parts.push(el("div", { class: "row wrap" }, btn("Video importieren", () => void startImport(app.id, t, job.url), { kind: "primary", size: "sm", icon: "download" }),
      el("span", { class: "small muted" }, `Vorlage: ${t.name}`)));
    else parts.push(el("p", { class: "help" }, "Keine Import-Vorlage für Adressen eingerichtet. Vorschlag (480p, H.264):"),
      codeWell(YTDLP_480P, { label: "Vorschlag für eine Import-Vorlage" }).el, el("a", { href: routePath.settings, class: "small" }, "Import-Vorlagen öffnen"));
    parts.push(el("div", { class: "row wrap" }, btn("Lokale Datei wählen …", () => void pickVideo(), { size: "sm", icon: "folder" })));
  }
  atlasBox.replaceChildren(...parts);
}

async function onStart() {
  if (isSoftDisabled(startBtn)) { checks.querySelector<HTMLElement>("a")?.focus(); return; }
  if (S.result && !(await api.confirm("Das vorhandene Ergebnis wird ersetzt. Neu berechnen?"))) return;
  if (await start(false)) go(routePath.project(S.cur!.app.id, "berechnung"));
}

export function suggestAfterTitle() { if (S.cur && !S.bbox && !S.cur.app.suggested && S.settings?.suggest_online) void suggestFromTitle(); }
