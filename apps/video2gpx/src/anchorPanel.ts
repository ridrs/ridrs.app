// Always-available "Ort festlegen" toolbar action + compact anchor tray on Ergebnis (Übersicht, Höhe, Analyse),
// plus advanced step-selective rerun inside the collapsible "Route anpassen & korrigieren" panel.
import L from "leaflet";
import { addAnchor, anchorReport, anchorReportDe, fmtT, normalizeAnchors, removeAnchor, rerunChoices, sameAnchors, type Anchor } from "./anchors";
import { go, routePath } from "./app/router";
import { active, start } from "./features/run";
import { normBox } from "./frames";
import { getMap } from "./mapPanel";
import { STEPS, S, bus, saveCur, toast } from "./state";
import type { Bbox, StepId } from "./types";
import { banner, btn, disclosure, iconBtn } from "./ui/components";
import { el, fmtSize } from "./util";
import { getPlayer } from "./videoPanel";

const COLOR = "#ea580c";
const MIN_DEG = 0.0002;
let barEl: HTMLElement, trayEl: HTMLElement, advRoot: HTMLElement;
let list: HTMLElement, report: HTMLElement, drawBtn: HTMLButtonElement, rerunBtn: HTMLButtonElement, stepSel: HTMLSelectElement, stepBtn: HTMLButtonElement, drawHint: HTMLElement;
let layer: L.LayerGroup | null = null;
let curT = 0;
let drawing = false, startLL: L.LatLng | null = null, tmp: L.Rectangle | null = null, suppressClick = false;

const anchors = (): Anchor[] => normalizeAnchors(S.cur?.app.anchors);
const locked = () => S.run.running || !!active.project;

function seekTo(t: number) {
  curT = t;
  if (getPlayer()) bus.emit("seek", t); else bus.emit("time", t);
  bus.emit("seeked");
}

async function setAnchors(a: Anchor[]) {
  if (!S.cur) return;
  await saveCur({ anchors: a.length ? a : null });
  render(); drawOnMap();
}

export function mountAnchors(barHost: HTMLElement, trayHost: HTMLElement, advancedHost: HTMLElement) {
  barEl = barHost;
  trayEl = trayHost;

  drawBtn = btn("Ort festlegen", () => toggleDraw(), { size: "sm", icon: "pin", attrs: { "aria-pressed": "false", title: "Video an eine bekannte Stelle spulen, klicken und einen Rahmen auf der Karte ziehen" } });
  rerunBtn = btn("Mit Ortsangaben neu berechnen", () => void rerun(null), { kind: "primary", size: "sm" });
  rerunBtn.hidden = true;
  barEl.append(drawBtn, rerunBtn);

  drawHint = el("p", { class: "small muted", hidden: true }, "Video an die gewünschte Stelle spulen und einen Rahmen auf der Karte ziehen (Esc zum Abbrechen).");
  list = el("ul", { class: "anchor-pills", "aria-label": "Ortsangaben" });
  report = el("div", {});
  trayEl.append(drawHint, list, report);

  stepSel = el("select", { "aria-label": "Ab welchem Schritt neu berechnen" }) as HTMLSelectElement;
  stepBtn = btn("Neu berechnen", () => void rerun((stepSel.value || null) as StepId | null), { size: "sm" });
  const advStep = disclosure("Erweitert: ab bestimmtem Schritt neu berechnen",
    el("div", { class: "row wrap small" }, el("label", {}, "Ab Schritt ", stepSel), stepBtn),
    el("p", { class: "help" }, "Schritte davor werden aus dem letzten Lauf übernommen und nicht neu gerechnet."));
  advRoot = el("section", { class: "anchors adjust-sec stack-s", "aria-label": "Erweiterte Neuberechnung" }, advStep);
  advancedHost.append(advRoot);

  bus.on("time", (t: number) => { curT = t; if (drawing) setDrawLabel(); });
  bus.on("stage", (s: string | null) => { if (s !== "ergebnis" && drawing) stopDraw(); });
  for (const ev of ["project", "result", "run", "runtick"]) bus.on(ev, () => { render(); if (ev !== "runtick") drawOnMap(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawing) stopDraw(); });
  queueMicrotask(() => initMap());
}

function initMap() {
  const map = getMap();
  if (!map) { setTimeout(initMap, 200); return; }
  layer = L.layerGroup().addTo(map);
  const c = map.getContainer();
  c.addEventListener("click", (e) => { if (suppressClick) { suppressClick = false; e.stopPropagation(); } }, true);
  map.on("mousedown", (e: L.LeafletMouseEvent) => {
    if (!drawing) return;
    startLL = e.latlng;
    tmp = L.rectangle([[e.latlng.lat, e.latlng.lng], [e.latlng.lat, e.latlng.lng]], { color: COLOR, weight: 2, fillOpacity: 0.2, interactive: false }).addTo(map);
  });
  map.on("mousemove", (e: L.LeafletMouseEvent) => {
    if (!drawing || !startLL || !tmp) return;
    const b = normBox(startLL.lat, startLL.lng, e.latlng.lat, e.latlng.lng);
    tmp.setBounds([[b[0], b[1]], [b[2], b[3]]]);
  });
  document.addEventListener("mouseup", (e) => {
    if (!drawing || !startLL) return;
    const ll = map.mouseEventToLatLng(e);
    const b: Bbox = normBox(startLL.lat, startLL.lng, ll.lat, ll.lng);
    const t = curT;
    suppressClick = true; setTimeout(() => (suppressClick = false), 0);
    stopDraw();
    if (b[2] - b[0] < MIN_DEG || b[3] - b[1] < MIN_DEG) { toast("Bitte einen Rahmen ziehen (mindestens etwa 20 m)."); return; }
    void setAnchors(addAnchor(anchors(), t, b)).then(() => toast(`Ortsangabe für ${fmtT(t)} gespeichert.`));
  });
  drawOnMap();
}

