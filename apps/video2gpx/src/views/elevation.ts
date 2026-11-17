// Höhe (stage 4): the sources of the elevation data and their download, the profile over the whole route (zoom, pan, layers, hover, click)
// and what it is made of. Inspection only: heights are not edited here (docs/FEATURE_elevation_stage.md).
import { go, routePath } from "../app/router";
import { E, anythingMissing, cancelDownload, loadDem, loadDiag, loadElevation, missingBytes, startDownload } from "../elevation";
import { ElevationChart, GRADE_TOKENS, DEFAULT_LAYERS, srcColour, type Layers } from "../elevationChart";
import { GRADE_LABEL, de, maxGrade, steepStretches, topDifferences, viewFor, type Stretch } from "../elevationStats";
import { mapMarks } from "../mapPanel";
import { S, bus } from "../state";
import { banner, btn, chip, iconBtn, progressBar, toneIcon, type Tone } from "../ui/components";
import { icon } from "../ui/icons";
import { el, fmtBytes, pointAt, pointAtArc } from "../util";
import { getPlayer } from "../videoPanel";
import { token } from "../app/theme";

const LAYER_KEY = "v2g.elevLayers";
let root: HTMLElement;
let statusEl: HTMLElement, nextBtn: HTMLButtonElement, notes: HTMLElement, srcBox: HTMLElement, chartBox: HTMLElement, legendEl: HTMLElement, figBox: HTMLElement, stretchBox: HTMLElement, attrBox: HTMLElement;
let zoomIn: HTMLButtonElement, zoomOut: HTMLButtonElement, zoomAll: HTMLButtonElement, rangeEl: HTMLElement, emptyEl: HTMLElement;
let chart: ElevationChart;
let layers: Layers = { ...DEFAULT_LAYERS, src: {} };
let dlBar: ReturnType<typeof progressBar>, dlText: HTMLElement;
let sig = "";

function loadLayers() {
  try { const t = localStorage.getItem(LAYER_KEY); if (t) { const o = JSON.parse(t); layers = { ...DEFAULT_LAYERS, ...o, src: { ...(o.src ?? {}) } }; } } catch { /* the defaults */ }
}
function saveLayers() { try { localStorage.setItem(LAYER_KEY, JSON.stringify(layers)); } catch { /* private mode */ } }

export function mountElevation(mainEl: HTMLElement) {
  loadLayers();
  root = el("div", { class: "elev-view", hidden: true });
  statusEl = el("span", { class: "row small" });
  nextBtn = btn("Weiter: Export", () => S.cur && go(routePath.project(S.cur.app.id, "export")), { kind: "primary", icon: "chevron", attrs: { "data-primary": "" } });
  notes = el("div", { class: "stack-s" });
  srcBox = el("section", { class: "panel stack", "aria-labelledby": "elev-src-h" });
  legendEl = el("div", { class: "elev-legend", role: "group", "aria-label": "Ebenen des Diagramms" });
  rangeEl = el("span", { class: "small muted tnum" });
  zoomIn = iconBtn("plus", "Hineinzoomen", () => chart.zoomBy(0.5));
  zoomOut = iconBtn("minus", "Herauszoomen", () => chart.zoomBy(2));
  zoomAll = btn("Ganze Strecke", () => chart.reset(), { size: "sm", icon: "expand" });
  chart = new ElevationChart({
    onView: () => syncZoom(),
    onHover: (arc) => { mapMarks.hover(arc === null || !S.result ? null : pointAtArc(S.result.points, arc)); },
    onClick: (arc) => seekToArc(arc),
  });
  emptyEl = el("div", { class: "elev-empty", hidden: true });
  chartBox = el("section", { class: "panel stack", "aria-labelledby": "elev-chart-h" },
    el("div", { class: "row wrap between" }, el("h3", { id: "elev-chart-h" }, "Höhenprofil der Strecke"),
      el("div", { class: "row" }, rangeEl, zoomOut, zoomIn, zoomAll)),
    el("div", { class: "elev-chartwrap" }, chart.el, emptyEl), legendEl,
    el("p", { class: "small muted" }, "Mausrad, Zwei-Finger-Geste oder die Knöpfe zoomen (bis etwa 200 m Breite), Ziehen verschiebt. Ein Klick springt im Video an die Stelle. Die Deckkraft eines Messpunkts ist das Gewicht, das ihm die Schätzung gegeben hat: kräftige Punkte trägt das Profil, blasse hat es verworfen."));
  figBox = el("section", { class: "panel stack", "aria-labelledby": "elev-fig-h" });
  stretchBox = el("section", { class: "panel stack", "aria-labelledby": "elev-str-h" });
  attrBox = el("section", { class: "panel stack-s", "aria-labelledby": "elev-attr-h" });
  root.append(
    el("div", { class: "row wrap between elev-head" }, el("div", { class: "row wrap" }, el("h2", {}, "Höhe"), statusEl), nextBtn),
    notes, srcBox, chartBox,
    el("div", { class: "elev-bottom" }, figBox, stretchBox), attrBox);
  mainEl.append(root);

  bus.on("stage", (s: string | null) => {
    const on = s === "hoehe";
    root.hidden = !on;
    if (on) void enter(); else { mapMarks.hover(null); mapMarks.stretch(null); }
  });
  bus.on("elevation", () => { if (!root.hidden) update(); });
  bus.on("result", () => { if (!root.hidden) update(); });
  bus.on("time", (t: number) => {
    if (root.hidden || !S.result) return;
    const p = pointAt(S.result.points, t);
    chart.setCursor(p.extrapolated || p.arc_m === undefined ? null : p.arc_m);
  });
  window.addEventListener("online", () => { if (!root.hidden) { void loadDem(true); update(); } });
  window.addEventListener("offline", () => { if (!root.hidden) update(); });
}

