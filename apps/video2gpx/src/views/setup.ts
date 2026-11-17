// Einrichten: the side panel next to the map. Video (or its download), search frame, hints, vehicle, options, and the
// checklist with the start button. Built once; update() patches it (no re-render while the user types).
import { api } from "../api";
import { attachVideo } from "../app/project";
import { go, routePath } from "../app/router";
import { active, canResume, checklist, start, type CheckId } from "../features/run";
import { importingFor } from "../features/import";
import { canEditFrames, mapTools, sizeWarning, suggestFromTitle } from "../mapPanel";
import { S, bus, coveringPbfs, effectivePbf, saveCur } from "../state";
import type { BikePaths, Vehicle } from "../types";
import { banner, btn, disclosure, emptyState, field, iconBtn, isSoftDisabled, segmented, setBtnLabel, setSoftDisabled, toneIcon, uid, type Tone } from "../ui/components";
import { icon } from "../ui/icons";
import { el, fmtBytes, fmtDur, fmtSize, fromLocalInput, toLocalInput } from "../util";
import { importBlock } from "./importDetails";
import { openMapData } from "./maps";
import { pickVideo } from "./start";

let side: HTMLElement, ws: HTMLElement;
let videoInfo: HTMLElement, videoEmpty: HTMLElement, videoMissing: HTMLElement, poster: HTMLElement, vTitle: HTMLElement, vMeta: HTMLElement, previewBtn: HTMLButtonElement;
let imp: ReturnType<typeof importBlock>;
let frameSize: HTMLElement, drawBtn: HTMLButtonElement, viewBtn: HTMLButtonElement, delBtn: HTMLButtonElement, coverage: HTMLElement, sizeWarn: HTMLElement, pbfSel: HTMLSelectElement, mapBtn: HTMLButtonElement;
let hintsDisc: HTMLDetailsElement, hintsSummary: HTMLElement;
const hintRows = {} as Record<"start" | "end", { draw: HTMLButtonElement; del: HTMLButtonElement; val: HTMLElement }>;
let hintLoad: HTMLButtonElement, hintDel: HTMLButtonElement, hintName: HTMLElement, buf: HTMLInputElement, bufVal: HTMLElement, bufRow: HTMLElement;
let vehicle: ReturnType<typeof segmented<Vehicle>>, bikePaths: ReturnType<typeof segmented<BikePaths>>, bikePathsField: HTMLElement, offset: HTMLInputElement, startTime: HTMLInputElement, fromFile: HTMLButtonElement, decoys: HTMLSelectElement;
let checks: HTMLUListElement, startBtn: HTMLButtonElement, resumeBtn: HTMLButtonElement, runLink: HTMLAnchorElement, footNote: HTMLElement;

