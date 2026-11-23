import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "./api";
import { FRAME_STYLE, FrameEditor, clampBox, type FrameKind } from "./frames";
import { growBbox, hintBounds, parseHint } from "./hint";
import { importingFor } from "./features/import";
import { S, bus, saveCur, toast } from "./state";
import type { Bbox, GeoHit, ProjectApp, RoutePoint } from "./types";
import { CONF_COLORS, KM_PER_DEG, bboxSizeKm, fmtSize, confClass, debounce, el, nearestPoint, pointAt, pointAtArc, squareAround } from "./util";

let map: L.Map;
let routeLayer = L.layerGroup();
let hintLayer = L.layerGroup();
let corridor: L.Polyline | null = null;
let frames: FrameEditor;
let marker: L.Marker | null = null;
/** the Höhe stage: the position under the mouse in the chart, and a stretch it points at */
let hoverDot: L.CircleMarker | null = null;
const markLayer = L.layerGroup();
let bannerEl: HTMLElement, offlineEl: HTMLElement, resultsEl: HTMLElement, noteEl: HTMLElement, searchInput: HTMLInputElement, legendEl: HTMLElement;
const markProgrammatic = (_ms = 900) => {}; // (the view no longer sets the search area)
/** frames are locked while a job runs */
const locked = () => S.run.running;
/** frames and hints can be edited: a video is there or on its way, and no job runs */
export const canEditFrames = () => !!S.cur && !locked() && (!!S.cur.app.video || importingFor(S.cur.app.id));
const HINT_COLOR = "#7c3aed";
const HINT_MARGIN_KM = 3;
/** read when the map is built: the mock may point it elsewhere (scenario "offline") */
const tileUrl = (): string => (window as any).__v2gTiles ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const arrowIcon = () =>
  L.divIcon({
    className: "pos-icon",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<div class="pos-arrow"><svg viewBox="0 0 34 34" width="34" height="34"><path d="M17 2 L26 26 L17 21 L8 26 Z" fill="#e5484d" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div>`,
  });

/** Builds the map region of the project workspace once: place search, banners, the square map, the legend. */
export function initMapPanel(root: HTMLElement) {
  searchInput = el("input", { type: "search", placeholder: "Ort suchen …", "aria-label": "Ort suchen", onkeydown: (e: KeyboardEvent) => {
    if (e.key === "Enter") void doSearch();
    else if (e.key === "ArrowDown" && !resultsEl.hidden) { e.preventDefault(); resultsEl.querySelector<HTMLElement>("button")?.focus(); }
    else if (e.key === "Escape") resultsEl.hidden = true;
  } });
  resultsEl = el("div", { class: "search-results", hidden: true, onkeydown: (e: KeyboardEvent) => {
    const els = Array.from(resultsEl.querySelectorAll<HTMLElement>("button")), i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); els[Math.min(els.length - 1, i + 1)]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) searchInput.focus(); else els[i - 1].focus(); }
    else if (e.key === "Escape") { resultsEl.hidden = true; searchInput.focus(); }
  } });
  bannerEl = el("div", { class: "banner info map-banner", hidden: true });
  offlineEl = el("div", { class: "banner warn map-banner", hidden: true }, "Keine Verbindung: Die Karte wird nicht angezeigt. Die Berechnung braucht kein Netz.");
  noteEl = el("div", { class: "map-note", hidden: true });
  legendEl = el("div", { class: "maplegend" });
  const mapDiv = el("div", { id: "map", class: "map" });
  root.append(
    el("div", { class: "search", role: "search" }, searchInput, el("button", { type: "button", class: "btn", onclick: () => void doSearch() }, "Suchen"), resultsEl),
    offlineEl, bannerEl,
    el("div", { class: "mapwrap" }, mapDiv, noteEl), legendEl,
    el("details", { class: "disc policy" }, el("summary", {}, "Ortssuche über Nominatim (online)"), el("div", { class: "disc-body small muted" }, "Die Ortssuche fragt Nominatim (OpenStreetMap) nur auf deine Suche hin, höchstens einmal pro Sekunde. Die Kartenkacheln kommen von openstreetmap.org. Die Berechnung selbst läuft offline.")));

  map = L.map(mapDiv, { zoomSnap: 0, zoomDelta: 0.5, wheelPxPerZoomLevel: 45, preferCanvas: true, attributionControl: false, center: [46.8, 8.2], zoom: 6 });
  // Touchpad pinch arrives as a wheel event with ctrlKey and tiny deltas (a few px); Leaflet treats it like a mouse wheel, which is far too slow
  mapDiv.addEventListener("wheel", (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() - e.deltaY * 0.04, { animate: false });
  }, { capture: true, passive: false });
  L.control.attribution({ prefix: false }).addAttribution('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors (ODbL)</a>').addTo(map);
  const tiles = L.tileLayer(tileUrl(), { maxZoom: 19, attribution: "" }).addTo(map);
  // offline: no tile has loaded and tiles fail
  let loaded = 0;
  tiles.on("tileload", () => { loaded++; offlineEl.hidden = true; });
  tiles.on("tileerror", () => { if (!loaded || !navigator.onLine) offlineEl.hidden = false; });
  window.addEventListener("offline", () => { loaded = 0; offlineEl.hidden = false; });
  window.addEventListener("online", () => { offlineEl.hidden = true; tiles.redraw(); });
  const zc = mapDiv.querySelector(".leaflet-control-zoom");
  zc?.querySelector(".leaflet-control-zoom-in")?.setAttribute("aria-label", "Vergrößern");
  zc?.querySelector(".leaflet-control-zoom-out")?.setAttribute("aria-label", "Verkleinern");
  zc?.querySelectorAll("a").forEach((a) => a.removeAttribute("title"));
  mapDiv.setAttribute("aria-label", "Karte");
  hintLayer.addTo(map);
  routeLayer.addTo(map);
  markLayer.addTo(map);
  (window as any).__v2gMap = map;

  frames = new FrameEditor(map, {
    locked,
    limit: (k) => (k === "search" ? null : S.bbox),
    onChange: (k, b) => setFrame(k, b),
  });
  frames.onDrawEnd = () => bus.emit("tool");

  map.on("moveend", sizeCorridor);
  map.on("zoomend", sizeCorridor);
  map.on("click", (e: L.LeafletMouseEvent) => {
    const pts = S.result?.points;
    if (!pts || !routeVisible()) return;
    const { p, dM } = nearestPoint(pts, e.latlng.lat, e.latlng.lng);
    const pxPerM = map.getZoom() ? 1 / metersPerPixel() : 0;
    if (dM * pxPerM > 24) return; // only clicks near the route
    bus.emit("seek", p.t);
    placeMarker(p);
  });
  document.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest(".search")) resultsEl.hidden = true; });

  bus.on("project", (app: ProjectApp | null) => void onProject(app));
  bus.on("result", () => { drawRoute(); renderLegend(); });
  bus.on("stage", (s: string | null) => { curStage = s; renderLegend(); });
  bus.on("bbox", renderLegend);
  bus.on("time", (t: number) => { lastT = t; const pts = S.result?.points; if (pts && routeVisible()) { const p = pointAt(pts, t); placeMarker(p); followMarker(p); } });
  bus.on("run", drawFrames);
  // after a window resize or a change of stage Leaflet must learn the new size (the frames are not tied to the view)
  let lastW = 0;
  const onResize = debounce(() => {
    const w = mapDiv.clientWidth;
    if (!w) return;
    map.invalidateSize({ pan: false });
    if (!lastW) refit(); // the map was hidden (another stage): show the frame or the route again
    lastW = w;
  }, 120);
  new ResizeObserver(() => { if (!mapDiv.clientWidth) lastW = 0; onResize(); }).observe(mapDiv);
  renderLegend();
}

/** fit the view to what matters in the open project: the route, else the search frame */
function refit() {
  const pts = S.result?.points;
  if (pts?.length && routeVisible()) map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number])), { padding: [30, 30], animate: false });
  else if (S.bbox) map.fitBounds([[S.bbox[0], S.bbox[1]], [S.bbox[2], S.bbox[3]]], { padding: [30, 30], animate: false });
}

const metersPerPixel = () => (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (256 * Math.pow(2, map.getZoom()));
const routeVisible = () => !!S.result && (S.showRoute || S.result.verdict !== "no_route");



// ---------- frames: search, start, end ----------

function persist() {
  if (S.cur) void saveCur({ bbox: S.bbox, start_frame: S.startFrame, end_frame: S.endFrame });
}

/** keep the start and end frame inside the search frame: shrink to the overlap, delete when nothing is left */
function clampInner(): string | null {
  let msg: string | null = null;
  for (const k of ["start", "end"] as const) {
    const cur = k === "start" ? S.startFrame : S.endFrame;
    if (!cur) continue;
    if (!S.bbox) { msg = `${FRAME_STYLE[k].label}rahmen entfernt: kein Suchrahmen.`; k === "start" ? (S.startFrame = null) : (S.endFrame = null); continue; }
    const c = clampBox(cur, S.bbox);
    const nothing = c[2] - c[0] < 0.0004 || c[3] - c[1] < 0.0004;
    const next = nothing ? null : c;
    if (nothing) msg = `Der ${k === "start" ? "Start" : "Ende"}-Rahmen lag außerhalb des Suchrahmens und wurde entfernt.`;
    else if (c.some((v, i) => Math.abs(v - cur[i]) > 1e-9)) msg = `Der ${k === "start" ? "Start" : "Ende"}-Rahmen wurde an den Suchrahmen angepasst.`;
    k === "start" ? (S.startFrame = next) : (S.endFrame = next);
  }
  return msg;
}

function setFrame(kind: FrameKind, b: Bbox | null) {
  if (locked()) return;
  if (kind === "search") S.bbox = b; else if (kind === "start") S.startFrame = b; else S.endFrame = b;
  const msg = kind === "search" ? clampInner() : null;
  if (msg) toast(msg);
  drawFrames(); persist();
  bus.emit("bbox");
}

function drawFrames() {
  if (!frames) return;
  frames.set("search", S.bbox, S.bbox ? fmtSize(S.bbox) : ""); frames.set("start", S.startFrame, S.startFrame ? fmtSize(S.startFrame) : ""); frames.set("end", S.endFrame, S.endFrame ? fmtSize(S.endFrame) : "");
}

function viewBox(): Bbox { const b = map.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]; }

/** The map tools of the Einrichten stage (the buttons live in views/setup.ts; the editing state stays here). */
export const mapTools = {
  /** the frame kind that is being drawn, or null */
  active: (): FrameKind | null => frames?.activeTool ?? null,
  /** start drawing a frame with the pointer; a second call for the same kind cancels */
  toggleDraw(k: FrameKind) {
    if (!canEditFrames() || (k !== "search" && !S.bbox)) return;
    if (frames.activeTool === k) frames.cancelDraw(); else { frames.startDraw(k); bus.emit("tool"); }
  },
  /** the search frame becomes the visible part of the map (the keyboard way to create one) */
  useView() { if (canEditFrames()) { const v = viewBox(); const dLa = (v[2] - v[0]) * 0.04, dLo = (v[3] - v[1]) * 0.04; setFrame("search", [v[0] + dLa, v[1] + dLo, v[2] - dLa, v[3] - dLo]); } },
  remove(k: FrameKind) { if (canEditFrames()) setFrame(k, null); },
  focusFrame(k: FrameKind) { frames.focus(k); },
  loadHint: () => loadHint(),
  removeHint: () => removeHint(),
  /** corridor width while the slider moves (commit: save) */
  setBuffer(m: number, commit: boolean) {
    const h = S.cur?.app.hint;
    if (!h || locked()) return;
    h.buffer_m = m; sizeCorridor();
    if (commit) { void saveCur({}); bus.emit("bbox"); }
  },
  focusSearch() { searchInput.focus(); },
};

/** whether the map pans along with the position during playback (remembered) */
const FOLLOW_KEY = "v2g.mapFollow";
let follow = true;
try { follow = localStorage.getItem(FOLLOW_KEY) !== "0"; } catch { /* private mode */ }
let followBox: HTMLElement | null = null;
let lastT = 0;
let curStage: string | null = null;
function followToggle(): HTMLElement {
  if (followBox) return followBox;
  const cb = el("input", { type: "checkbox", checked: follow, onchange: () => {
    follow = cb.checked;
    try { localStorage.setItem(FOLLOW_KEY, follow ? "1" : "0"); } catch { /* private mode */ }
    const pts = S.result?.points;
    if (follow && pts && routeVisible()) followMarker(pointAt(pts, lastT));
  } });
  followBox = el("label", { class: "check map-follow" }, cb, el("span", {}, "Karte folgt der Position"));
  return followBox;
}

function renderLegend() {
  legendEl.replaceChildren();
  const sw = (cls: string, color: string, label: string) => el("span", { class: "lg" }, el("i", { class: `sw ${cls}`, style: `--c:${color}` }), label);
  const playback = curStage === "ergebnis" || curStage === "analyse" || curStage === "hoehe";
  if (playback) {
    legendEl.append(sw("line", CONF_COLORS.high, "Route"), sw("line", CONF_COLORS.mid, "mittel"), sw("line", CONF_COLORS.low, "gering"));
    if (S.hint) legendEl.append(sw("dash", HINT_COLOR, "Hinweis"));
    legendEl.append(followToggle());
  } else {
    legendEl.append(sw("box", FRAME_STYLE.search.color, "Suchrahmen"));
    if (S.startFrame) legendEl.append(sw("box", FRAME_STYLE.start.color, "Start"));
    if (S.endFrame) legendEl.append(sw("box", FRAME_STYLE.end.color, "Ende"));
    if (S.hint) legendEl.append(sw("dash", HINT_COLOR, "Streckenhinweis"));
  }
}

// ---------- route hint ----------

function sizeCorridor() {
  if (!corridor) return;
  const buf = S.cur?.app.hint?.buffer_m ?? 300;
  corridor.setStyle({ weight: Math.max(2, (2 * buf) / metersPerPixel()) });
}

function drawHint() {
  hintLayer.clearLayers(); corridor = null;
  const h = S.hint;
  if (!h) return;
  const lls = h.lines.map((l) => l.map(([la, lo]) => [la, lo] as [number, number]));
  corridor = L.polyline(lls, { color: HINT_COLOR, weight: 10, opacity: 0.1, lineCap: "round", lineJoin: "round", interactive: false, renderer: L.svg({ padding: 0.5 }) }).addTo(hintLayer);
  const line = L.polyline(lls, { color: HINT_COLOR, weight: 2.5, opacity: 0.95, dashArray: "7 6", interactive: true, renderer: L.svg({ padding: 0.5 }) }).addTo(hintLayer);
  line.bindTooltip("Vermutete Strecke (Hinweis)", { sticky: true });
  sizeCorridor();
}

async function showHint(text: string, name: string) {
  const lines = parseHint(text);
  S.hint = { name, lines };
  drawHint();
}

async function loadHint() {
  const app = S.cur?.app;
  if (!app || locked()) return;
  const src = await api.pickHint();
  if (!src) return;
  try {
    const r = await api.hintImport(app.id, src);
    await showHint(r.text, r.name);
    const buf = app.hint?.buffer_m ?? 300;
    await saveCur({ hint: { name: r.name, path: r.path, buffer_m: buf } });
    const hb = hintBounds(S.hint!.lines);
    if (!S.bbox || !(S.bbox[0] <= hb[0] && S.bbox[1] <= hb[1] && S.bbox[2] >= hb[2] && S.bbox[3] >= hb[3])) {
      setFrame("search", growBbox(hb, HINT_MARGIN_KM));
      toast(`Suchrahmen vorgeschlagen: Umriss des Hinweises plus ${HINT_MARGIN_KM} km Rand. Du kannst ihn ändern.`);
    }
    markProgrammatic();
    map.fitBounds([[hb[0], hb[1]], [hb[2], hb[3]]], { padding: [40, 40], animate: false });
  } catch (e) {
    S.hint = null; drawHint();
    await api.hintRemove(app.id).catch(() => {});
    await saveCur({ hint: null });
    toast(`Routenhinweis nicht geladen: ${e instanceof Error ? e.message : e}`, "error");
  }
  bus.emit("bbox");
}

async function removeHint() {
  const app = S.cur?.app;
  if (!app || locked()) return;
  S.hint = null; drawHint();
  await api.hintRemove(app.id).catch(() => {});
  await saveCur({ hint: null });
  bus.emit("bbox");
}

function setView(b: Bbox, pad = 0) {
  markProgrammatic();
  map.invalidateSize();
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { animate: false, padding: [pad, pad] });
}

async function onProject(app: ProjectApp | null) {
  routeLayer.clearLayers(); marker?.remove(); marker = null; noteEl.hidden = true;
  markLayer.clearLayers(); hoverDot = null;
  bannerEl.hidden = true; resultsEl.hidden = true;
  frames.cancelDraw();
  S.hint = null; drawHint();
  S.bbox = app?.bbox ?? null; S.startFrame = app?.start_frame ?? null; S.endFrame = app?.end_frame ?? null;
  drawFrames();
  if (!app) { bus.emit("bbox"); return; }
  if (app.hint) {
    try { await showHint(await api.hintRead(app.id, app.hint.path), app.hint.name); }
    catch (e) { toast(`Routenhinweis „${app.hint.name}“ konnte nicht geladen werden: ${e instanceof Error ? e.message : e}`, "error"); }
    if (S.cur?.app.id !== app.id) return;
  }
  if (app.bbox) { setView(app.bbox, 30); showBanner(app); }
  else if (S.hint) { const hb = hintBounds((S.hint as { lines: [number, number][][] }).lines); setView(hb, 30); showBanner(app); }
  else {
    if ((app.video || (importingFor(app.id) && app.name !== "Neues Projekt")) && !app.suggested && S.settings?.suggest_online) void suggestFromTitle();
    else showBanner(app);
  }
  bus.emit("bbox");
}

function showBanner(app: ProjectApp) {
  const s = app.suggestion;
  bannerEl.hidden = false; bannerEl.replaceChildren();
  if (!app.video && !importingFor(app.id)) { bannerEl.hidden = true; return; }
  if (s?.found && s.hit && app.bbox) {
    const loc = s.local_pbf ? `lokale Kartendaten vorhanden (${s.local_pbf.split("/").pop()})` : "keine lokalen Kartendaten für diesen Ort";
    bannerEl.append(el("span", {}, `Vorschlag aus dem Titel („${s.query}“): ${s.hit.name.split(",").slice(0, 2).join(",")} — ${loc}. Der Suchrahmen ist ein Vorschlag: verschieben, Größe ändern oder neu zeichnen.`));
  } else if (s && !app.bbox) {
    bannerEl.append(el("span", {}, "Im Titel wurde kein Ort gefunden. Bitte den Ort suchen und dann einen Suchrahmen zeichnen."));
  } else if (app.bbox) {
    bannerEl.hidden = true;
  } else {
    bannerEl.append(el("span", {}, "Zuerst den Ort suchen oder die Karte verschieben, dann einen Suchrahmen zeichnen (oder den sichtbaren Ausschnitt übernehmen). "), el("button", { type: "button", class: "btn sm", onclick: () => void suggestFromTitle() }, "Aus dem Titel vorschlagen (online)"));
  }
}

/** a square of `km` x `km` around a point */
function squareKm(lat: number, lon: number, km: number): Bbox {
  const dLat = km / 2 / 111.2, dLon = km / 2 / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

export async function suggestFromTitle() {
  const app = S.cur?.app;
  if (!app) return;
  const title = app.probe?.title ?? app.name;
  bannerEl.hidden = false; bannerEl.replaceChildren(el("span", {}, `Suche Ort aus dem Titel „${title}“ (Nominatim, online) …`));
  try {
    const s = await api.geoSuggest(title);
    if (S.cur?.app.id !== app.id) return;
    app.suggested = true; app.suggestion = s;
    if (s.found && s.hit) {
      const b = squareKm(s.hit.lat, s.hit.lon, 60); // proposed search frame: 60 x 60 km around the hit (the blind-test rule), editable
      app.bbox = b; S.bbox = b;
      await saveCur({ suggested: true, suggestion: s, bbox: b });
      drawFrames(); setView(b, 30); bus.emit("bbox");
    } else await saveCur({ suggested: true, suggestion: s });
    showBanner(app);
  } catch (e) {
    bannerEl.replaceChildren(el("span", {}, `Ortssuche aus dem Titel fehlgeschlagen: ${e}`), el("button", { type: "button", class: "btn sm", onclick: () => void suggestFromTitle() }, "Erneut versuchen"));
  }
}

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  resultsEl.hidden = false; resultsEl.replaceChildren(el("div", { class: "muted pad" }, "Suche …"));
  try {
    const hits = await api.geoSearch(q);
    resultsEl.replaceChildren();
    if (!hits.length) resultsEl.append(el("div", { class: "muted pad" }, "Nichts gefunden."));
    for (const h of hits) resultsEl.append(el("button", { type: "button", class: "hit", onclick: () => { goTo(h); resultsEl.hidden = true; searchInput.focus(); } }, h.name));
  } catch (e) {
    resultsEl.replaceChildren(el("div", { class: "err pad", role: "alert" }, navigator.onLine ? String(e) : "Keine Verbindung: Die Ortssuche braucht das Netz."));
  }
}

/** a place hit moves the view; a project without a search frame also gets one there (a usable start for editing) */
function goTo(h: GeoHit) {
  const b: Bbox = h.bbox ?? squareAround(h.lat, h.lon, 10);
  const km = bboxSizeKm(b);
  const area = km.w < 20 || km.h < 20 ? squareAround(h.lat, h.lon, 15) : b;
  setView(area, 10);
  if (!S.bbox && canEditFrames()) setFrame("search", area);
}

/** a warning about the size of the search frame, or null */
export function sizeWarning(b: Bbox): string | null {
  const { diag, w, h } = bboxSizeKm(b);
  if (diag > 140) return "Sehr großer Suchrahmen: Die Routensuche braucht viel Speicher und Zeit und kann mit „zu wenig Speicher“ abbrechen. Besser einen kleineren Rahmen zeichnen (oder eine Startrahmen und einen Routenhinweis setzen).";
  if (Math.min(w, h) < 4) return "Sehr kleiner Suchrahmen: Die Strecke könnte über den Rand hinausgehen. Nach Schritt 1 prüft die App das mit der Videolänge.";
  return null;
}

// ---------- result: route coloured by confidence, position marker ----------

function drawRoute(opts?: { preserveView?: boolean }) {
  routeLayer.clearLayers(); marker?.remove(); marker = null;
  const r = S.result;
  noteEl.hidden = true;
  if (!r) return;
  if (!routeVisible()) {
    noteEl.hidden = false;
    noteEl.replaceChildren(el("div", {}, "Keine verlässliche Route gefunden. Die App zeigt sie deshalb nicht an."), el("button", { type: "button", class: "btn sm", onclick: () => { S.showRoute = true; bus.emit("result"); } }, "Route trotzdem anzeigen"));
    return;
  }
  const pts = r.points;
  let start = 0;
  const flush = (end: number) => {
    const seg = pts.slice(start, end + 1);
    if (seg.length < 2) return;
    const cls = confClass(seg[0]);
    L.polyline(seg.map((p) => [p.lat, p.lon] as [number, number]), { color: CONF_COLORS[cls], weight: 5, opacity: cls === "none" ? 0.7 : 0.95, dashArray: cls === "none" ? "3 7" : undefined, lineCap: "round" }).addTo(routeLayer);
  };
  for (let i = 1; i < pts.length; i++) if (confClass(pts[i]) !== confClass(pts[start])) { flush(i); start = i; }
  flush(pts.length - 1);
  const dot = (p: RoutePoint, c: string, t: string) => L.circleMarker([p.lat, p.lon], { radius: 6, color: "#fff", weight: 2, fillColor: c, fillOpacity: 1 }).bindTooltip(t).addTo(routeLayer);
  dot(pts[0], "#1f8a4c", "Start");
  dot(pts[pts.length - 1], "#111827", "Ende");
  markProgrammatic();
  if (!opts?.preserveView) map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number])), { padding: [30, 30], animate: false });
  placeMarker(pointAt(pts, lastT) ?? pts[0]);
}

function placeMarker(p: RoutePoint) {
  if (!marker) marker = L.marker([p.lat, p.lon], { icon: arrowIcon(), interactive: false, zIndexOffset: 1000 }).addTo(map);
  marker.setLatLng([p.lat, p.lon]);
  const a = marker.getElement()?.querySelector<HTMLElement>(".pos-arrow");
  if (a) a.style.transform = `rotate(${p.heading}deg)`;
}

function followMarker(p: RoutePoint) {
  if (follow && !map.getBounds().pad(-0.15).contains([p.lat, p.lon])) {
    markProgrammatic(1000);
    map.panTo([p.lat, p.lon], { animate: true, duration: 0.4 });
  }
}



/** Marks of the Höhe stage on the map: the position under the mouse in the chart (null removes it) and a stretch of the route (zoom to it). */
export const mapMarks = {
  hover(p: { lat: number; lon: number } | null) {
    if (!map) return;
    if (!p) { hoverDot?.remove(); hoverDot = null; return; }
    if (!hoverDot) hoverDot = L.circleMarker([p.lat, p.lon], { radius: 7, color: "#fff", weight: 2.5, fillColor: "#e5484d", fillOpacity: 1, interactive: false }).addTo(markLayer);
    hoverDot.setLatLng([p.lat, p.lon]);
  },
  /** the route between arc a and b (m): drawn over the route and zoomed to; a null range removes the highlight */
  stretch(a: number | null, b = 0) {
    stretchLines.forEach((l) => l.remove()); stretchLines = [];
    const pts = S.result?.points;
    if (!map || a === null || !pts) return;
    const seg = pts.filter((p) => !p.extrapolated && p.arc_m !== undefined && p.arc_m >= a && p.arc_m <= b).map((p) => [p.lat, p.lon] as [number, number]);
    if (seg.length < 2) { const p = pointAtArc(pts, (a + b) / 2); if (p) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16), { animate: false }); return; }
    stretchLines.push(L.polyline(seg, { color: "#fff", weight: 11, opacity: 0.9, lineCap: "round", interactive: false }).addTo(markLayer), L.polyline(seg, { color: "#ea580c", weight: 6, opacity: 1, lineCap: "round", interactive: false }).addTo(markLayer));
    map.fitBounds(L.latLngBounds(seg), { padding: [50, 50], maxZoom: 17, animate: false });
  },
};
let stretchLines: L.Polyline[] = [];

/** the Leaflet map (the anchor editor and route drag editor of the result view draw on it) */
export const getMap = (): L.Map => map;
export const isRouteVisible = (): boolean => routeVisible();
