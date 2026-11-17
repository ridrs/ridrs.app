// Analyse (stage 4): what the pipeline saw on the weak stretches and why. The video carries an overlay of what was tracked at the current time ("Bewegung",
// "Rotation"), the charts below put curvature of the video against the map's, rotation, speed and quality on one time axis, and the list names the weak
// stretches with the causes measured on them. Inspection only (docs/FEATURE_analysis_insight.md, Part A).
import { A, analyseBusy, loadSeries, overlayOn, requestFrame, setSwitch } from "../analyse";
import { AnalyseChart, DEFAULT_LAYERS, type ChartLayers } from "../analyseChart";
import { Overlay, COL, GAIN, shownBand } from "../analyseOverlay";
import { de, fmtClock, viewFor } from "../analyseStats";
import { go, routePath } from "../app/router";
import { mapMarks } from "../mapPanel";
import { S, bus } from "../state";
import type { AnalyseStretch, InspectFrame } from "../types";
import { banner, btn, chip, iconBtn, toneIcon } from "../ui/components";
import { icon } from "../ui/icons";
import { el, fmtKm, pointAt } from "../util";
import { getPlayer } from "../videoPanel";

const LAYER_KEY = "v2g.analyseLayers";
const TICK_MS = 2500;       // while the video plays the overlay is asked for this often
let root: HTMLElement, statusEl: HTMLElement, nextBtn: HTMLButtonElement, notes: HTMLElement, ovBox: HTMLElement, frameInfo: HTMLElement, chartBox: HTMLElement, legendEl: HTMLElement;
let listBox: HTMLElement, figBox: HTMLElement, emptyEl: HTMLElement, rangeEl: HTMLElement;
let zoomIn: HTMLButtonElement, zoomOut: HTMLButtonElement, zoomAll: HTMLButtonElement;
let chart: AnalyseChart, overlay: Overlay;
let layers: ChartLayers = { ...DEFAULT_LAYERS };
let sig = "", curT = 0;
let deb = 0, tick = 0, playing = false;
const cbs: Record<"motion" | "rotation", HTMLInputElement> = {} as any;

function loadLayers() { try { const o = JSON.parse(localStorage.getItem(LAYER_KEY) ?? "{}"); layers = { ...DEFAULT_LAYERS, ...o }; } catch { /* the defaults */ } }
function saveLayers() { try { localStorage.setItem(LAYER_KEY, JSON.stringify(layers)); } catch { /* private mode */ } }