export function mountSetup(sideEl: HTMLElement, wsEl: HTMLElement) {
  side = sideEl; ws = wsEl;
  // ---- video
  poster = el("span", { class: "poster lg none" }, icon("film"));
  vTitle = el("div", { class: "v-title" });
  vMeta = el("div", { class: "small muted tnum" });
  previewBtn = btn("Vorschau", () => { const on = !ws.classList.contains("with-video"); ws.classList.toggle("with-video", on); previewBtn.setAttribute("aria-expanded", String(on)); setBtnLabel(previewBtn, on ? "Vorschau schließen" : "Vorschau"); }, { size: "sm", icon: "play", attrs: { "aria-expanded": "false" } });
  videoInfo = el("div", { class: "v-info" }, poster, el("div", { class: "grow" }, vTitle, vMeta, el("div", { class: "row" }, previewBtn)));
  videoEmpty = emptyState("film", "Kein Video", "Wähle eine Datei oder gib auf der Startseite eine Adresse ein.",
    btn("Datei wählen …", () => void pickVideo(), { size: "sm", icon: "folder" }), btn("Adresse eingeben", () => go(routePath.start), { size: "sm" }));
  videoMissing = el("div", {});
  imp = importBlock();
  // ---- search frame
  frameSize = el("span", { class: "small muted tnum nowrap" });
  drawBtn = btn("Zeichnen", () => mapTools.toggleDraw("search"), { size: "sm", icon: "edit", attrs: { "aria-pressed": "false" } });
  viewBtn = btn("Sichtbarer Ausschnitt", () => mapTools.useView(), { size: "sm", icon: "map" });
  delBtn = btn("Löschen", () => mapTools.remove("search"), { size: "sm", icon: "trash" });
  coverage = el("div", { class: "coverage", "aria-live": "polite" });
  pbfSel = el("select", { "aria-label": "Karte für die Berechnung", onchange: () => void saveCur({ pbf: pbfSel.value }).then(update) });
  mapBtn = btn("Kartendaten laden …", () => openMapData(true), { size: "sm", icon: "download" });
  sizeWarn = el("div", { class: "small warn-text", hidden: true });
  // ---- hints
  const hintRow = (k: "start" | "end", label: string, color: string) => {
    // the accessible name is "<Start|Ende>rahmen" plus the visible button text (Zeichnen / Neu zeichnen / …)
    const lid = uid("hint-l"), bid = uid("hint-b");
    const r = { draw: btn("Zeichnen", () => mapTools.toggleDraw(k), { size: "sm", attrs: { id: bid, "aria-pressed": "false", "aria-labelledby": `${lid} ${bid}` } }), del: iconBtn("cross", `${label}rahmen löschen`, () => mapTools.remove(k)), val: el("span", { class: "small muted tnum" }) };
    hintRows[k] = r;
    return el("div", { class: "hint-row" }, el("span", { class: "hint-l" }, el("i", { class: "sw box", style: `--c:${color}` }), label, el("span", { id: lid, hidden: true }, `${label}rahmen`)), r.draw, r.val, r.del);
  };
  hintLoad = btn("GPX/KML laden …", () => void mapTools.loadHint(), { size: "sm", icon: "route" });
  hintDel = iconBtn("cross", "Streckenhinweis entfernen", () => void mapTools.removeHint());
  hintName = el("span", { class: "small ellipsis" });
  bufVal = el("output", { class: "small tnum" });
  buf = el("input", { type: "range", min: "100", max: "1000", step: "50", "aria-label": "Korridor um den Streckenhinweis", oninput: () => { bufVal.textContent = `${buf.value} m`; mapTools.setBuffer(Number(buf.value), false); }, onchange: () => mapTools.setBuffer(Number(buf.value), true) });
  bufRow = el("div", { class: "hint-row" }, el("span", { class: "hint-l" }, "Korridor"), buf, bufVal);
  hintsSummary = el("span", { class: "muted small" });
  hintsDisc = el("details", { class: "disc" },
    el("summary", {}, icon("chevron"), el("span", { class: "sec-h" }, el("span", { class: "sec-n" }, "2"), "Hinweise (optional)"), hintsSummary),
    el("div", { class: "disc-body stack-s" },
      hintRow("start", "Start", "var(--map-start)"), hintRow("end", "Ende", "var(--map-end)"),
      el("div", { class: "hint-row" }, el("span", { class: "hint-l" }, el("i", { class: "sw dash", style: "--c:var(--map-hint)" }), "Strecke"), hintLoad, hintName, hintDel),
      bufRow,
      el("p", { class: "help" }, "Start- und Endrahmen liegen im Suchrahmen. Ein Streckenhinweis (GPX oder KML) grenzt die Suche auf einen Korridor ein.")));
  // ---- vehicle and options
  vehicle = segmented<Vehicle>("Fahrzeug", [["auto", "Automatisch"], ["bike", "Fahrrad"], ["motorcycle", "Motorrad"], ["car", "Auto"]], "auto", (v) => void saveCur({ vehicle: v }).then(update));
  // bike paths (pipeline --bike-paths): only for a bike, so hidden for motorcycle and car
  bikePaths = segmented<BikePaths>("Rad- und Waldwege einbeziehen", [["off", "Aus"], ["auto", "Automatisch"], ["on", "Ein"]], "off", (v) => void saveCur({ bike_paths: v }));
  const bpLabel = uid("bp-l"), bpHelp = uid("bp-h");
  bikePaths.el.removeAttribute("aria-label");
  bikePaths.el.setAttribute("aria-labelledby", bpLabel);
  bikePaths.el.setAttribute("aria-describedby", bpHelp);
  bikePathsField = el("div", { class: "field" }, el("label", { id: bpLabel }, "Rad- und Waldwege einbeziehen"), bikePaths.el,
    el("div", { class: "help", id: bpHelp }, "Nur für Fahrräder. Automatisch: ein zweiter Durchlauf mit Rad-, Wald- und Feldwegen, wenn die Straßen keine sichere Route ergeben. Ein: immer mit diesen Wegen. Am besten mit kleinem Suchrahmen oder Streckenhinweis."));
  offset = el("input", { type: "number", step: "0.1", min: "-5", max: "5", placeholder: "Standard", class: "narrow", onchange: () => void saveCur({ offset_m: offset.value === "" ? null : Number(offset.value) }) });
  startTime = el("input", { type: "datetime-local", onchange: () => void saveCur({ start_time: fromLocalInput(startTime.value) }) });
  fromFile = btn("aus Videodatei", () => { const ct = S.cur?.app.probe?.creation_time; if (ct) { startTime.value = toLocalInput(ct); void saveCur({ start_time: fromLocalInput(startTime.value) }); } }, { size: "sm" });
  decoys = el("select", { onchange: () => void saveCur({ decoys: Number(decoys.value) }) },
    ...([[0, "aus (Standard)"], [3, "3 Vergleichsstrecken"], [19, "19 (vollständig, dauert lange)"]] as const).map(([v, l]) => el("option", { value: String(v) }, l)));
  const opts = disclosure("Weitere Optionen",
    field("Fahrlinie (m rechts)", offset, "Abstand rechts von der Straßenmitte in Metern. Leer = Standard (Fahrrad 1,5 m, sonst 1,6 m).").el,
    el("div", { class: "row end-align" }, field("Startzeit", startTime, "Uhrzeit des ersten Videobilds für die GPX-Zeitstempel. Später änderbar.", "grow").el, fromFile),
    field("Plausibilitätstest", decoys, "Prüft die Route gegen Vergleichsstrecken. Verdoppelt etwa die Rechenzeit.").el);
  // ---- footer
  checks = el("ul", { class: "checks", id: uid("checks"), "aria-label": "Voraussetzungen" });
  startBtn = btn("Abgleich starten", () => void onStart(), { kind: "primary", size: "lg", icon: "play", attrs: { "data-primary": "", "aria-describedby": checks.id } });
  resumeBtn = btn("Fortsetzen", () => void start(true).then((ok) => ok && go(routePath.project(S.cur!.app.id, "berechnung"))), { size: "lg" });
  runLink = el("a", { class: "btn lg", hidden: true }, "Zur Berechnung");
  footNote = el("p", { class: "small muted", hidden: true });

  const sec = (n: string, title: string, ...body: (Node | null)[]) => el("section", { class: "side-sec" }, el("h2", { class: "sec-h" }, n ? el("span", { class: "sec-n" }, n) : null, title), ...body);
  side.append(
    el("div", { class: "side-scroll" },
      el("section", { class: "side-sec" }, el("h2", { class: "sec-h" }, "Video"), videoMissing, videoInfo, videoEmpty, imp.el),
      sec("1", "Suchrahmen", el("div", { class: "row between" }, el("div", { class: "row wrap" }, drawBtn, viewBtn, delBtn), frameSize), coverage, sizeWarn),
      el("section", { class: "side-sec" }, hintsDisc),
      sec("3", "Fahrzeug", vehicle.el, bikePathsField, opts)),
    el("div", { class: "side-foot" }, checks, el("div", { class: "row wrap" }, startBtn, resumeBtn, runLink), footNote));

  for (const ev of ["project", "bbox", "pbfs", "env", "run", "runtick", "import", "video", "video-state", "tool", "poster", "result", "import-title"]) bus.on(ev, schedule);
  bus.on("project", () => { ws.classList.remove("with-video"); previewBtn.setAttribute("aria-expanded", "false"); setBtnLabel(previewBtn, "Vorschau"); syncInputs(); });
  bus.on("stage", (s: string | null) => { if (s === "einrichten") { syncInputs(); update(); } });
}