/** the stage was opened: the sources (online sizes), the profile (a stale one is computed again) and its diagnostics */
async function enter() {
  if (!S.cur || !S.result) return;
  update();
  void loadDem(navigator.onLine);
  if (E.state !== "ready" || !E.profile) await loadElevation();
  if (E.state === "ready" && E.stale) await loadElevation({ recompute: true });
  await loadDiag();
}

function seekToArc(arc: number) {
  const p = S.result && pointAtArc(S.result.points, arc);
  if (!p) return;
  if (getPlayer()) bus.emit("seek", p.t); else bus.emit("time", p.t);
  bus.emit("seeked");
}

function syncZoom() {
  zoomIn.disabled = !chart.canZoomIn(); zoomOut.disabled = !chart.canZoomOut(); zoomAll.disabled = !chart.canZoomOut();
  const { v0, v1 } = chart.view;
  rangeEl.textContent = E.profile ? `km ${de(v0 / 1000, 2)} bis ${de(v1 / 1000, 2)}` : "";
}

// ------------------------------------------------------------------ rendering
function update() {
  if (!S.cur || !S.result) return;
  const d = E.dl;
  const s = JSON.stringify([E.state, E.stale, !!E.profile, E.profile?.z.length, E.profile?.ascent_m, !!E.diag, !!E.dem, E.dem?.missing_bytes, E.dem?.extras?.missing_blocks, d.running, d.error, d.note, d.cancelled, E.error, E.diagError, navigator.onLine]);
  if (s !== sig) { sig = s; renderAll(); }
  renderProgress();
}

const TONE: Record<string, Tone> = { current: "ok", stale: "warn", missing: "warn", computing: "run", error: "bad" };
function renderStatus() {
  const st = E.dl.running ? "run" : E.state === "computing" || E.state === "loading" ? "computing" : E.state === "missing" ? "missing" : E.state === "error" ? "error" : E.profile && E.stale ? "stale" : E.profile ? "current" : "computing";
  const text = { run: "Höhendaten werden geladen …", computing: "Profil wird berechnet …", missing: "Kein Profil: Copernicus-Kacheln fehlen", error: "Profil nicht verfügbar", stale: "Profil veraltet", current: "Profil aktuell" }[st];
  statusEl.replaceChildren(toneIcon(st === "run" ? "run" : TONE[st] ?? "info"), el("span", {}, text));
  nextBtn.className = "btn primary";
}

function renderAll() {
  renderStatus();
  renderNotes();
  renderSources();
  renderChart();
  renderFigures();
  renderStretches();
  renderAttribution();
}

function renderNotes() {
  notes.replaceChildren();
  if (E.state === "error") notes.append(banner("bad", `Das Höhenprofil konnte nicht berechnet werden: ${E.error ?? "unbekannter Fehler"}`));
  if (E.profile && E.stale && E.state === "ready") notes.append(banner("info", "Das Profil stammt von einer älteren Version der Berechnung oder aus anderen Höhendaten und wird neu berechnet."));
  if (E.profile && !E.profile.diag && !E.dl.running) notes.append(banner("info", "Zu diesem Profil gibt es keine Diagnosedaten (es wurde mit einer älteren Pipeline erstellt). Quellen, Vergleich mit P13 und Gewichte erscheinen nach der nächsten Berechnung."));
  if (E.diagError && E.profile) notes.append(banner("warn", `Diagnosedaten nicht gelesen: ${E.diagError}`));
}

