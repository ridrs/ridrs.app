// Analyse: focused diagnostic inspector — compact single-row overlay toolbar (explanation collapsed by default),
// synced video + map, 5-lane timeline charts with concise hint + collapsible guide, weak stretches & figures.
import { A, loadSeries, overlayOn, requestFrame, setSwitch } from "../analyse";
import { AnalyseChart, DEFAULT_LAYERS, type ChartLayers } from "../analyseChart";
import { Overlay, COL, GAIN, shownBand } from "../analyseOverlay";
import { de, fmtClock, viewFor } from "../analyseStats";
import { go, routePath } from "../app/router";
import { mapMarks } from "../mapPanel";
import { S, bus } from "../state";
import type { AnalyseStretch, InspectFrame } from "../types";
import { banner, btn, chip, disclosure, iconBtn } from "../ui/components";
import { icon } from "../ui/icons";
import { el, fmtKm, pointAt } from "../util";
import { getPlayer } from "../videoPanel";

const LAYER_KEY = "v2g.analyseLayers";
const TICK_MS = 2500;
let root: HTMLElement, busyEl: HTMLElement, nextBtn: HTMLButtonElement, notes: HTMLElement, ovBox: HTMLElement, frameInfo: HTMLElement, chartBox: HTMLElement, legendEl: HTMLElement;
let listBox: HTMLElement, figBox: HTMLElement, emptyEl: HTMLElement, rangeEl: HTMLElement;
let zoomIn: HTMLButtonElement, zoomOut: HTMLButtonElement, zoomAll: HTMLButtonElement;
let chart: AnalyseChart, overlay: Overlay;
let layers: ChartLayers = { ...DEFAULT_LAYERS };
let sig = "", curT = 0;
let deb = 0, tick = 0, playing = false;
const cbs: Record<"motion" | "rotation", HTMLInputElement> = {} as any;

function loadLayers() { try { const o = JSON.parse(localStorage.getItem(LAYER_KEY) ?? "{}"); layers = { ...DEFAULT_LAYERS, ...o }; } catch { /* the defaults */ } }
function saveLayers() { try { localStorage.setItem(LAYER_KEY, JSON.stringify(layers)); } catch { /* private mode */ } }

