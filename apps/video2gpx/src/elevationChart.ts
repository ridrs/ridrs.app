// The profile chart of the Höhe stage (canvas, own code, no chart library): the final profile and its comparison with P13, the raw samples per
// source with the estimator's weight as opacity, background bands, ruggedness and grade strips. Zoom (wheel, pinch, buttons, keys), pan (drag),
// hover (tooltip, position on the map), click (video seeks), a playback cursor.
import { token } from "./app/theme";
import { MIN_SPAN_M, clampView, de, gradeClass, gradeSeries, niceTicks, shareText, zoomAround, type View } from "./elevationStats";
import type { DiagSource, ElevationDiag, ElevationProfile } from "./types";
import { el } from "./util";

export interface Layers { final: boolean; p13: boolean; tunnel: boolean; filled: boolean; rug: boolean; grade: boolean; src: Record<string, boolean> }
export const DEFAULT_LAYERS: Layers = { final: true, p13: true, tunnel: true, filled: true, rug: true, grade: true, src: {} };
export interface Hooks { onHover(arc: number | null): void; onClick(arc: number): void; onView(): void }

const LEFT = 50, RIGHT = 12, TOP = 10, AXIS_H = 20, STRIP_H = 8, STRIP_GAP = 4;
export const SRC_COLOURS = 6;
export const srcColour = (colour: number) => token(`--c-src-${colour % SRC_COLOURS}`, "#888");
export const GRADE_TOKENS = ["--c-grade-1", "--c-grade-2", "--c-grade-3", "--c-grade-4"] as const;
const rgba = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export class ElevationChart {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private live: HTMLElement;
  private profile: ElevationProfile | null = null;
  private diag: ElevationDiag | null = null;
  private grade: number[] = [];
  view: View = { v0: 0, v1: 1 };
  layers: Layers = { ...DEFAULT_LAYERS, src: {} };
  private cursor: number | null = null;
  private hover: number | null = null;
  private raf = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragFrom: { x: number; v: View } | null = null;
  private moved = 0;
  private pinch: { d: number; v: View; at: number } | null = null;
  private plot = { x: LEFT, y: TOP, w: 100, h: 100 };

  constructor(private hooks: Hooks) {
    this.canvas = el("canvas", { class: "ec-canvas", "aria-hidden": "true" });
    this.tip = el("div", { class: "ec-tip", hidden: true, "aria-hidden": "true" });
    this.live = el("div", { class: "sr-only", "aria-live": "polite" });
    this.el = el("div", { class: "ec", tabIndex: 0, role: "group", "aria-label": "Höhenprofil der ganzen Strecke. Pfeil links und rechts: Position wählen, Umschalt mit Pfeil: verschieben, Plus und Minus: zoomen, Eingabe: Video dorthin springen, Null: ganze Strecke." }, this.canvas, this.tip, this.live);
    const c = this.canvas;
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e, true));
    c.addEventListener("pointerleave", (e) => { if (!this.pointers.size && e.pointerType !== "touch") this.setHover(null); });
    c.addEventListener("dblclick", (e) => { const a = this.arcAt(e.clientX); this.setView(zoomAround(this.view, 0.4, a, this.s0, this.s1)); });
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("blur", () => { if (!this.pointers.size) this.setHover(null); });
    new ResizeObserver(() => this.draw()).observe(this.el);
    window.addEventListener("themechange", () => this.draw());
  }

  // ---- data
  get s0() { return this.profile?.s0 ?? 0; }
  get s1() { return this.profile ? this.profile.s0 + (this.profile.z.length - 1) * this.profile.ds : 1; }
  setData(profile: ElevationProfile | null, diag: ElevationDiag | null) {
    const first = !this.profile || !profile || this.profile.z.length !== profile.z.length;
    this.profile = profile; this.diag = diag;
    this.grade = profile ? gradeSeries(profile.z, profile.ds, 50) : [];
    for (const s of diag?.sources ?? []) if (!(s.name in this.layers.src)) this.layers.src[s.name] = true;
    if (first) this.view = { v0: this.s0, v1: this.s1 };
    this.view = clampView(this.view, this.s0, this.s1);
    this.draw();
  }
  setLayers(l: Layers) { this.layers = l; this.draw(); }
  setCursor(arc: number | null) { if (arc !== this.cursor) { this.cursor = arc; this.drawSoon(); } }
  setView(v: View) { this.view = clampView(v, this.s0, this.s1); this.hooks.onView(); this.draw(); }
  zoomBy(factor: number) { this.setView(zoomAround(this.view, factor, this.cursor !== null && this.cursor >= this.view.v0 && this.cursor <= this.view.v1 ? this.cursor : (this.view.v0 + this.view.v1) / 2, this.s0, this.s1)); }
  reset() { this.setView({ v0: this.s0, v1: this.s1 }); }
  canZoomIn() { return this.view.v1 - this.view.v0 > MIN_SPAN_M + 1; }
  canZoomOut() { return this.view.v1 - this.view.v0 < this.s1 - this.s0 - 1; }

  // ---- geometry
  private arcAt(clientX: number) {
    const r = this.canvas.getBoundingClientRect(), p = this.plot;
    const f = Math.max(0, Math.min(1, (clientX - r.left - p.x) / p.w));
    return this.view.v0 + f * (this.view.v1 - this.view.v0);
  }
  private X(s: number) { return this.plot.x + ((s - this.view.v0) / (this.view.v1 - this.view.v0)) * this.plot.w; }
  private index(s: number) { return Math.max(0, Math.min((this.profile?.z.length ?? 1) - 1, Math.round((s - this.s0) / (this.profile?.ds ?? 5)))); }

  // ---- events
  private onWheel(e: WheelEvent) {
    if (!this.profile) return;
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
      const span = this.view.v1 - this.view.v0;
      this.setView({ v0: this.view.v0 + (e.deltaX / this.plot.w) * span, v1: this.view.v1 + (e.deltaX / this.plot.w) * span });
      return;
    }
    const k = e.ctrlKey ? 0.012 : e.deltaMode === 1 ? 0.05 : 0.0016;   // a trackpad pinch arrives as a wheel with ctrl and small deltas
    this.setView(zoomAround(this.view, Math.exp(e.deltaY * k), this.arcAt(e.clientX), this.s0, this.s1));
  }
  private onDown(e: PointerEvent) {
    if (!this.profile) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved = 0;
    if (this.pointers.size === 1) this.dragFrom = { x: e.clientX, v: { ...this.view } };
    else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, v: { ...this.view }, at: this.arcAt((a.x + b.x) / 2) };
      this.dragFrom = null; this.moved = 99;
    }
    this.el.classList.add("grabbing");
  }
  private onMove(e: PointerEvent) {
    if (!this.profile) return;
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.view = zoomAround(this.pinch.v, this.pinch.d / d, this.pinch.at, this.s0, this.s1);
        this.hooks.onView(); this.draw();
      } else if (this.dragFrom) {
        const dx = e.clientX - this.dragFrom.x;
        this.moved = Math.max(this.moved, Math.abs(dx));
        if (this.moved > 4) {
          const span = this.dragFrom.v.v1 - this.dragFrom.v.v0, d = -(dx / this.plot.w) * span;
          this.view = clampView({ v0: this.dragFrom.v.v0 + d, v1: this.dragFrom.v.v1 + d }, this.s0, this.s1);
          this.hooks.onView(); this.draw();
        }
      }
    }
    this.setHover(this.arcAt(e.clientX), e.clientX, e.clientY);
  }
  private onUp(e: PointerEvent, cancel = false) {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) {
      this.el.classList.remove("grabbing");
      if (had && !cancel && this.moved <= 4 && this.dragFrom) this.hooks.onClick(this.arcAt(e.clientX));
      this.dragFrom = null;
      if (e.pointerType === "touch") this.setHover(null);
    }
  }
  private onKey(e: KeyboardEvent) {
    if (!this.profile || e.metaKey || e.ctrlKey || e.altKey) return;
    const span = this.view.v1 - this.view.v0;
    const at = this.hover ?? (this.view.v0 + this.view.v1) / 2;
    const move = (d: number) => { const a = Math.max(this.view.v0, Math.min(this.view.v1, at + d)); this.setHover(a); this.announce(a); };
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = (e.key === "ArrowRight" ? 1 : -1) * span / (e.shiftKey ? 4 : 60);
      if (e.shiftKey) this.setView({ v0: this.view.v0 + d, v1: this.view.v1 + d }); else move(d);
    } else if (e.key === "+" || e.key === "=") { e.preventDefault(); this.setView(zoomAround(this.view, 0.6, at, this.s0, this.s1)); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); this.setView(zoomAround(this.view, 1 / 0.6, at, this.s0, this.s1)); }
    else if (e.key === "0") { e.preventDefault(); this.reset(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.hooks.onClick(at); }
    else if (e.key === "Escape") this.setHover(null);
  }
  private announce(arc: number) { this.live.textContent = this.describe(arc).join(". "); }

  // ---- hover
  private setHover(arc: number | null, cx?: number, cy?: number) {
    this.hover = arc;
    this.hooks.onHover(arc);
    if (arc === null || !this.profile) { this.tip.hidden = true; this.drawSoon(); return; }
    const lines = this.describe(arc);
    this.tip.hidden = false;
    this.tip.replaceChildren(el("b", {}, lines[0]), ...lines.slice(1).map((l) => el("div", {}, l)));
    const r = this.el.getBoundingClientRect(), tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let x = (cx !== undefined ? cx - r.left : this.X(arc)) + 14;
    if (x + tw > r.width - 4) x -= tw + 28;
    const y = Math.max(4, Math.min(r.height - th - AXIS_H - 4, (cy !== undefined ? cy - r.top : this.plot.y + 20) - th / 2));
    this.tip.style.left = `${Math.max(4, x)}px`; this.tip.style.top = `${y}px`;
    this.drawSoon();
  }
  /** the lines of the tooltip: km and height, grade, source share, ruggedness and strategy */
  describe(arc: number): string[] {
    const p = this.profile!, i = this.index(arc), d = this.diag;
    const out = [`km ${de(arc / 1000, 2)} · ${de(p.z[i], 0)} m`, `Steigung ${this.grade[i] >= 0.05 ? "+" : ""}${de(this.grade[i], 1)} %`];
    if (d) {
      const parts = d.sources.map((s) => ({ title: s.title, sh: s.sh[i] ?? 0 }));
      out.push(`Quellen: ${shareText(parts)}`);
      const rug = d.rug[i];
      out.push(`Geländeunruhe ${rug === null ? "–" : de(rug, 2)}`);
      const w = d.w_dtm[i] ?? 0;
      out.push(`Verfahren: ${w >= 0.5 ? "robust, mehrere Quellen" : w > 0.02 ? "Übergang robust / P13" : "P13"}`);
      const p13 = d.z_p13[i];
      if (p13 !== null && Math.abs(p13 - p.z[i]) >= 0.5) out.push(`P13: ${de(p13, 0)} m (${p.z[i] - p13 >= 0 ? "+" : ""}${de(p.z[i] - p13, 1)} m)`);
      if (d.gap[i]) out.push("Tunnel oder Brücke (interpoliert)");
      if (d.filled[i]) out.push("Copernicus-Modell hier aufgefüllt");
    }
    return out;
  }

  // ---- drawing
  private drawSoon() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }

  draw() {
    const cv = this.canvas, r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(60, Math.round(r.width)), H = Math.max(60, Math.round(r.height));
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const c = cv.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const p = this.profile;
    if (!p || p.z.length < 2) return;
    const L = this.layers, d = this.diag, ds = p.ds;
    const text = token("--c-text", "#111"), muted = token("--c-text-2", "#666"), grid = token("--c-border", "#ddd"), surface2 = token("--c-surface-2", "#eee");
    // layout: plot, then the strips, then the axis
    const strips = (L.rug && d ? 1 : 0) + (L.grade ? 1 : 0);
    const stripsH = strips * (STRIP_H + STRIP_GAP);
    const pl = { x: LEFT, y: TOP, w: Math.max(40, W - LEFT - RIGHT), h: Math.max(40, H - TOP - AXIS_H - stripsH - 4) };
    this.plot = pl;
    const { v0, v1 } = this.view, span = v1 - v0;
    const i0 = Math.max(0, Math.floor((v0 - this.s0) / ds) - 1), i1 = Math.min(p.z.length - 1, Math.ceil((v1 - this.s0) / ds) + 1);
    const step = Math.max(1, Math.floor((i1 - i0) / (pl.w * 2)));
    // y range: the final profile and the comparison in view
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i += 1) {
      lo = Math.min(lo, p.z[i]); hi = Math.max(hi, p.z[i]);
      const q = L.p13 && d ? d.z_p13[i] : null;
      if (q !== null && q !== undefined) { lo = Math.min(lo, q); hi = Math.max(hi, q); }
    }
    if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6; }
    const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
    const Y = (z: number) => pl.y + pl.h - ((z - lo) / (hi - lo)) * pl.h;
    const X = (s: number) => pl.x + ((s - v0) / span) * pl.w;

    // bands: tunnels / bridges and void-filled Copernicus pixels
    c.save(); c.beginPath(); c.rect(pl.x, pl.y, pl.w, pl.h); c.clip();
    const band = (arr: number[], col: string, a: number) => {
      c.fillStyle = rgba(col, a);
      let start = -1;
      for (let i = i0; i <= i1 + 1; i++) {
        const on = i <= i1 && arr[i] === 1;
        if (on && start < 0) start = i;
        if (!on && start >= 0) { const xa = X(this.s0 + (start - 0.5) * ds), xb = X(this.s0 + (i - 0.5) * ds); c.fillRect(xa, pl.y, Math.max(1.5, xb - xa), pl.h); start = -1; }
      }
    };
    if (d && L.filled) band(d.filled, token("--c-warn", "#a60"), 0.2);
    if (d && L.tunnel) band(d.gap, token("--c-hint", "#63d"), 0.2);
    c.restore();

    // grid and axes
    c.font = "11px " + token("--font", "system-ui, sans-serif"); c.textBaseline = "middle";
    c.lineWidth = 1; c.strokeStyle = grid; c.fillStyle = muted; c.textAlign = "right";
    for (const t of niceTicks(lo + padY, hi - padY, Math.max(3, Math.round(pl.h / 45)))) {
      const y = Math.round(Y(t)) + 0.5;
      c.beginPath(); c.moveTo(pl.x, y); c.lineTo(pl.x + pl.w, y); c.stroke();
      c.fillText(`${de(t, 0)} m`, pl.x - 6, y);
    }
    const km = span >= 6000;
    c.textAlign = "center"; c.textBaseline = "top";
    const axisY = pl.y + pl.h + stripsH + 4;
    for (const t of niceTicks(v0 / 1000, v1 / 1000, Math.max(3, Math.round(pl.w / 90)))) {
      const x = Math.round(X(t * 1000)) + 0.5;
      c.strokeStyle = grid; c.beginPath(); c.moveTo(x, pl.y); c.lineTo(x, pl.y + pl.h); c.stroke();
      c.fillText(span < 2500 ? `${de(t, 2)} km` : km ? `${de(t, t % 1 ? 1 : 0)} km` : `${de(t, 1)} km`, x, axisY + 2);
    }
    c.strokeStyle = muted; c.strokeRect(pl.x + 0.5, pl.y + 0.5, pl.w - 1, pl.h - 1);

    c.save(); c.beginPath(); c.rect(pl.x, pl.y, pl.w, pl.h); c.clip();
    // comparison profile (P13)
    if (d && L.p13) {
      c.beginPath(); let pen = false;
      for (let i = i0; i <= i1; i += step) { const q = d.z_p13[i]; if (q === null) { pen = false; continue; } const x = X(this.s0 + i * ds), y = Y(q); if (!pen) { c.moveTo(x, y); pen = true; } else c.lineTo(x, y); }
      c.setLineDash([6, 4]); c.lineWidth = 1.4; c.strokeStyle = muted; c.stroke(); c.setLineDash([]);
    }
    // final profile
    if (L.final) {
      c.beginPath();
      for (let i = i0; i <= i1; i += step) { const x = X(this.s0 + i * ds), y = Y(p.z[i]); if (i === i0) c.moveTo(x, y); else c.lineTo(x, y); }
      c.lineJoin = "round"; c.lineWidth = 2.2; c.strokeStyle = text; c.stroke();
    }
    // raw samples per source: the opacity is the weight the estimator gave the sample
    if (d) {
      for (const s of d.sources) {
        if (!L.src[s.name]) continue;
        c.fillStyle = srcColour(s.colour);
        const pxPer = (pl.w * ds) / span, dot = pxPer < 1.5 ? 2 : pxPer < 5 ? 3 : 4, dstep = Math.max(1, Math.floor((i1 - i0) / (pl.w * 3)));
        for (let i = i0; i <= i1; i += dstep) {
          const z = s.z[i];
          if (z === null || z < lo - 5 || z > hi + 5) continue;
          const w = s.w ? s.w[i] ?? 0 : 0.7;
          c.globalAlpha = 0.1 + 0.9 * w;
          c.fillRect(X(this.s0 + i * ds) - dot / 2, Y(z) - dot / 2, dot, dot);
        }
        c.globalAlpha = 1;
      }
    }
    c.restore();

    // strips: ruggedness (grey scale) and grade (four classes)
    let sy = pl.y + pl.h + STRIP_GAP;
    const label = (t: string, y: number) => { c.font = "10px " + token("--font", "system-ui, sans-serif"); c.fillStyle = muted; c.textAlign = "right"; c.textBaseline = "middle"; c.fillText(t, pl.x - 5, y + STRIP_H / 2); };
    const group = Math.max(1, Math.floor((i1 - i0) / pl.w));          // samples per pixel column when zoomed out: the steepest / roughest one counts
    const cell = (i: number) => { const xa = Math.max(pl.x, X(this.s0 + (i - 0.5) * ds)), xb = Math.min(pl.x + pl.w, X(this.s0 + (i - 0.5 + group) * ds)); return xb > xa ? [xa, xb - xa + 0.5] : null; };
    if (L.rug && d) {
      c.fillStyle = surface2; c.fillRect(pl.x, sy, pl.w, STRIP_H);
      const base = token("--c-text", "#111");
      for (let i = i0; i <= i1; i += group) {
        let v = -1; for (let j = i; j < Math.min(i + group, p.z.length); j++) v = Math.max(v, d.rug[j] ?? -1);
        const cl = cell(i); if (v < 0 || !cl) continue;
        c.fillStyle = rgba(base, 0.08 + 0.72 * v); c.fillRect(cl[0], sy, cl[1], STRIP_H);
      }
      label("Unruhe", sy); sy += STRIP_H + STRIP_GAP;
    }
    if (L.grade) {
      const cols = GRADE_TOKENS.map((t) => token(t, "#888"));
      for (let i = i0; i <= i1; i += group) {
        let g = 0; for (let j = i; j < Math.min(i + group, p.z.length); j++) g = Math.max(g, Math.abs(this.grade[j]));
        const cl = cell(i); if (!cl) continue;
        c.fillStyle = cols[gradeClass(g)]; c.fillRect(cl[0], sy, cl[1], STRIP_H);
      }
      label("Steigung", sy); sy += STRIP_H + STRIP_GAP;
    }

    // playback cursor and hover
    const line = (s: number, col: string, w: number, dash: number[]) => {
      const x = Math.round(X(s)) + 0.5;
      if (x < pl.x || x > pl.x + pl.w) return;
      c.beginPath(); c.setLineDash(dash); c.lineWidth = w; c.strokeStyle = col; c.moveTo(x, pl.y); c.lineTo(x, pl.y + pl.h + stripsH); c.stroke(); c.setLineDash([]);
    };
    if (this.cursor !== null) {
      line(this.cursor, token("--c-accent", "#2563eb"), 2, []);
      if (this.cursor >= v0 && this.cursor <= v1) { c.fillStyle = token("--c-accent", "#2563eb"); const x = X(this.cursor); c.beginPath(); c.moveTo(x - 5, pl.y); c.lineTo(x + 5, pl.y); c.lineTo(x, pl.y + 7); c.closePath(); c.fill(); }
    }
    if (this.hover !== null) {
      line(this.hover, text, 1, [3, 3]);
      const i = this.index(this.hover), x = X(this.s0 + i * ds);
      if (x >= pl.x && x <= pl.x + pl.w) { c.beginPath(); c.arc(x, Y(p.z[i]), 4.5, 0, Math.PI * 2); c.fillStyle = token("--c-surface", "#fff"); c.fill(); c.lineWidth = 2; c.strokeStyle = text; c.stroke(); }
    }
  }
}

/** the legend entries of the sources (colour dot, name) */
export function sourceLegend(s: DiagSource): { colour: string; title: string } { return { colour: srcColour(s.colour), title: s.title }; }