function setDrawLabel() { drawBtn.querySelector("span")!.textContent = drawing ? `Rahmen für ${fmtT(curT)} ziehen … (Esc)` : "Ort festlegen"; }

function toggleDraw() { if (drawing) stopDraw(); else startDraw(); }
function startDraw() {
  const map = getMap();
  if (!map || locked() || !S.cur) return;
  getPlayer()?.pause();
  drawing = true;
  map.dragging.disable();
  map.getContainer().classList.add("drawing");
  drawBtn.setAttribute("aria-pressed", "true");
  setDrawLabel();
  render();
}
function stopDraw() {
  const map = getMap();
  drawing = false; startLL = null;
  tmp?.remove(); tmp = null;
  map?.dragging.enable();
  map?.getContainer().classList.remove("drawing");
  drawBtn.setAttribute("aria-pressed", "false");
  setDrawLabel();
  render();
}

function drawOnMap() {
  if (!layer) return;
  layer.clearLayers();
  for (const a of anchors()) {
    const r = L.rectangle([[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[3]]], { color: COLOR, weight: 2, fillOpacity: 0.15, dashArray: "4 3" }).addTo(layer);
    r.bindTooltip(fmtT(a.t), { permanent: true, direction: "top", className: "anchor-label" });
    r.on("click", (e: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); seekTo(a.t); });
  }
}

function finished(): Partial<Record<StepId, boolean>> {
  const o: Partial<Record<StepId, boolean>> = {};
  for (const s of STEPS) o[s.id] = ["done", "skipped"].includes(S.run.steps[s.id].state) || (!!S.result && !S.run.started);
  return o;
}

function render() {
  if (!barEl) return;
  const a = anchors(), lk = locked(), app = S.cur?.app;
  barEl.hidden = !app;
  advRoot.hidden = !app;
  if (!app) { trayEl.hidden = true; return; }
  if (lk && drawing) stopDraw();
  drawBtn.disabled = lk;
  drawHint.hidden = !drawing;
  list.replaceChildren(...a.map((x, i) => {
    const coords = `${x.bbox[0].toFixed(4)}, ${x.bbox[1].toFixed(4)} – ${x.bbox[2].toFixed(4)}, ${x.bbox[3].toFixed(4)}`;
    return el("li", { class: "anchor-pill" },
      btn(`${fmtT(x.t)}`, () => { seekTo(x.t); getMap()?.fitBounds([[x.bbox[0], x.bbox[1]], [x.bbox[2], x.bbox[3]]], { maxZoom: 17, padding: [60, 60] }); }, { size: "sm", kind: "ghost", attrs: { title: "Video zu dieser Zeit spulen und Rahmen zeigen", "aria-label": `Ortsangabe ${fmtT(x.t)}: Video hierhin spulen` } }),
      el("span", { class: "small muted tnum", title: coords }, fmtSize(x.bbox)),
      iconBtn("trash", `Ortsangabe ${fmtT(x.t)} löschen`, () => { if (!locked()) void setAnchors(removeAnchor(anchors(), i)); }, { disabled: lk }));
  }));
  list.hidden = !a.length;
  const changed = !sameAnchors(a, app.last_run?.anchors);
  rerunBtn.hidden = !changed;
  rerunBtn.disabled = lk || !app.last_run || !changed;
  const rep = anchorReport(S.result?.project?.steps?.route_search?.summary?.anchors ?? S.result?.project?.anchors);
  report.replaceChildren();
  if (rep) report.append(rep.dropped.length ? banner("warn", anchorReportDe(rep), ". Ein nicht erfüllbarer Rahmen passt zu keiner Route zusammen mit den anderen; bitte Zeit und Rahmen prüfen.") : el("p", { class: "small" }, anchorReportDe(rep) + "."));
  trayEl.hidden = !drawing && !a.length && !rep;

  const ch = rerunChoices(finished());
  const key = ch.join(",");
  if (stepSel.dataset.key !== key) {
    stepSel.dataset.key = key;
    const prev = stepSel.value;
    stepSel.replaceChildren(...ch.map((id, i) => el("option", { value: id }, `${i + 1}. ${STEPS.find((s) => s.id === id)!.label}${i === 0 ? " (alles neu)" : ""}`)));
    stepSel.value = ch.includes(prev as StepId) ? prev : ch.includes("route_search") ? "route_search" : ch[0];
  }
  stepSel.disabled = lk; stepBtn.disabled = lk || !app.last_run;
}

async function rerun(fromStep: StepId | null) {
  const id = S.cur?.app.id;
  if (!id || locked()) return;
  if (await start(false, fromStep)) go(routePath.project(id, "berechnung"));
}