export function mountAnalyse(mainEl: HTMLElement, videoHost: HTMLElement, headEl: HTMLElement) {
  loadLayers();
  overlay = new Overlay(videoHost);
  root = el("div", { class: "an-view", hidden: true });
  nextBtn = btn("Weiter: Export", () => S.cur && go(routePath.project(S.cur.app.id, "export")), { kind: "primary", icon: "chevron", attrs: { "data-primary": "" } });
  notes = el("div", { class: "stack-s" });
  frameInfo = el("div", { class: "an-frameinfo small", "aria-live": "polite", hidden: true });
  busyEl = el("span", { class: "muted row small an-busy" }, icon("spinner", "spin"), "aktualisiert …");
  const sw = (k: "motion" | "rotation", text: string, sample: HTMLElement) => {
    const c = el("input", { type: "checkbox", checked: A[k], onchange: () => { setSwitch(k, c.checked); onSwitch(); } });
    cbs[k] = c;
    return el("label", { class: "check an-sw" }, c, sample, el("span", {}, text));
  };
  const dotSw = (...cols: string[]) => el("span", { class: "an-swatch", "aria-hidden": "true" }, ...cols.map((col) => el("i", { style: `background:${col}` })));

  // Compact top bar: overlay switches + collapsible legend explanation (collapsed by default so video & map start high!)
  const ovHelp = disclosure("Overlay-Legende",
    el("p", { class: "small muted" }, `Neuverfolgung für das aktuelle Bild (ca. 1 s, ändert kein Ergebnis). Bewegung: grün = Inlier, rot = verworfen, magenta = ignorierter Verkehr, Pfeil = Verschiebung (${GAIN.motion}-fach), gelb = Horizont. Rotation: Fernmerkmale über Horizont, cyan = Inlier, orange = verworfen, Pfeil = ${GAIN.rotation}-fach. Beim Abspielen alle ${TICK_MS / 1000} s aktualisiert.`));

  ovBox = el("section", { class: "panel stack-s an-ov", "aria-labelledby": "an-ov-h", hidden: true },
    el("div", { class: "row wrap between" },
      el("div", { class: "row wrap" },
        el("h2", { id: "an-ov-h", class: "an-ov-h" }, "Analyse"),
        sw("motion", "Bewegung", dotSw(COL.inlier, COL.outlier, COL.traffic, COL.ignored)),
        sw("rotation", "Rotation", dotSw(COL.farIn, COL.farOut)),
        busyEl),
      el("div", { class: "row wrap" },
        btn("Höhe", () => S.cur && go(routePath.project(S.cur.app.id, "hoehe")), { size: "sm", icon: "mountain" }),
        nextBtn)),
    frameInfo,
    ovHelp);

  legendEl = el("div", { class: "elev-legend", role: "group", "aria-label": "Spuren der Diagramme" });
  rangeEl = el("span", { class: "small muted tnum" });
  zoomIn = iconBtn("plus", "Hineinzoomen", () => chart.zoomBy(0.5));
  zoomOut = iconBtn("minus", "Herauszoomen", () => chart.zoomBy(2));
  zoomAll = btn("Ganzes Video", () => chart.reset(), { size: "sm", icon: "expand" });
  chart = new AnalyseChart({
    onView: () => syncZoom(),
    onHover: (t) => mapMarks.hover(t === null || !S.result ? null : pointAt(S.result.points, t)),
    onClick: (t) => seek(t),
  });
  emptyEl = el("div", { class: "elev-empty", hidden: true });
  chartBox = el("section", { class: "panel stack", "aria-labelledby": "an-chart-h" },
    el("div", { class: "row wrap between elev-head" }, el("h3", { id: "an-chart-h" }, "Verlauf im Video"), el("div", { class: "row" }, rangeEl, zoomOut, zoomIn, zoomAll)),
    el("div", { class: "elev-chartwrap" }, chart.el, emptyEl), legendEl,
    el("div", { class: "row wrap between" },
      el("span", { class: "small muted" }, "Klick springt im Video · Ziehen zoomt · Umschalt+Ziehen verschiebt · Rot = schwache Abschnitte"),
      disclosure("Hilfe zum Diagramm",
        el("p", { class: "small muted" }, "Mausrad, Zwei-Finger-Geste oder +/− zoomen (bis 10 s Breite), Doppelklick zoomt hinein. Die Kurvenrate zeigt die Richtungsänderung je Kilometer (links positiv) aus dem Video gegen die OSM-Karte: passen beide nicht zusammen, stimmt entweder die Messung nicht oder die Position ist falsch."))));
  listBox = el("section", { class: "panel stack", "aria-labelledby": "an-list-h" });
  figBox = el("section", { class: "panel stack", "aria-labelledby": "an-fig-h" });
  root.append(notes, chartBox, el("div", { class: "elev-bottom an-bottom" }, listBox, figBox));
  mainEl.append(root);
  headEl.append(ovBox);

  bus.on("stage", (s: string | null) => {
    const on = s === "analyse";
    root.hidden = !on; ovBox.hidden = !on;
    if (on) void enter(); else leave();
  });
  bus.on("analyse", () => { if (!root.hidden) update(); });
  bus.on("result", () => { if (!root.hidden) void enter(); });
  bus.on("time", (t: number) => {
    curT = t;
    if (root.hidden || !S.result) return;
    chart.setCursor(t);
    if (overlayOn()) onTime(t);
  });
  bus.on("seeked", () => { if (!root.hidden && overlayOn()) ask(curT, 60); });
  bus.on("playstate", (p: boolean) => { playing = p; if (!root.hidden) onPlaystate(); });
  bus.on("player", () => { if (!root.hidden) { overlay.draw(); if (overlayOn()) ask(curT, 200); } });
  window.addEventListener("online", () => { if (!root.hidden) update(); });
}

function onSwitch() {
  if (overlayOn()) ask(currentTime(), 0); else { overlay.set(null, false, false); }
  update();
}
const currentTime = () => getPlayer()?.time ?? curT;

