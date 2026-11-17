// Map frames drawn by the user: search frame (blue), start frame (green, "Start"), end frame (red, "Ende").
// Own small Leaflet implementation: draw with a drag, move by dragging the frame, resize with the corner handles, delete with the ✕ handle.
import L from "leaflet";
import type { Bbox } from "./types";

export type FrameKind = "search" | "start" | "end";
export const FRAME_STYLE: Record<FrameKind, { color: string; fill: number; label: string }> = {
  search: { color: "#2563eb", fill: 0.07, label: "Suchrahmen" },
  start: { color: "#1f8a4c", fill: 0.18, label: "Start" },
  end: { color: "#d9363e", fill: 0.18, label: "Ende" },
};
const MIN_DEG = 0.0004; // about 40 m: smaller drags are ignored (a click is not a frame)

export interface FrameHooks {
  /** the frame changed by the user (null = deleted) */
  onChange(kind: FrameKind, b: Bbox | null): void;
  /** frames are locked while a job runs */
  locked(): boolean;
  /** bounds a frame must stay inside (start and end inside the search frame), or null */
  limit(kind: FrameKind): Bbox | null;
}

export const clampMove = (b: Bbox, lim: Bbox | null): Bbox => {
  if (!lim) return b;
  const h = b[2] - b[0], w = b[3] - b[1];
  let s = Math.min(Math.max(b[0], lim[0]), lim[2] - h), west = Math.min(Math.max(b[1], lim[1]), lim[3] - w);
  if (h > lim[2] - lim[0]) s = lim[0];
  if (w > lim[3] - lim[1]) west = lim[1];
  return [s, west, Math.min(s + h, lim[2]), Math.min(west + w, lim[3])];
};

/** corners clamped into the limit (resize and draw) */
export const clampBox = (b: Bbox, lim: Bbox | null): Bbox =>
  lim ? [Math.max(b[0], lim[0]), Math.max(b[1], lim[1]), Math.min(b[2], lim[2]), Math.min(b[3], lim[3])] : b;

export const normBox = (la1: number, lo1: number, la2: number, lo2: number): Bbox => [Math.min(la1, la2), Math.min(lo1, lo2), Math.max(la1, la2), Math.max(lo1, lo2)];

interface Entry { kind: FrameKind; box: Bbox; rect: L.Rectangle; handles: L.Marker[]; del: L.Marker | null }

export class FrameEditor {
  private entries: Partial<Record<FrameKind, Entry>> = {};
  private renderer: L.SVG;
  private drawing: FrameKind | null = null;
  private tmp: L.Rectangle | null = null;
  private anchor: L.LatLng | null = null;
  onDrawEnd: () => void = () => {};