let pending = false;
function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; update(); }); }

/** form values from the project (only when a project is opened, never while the user types) */
function syncInputs() {
  const app = S.cur?.app;
  if (!app) return;
  vehicle.set(app.vehicle ?? "auto");
  bikePaths.set(app.bike_paths ?? "off");
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
  videoInfo.hidden = !app.video || S.videoMissing;
  videoEmpty.hidden = !!app.video || loading || !imp.el.hidden;
  videoMissing.replaceChildren();
  if (app.video && S.videoMissing) videoMissing.append(banner("warn", el("div", {}, "Das Video wurde nicht gefunden: ", el("span", { class: "mono wrap-any" }, app.video)), el("div", { class: "row" }, btn("Neu zuordnen …", async () => { const f = await api.pickVideo(); if (f) await attachVideo(app.id, f); }, { size: "sm" }))));
  if (app.video) {
    const p = app.probe;
    vTitle.textContent = p?.title ?? app.name;
    vMeta.textContent = [p?.duration ? fmtDur(p.duration) : null, p?.width ? `${p.width}×${p.height}` : null, p?.codec?.toUpperCase(), p?.hdr ? "HDR" : null, p?.bytes ? fmtBytes(p.bytes) : null].filter(Boolean).join(" · ");
    if (app.poster && poster.tagName !== "IMG") { const img = el("img", { class: "poster lg", src: api.fileUrl(app.poster), alt: "" }); poster.replaceWith(img); poster = img; }
  }
  // search frame
  const b = S.bbox;
  frameSize.textContent = b ? fmtSize(b) : "";
  const tool = mapTools.active();
  drawBtn.setAttribute("aria-pressed", String(tool === "search"));
  setBtnLabel(drawBtn, tool === "search" ? "Zeichnen beenden" : b ? "Neu zeichnen" : "Zeichnen");
  for (const x of [drawBtn, viewBtn]) x.disabled = !editable;
  delBtn.disabled = !editable || !b; delBtn.hidden = !b;
  const cov = coveringPbfs(b), pbf = effectivePbf(b);
  coverage.replaceChildren();
  if (!b) coverage.append(el("div", { class: "row" }, toneIcon("wait"), el("span", { class: "muted" }, "Zuerst einen Suchrahmen zeichnen.")));
  else if (pbf) {
    coverage.append(el("div", { class: "row" }, toneIcon("ok"), el("span", {}, `Karte: ${pbf.name} (${fmtBytes(pbf.bytes)})`)));
    if (cov.length > 1) { if (pbfSel.options.length !== cov.length || pbfSel.value !== pbf.path) pbfSel.replaceChildren(...cov.map((p) => el("option", { value: p.path, selected: p.path === pbf.path }, `${p.name} · ${fmtBytes(p.bytes)}`))); pbfSel.disabled = running; coverage.append(pbfSel); }
  } else coverage.append(el("div", { class: "row wrap" }, toneIcon("bad"), el("span", {}, "Keine lokale Karte deckt den Suchrahmen ab.")), el("div", {}, mapBtn));
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
  const parts = [frames.start ? "Startrahmen" : null, frames.end ? "Endrahmen" : null, h ? "Strecke" : null].filter(Boolean);
  hintsSummary.textContent = parts.length ? parts.join(", ") : "keine";
  // vehicle, options
  vehicle.setDisabled(running);
  bikePaths.setDisabled(running);
  bikePathsField.hidden = app.vehicle === "motorcycle" || app.vehicle === "car";
  for (const x of [offset, startTime, decoys]) x.disabled = running;
  fromFile.hidden = !app.probe?.creation_time; fromFile.disabled = running;
  // checklist and start
  const list = checklist();
  const rows = list.map((c) => {
    const tone: Tone = c.ok ? (c.id === "video" && loading ? "run" : "ok") : "bad";
    const li = el("li", { class: `check-item ${c.ok ? "ok" : "open"}` }, toneIcon(tone), c.ok ? el("span", {}, c.label) : el("a", { href: c.id === "tools" ? routePath.tools : "#", onclick: (e: Event) => { if (c.id !== "tools") { e.preventDefault(); CHECK_TARGET[c.id](); } } }, c.label));
    return li;
  });
  const sig = list.map((c) => `${c.id}:${c.ok}:${c.label}`).join("|") + loading;
  if (checks.dataset.sig !== sig) {
    const f = checks.contains(document.activeElement) ? document.activeElement!.textContent : null;
    checks.dataset.sig = sig; checks.replaceChildren(...rows);
    if (f) Array.from(checks.querySelectorAll("a")).find((a) => a.textContent === f)?.focus();
  }
  const open = list.filter((c) => !c.ok);
  const runningHere = active.project === app.id;
  setSoftDisabled(startBtn, open.length > 0 || !!active.project);
  setBtnLabel(startBtn, S.result ? "Neu berechnen" : "Abgleich starten");
  startBtn.hidden = runningHere;
  resumeBtn.hidden = !canResume();
  runLink.hidden = !runningHere; runLink.href = routePath.project(app.id, "berechnung");
  footNote.hidden = !(open.length || (active.project && !runningHere) || (loading && !open.length));
  footNote.textContent = open.length ? `Es fehlt noch: ${open.map((c) => c.label).join(", ")}.` : active.project && !runningHere ? "Es läuft schon eine Berechnung in einem anderen Projekt." : "Die Berechnung startet, sobald das Video geladen ist.";
}

async function onStart() {
  if (isSoftDisabled(startBtn)) { checks.querySelector<HTMLElement>("a")?.focus(); return; }
  if (S.result && !(await api.confirm("Das vorhandene Ergebnis wird ersetzt. Neu berechnen?"))) return;
  if (await start(false)) go(routePath.project(S.cur!.app.id, "berechnung"));
}

/** after the title of an import is known: the map may suggest a search frame from it */
export function suggestAfterTitle() { if (S.cur && !S.bbox && !S.cur.app.suggested && S.settings?.suggest_online) void suggestFromTitle(); }