async function enter() {
  if (!S.cur || !S.result) return;
  chart.setSelected(null);
  cbs.motion.checked = A.motion; cbs.rotation.checked = A.rotation;
  update();
  await loadSeries();
  playing = !!getPlayer()?.playing;
  onPlaystate();
  if (overlayOn()) ask(currentTime(), 100);
}
function leave() {
  mapMarks.hover(null); mapMarks.stretch(null);
  clearTimeout(deb); clearInterval(tick); tick = 0;
  overlay.set(null, false, false);
}

function ask(t: number, delay: number) {
  clearTimeout(deb);
  deb = window.setTimeout(() => { void requestFrame(t); }, delay);
}
function onTime(t: number) {
  if (playing) return;
  if (Math.abs(t - A.frameFor) > 0.04 && Math.abs(t - lastAsked) > 0.04) { lastAsked = t; ask(t, 160); }
  else drawOverlay();
}
let lastAsked = -1;
function onPlaystate() {
  clearInterval(tick); tick = 0;
  if (playing && overlayOn() && !root.hidden) {
    tick = window.setInterval(() => { if (!A.frameBusy) void requestFrame(currentTime()); }, TICK_MS);
    void requestFrame(currentTime());
  } else if (!playing && overlayOn()) ask(currentTime(), 120);
  drawOverlay();
}

function seek(t: number) {
  if (getPlayer()) bus.emit("seek", t); else bus.emit("time", t);
  bus.emit("seeked");
}

function syncZoom() {
  zoomIn.disabled = !chart.canZoomIn(); zoomOut.disabled = !chart.canZoomOut(); zoomAll.disabled = !chart.canZoomOut();
  const { v0, v1 } = chart.view;
  rangeEl.textContent = A.series ? `${fmtClock(v0)} bis ${fmtClock(v1)}` : "";
}

function update() {
  if (!S.cur || !S.result) return;
  const sg = JSON.stringify([A.state, A.series?.n, A.series?.result_mtime, A.error, A.frameBusy, A.frameError, A.motion, A.rotation, A.frame?.t, A.frame?.seconds, navigator.onLine]);
  if (sg !== sig) {
    const dataChanged = !sig || JSON.parse(sig)[0] !== A.state || JSON.parse(sig)[1] !== A.series?.n || JSON.parse(sig)[2] !== A.series?.result_mtime;
    sig = sg;
    renderNotes(); renderFrameInfo();
    if (dataChanged) { renderChart(); renderList(); renderFigures(); }
  }
  drawOverlay();
}

function renderNotes() {
  notes.replaceChildren();
  if (A.state === "error") notes.append(banner("bad", `Die Analyse konnte nicht gelesen werden: ${A.error ?? "unbekannter Fehler"}`));
  if (A.state === "ready" && A.series && !A.series.scale_from_route) notes.append(banner("info", "Zur Routensuche liegt keine Datei vor (route.pkl): Kurvenrate und Tempo sind mit Standard-Brennweite gerechnet."));
  if (A.frameError && overlayOn()) notes.append(banner("warn", `Das Overlay konnte nicht berechnet werden: ${A.frameError}`));
  if (!S.cur?.app.video && overlayOn()) notes.append(banner("info", "Ohne Video gibt es kein Overlay."));
}

