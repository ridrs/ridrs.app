// The charts of the Analyse stage: one canvas, five lanes on one time axis (curvature video against map, yaw rate, speed, quality, confidence and events).
// All lanes share zoom (wheel, pinch, buttons, keys, dragging a time range with the mouse), pan (Shift+drag, one finger), hover (values of every lane, position on the map) and click (the video seeks); a cursor
// follows playback; the weak stretches are shaded and the one picked in the list is marked. Own canvas code, as elevationChart.ts (no chart library).
import { MIN_SPAN_S, clampView, confCls, de, fmtClock, indexAt, kappaTickLabel, niceTicks, radiusText, robustRange, timeTicks, zoomAround, type View } from "./analyseStats";
import { token } from "./app/theme";
import type { AnalyseStretch, InspectSeries } from "./types";
import { el } from "./util";

export interface Hooks { onHover(t: number | null): void; onClick(t: number): void; onView(): void }
export interface ChartLayers { curve: boolean; yaw: boolean; speed: boolean; quality: boolean; band: boolean }
export const DEFAULT_LAYERS: ChartLayers = { curve: true, yaw: true, speed: true, quality: true, band: true };

const LEFT = 78, RIGHT = 12, TOP = 4, AXIS_H = 22, GAP = 8;
const LANES = [
  { id: "curve", label: "Kurvenrate (1/km, Radius an der Achse)", h: 3 },
  { id: "yaw", label: "Gierrate (°/s)", h: 2 },
  { id: "speed", label: "Geschwindigkeit (m/s)", h: 2 },
  { id: "quality", label: "Qualität", h: 2 },
  { id: "band", label: "Sicherheit und Ereignisse", h: 1.5 },
] as const;
type LaneId = (typeof LANES)[number]["id"];
const rgba = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const CONF_TOKEN = { high: "--map-conf-high", mid: "--map-conf-mid", low: "--map-conf-low", none: "--map-conf-none" } as const;
export const CONF_DE = { high: "hoch", mid: "mittel", low: "gering", none: "außerhalb" } as const;

export class AnalyseChart {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private live: HTMLElement;
  private S: InspectSeries | null = null;
  view: View = { v0: 0, v1: 1 };
  layers: ChartLayers = { ...DEFAULT_LAYERS };
  private cursor: number | null = null;
  private hover: number | null = null;
  private selected: AnalyseStretch | null = null;
  private raf = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  /** pan: move the view; brush: mark a time range and zoom into it on release (the mouse without Shift) */
  private dragFrom: { x: number; v: View; mode: "pan" | "brush" } | null = null;
  private brushEl: HTMLElement;
  private moved = 0;
  private pinch: { d: number; v: View; at: number } | null = null;
  private plot = { x: LEFT, y: TOP, w: 100, h: 100 };
  private lanes: { id: LaneId; y: number; h: number }[] = [];
  /** cached ranges per lane (computed once per data set) */
  private ranges: Partial<Record<LaneId | "yaw", [number, number]>> = {};
  private qmax = { inliers: 1, rms: 1, sd: 1 };