  constructor(private map: L.Map, private hooks: FrameHooks) {
    this.renderer = L.svg({ padding: 0.5 });
    this.renderer.addTo(map);
    map.on("mousedown", (e: L.LeafletMouseEvent) => this.down(e));
    map.on("mousemove", (e: L.LeafletMouseEvent) => this.move(e));
    document.addEventListener("mouseup", (e) => this.up(e));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.drawing) this.cancelDraw(); });
  }

  get activeTool(): FrameKind | null { return this.drawing; }

  startDraw(kind: FrameKind) {
    if (this.hooks.locked()) return;
    this.cancelDraw();
    this.drawing = kind;
    this.map.dragging.disable();
    this.map.getContainer().classList.add("drawing");
  }

  cancelDraw() {
    const had = this.drawing;
    this.drawing = null; this.anchor = null;
    this.tmp?.remove(); this.tmp = null;
    this.map.dragging.enable();
    this.map.getContainer().classList.remove("drawing");
    if (had) this.onDrawEnd();
  }

  private down(e: L.LeafletMouseEvent) {
    if (!this.drawing) return;
    this.anchor = e.latlng;
    const st = FRAME_STYLE[this.drawing];
    this.tmp = L.rectangle([[e.latlng.lat, e.latlng.lng], [e.latlng.lat, e.latlng.lng]], { renderer: this.renderer, color: st.color, weight: 2, fillOpacity: st.fill, interactive: false }).addTo(this.map);
  }

  private move(e: L.LeafletMouseEvent) {
    if (!this.drawing || !this.anchor || !this.tmp) return;
    const b = clampBox(normBox(this.anchor.lat, this.anchor.lng, e.latlng.lat, e.latlng.lng), this.hooks.limit(this.drawing));
    this.tmp.setBounds([[b[0], b[1]], [b[2], b[3]]]);
  }

  private up(e: MouseEvent) {
    if (!this.drawing || !this.anchor || !this.tmp) return;
    const kind = this.drawing;
    const ll = this.map.mouseEventToLatLng(e);
    const b = clampBox(normBox(this.anchor.lat, this.anchor.lng, ll.lat, ll.lng), this.hooks.limit(kind));
    this.cancelDraw();
    if (b[2] - b[0] >= MIN_DEG && b[3] - b[1] >= MIN_DEG) this.hooks.onChange(kind, b);
  }

  /** (re)draw a frame; null removes it. `locked` frames are dashed and not editable. */
  set(kind: FrameKind, box: Bbox | null, size = "") {
    const old = this.entries[kind];
    const hadFocus = !!old && document.activeElement === old.rect.getElement();
    if (old) { old.rect.remove(); old.handles.forEach((h) => h.remove()); old.del?.remove(); delete this.entries[kind]; }
    if (!box) return;
    const locked = this.hooks.locked();
    const st = FRAME_STYLE[kind];
    const rect = L.rectangle([[box[0], box[1]], [box[2], box[3]]], {
      renderer: this.renderer, color: st.color, weight: kind === "search" ? 2.5 : 2.5, fillOpacity: locked ? 0.03 : st.fill, dashArray: locked ? "7 6" : undefined, interactive: !locked,
      className: `frame frame-${kind}`,
    }).addTo(this.map);
    if (kind !== "search") rect.bindTooltip(st.label, { permanent: true, direction: "center", className: `frame-label frame-label-${kind}` });
    const entry: Entry = { kind, box, rect, handles: [], del: null };
    this.entries[kind] = entry;
    if (!locked) this.enable(entry);
    // keyboard: the frame is focusable; arrows move it by 5 % of its size, Shift+arrows resize, Delete removes
    const node = rect.getElement() as SVGElement | undefined;
    if (node && !locked) {
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "group");
      node.setAttribute("aria-label", `${kind === "search" ? "Suchrahmen" : st.label + "rahmen"}${size ? ", " + size : ""}. Pfeiltasten verschieben, Umschalt und Pfeiltasten ändern die Größe, Entf löscht.`);
      node.addEventListener("keydown", (e) => this.key(kind, e as KeyboardEvent));
      if (hadFocus) node.focus();
    }
    // start / end frames above the search frame
    if (kind !== "search") rect.bringToFront();
  }

  focus(kind: FrameKind) { (this.entries[kind]?.rect.getElement() as SVGElement | undefined)?.focus(); }

  private key(kind: FrameKind, e: KeyboardEvent) {
    const en = this.entries[kind];
    if (!en || this.hooks.locked()) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.hooks.onChange(kind, null); return; }
    const d: Record<string, [number, number]> = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault(); e.stopPropagation();
    const b = en.box, dLat = (b[2] - b[0]) * 0.05 * v[0], dLon = (b[3] - b[1]) * 0.05 * v[1], lim = this.hooks.limit(kind);
    // Shift: the north and east edges move (grow or shrink); else the whole frame moves
    const next: Bbox = e.shiftKey ? clampBox([b[0], b[1], b[2] + dLat, b[3] + dLon], lim) : clampMove([b[0] + dLat, b[1] + dLon, b[2] + dLat, b[3] + dLon], lim);
    if (next[2] - next[0] < MIN_DEG || next[3] - next[1] < MIN_DEG) return;
    this.commit(kind, next);
  }

  private corner(box: Bbox, i: number): [number, number] {
    return [[box[0], box[1]], [box[0], box[3]], [box[2], box[3]], [box[2], box[1]]][i] as [number, number]; // SW SE NE NW
  }

  private enable(en: Entry) {
    const { kind, rect } = en;
    const icon = L.divIcon({ className: `frame-handle frame-handle-${kind}`, iconSize: [28, 28], iconAnchor: [14, 14] });
    for (let i = 0; i < 4; i++) {
      const m = L.marker(this.corner(en.box, i), { icon, draggable: true, zIndexOffset: 800, keyboard: false }).addTo(this.map);
      m.on("drag", () => {
        const opp = this.corner(en.box, (i + 2) % 4), p = m.getLatLng();
        const b = clampBox(normBox(opp[0], opp[1], p.lat, p.lng), this.hooks.limit(kind));
        rect.setBounds([[b[0], b[1]], [b[2], b[3]]]);
        this.placeHandles(en, b, i);
      });
      m.on("dragend", () => {
        const bb = rect.getBounds();
        this.commit(kind, [bb.getSouth(), bb.getWest(), bb.getNorth(), bb.getEast()]);
      });
      en.handles.push(m);
    }
    en.del = L.marker(this.deletePos(en.box), { icon: L.divIcon({ className: `frame-del frame-del-${kind}`, html: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>', iconSize: [28, 28], iconAnchor: [-2, 30] }), zIndexOffset: 900, keyboard: false, title: `${FRAME_STYLE[kind].label} löschen` }).addTo(this.map);
    en.del.on("click", (e) => { L.DomEvent.stopPropagation(e); this.hooks.onChange(kind, null); });
    // move by dragging the frame itself
    let start: L.LatLng | null = null, origin: Bbox | null = null;
    rect.on("mousedown", (e: L.LeafletMouseEvent) => {
      if (this.drawing) return;
      L.DomEvent.stop(e.originalEvent);
      start = e.latlng; origin = en.box; this.map.dragging.disable();
      const mv = (ev: L.LeafletMouseEvent) => {
        if (!start || !origin) return;
        const dLat = ev.latlng.lat - start.lat, dLon = ev.latlng.lng - start.lng;
        const b = clampMove([origin[0] + dLat, origin[1] + dLon, origin[2] + dLat, origin[3] + dLon], this.hooks.limit(kind));
        rect.setBounds([[b[0], b[1]], [b[2], b[3]]]);
        this.placeHandles(en, b);
      };
      const end = () => {
        this.map.off("mousemove", mv); document.removeEventListener("mouseup", end);
        this.map.dragging.enable();
        if (!start) return;
        start = null; origin = null;
        const bb = rect.getBounds();
        this.commit(kind, [bb.getSouth(), bb.getWest(), bb.getNorth(), bb.getEast()]);
      };
      this.map.on("mousemove", mv); document.addEventListener("mouseup", end);
    });
  }

  private commit(kind: FrameKind, b: Bbox) {
    const en = this.entries[kind];
    if (en) en.box = b;
    this.hooks.onChange(kind, b);
  }

  private deletePos(b: Bbox): [number, number] { return [b[2], b[3]]; }

  private placeHandles(en: Entry, b: Bbox, skip = -1) {
    en.handles.forEach((h, i) => { if (i !== skip) h.setLatLng(this.corner(b, i)); });
    en.del?.setLatLng(this.deletePos(b));
  }

  fit(box: Bbox, pad = 30) {
    this.map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { animate: false, padding: [pad, pad] });
  }
}