function frameLine(label: string, text: string, ok?: boolean, why?: string): HTMLElement {
  return el("div", { class: "an-fl" }, el("b", {}, label), el("span", {}, text), ok === undefined ? "" : ok ? chip("stimmt überein", "ok", "Dieselben Zahlen wie in der Berechnung") : chip("weicht ab", "warn", why ?? ""));
}
function renderFrameInfo() {
  const on = overlayOn();
  busyEl.style.visibility = on && A.frameBusy && A.frame ? "visible" : "hidden";
  frameInfo.hidden = !on;
  frameInfo.replaceChildren();
  if (!on) return;
  const f = A.frame;
  if (!f) { frameInfo.append(el("div", { class: "muted row" }, ...(A.frameBusy ? [icon("spinner", "spin"), "Punkte werden verfolgt …"] : ["Noch kein Bild berechnet."]))); return; }
  frameInfo.append(...frameLines(f));
}
function frameLines(f: InspectFrame): HTMLElement[] {
  const out: HTMLElement[] = [];
  const m = A.motion ? f.motion : undefined, r = A.rotation ? f.rotation : undefined;
  if (m) {
    if (m.error) out.push(frameLine("Bewegung", m.error));
    else {
      const fit = m.fit;
      out.push(frameLine("Bewegung", `Bildpaar ${m.pair} bei ${fmtClock(m.t)}: ${fit ? `${fit.inliers} von ${m.tracked} Punkten tragen die Bewegung, rms ${de(fit.rms ?? 0, 2)} px` : `kein Fit (${m.tracked} Punkte verfolgt)`}${fit?.yaw_deg_s != null ? `, Gierrate ${de(fit.yaw_deg_s, 1)} °/s` : ""}${fit?.pitch_deg_s != null ? `, Nicken ${de(fit.pitch_deg_s, 1)} °/s` : ""}${fit?.speed_ms != null ? `, Tempo ${de(fit.speed_ms, 1)} m/s` : ""}${m.source === "roh" ? " (ungefiltertes Bild)" : ""}`,
        m.stored ? m.agree : undefined, m.diff ? `Abweichende Spalten: ${Object.keys(m.diff).join(", ")}.` : undefined));
      const tr = m.traffic, pf = m.plain_fit;
      if (tr?.state === "replaced")
        out.push(frameLine("Verkehr", `Fahrzeug im Fit${pf?.speed_ms != null ? ` (${de(pf.speed_ms, 1)} m/s, rms ${de(pf.rms ?? 0, 2)} px)` : ""}: Straßen-Kandidat ${tr.pick} von ${tr.candidates}, ${tr.n_traffic ?? 0} Punkte ignoriert.`));
      else if (tr?.state === "rejected")
        out.push(frameLine("Fit", `Kein verlässliches Tempo (rms ${de(tr.rms ?? 0, 2)} px${tr.limit != null ? `, Grenze ${de(tr.limit, 2)} px` : ""}): ${tr.n_ignored ?? tr.n_traffic ?? 0} Punkte ignoriert.`));
    }
  }
  if (r) {
    if (r.error) out.push(frameLine("Rotation", r.error));
    else {
      const b = shownBand(f);
      out.push(frameLine("Rotation", `Fenster ${r.window} (${fmtClock(r.ta)}–${fmtClock(r.tb)}): ${r.chosen >= 0 && b ? `Band ${b.band + 1}, ${b.n_inl}/${b.n_pts} Punkte, Gierrate ${r.yaw_deg_s != null ? de(r.yaw_deg_s, 1) + " °/s" : "–"}` : `kein brauchbarer Fit${b ? ` (${b.why || "unsicher"})` : ""}`}`,
        r.agree, "Weicht von der Berechnung ab."));
    }
  }
  if (!out.length) out.push(el("div", { class: "muted" }, "Keine Daten."));
  return out;
}

function drawOverlay() {
  if (root.hidden) return;
  const f = A.frame, t = currentTime();
  const age = f ? Math.abs(A.frameFor - t) : Infinity;
  const limit = playing ? TICK_MS / 1000 + 1.5 : 0.6;
  const fresh = !!f && age <= limit;
  let note = "";
  if (overlayOn()) {
    if (f && !fresh) note = A.frameBusy ? "Overlay wird berechnet …" : "Overlay veraltet";
    else if (playing && f) note = `Overlay von ${fmtClock(A.frameFor)}, alle ${TICK_MS / 1000} s neu`;
    else if (A.frameBusy && !f) note = "Overlay wird berechnet …";
  }
  overlay.set(fresh ? f : null, A.motion, A.rotation, note);
}

function renderChart() {
  const S_ = A.series;
  emptyEl.hidden = !!S_;
  chart.el.hidden = !S_;
  if (!S_) emptyEl.replaceChildren(A.state === "error" ? el("div", {}, "Die Analyse ist nicht verfügbar.") : el("div", { class: "row center" }, icon("spinner", "spin"), "Die Auswertung wird gelesen …"));
  chart.setData(S_);
  chart.setLayers(layers);
  syncZoom();
  renderLegend();
}
function renderLegend() {
  legendEl.replaceChildren();
  const items: [keyof ChartLayers, string][] = [["curve", "Kurvenrate"], ["yaw", "Gierrate"], ["speed", "Geschwindigkeit"], ["quality", "Qualität"], ["band", "Sicherheit & Ereignisse"]];
  for (const [k, label] of items) {
    const c = el("input", { type: "checkbox", checked: layers[k], onchange: () => { layers[k] = c.checked; saveLayers(); chart.setLayers(layers); } });
    legendEl.append(el("label", { class: "check small elev-lg" }, c, el("span", {}, label)));
  }
}