// ---- sources and download
interface Row { name: string; title: string; region: string; licence: string; have: number; total: number; bytes: number; exact: boolean; used: boolean; note: string }
function rows(): Row[] {
  const dem = E.dem;
  if (!dem) return [];
  const used = new Set((E.profile?.sources ?? []).map((x) => x.name));
  const out: Row[] = [];
  const miss = dem.tiles.filter((t) => t.state === "missing").length;
  out.push({ name: "copernicus", title: "Copernicus DEM GLO-30", region: "weltweit, 30 m", licence: E.profile?.sources?.find((x) => x.name === "copernicus")?.licence ?? "Copernicus-Lizenz (Nennung)", have: dem.tiles.length - miss, total: dem.tiles.length, bytes: dem.missing_bytes, exact: dem.exact, used: used.has("copernicus") || (!!E.profile && !miss), note: dem.tiles.some((t) => t.state === "sea") ? "Teile Meer: keine Kachel nötig" : "" });
  const filled = !!E.diag?.filled.some((v) => v === 1);
  for (const [name, x] of Object.entries(dem.extras?.sources ?? {})) {
    out.push({ name, title: x.title, region: x.region, licence: x.licence, have: x.blocks - x.missing, total: x.blocks, bytes: x.missing_bytes ?? 0, exact: false,
      used: used.has(name) || (x.kind === "mask" && filled), note: x.conditional ? "nur nötig, wo das Modell aufgefüllt ist" : x.status !== "verified" ? "Nutzungsbedingungen ungeprüft" : x.kind === "mask" ? "Maske der aufgefüllten Pixel" : "" });
  }
  return out;
}

function renderSources() {
  srcBox.replaceChildren(el("h3", { id: "elev-src-h" }, "Höhendaten für diese Strecke"));
  const dem = E.dem;
  if (!dem) { srcBox.append(el("p", { class: "muted small" }, "Prüfe, welche Höhendaten die Strecke braucht …")); }
  else {
    const rs = rows();
    const head = ["Quelle", "Lizenz", "Blöcke", "Download", "Im Profil"].map((h) => el("th", { scope: "col" }, h));
    const body = rs.map((r) => {
      const done = r.have >= r.total;
      return el("tr", {},
        el("th", { scope: "row" }, el("div", { class: "src-name" }, r.title), el("div", { class: "small muted" }, [r.region, r.note].filter(Boolean).join(" · "))),
        el("td", { class: "small" }, r.licence),
        el("td", { class: "tnum" }, el("span", { class: "row" }, toneIcon(done ? "ok" : "warn"), el("span", {}, `${r.have} von ${r.total}`, el("span", { class: "sr-only" }, done ? " vorhanden" : " fehlen noch")))),
        el("td", { class: "tnum small" }, done ? "–" : `${r.exact ? "" : "ca. "}${fmtBytes(r.bytes || undefined)}`),
        el("td", {}, r.used ? chip("ja", "ok") : chip(done ? "nein" : "noch nicht", "")));
    });
    srcBox.append(el("div", { class: "table-wrap" }, el("table", { class: "src-table" }, el("thead", {}, el("tr", {}, ...head)), el("tbody", {}, ...body))));
  }
  // download
  dlBar = progressBar("Höhendaten werden geladen"); dlBar.el.hidden = true;
  dlText = el("span", { class: "small muted tnum", "aria-live": "polite" });
  const d = E.dl, missing = anythingMissing(), offline = !navigator.onLine;
  const size = missing ? ` (${E.dem?.exact && !(E.dem?.extras?.missing_blocks) ? "" : "ca. "}${fmtBytes(missingBytes())})` : "";
  const go1 = btn(`Höhendaten laden${size}`, () => void startDownload(), { kind: missing && !offline ? "primary" : undefined, icon: "download", disabled: !missing || d.running || offline });
  const cancel = btn("Abbrechen", () => void cancelDownload(), { kind: "danger", size: "sm" });
  cancel.hidden = !d.running;
  const line = el("div", { class: "row wrap" }, go1, cancel, dlText);
  srcBox.append(line, dlBar.el);
  if (d.error) srcBox.append(el("div", { class: "err small", role: "alert" }, `Fehler beim Laden: ${d.error}`));
  else if (d.cancelled) srcBox.append(el("div", { class: "small muted" }, "Abgebrochen. Das Profil wird aus den vorhandenen Daten berechnet."));
  else if (d.note) srcBox.append(el("div", { class: "small muted" }, d.note));
  if (dem && !missing) srcBox.append(el("p", { class: "small muted" }, "Alle Höhendaten für diese Strecke sind vorhanden."));
  else if (dem && offline) srcBox.append(el("p", { class: "small muted" }, "Keine Verbindung: Das Profil wird aus den vorhandenen Daten berechnet. Es fehlen noch Daten dieser Quellen. Zum Laden brauchst du das Netz."));
  else if (dem) srcBox.append(el("p", { class: "small muted" }, "Auch ohne Download wird das Profil aus den vorhandenen Daten berechnet; fehlende Quellen machen es an manchen Stellen ungenauer. Nach dem Laden wird es neu berechnet."));
}