export function mountAnalyse(mainEl: HTMLElement, videoHost: HTMLElement) {
  loadLayers();
  overlay = new Overlay(videoHost);
  root = el("div", { class: "an-view", hidden: true });
  statusEl = el("span", { class: "row small" });
  nextBtn = btn("Weiter: Höhe", () => S.cur && go(routePath.project(S.cur.app.id, "hoehe")), { kind: "primary", icon: "chevron", attrs: { "data-primary": "" } });
  notes = el("div", { class: "stack-s" });
  frameInfo = el("div", { class: "an-frameinfo small", "aria-live": "polite" });
  const sw = (k: "motion" | "rotation", text: string, sample: HTMLElement) => {
    const c = el("input", { type: "checkbox", checked: A[k], onchange: () => { setSwitch(k, c.checked); onSwitch(); } });
    cbs[k] = c;
    return el("label", { class: "check an-sw" }, c, sample, el("span", {}, text));
  };
  const dotSw = (col: string, col2: string) => el("span", { class: "an-swatch", "aria-hidden": "true" }, el("i", { style: `background:${col}` }), el("i", { style: `background:${col2}` }));
  ovBox = el("section", { class: "panel stack", "aria-labelledby": "an-ov-h" },
    el("div", { class: "row wrap between" }, el("h3", { id: "an-ov-h" }, "Overlay auf dem Video"),
      el("div", { class: "row wrap" }, sw("motion", "Bewegung", dotSw(COL.inlier, COL.outlier)), sw("rotation", "Rotation", dotSw(COL.farIn, COL.farOut)))),
    el("p", { class: "small muted" }, `Die Punkte werden für das Bild unter dem Zeiger neu verfolgt (mit den Parametern der Berechnung, ohne ein Ergebnis zu ändern); das dauert etwa eine Sekunde. Bewegung: Straßenpunkte der Bildbewegung, grün = zählt für Tempo und Gierrate (Inlier), rot = verworfen, Pfeil = Verschiebung zum nächsten Bild (${GAIN.motion}-fach), gestrichelt das Straßenfeld, gelb der Horizont. Rotation: Fernmerkmale über dem Horizont, cyan = Inlier, orange = verworfen, Pfeil = Verschiebung im Fenster (${GAIN.rotation}-fach), gepunktet die Bänder, oben die Gierrate. Beim Abspielen wird alle ${TICK_MS / 1000} s aktualisiert.`),
    frameInfo);
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
    el("p", { class: "small muted" }, "Mausrad, Zwei-Finger-Geste oder die Knöpfe zoomen (bis 10 s Breite), Ziehen verschiebt, ein Klick springt im Video an die Stelle. Rot hinterlegt sind die schwachen Abschnitte. Die Kurvenrate ist die Richtungsänderung je Kilometer über ein Fenster von etwa 30 m, links positiv: aus der Gierrate und dem Tempo des Videos, und aus der Linie der Karte an der gefundenen Stelle. Passen beide nicht zusammen, stimmt entweder die Messung nicht, oder die Position ist falsch."));
  listBox = el("section", { class: "panel stack", "aria-labelledby": "an-list-h" });
  figBox = el("section", { class: "panel stack", "aria-labelledby": "an-fig-h" });
  root.append(
    el("div", { class: "row wrap between elev-head" }, el("div", { class: "row wrap" }, el("h2", {}, "Analyse"), statusEl), nextBtn),
    notes, ovBox, chartBox, el("div", { class: "elev-bottom an-bottom" }, listBox, figBox));
  mainEl.append(root);

  bus.on("stage", (s: string | null) => {
    const on = s === "analyse";
    root.hidden = !on;
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

/** a frame for time t: wait a moment (a scrub makes many), then ask; the backend ends an older request, an older answer is dropped */
function ask(t: number, delay: number) {
  clearTimeout(deb);
  deb = window.setTimeout(() => { void requestFrame(t); }, delay);
}
function onTime(t: number) {
  if (playing) return;                                     // while playing the timer asks
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

// ------------------------------------------------------------------ rendering
function update() {
  if (!S.cur || !S.result) return;
  const sg = JSON.stringify([A.state, A.series?.n, A.series?.result_mtime, A.error, A.frameBusy, A.frameError, A.motion, A.rotation, A.frame?.t, A.frame?.seconds, navigator.onLine]);
  if (sg !== sig) {
    const dataChanged = !sig || JSON.parse(sig)[0] !== A.state || JSON.parse(sig)[1] !== A.series?.n || JSON.parse(sig)[2] !== A.series?.result_mtime;
    sig = sg;
    renderStatus(); renderNotes(); renderFrameInfo();
    if (dataChanged) { renderChart(); renderList(); renderFigures(); }
  }
  drawOverlay();
}

function renderStatus() {
  const st = analyseBusy() ? "run" : A.state === "error" ? "bad" : A.state === "ready" ? "ok" : "info";
  const text = analyseBusy() ? "Auswertung wird gelesen …" : A.state === "error" ? "Analyse nicht verfügbar" : A.state === "ready" ? `${A.series!.stretches.length} schwache${A.series!.stretches.length === 1 ? "r" : ""} Abschnitt${A.series!.stretches.length === 1 ? "" : "e"}` : "";
  statusEl.replaceChildren(toneIcon(st), el("span", {}, text));
}

function renderNotes() {
  notes.replaceChildren();
  if (A.state === "error") notes.append(banner("bad", `Die Analyse konnte nicht gelesen werden: ${A.error ?? "unbekannter Fehler"}`));
  if (A.state === "ready" && A.series && !A.series.scale_from_route) notes.append(banner("info", "Zur Routensuche liegt keine Datei vor (route.pkl): Kurvenrate und Tempo sind mit der Standard-Brennweite und ohne den Streckenfaktor gerechnet."));
  if (A.frameError && overlayOn()) notes.append(banner("warn", `Das Overlay konnte nicht berechnet werden: ${A.frameError}`));
  if (!S.cur?.app.video && overlayOn()) notes.append(banner("info", "Ohne Video gibt es kein Overlay."));
}

function frameLine(label: string, text: string, ok?: boolean, why?: string): HTMLElement {
  return el("div", { class: "an-fl" }, el("b", {}, label), el("span", {}, text), ok === undefined ? "" : ok ? chip("stimmt mit der Berechnung überein", "ok", "Dieselben Zahlen wie in der gespeicherten Zeile der Berechnung") : chip("weicht von der Berechnung ab", "warn", why ?? ""));
}
function renderFrameInfo() {
  frameInfo.replaceChildren();
  if (!overlayOn()) { frameInfo.append(el("div", { class: "muted" }, "Schalte „Bewegung“ oder „Rotation“ ein, um zu sehen, was die Berechnung im Bild verfolgt hat.")); return; }
  const f = A.frame;
  if (!f) { frameInfo.append(el("div", { class: "muted row" }, ...(A.frameBusy ? [icon("spinner", "spin"), "Punkte werden verfolgt …"] : ["Noch kein Bild berechnet."]))); return; }
  frameInfo.append(...frameLines(f), A.frameBusy ? el("div", { class: "muted row small" }, icon("spinner", "spin"), "aktualisiert …") : "");
}
function frameLines(f: InspectFrame): HTMLElement[] {
  const out: HTMLElement[] = [];
  const m = A.motion ? f.motion : undefined, r = A.rotation ? f.rotation : undefined;
  if (m) {
    if (m.error) out.push(frameLine("Bewegung", m.error));
    else {
      const fit = m.fit;
      out.push(frameLine("Bewegung", `Bildpaar ${m.pair} bei ${fmtClock(m.t)}: ${fit ? `${fit.inliers} von ${m.tracked} Punkten tragen die Bewegung, rms ${de(fit.rms ?? 0, 2)} px` : `kein Fit (${m.tracked} Punkte verfolgt)`}${fit?.yaw_deg_s != null ? `, Gierrate ${de(fit.yaw_deg_s, 1)} °/s` : ""}${fit?.pitch_deg_s != null ? `, Nicken ${de(fit.pitch_deg_s, 1)} °/s` : ""}${fit?.speed_ms != null ? `, Tempo ${de(fit.speed_ms, 1)} m/s` : ""}${m.source === "roh" ? " (ungefiltertes Bild)" : ""}`,
        m.stored ? m.agree : undefined, m.diff ? `Abweichende Spalten: ${Object.keys(m.diff).join(", ")}. Mögliche Gründe: andere Pipeline-Version als bei der Berechnung, oder ein Video mit unregelmäßigen Zeitstempeln.` : undefined));
    }
  }
  if (r) {
    if (r.error) out.push(frameLine("Rotation", r.error));
    else {
      const b = shownBand(f);
      out.push(frameLine("Rotation", `Fenster ${r.window} (${fmtClock(r.ta)}–${fmtClock(r.tb)}): ${r.chosen >= 0 && b ? `Band ${b.band + 1}, ${b.n_inl} von ${b.n_pts} Punkten tragen die Drehung, Gierrate ${r.yaw_deg_s != null ? de(r.yaw_deg_s, 1) + " °/s" : "–"}` : `kein Band mit brauchbarem Fit${b ? ` (${b.why || "unsicher"})` : ""}`}`,
        r.agree, "Der Fit weicht von dem der Berechnung ab: andere Pipeline-Version oder ein Video mit unregelmäßigen Zeitstempeln."));
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
  const items: [keyof ChartLayers, string][] = [["curve", "Kurvenrate"], ["yaw", "Gierrate"], ["speed", "Geschwindigkeit"], ["quality", "Qualität"], ["band", "Sicherheit und Ereignisse"]];
  for (const [k, label] of items) {
    const c = el("input", { type: "checkbox", checked: layers[k], onchange: () => { layers[k] = c.checked; saveLayers(); chart.setLayers(layers); } });
    legendEl.append(el("label", { class: "check small elev-lg" }, c, el("span", {}, label)));
  }
}

function renderList() {
  listBox.replaceChildren(el("h3", { id: "an-list-h" }, "Schwache Abschnitte"));
  const S_ = A.series;
  if (!S_) { listBox.append(el("p", { class: "muted small" }, "Noch keine Daten.")); return; }
  if (!S_.stretches.length) { listBox.append(el("p", { class: "small" }, "Keine schwachen Abschnitte: Die Straße ist überall mit mittlerer oder hoher Sicherheit gefunden.")); return; }
  listBox.append(el("p", { class: "small muted" }, "Abschnitte, die die Karte grau markiert (Sicherheit unter 50 % oder außerhalb des erkannten Abschnitts), mit den Ursachen, die auf ihnen gemessen wurden. Jede Ursache nennt ihren Wert."));
  const ul = el("ul", { class: "an-list" });
  for (const st of S_.stretches) {
    const km = `${de(st.s0 / 1000, 2)}–${de(st.s1 / 1000, 2)} km`;
    const li = el("li", { class: "an-item" },
      el("div", { class: "row wrap between" },
        el("span", {}, el("b", { class: "tnum" }, `${fmtClock(st.t0)}–${fmtClock(st.t1)}`), el("span", { class: "muted tnum" }, ` · ${km} · ${de(st.dur, 0)} s · Sicherheit ${de(100 * st.conf_mean, 0)} %`)),
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
    fig(m.length ? `${de((100 * good) / m.length, 0)} %` : "–", "der 100-m-Stücke mit guter Passung"),
    fig(fmtKm(S_.stretches.reduce((a, s) => a + Math.max(0, s.s1 - s.s0), 0) / 1000), "in schwachen Abschnitten"),
    fig(`${de(weak / 60, weak >= 600 ? 0 : 1)} min`, "Dauer der schwachen Abschnitte"),
    fig(S_.f_eff ? `${de(S_.f_eff, 0)} px` : "–", "wirksame Brennweite (Winkel = px / f)")));
  const dl = el("dl", { class: "elev-dl small" });
  const add = (k: string, v: string) => dl.append(el("dt", {}, k), el("dd", {}, v));
  add("Passung eines 100-m-Stücks", "1 minus die Abweichung der Kurvenrate (Video minus Karte, quadratisch gemittelt) im Verhältnis zur Kurvenrate der Karte; Kurven enger als R = 300 m zählen als Kurve.");
  add("Streckenfaktor", S_.kappa ? `${de(S_.kappa, 2)} (Tempo des Videos × Faktor = Meter)` : "–");
  add("Ursachen", "Gemessen, nicht geschätzt: jede nennt Wert und Grenze. „Mehrere Straßen passen ähnlich gut“ steht dort, wo keine Störung gemessen wurde.");
  if (S_.odofail_spans.length) add("Wegmessung ausgefallen", S_.odofail_spans.map(([a, b]) => `${fmtClock(a)}–${fmtClock(b)}`).join(", "));
  if (S_.cuts.length) add("Szenenschnitte", S_.cuts.map(([a]) => fmtClock(a)).join(", "));
  figBox.append(dl);
}