  constructor(private hooks: Hooks) {
    this.canvas = el("canvas", { class: "ec-canvas", "aria-hidden": "true" });
    this.tip = el("div", { class: "ec-tip", hidden: true, "aria-hidden": "true" });
    this.live = el("div", { class: "sr-only", "aria-live": "polite" });
    this.brushEl = el("div", { class: "ac-brush", hidden: true, "aria-hidden": "true" });
    this.el = el("div", { class: "ec ac", tabIndex: 0, role: "group", "aria-label": "Diagramme der Analyse auf einer gemeinsamen Zeitachse. Pfeil links und rechts: Zeit wählen, Umschalt mit Pfeil: verschieben, Plus und Minus: zoomen, Eingabe: Video dorthin springen, Null: ganzes Video." }, this.canvas, this.brushEl, this.tip, this.live);
    const c = this.canvas;
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e, true));
    c.addEventListener("pointerleave", (e) => { if (!this.pointers.size && e.pointerType !== "touch") this.setHover(null); });
    c.addEventListener("dblclick", (e) => this.setView(zoomAround(this.view, 0.4, this.timeAt(e.clientX), this.t0, this.t1)));
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("blur", () => { if (!this.pointers.size) this.setHover(null); });
    new ResizeObserver(() => this.draw()).observe(this.el);
    window.addEventListener("themechange", () => this.draw());
  }

  // ---- data
  get t0() { return this.S?.t0 ?? 0; }
  get t1() { return this.S ? this.S.t0 + (this.S.n - 1) * this.S.dt : 1; }
  setData(S: InspectSeries | null) {
    const first = !this.S || !S || this.S.n !== S.n;
    this.S = S;
    this.ranges = {};
    if (S) {
      this.ranges.curve = robustRange([S.kappa_video, S.kappa_map], 0.01, 0.99, true, 0.08, 20);
      this.ranges.yaw = robustRange([S.yaw_vms, S.yaw_far], 0.01, 0.99, true, 0.08, 3);
      this.ranges.speed = robustRange([S.speed_vms, S.speed_fused], 0.005, 0.995, false, 0.1, 4);
      this.ranges.speed = [Math.min(0, this.ranges.speed[0]), this.ranges.speed[1]];
      const mx = (a: (number | null)[], q: number) => robustRange([a], 0.5, q, false, 0, 1)[1];
      this.qmax = { inliers: Math.max(1, mx(S.inliers, 0.995)), rms: Math.max(0.5, mx(S.rms, 0.995)), sd: Math.max(5, mx(S.s_sd, 0.99)) };
    }
    if (first) this.view = { v0: this.t0, v1: this.t1 };
    this.view = clampView(this.view, this.t0, this.t1);
    this.draw();
  }
  setLayers(l: ChartLayers) { this.layers = l; this.draw(); }
  setCursor(t: number | null) { if (t !== this.cursor) { this.cursor = t; this.drawSoon(); } }
  /** the stretch picked in the list (null: none) */
  setSelected(s: AnalyseStretch | null) { this.selected = s; this.draw(); }
  setView(v: View) { this.view = clampView(v, this.t0, this.t1); this.hooks.onView(); this.draw(); }
  zoomBy(f: number) { const c = this.cursor !== null && this.cursor >= this.view.v0 && this.cursor <= this.view.v1 ? this.cursor : (this.view.v0 + this.view.v1) / 2; this.setView(zoomAround(this.view, f, c, this.t0, this.t1)); }
  reset() { this.setView({ v0: this.t0, v1: this.t1 }); }
  canZoomIn() { return this.view.v1 - this.view.v0 > MIN_SPAN_S + 0.5; }
  canZoomOut() { return this.view.v1 - this.view.v0 < this.t1 - this.t0 - 0.5; }

  // ---- geometry
  private timeAt(clientX: number) {
    const r = this.canvas.getBoundingClientRect(), p = this.plot;
    const f = Math.max(0, Math.min(1, (clientX - r.left - p.x) / p.w));
    return this.view.v0 + f * (this.view.v1 - this.view.v0);
  }
  private X(t: number) { return this.plot.x + ((t - this.view.v0) / (this.view.v1 - this.view.v0)) * this.plot.w; }

  // ---- events
  private onWheel(e: WheelEvent) {
    if (!this.S) return;
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
      const span = this.view.v1 - this.view.v0, d = (e.deltaX / this.plot.w) * span;
      this.setView({ v0: this.view.v0 + d, v1: this.view.v1 + d });
      return;
    }
    const k = e.ctrlKey ? 0.012 : e.deltaMode === 1 ? 0.05 : 0.0016;
    this.setView(zoomAround(this.view, Math.exp(e.deltaY * k), this.timeAt(e.clientX), this.t0, this.t1));
  }
  private onDown(e: PointerEvent) {
    if (!this.S) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    if (this.pointers.size === 1) this.dragFrom = { x: e.clientX, v: { ...this.view }, mode: e.pointerType === "touch" || e.shiftKey ? "pan" : "brush" };
    else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, v: { ...this.view }, at: this.timeAt((a.x + b.x) / 2) };
      this.dragFrom = null; this.moved = 99; this.hideBrush();
    }
    if (this.dragFrom?.mode !== "brush") this.el.classList.add("grabbing");
  }
  private onMove(e: PointerEvent) {
    if (!this.S) return;
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.view = zoomAround(this.pinch.v, this.pinch.d / d, this.pinch.at, this.t0, this.t1);
        this.hooks.onView(); this.draw();
      } else if (this.dragFrom) {
        const dx = e.clientX - this.dragFrom.x;
        this.moved = Math.max(this.moved, Math.abs(dx));
        if (this.moved > 4 && this.dragFrom.mode === "brush") this.showBrush(this.dragFrom.x, e.clientX);
        else if (this.moved > 4) {
          const span = this.dragFrom.v.v1 - this.dragFrom.v.v0, d = -(dx / this.plot.w) * span;
          this.view = clampView({ v0: this.dragFrom.v.v0 + d, v1: this.dragFrom.v.v1 + d }, this.t0, this.t1);
          this.hooks.onView(); this.draw();
        }
      }
    }
    this.setHover(this.timeAt(e.clientX), e.clientX, e.clientY);
  }
  private onUp(e: PointerEvent, cancel = false) {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) {
      this.el.classList.remove("grabbing");
      if (had && !cancel && this.moved <= 4 && this.dragFrom) this.hooks.onClick(this.timeAt(e.clientX));
      else if (had && !cancel && this.dragFrom?.mode === "brush") {
        const a = this.timeAt(this.dragFrom.x), b = this.timeAt(e.clientX);
        this.setView({ v0: Math.min(a, b), v1: Math.max(a, b) }); // clampView keeps at least MIN_SPAN_S
      }
      this.dragFrom = null; this.hideBrush();
      if (e.pointerType === "touch") this.setHover(null);
    }
  }
  /** the marked range between two client x positions, inside the plot */
  private showBrush(xa: number, xb: number) {
    const r = this.canvas.getBoundingClientRect(), p = this.plot;
    const cl = (x: number) => Math.max(p.x, Math.min(p.x + p.w, x - r.left));
    const a = cl(Math.min(xa, xb)), b = cl(Math.max(xa, xb));
    const last = this.lanes[this.lanes.length - 1], bottom = last ? last.y + last.h : p.y + p.h;
    Object.assign(this.brushEl.style, { left: `${a}px`, width: `${Math.max(1, b - a)}px`, top: `${p.y}px`, height: `${bottom - p.y}px` });
    this.brushEl.hidden = false;
  }
  private hideBrush() { this.brushEl.hidden = true; }
  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && this.dragFrom?.mode === "brush") { e.preventDefault(); this.dragFrom = null; this.hideBrush(); return; }
    if (!this.S || e.metaKey || e.ctrlKey || e.altKey) return;
    const span = this.view.v1 - this.view.v0, at = this.hover ?? this.cursor ?? (this.view.v0 + this.view.v1) / 2;
    const move = (d: number) => { const a = Math.max(this.view.v0, Math.min(this.view.v1, at + d)); this.setHover(a); this.live.textContent = this.describe(a).join(". "); };
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = ((e.key === "ArrowRight" ? 1 : -1) * span) / (e.shiftKey ? 4 : 60);
      if (e.shiftKey) this.setView({ v0: this.view.v0 + d, v1: this.view.v1 + d }); else move(d);
    } else if (e.key === "+" || e.key === "=") { e.preventDefault(); this.setView(zoomAround(this.view, 0.6, at, this.t0, this.t1)); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); this.setView(zoomAround(this.view, 1 / 0.6, at, this.t0, this.t1)); }
    else if (e.key === "0") { e.preventDefault(); this.reset(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.hooks.onClick(at); }
    else if (e.key === "Escape") this.setHover(null);
  }

  // ---- hover
  private setHover(t: number | null, cx?: number, cy?: number) {
    this.hover = t;
    this.hooks.onHover(t);
    if (t === null || !this.S) { this.tip.hidden = true; this.drawSoon(); return; }
    const lines = this.describe(t);
    this.tip.hidden = false;
    this.tip.replaceChildren(el("b", {}, lines[0]), ...lines.slice(1).map((l) => el("div", {}, l)));
    const r = this.el.getBoundingClientRect(), tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let x = (cx !== undefined ? cx - r.left : this.X(t)) + 14;
    if (x + tw > r.width - 4) x -= tw + 28;
    const y = Math.max(4, Math.min(r.height - th - AXIS_H - 4, (cy !== undefined ? cy - r.top : this.plot.y + 20) - th / 2));
    this.tip.style.left = `${Math.max(4, x)}px`; this.tip.style.top = `${y}px`;
    this.drawSoon();
  }
  /** the lines of the tooltip: time and km, then the values of every lane at that second */
  describe(t: number): string[] {
    const S = this.S!, i = indexAt(S, t);
    const f = (a: (number | null)[], d = 1, u = "") => (a[i] === null || a[i] === undefined ? "–" : `${de(a[i]!, d)}${u}`);
    const out = [`${fmtClock(t)} · km ${S.s[i] === null ? "–" : de(S.s[i]! / 1000, 2)}`];
    out.push(`Kurve: Video ${radiusText(S.kappa_video[i])}, Karte ${radiusText(S.kappa_map[i])}`);
    out.push(`Gierrate: Videobewegung ${f(S.yaw_vms, 1, " °/s")}, Fernmerkmale ${f(S.yaw_far, 1, " °/s")}`);
    out.push(`Tempo: Video ${f(S.speed_vms, 1, " m/s")}, Strecke ${f(S.speed_fused, 1, " m/s")}`);
    out.push(`Inlier ${f(S.inliers, 0)}, rms ${f(S.rms, 2, " px")}, nutzbar ${S.usable[i] === null ? "–" : de(100 * S.usable[i]!, 0) + " %"}, Position ± ${f(S.s_sd, 0, " m")}`);
    const cls = confCls(S.conf[i], S.extrap[i]);
    const ev = [S.in_gap[i] ? "Lücke" : "", S.tunnel[i] ? "Tunnel" : "", S.cut[i] ? "Szenenschnitt" : "", S.odofail[i] ? "Wegmessung ausgefallen" : ""].filter(Boolean);
    out.push(`Sicherheit ${S.conf[i] === null ? "–" : de(100 * S.conf[i]!, 0) + " %"} (${CONF_DE[cls]})${ev.length ? " · " + ev.join(", ") : ""}`);
    const st = S.stretches.find((x) => t >= x.t0 && t <= x.t1);
    if (st) out.push(`Schwacher Abschnitt: ${st.causes.map((c) => c.text.split(":")[0]).join("; ")}`);
    return out;
  }

  // ---- drawing
  private drawSoon() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }

  draw() {
    const cv = this.canvas, r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(120, Math.round(r.width)), H = Math.max(120, Math.round(r.height));
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const c = cv.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const S = this.S;
    if (!S || S.n < 2) return;
    const text = token("--c-text", "#111"), muted = token("--c-text-2", "#666"), grid = token("--c-border", "#ddd"), surface2 = token("--c-surface-2", "#eee");
    const accent = token("--c-accent", "#2563eb"), warn = token("--c-warn", "#a60"), bad = token("--c-bad", "#b30"), hint = token("--c-hint", "#63d");
    const amber = token("--c-src-0", "#b45309"), teal = token("--c-src-2", "#0f766e");
    const { v0, v1 } = this.view, span = v1 - v0;
    const font = token("--font", "system-ui, sans-serif");

    // lane layout
    const on = LANES.filter((l) => this.layers[l.id]);
    const pl = { x: LEFT, y: TOP, w: Math.max(60, W - LEFT - RIGHT), h: Math.max(60, H - TOP - AXIS_H) };
    this.plot = pl;
    const totalW = on.reduce((a, l) => a + l.h, 0) || 1, avail = pl.h - GAP * Math.max(0, on.length - 1);
    this.lanes = [];
    let y = pl.y;
    for (const l of on) { const h = (avail * l.h) / totalW; this.lanes.push({ id: l.id, y, h }); y += h + GAP; }
    const X = (t: number) => pl.x + ((t - v0) / span) * pl.w;
    const i0 = Math.max(0, Math.floor((v0 - S.t0) / S.dt) - 1), i1 = Math.min(S.n - 1, Math.ceil((v1 - S.t0) / S.dt) + 1);
    const group = Math.max(1, Math.floor((i1 - i0 + 1) / pl.w));

    // weak stretches: a faint band across all lanes, the picked one stronger
    const bottom = this.lanes.length ? this.lanes[this.lanes.length - 1].y + this.lanes[this.lanes.length - 1].h : pl.y + pl.h;
    c.save(); c.beginPath(); c.rect(pl.x, pl.y, pl.w, bottom - pl.y); c.clip();
    for (const st of S.stretches) {
      if (st.t1 < v0 || st.t0 > v1) continue;
      const sel = this.selected && this.selected.t0 === st.t0;
      c.fillStyle = rgba(bad, sel ? 0.2 : 0.07);
      c.fillRect(X(st.t0), pl.y, Math.max(2, X(st.t1) - X(st.t0)), bottom - pl.y);
      if (sel) { c.strokeStyle = bad; c.lineWidth = 1.5; c.strokeRect(X(st.t0) + 0.5, pl.y + 0.5, Math.max(2, X(st.t1) - X(st.t0)) - 1, bottom - pl.y - 1); }
    }
    c.restore();

    // time grid and axis
    const ticks = timeTicks(v0, v1, Math.max(3, Math.round(pl.w / 90)));
    c.font = `11px ${font}`; c.lineWidth = 1;
    for (const t of ticks) {
      const x = Math.round(X(t)) + 0.5;
      c.strokeStyle = grid; c.beginPath(); c.moveTo(x, pl.y); c.lineTo(x, bottom); c.stroke();
      c.fillStyle = muted; c.textAlign = "center"; c.textBaseline = "top"; c.fillText(fmtClock(t), x, bottom + 5);
    }

    // lanes: background and y axis first, the data clipped to the lane
    for (const L of this.lanes) {
      c.fillStyle = rgba(surface2, 0.35); c.fillRect(pl.x, L.y, pl.w, L.h);
      const yOf = (v: number, lo: number, hi: number) => L.y + L.h - ((v - lo) / (hi - lo)) * L.h;
      const axis = (lo: number, hi: number, fmt: (v: number) => string, tk: number[]) => {
        c.font = `10.5px ${font}`; c.textAlign = "right"; c.textBaseline = "middle"; c.fillStyle = muted; c.strokeStyle = grid; c.lineWidth = 1;
        for (const v of tk) {
          const yy = Math.round(yOf(v, lo, hi)) + 0.5;
          if (yy < L.y + 4 || yy > L.y + L.h - 4) continue;
          c.beginPath(); c.moveTo(pl.x, yy); c.lineTo(pl.x + pl.w, yy); c.stroke();
          c.fillText(fmt(v), pl.x - 6, yy);
        }
      };
      const line = (a: (number | null)[], lo: number, hi: number, col: string, lw = 1.6, dash: number[] = []) => {
        c.beginPath(); let pen = false;
        for (let i = i0; i <= i1; i += group) {
          let sum = 0, n = 0;
          for (let j = i; j < Math.min(i + group, S.n); j++) { const v = a[j]; if (v !== null && v !== undefined && Number.isFinite(v)) { sum += v; n++; } }
          if (!n) { pen = false; continue; }
          const x = X(S.t0 + (i + (group - 1) / 2) * S.dt), yv = yOf(sum / n, lo, hi);
          if (!pen) { c.moveTo(x, yv); pen = true; } else c.lineTo(x, yv);
        }
        c.setLineDash(dash); c.lineWidth = lw; c.strokeStyle = col; c.lineJoin = "round"; c.stroke(); c.setLineDash([]);
      };
      const clip = () => { c.save(); c.beginPath(); c.rect(pl.x, L.y, pl.w, L.h); c.clip(); };
      if (L.id === "curve") {
        const [lo, hi] = this.ranges.curve!;
        const rad = [500, 200, 100, 50, 25].flatMap((rr) => [1000 / rr, -1000 / rr]).filter((k) => k > lo * 0.92 && k < hi * 0.92).sort((a, b) => Math.abs(a) - Math.abs(b));
        const kept: number[] = [0];                                              // radius ticks that keep 15 px apart
        for (const k of rad) if (kept.every((q) => Math.abs(yOf(k, lo, hi) - yOf(q, lo, hi)) >= 15)) kept.push(k);
        axis(lo, hi, kappaTickLabel, kept);
        clip();
        const yz = yOf(0, lo, hi);
        c.strokeStyle = muted; c.beginPath(); c.moveTo(pl.x, yz); c.lineTo(pl.x + pl.w, yz); c.stroke();
        c.fillStyle = rgba(warn, 0.28);                                           // the difference between the two curves
        for (let i = i0; i <= i1; i += group) {
          const a = S.kappa_video[i], b = S.kappa_map[i];
          if (a === null || b === null) continue;
          const ya = yOf(a, lo, hi), yb = yOf(b, lo, hi), x = X(S.t0 + i * S.dt);
          c.fillRect(x - 0.5, Math.min(ya, yb), Math.max(1.2, (pl.w * S.dt * group) / span), Math.abs(ya - yb));
        }
        line(S.kappa_map, lo, hi, text, 1.6, [5, 3]);
        line(S.kappa_video, lo, hi, accent, 1.8);
        c.restore();
        this.legend(c, L, [["Video", accent, false], ["Karte (OSM)", text, true], ["Unterschied", rgba(warn, 0.7), false]], font, muted);
      } else if (L.id === "yaw") {
        const [lo, hi] = this.ranges.yaw!;
        axis(lo, hi, (v) => de(v, 0), niceTicks(lo, hi, Math.max(2, Math.round(L.h / 28))));
        clip(); line(S.yaw_vms, lo, hi, amber, 1.4); line(S.yaw_far, lo, hi, teal, 1.4); c.restore();
        this.legend(c, L, [["Videobewegung", amber, false], ["Fernmerkmale", teal, false]], font, muted);
      } else if (L.id === "speed") {
        const [lo, hi] = this.ranges.speed!;
        axis(lo, hi, (v) => de(v, 0), niceTicks(lo, hi, Math.max(2, Math.round(L.h / 28))));
        clip(); line(S.speed_fused, lo, hi, text, 1.6, [5, 3]); line(S.speed_vms, lo, hi, amber, 1.5); c.restore();
        this.legend(c, L, [["Video (vms × κ)", amber, false], ["Strecke (Ergebnis)", text, true]], font, muted);
      } else if (L.id === "quality") {
        clip();
        line(S.inliers, 0, this.qmax.inliers * 1.05, accent, 1.4);
        line(S.rms, 0, this.qmax.rms * 1.05, warn, 1.2);
        line(S.s_sd, 0, this.qmax.sd * 1.05, bad, 1.4, [2, 2]);
        c.restore();
        this.legend(c, L, [[`Inlier (0–${de(this.qmax.inliers, 0)})`, accent, false], [`rms (0–${de(this.qmax.rms, 1)} px)`, warn, false], [`Streuung s_sd (0–${de(this.qmax.sd, 0)} m)`, bad, true]], font, muted);
      } else {
        clip();
        const bh = Math.min(16, L.h * 0.5);                                         // confidence in the map's colours, the events below
        let start = i0, cls = confCls(S.conf[i0], S.extrap[i0]) as string;
        for (let i = i0 + 1; i <= i1 + 1; i++) {
          const k = i <= i1 ? confCls(S.conf[i], S.extrap[i]) : "";
          if (k !== cls) {
            c.fillStyle = token(CONF_TOKEN[cls as keyof typeof CONF_TOKEN], "#888");
            const xa = X(S.t0 + (start - 0.5) * S.dt), xb = X(S.t0 + (i - 0.5) * S.dt);
            c.fillRect(xa, L.y + 16, Math.max(1, xb - xa), bh);
            start = i; cls = k;
          }
        }
        const row = (flag: number[], col: string, yy: number, hh: number) => {
          c.fillStyle = col;
          let s0 = -1;
          for (let i = i0; i <= i1 + 1; i++) {
            const onn = i <= i1 && flag[i] === 1;
            if (onn && s0 < 0) s0 = i;
            if (!onn && s0 >= 0) { const xa = X(S.t0 + (s0 - 0.5) * S.dt); c.fillRect(xa, yy, Math.max(1.5, X(S.t0 + (i - 0.5) * S.dt) - xa), hh); s0 = -1; }
          }
        };
        const ey = L.y + 16 + bh + 4, eh = Math.max(3, (L.h - 16 - bh - 8) / 2);
        row(S.in_gap, warn, ey, eh); row(S.tunnel, hint, ey, eh); row(S.odofail, bad, ey + eh + 1, eh); row(S.local.map((v) => (v === 1 ? 1 : 0)), accent, ey + eh + 1, eh);
        c.strokeStyle = text; c.lineWidth = 1.5;
        for (const [a, b] of S.cuts) { const x = Math.round(X((a + b) / 2)) + 0.5; c.beginPath(); c.moveTo(x, L.y); c.lineTo(x, L.y + L.h); c.stroke(); }
        c.restore();
        this.legend(c, L, [["Lücke", warn, false], ["Tunnel", hint, false], ["Wegmessung aus", bad, false], ["Lokale Prüfung", accent, false], ["Schnitt", text, false]], font, muted, true);
      }
    }

    // playback cursor and hover
    const line = (t: number, col: string, w: number, dash: number[]) => {
      const x = Math.round(X(t)) + 0.5;
      if (x < pl.x || x > pl.x + pl.w) return;
      c.beginPath(); c.setLineDash(dash); c.lineWidth = w; c.strokeStyle = col; c.moveTo(x, pl.y); c.lineTo(x, bottom); c.stroke(); c.setLineDash([]);
    };
    if (this.cursor !== null) {
      line(this.cursor, accent, 2, []);
      if (this.cursor >= v0 && this.cursor <= v1) { c.fillStyle = accent; const x = X(this.cursor); c.beginPath(); c.moveTo(x - 5, pl.y); c.lineTo(x + 5, pl.y); c.lineTo(x, pl.y + 7); c.closePath(); c.fill(); }
    }
    if (this.hover !== null) {
      line(this.hover, text, 1, [3, 3]);
      const i = indexAt(S, this.hover), x = X(S.t0 + i * S.dt);
      for (const L of this.lanes) {
        const dots: [(number | null)[], string, number, number][] = [];
        if (L.id === "curve") { const [lo, hi] = this.ranges.curve!; dots.push([S.kappa_video, accent, lo, hi], [S.kappa_map, text, lo, hi]); }
        if (L.id === "yaw") { const [lo, hi] = this.ranges.yaw!; dots.push([S.yaw_vms, amber, lo, hi], [S.yaw_far, teal, lo, hi]); }
        if (L.id === "speed") { const [lo, hi] = this.ranges.speed!; dots.push([S.speed_vms, amber, lo, hi], [S.speed_fused, text, lo, hi]); }
        if (x < pl.x || x > pl.x + pl.w) continue;
        for (const [a, col, lo, hi] of dots) {
          const v = a[i]; if (v === null || v === undefined) continue;
          c.beginPath(); c.arc(x, L.y + L.h - ((v - lo) / (hi - lo)) * L.h, 3.6, 0, Math.PI * 2); c.fillStyle = token("--c-surface", "#fff"); c.fill(); c.lineWidth = 2; c.strokeStyle = col; c.stroke();
        }
      }
    }
  }

  /** the lane's key: coloured line samples with names, top left inside the lane */
  private legend(c: CanvasRenderingContext2D, L: { y: number; h: number }, items: [string, string, boolean][], font: string, muted: string, small = false) {
    c.font = `${small ? 10 : 10.5}px ${font}`; c.textBaseline = "top"; c.textAlign = "left";
    let x = this.plot.x + 6;
    const y = L.y + 3;
    const wTotal = items.reduce((a, [n]) => a + c.measureText(n).width + 28, 0);
    c.fillStyle = rgba(token("--c-surface", "#fff"), 0.78); c.fillRect(x - 3, y - 1, wTotal, 14);
    for (const [name, col, dash] of items) {
      c.strokeStyle = col; c.lineWidth = 2; c.setLineDash(dash ? [4, 2] : []); c.beginPath(); c.moveTo(x, y + 6); c.lineTo(x + 14, y + 6); c.stroke(); c.setLineDash([]);
      c.fillStyle = muted; c.fillText(name, x + 18, y);
      x += c.measureText(name).width + 28;
    }
  }
}