function renderProgress() {
  if (!dlBar) return;
  const d = E.dl;
  dlBar.el.hidden = !d.running && E.state !== "computing";
  if (d.running) {
    dlBar.set(d.total ? (100 * (d.index + d.bytes / d.total)) / Math.max(1, d.of) : d.of ? (100 * d.index) / d.of : null);
    dlText.textContent = !d.of && !d.bytes ? "Verbinde …" : d.extra ? `Genauere Höhendaten: ${fmtBytes(d.bytes)} (Block ${d.index} von ${d.of})` : `${fmtBytes(d.bytes)}${d.total ? ` von ${fmtBytes(d.total)}` : ""} (Kachel ${d.index + 1} von ${d.of})`;
  } else if (E.state === "computing") { dlBar.set(null); dlText.textContent = "Profil wird berechnet …"; }
  else dlText.textContent = "";
}

// ---- chart
function renderChart() {
  const p = E.profile;
  emptyEl.hidden = !!p;
  chart.el.hidden = !p;
  if (!p) {
    emptyEl.replaceChildren(E.state === "missing" ? el("div", {}, "Für diese Strecke fehlen die Copernicus-Kacheln. Lade die Höhendaten oben, dann erscheint das Profil.")
      : E.state === "error" ? el("div", {}, "Das Profil ist nicht verfügbar.") : el("div", { class: "row center" }, icon("spinner", "spin"), "Profil wird berechnet …"));
  }
  chart.setData(p, E.diag);
  chart.setLayers(layers);
  syncZoom();
  renderLegend();
}

function renderLegend() {
  legendEl.replaceChildren();
  const d = E.diag;
  const item = (key: keyof Omit<Layers, "src">, label: string, sample: HTMLElement) => {
    const c = el("input", { type: "checkbox", checked: layers[key] as boolean, onchange: () => { (layers[key] as boolean) = c.checked; saveLayers(); chart.setLayers(layers); } });
    return el("label", { class: "check small elev-lg" }, c, sample, el("span", {}, label));
  };
  const sw = (cls: string, style = "") => el("i", { class: `elev-sw ${cls}`, style });
  legendEl.append(item("final", "Endgültiges Profil", sw("line thick")));
  if (!d) return;
  legendEl.append(item("p13", "nur Copernicus (P13)", sw("line dash")));
  for (const s of d.sources) {
    const c = el("input", { type: "checkbox", checked: layers.src[s.name] !== false, onchange: () => { layers.src[s.name] = c.checked; saveLayers(); chart.setLayers(layers); } });
    legendEl.append(el("label", { class: "check small elev-lg" }, c, sw("dot", `--c:${srcColour(s.colour)}`), el("span", {}, `Messpunkte ${s.title.replace(/ \(.*\)$/, "")}`)));
  }
  legendEl.append(item("tunnel", "Tunnel und Brücken (interpoliert)", sw("band hint")), item("filled", "Copernicus aufgefüllt", sw("band warn")), item("rug", "Geländeunruhe", sw("rug")),
    item("grade", `Steigung (${GRADE_LABEL.map((l, i) => `${["grün", "gelb", "orange", "rot"][i]} ${l}`).join(", ")})`, el("span", { class: "elev-grade" }, ...GRADE_TOKENS.map((t) => el("i", { class: "elev-sw g", style: `--c:${token(t, "#888")}` })))));
}