function renderList() {
  listBox.replaceChildren(el("h3", { id: "an-list-h" }, "Schwache Abschnitte"));
  const S_ = A.series;
  if (!S_) { listBox.append(el("p", { class: "muted small" }, "Noch keine Daten.")); return; }
  if (!S_.stretches.length) { listBox.append(el("p", { class: "small ok-text" }, "Keine schwachen Abschnitte: Die Straße wurde überall mit mittlerer oder hoher Sicherheit erkannt.")); return; }
  listBox.append(el("p", { class: "small muted" }, "Abschnitte mit geringer Sicherheit (< 50 %) und ihre gemessenen Ursachen."));
  const ul = el("ul", { class: "an-list" });
  for (const st of S_.stretches) {
    const km = `${de(st.s0 / 1000, 2)}–${de(st.s1 / 1000, 2)} km`;
    const li = el("li", { class: "an-item" },
      el("div", { class: "row wrap between" },
        el("span", {}, el("b", { class: "tnum" }, `${fmtClock(st.t0)}–${fmtClock(st.t1)}`), el("span", { class: "muted tnum" }, ` · ${km} · ${de(st.dur, 0)} s · ${de(100 * st.conf_mean, 0)} %`)),
        btn("Anzeigen", () => show(st), { size: "sm", icon: "map", title: "Im Diagramm und auf der Karte zeigen und das Video dorthin setzen" })),
      el("ul", { class: "an-causes small" }, ...st.causes.map((c) => el("li", { class: c.id === "none" || c.id === "ambiguous" ? "muted" : "" }, c.text))));
    ul.append(li);
  }
  listBox.append(ul);
}
function show(st: AnalyseStretch) {
  const S_ = A.series!;
  chart.setSelected(st);
  chart.setView(viewFor(st.t0, st.t1, S_.t0, S_.t0 + (S_.n - 1) * S_.dt));
  mapMarks.stretch(st.s0, Math.max(st.s1, st.s0 + 20));
  seek(st.t0);
  chart.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderFigures() {
  figBox.replaceChildren(el("h3", { id: "an-fig-h" }, "Kurven: Video gegen Karte"));
  const S_ = A.series;
  if (!S_) { figBox.append(el("p", { class: "muted small" }, "Noch keine Daten.")); return; }
  const m = S_.cells.match.filter((x): x is number => x !== null);
  const good = m.filter((x) => x >= 0.6).length;
  const fig = (v: string, l: string) => el("div", { class: "ride-box" }, el("div", { class: "ride-v mono tnum" }, v), el("div", { class: "ride-l" }, l));
  const weak = S_.stretches.reduce((a, s) => a + s.dur, 0);
  figBox.append(el("div", { class: "elev-figs" },
    fig(m.length ? `${de((100 * good) / m.length, 0)} %` : "–", "100-m-Stücke gut"),
    fig(fmtKm(S_.stretches.reduce((a, s) => a + Math.max(0, s.s1 - s.s0), 0) / 1000), "schwach"),
    fig(`${de(weak / 60, weak >= 600 ? 0 : 1)} min`, "schwache Dauer"),
    fig(S_.f_eff ? `${de(S_.f_eff, 0)} px` : "–", "Brennweite")));
  const dl = el("dl", { class: "elev-dl small" });
  const add = (k: string, v: string) => dl.append(el("dt", {}, k), el("dd", {}, v));
  add("Streckenfaktor", S_.kappa ? `${de(S_.kappa, 2)} (Video-Tempo × Faktor = Meter)` : "–");
  if (S_.odofail_spans.length) add("Wegmessung aus", S_.odofail_spans.map(([a, b]) => `${fmtClock(a)}–${fmtClock(b)}`).join(", "));
  if (S_.cuts.length) add("Szenenschnitte", S_.cuts.map(([a]) => fmtClock(a)).join(", "));
  figBox.append(dl);
}