// ---- key figures
function renderFigures() {
  figBox.replaceChildren(el("h3", { id: "elev-fig-h" }, "Kennzahlen"));
  const p = E.profile, d = E.diag;
  if (!p) { figBox.append(el("p", { class: "muted small" }, "Noch kein Profil.")); return; }
  const maxG = d ? d.max_grade_pct : maxGrade(p.z, p.ds);
  const fig = (v: string, l: string) => el("div", { class: "ride-box" }, el("div", { class: "ride-v mono tnum" }, v), el("div", { class: "ride-l" }, l));
  figBox.append(el("div", { class: "elev-figs" },
    fig(`${de(p.ascent_m, 0)} m`, "Anstieg"), fig(`${de(p.descent_m, 0)} m`, "Abstieg"), fig(`${de(p.min_m, 0)} m`, "tiefster Punkt"), fig(`${de(p.max_m, 0)} m`, "höchster Punkt"), fig(`${de(maxG, 1)} %`, "größte Steigung (50 m)")));
  if (!d) return;
  const dl = el("dl", { class: "elev-dl small" });
  const add = (k: string, v: string) => dl.append(el("dt", {}, k), el("dd", {}, v));
  add("Verfahren", `robust mit mehreren Quellen auf ${de(d.strategy_share.robust * 100, 0)} % der Strecke, nur Copernicus (P13) auf ${de(d.strategy_share.p13 * 100, 0)} %`);
  const src = d.sources.map((s) => `${s.title.replace(/ \(.*\)$/, "")} ${de((d.source_share[s.name] ?? 0) * 100, 0)} %`).join(", ");
  add("Anteil der Quellen", src);
  const diff = p.ascent_m - d.ascent_p13_m;
  add("Vergleich mit P13", d.strategy_share.robust < 0.005 ? "gleich (keine weiteren Quellen im Profil)" : `Anstieg ${diff >= 0 ? "+" : "−"}${de(Math.abs(diff), 0)} m gegenüber nur Copernicus (P13: ${de(d.ascent_p13_m, 0)} m)`);
  figBox.append(dl);
}

// ---- conspicuous stretches
function renderStretches() {
  stretchBox.replaceChildren(el("h3", { id: "elev-str-h" }, "Auffällige Stellen"));
  const p = E.profile, d = E.diag;
  if (!p) { stretchBox.append(el("p", { class: "muted small" }, "Noch kein Profil.")); return; }
  const list: Stretch[] = [...(d ? topDifferences(p.z, d.z_p13, p.ds, p.s0, 5) : []), ...steepStretches(p.z, p.ds, p.s0, 12)].sort((a, b) => a.a - b.a);
  if (!list.length) { stretchBox.append(el("p", { class: "small muted" }, d ? "Keine auffälligen Stellen: Das Profil weicht nirgends deutlich von P13 ab, und nirgends ist es steiler als 12 %." : "Keine Stelle ist steiler als 12 %.")); return; }
  const ul = el("ul", { class: "elev-str" });
  for (const s of list) {
    const km = `km ${de(s.a / 1000, 2)}${s.b - s.a > 30 ? `–${de(s.b / 1000, 2)}` : ""}`;
    const what = s.kind === "diff" ? `weicht bis ${de(s.value, 1)} m von P13 ab` : `Steigung bis ${de(s.value, 1)} %`;
    ul.append(el("li", { class: "row wrap between" }, el("span", {}, el("b", { class: "tnum" }, km), ` · ${what}`),
      btn("Anzeigen", () => { chart.setView(viewFor(s.a, Math.max(s.b, s.a + 20), p.s0, p.s0 + (p.z.length - 1) * p.ds)); mapMarks.stretch(s.a, Math.max(s.b, s.a + 20)); chart.el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, { size: "sm", icon: "map", title: "Im Diagramm und auf der Karte zeigen" })));
  }
  stretchBox.append(ul);
  if (!d) stretchBox.append(el("p", { class: "small muted" }, "Ohne Diagnosedaten nur die steilen Stellen."));
}

function renderAttribution() {
  attrBox.replaceChildren(el("h3", { id: "elev-attr-h" }, "Quellen und Lizenzen"));
  const p = E.profile;
  if (!p) { attrBox.append(el("p", { class: "small muted" }, "Erscheinen mit dem Profil.")); return; }
  const used = p.sources ?? [];
  attrBox.append(el("p", { class: "small" }, used.length ? `Im Profil verwendet: ${used.map((s) => `${s.title} (${s.licence})`).join("; ")}.` : p.source),
    el("p", { class: "small muted wrap-any" }, p.attribution));
}

