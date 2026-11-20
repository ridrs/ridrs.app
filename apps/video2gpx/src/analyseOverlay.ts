// The overlay of the Analyse stage: a canvas exactly on the picture of the video (letterbox-aware) that draws what the pipeline tracked at the current time.
// "Bewegung": road points of the vms pair (inliers green, outliers red, passing traffic the speed ignores magenta and dashed, the points of a rejected pair grey and dashed), their flow, the road area and the horizon row. "Rotation": the far features of the
// far-feature window (inliers cyan, outliers orange), the band rows and a yaw-rate arrow. Coordinates come in px of the analysis frame (360 rows).
import { de, letterbox, toPicture, type Rect } from "./analyseStats";
import type { FrameBand, InspectFrame } from "./types";
import { el } from "./util";

export const COL = { inlier: "#3ddc84", outlier: "#ff5a4d", traffic: "#ff4dd8", ignored: "#b8b8b8", farIn: "#4dd0ff", farOut: "#ffb020", horizon: "#ffe14d", band: "#7fdcff", area: "rgba(255,255,255,.55)" };
/** arrows show the flow of one frame pair (motion) or of one window of k frames (rotation) enlarged by this factor */
export const GAIN = { motion: 14, rotation: 3 };

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  private frame: InspectFrame | null = null;
  private show = { motion: false, rotation: false };
  /** a note drawn small in a corner of the picture (stale data, a running request) */
  private note = "";

  constructor(private host: HTMLElement) {
    this.canvas = el("canvas", { class: "ov-canvas", "aria-hidden": "true" });
    host.append(this.canvas);
    const ro = new ResizeObserver(() => this.draw());
    ro.observe(host);
    window.addEventListener("resize", () => this.draw());
  }
  set(frame: InspectFrame | null, motion: boolean, rotation: boolean, note = "") { this.frame = frame; this.show = { motion, rotation }; this.note = note; this.draw(); }
  hide() { this.canvas.hidden = true; }

  /** where the picture lies inside the host: the stage box (16:9) and the letterboxed media inside it */
  geometry(): { stage: Rect; pic: Rect } | null {
    const stage = this.host.querySelector<HTMLElement>(".stage");
    if (!stage) return null;
    const hr = this.host.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    if (sr.width < 2) return null;
    const media = stage.querySelector<HTMLVideoElement | HTMLImageElement>("video, img.frame");
    const mw = media instanceof HTMLVideoElement ? media.videoWidth : media instanceof HTMLImageElement ? media.naturalWidth : 0;
    const mh = media instanceof HTMLVideoElement ? media.videoHeight : media instanceof HTMLImageElement ? media.naturalHeight : 0;
    const fw = this.frame?.frame_width || 640, fh = this.frame?.frame_height || 360;
    return { stage: { x: sr.left - hr.left, y: sr.top - hr.top, w: sr.width, h: sr.height }, pic: letterbox(sr.width, sr.height, mw || fw, mh || fh) };
  }

  draw() {
    const cv = this.canvas, g = this.geometry();
    if (!g) { cv.hidden = true; return; }
    cv.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    cv.style.left = `${g.stage.x}px`; cv.style.top = `${g.stage.y}px`; cv.style.width = `${g.stage.w}px`; cv.style.height = `${g.stage.h}px`;
    if (cv.width !== Math.round(g.stage.w * dpr) || cv.height !== Math.round(g.stage.h * dpr)) { cv.width = Math.round(g.stage.w * dpr); cv.height = Math.round(g.stage.h * dpr); }
    const c = cv.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, g.stage.w, g.stage.h);
    const f = this.frame;
    c.save(); c.beginPath(); c.rect(g.pic.x, g.pic.y, g.pic.w, g.pic.h); c.clip();
    if (f && this.show.motion && f.motion && !f.motion.error) drawMotion(c, g.pic, f);
    if (f && this.show.rotation && f.rotation && !f.rotation.error) drawRotation(c, g.pic, f);
    c.restore();
    if (this.note) {
      c.font = "11px system-ui, sans-serif"; c.textBaseline = "top"; c.textAlign = "left";
      const w = c.measureText(this.note).width + 10;
      c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(g.pic.x + 6, g.pic.y + g.pic.h - 22, w, 17);
      c.fillStyle = "#fff"; c.fillText(this.note, g.pic.x + 11, g.pic.y + g.pic.h - 20);
    }
  }
}

function dot(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = col; c.fill(); }
function arrow(c: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, col: string, w: number, dash: number[] = []) {
  c.setLineDash(dash); c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x, y); c.lineTo(x + dx, y + dy); c.stroke(); c.setLineDash([]);
}
function cross(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string) {
  c.strokeStyle = col; c.lineWidth = 1.6; c.beginPath(); c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x - r, y + r); c.lineTo(x + r, y - r); c.stroke();
}
function label(c: CanvasRenderingContext2D, t: string, x: number, y: number, col: string, align: CanvasTextAlign = "left") {
  c.font = "600 11px system-ui, sans-serif"; c.textAlign = align; c.textBaseline = "bottom";
  c.lineWidth = 3; c.strokeStyle = "rgba(0,0,0,.65)"; c.strokeText(t, x, y); c.fillStyle = col; c.fillText(t, x, y);
}
const hline = (c: CanvasRenderingContext2D, pic: Rect, y: number, col: string, dash: number[], w = 1.5) => {
  c.setLineDash(dash); c.lineWidth = w; c.strokeStyle = col; c.beginPath(); c.moveTo(pic.x, y); c.lineTo(pic.x + pic.w, y); c.stroke(); c.setLineDash([]);
};

function drawMotion(c: CanvasRenderingContext2D, pic: Rect, f: InspectFrame) {
  const m = f.motion!, fw = m.width || f.frame_width, fh = m.height || f.frame_height, k = pic.w / fw;
  // the road area the speed fit looks at
  if (m.polygon.length > 2) {
    c.beginPath();
    m.polygon.forEach(([x, y], i) => { const [px, py] = toPicture(pic, fw, fh, x, y); if (i) c.lineTo(px, py); else c.moveTo(px, py); });
    c.closePath(); c.setLineDash([6, 4]); c.lineWidth = 1.3; c.strokeStyle = COL.area; c.stroke(); c.setLineDash([]);
  }
  const [, hy] = toPicture(pic, fw, fh, 0, m.horizon);
  hline(c, pic, hy, COL.horizon, [8, 5]);
  label(c, "Horizont (Bewegung)", pic.x + 6, hy - 3, COL.horizon);
  for (const [x, y, dx, dy, inl] of m.points) {                    // outliers first, so the inliers lie on top
    if (inl !== 0) continue;
    const [px, py] = toPicture(pic, fw, fh, x, y);
    arrow(c, px, py, dx * k * GAIN.motion, dy * k * GAIN.motion, COL.outlier, 1.1); dot(c, px, py, 2, COL.outlier);
  }
  for (const [x, y, dx, dy, inl] of m.points) {                    // a rejected pair (fit not good enough): every point ignored, no vehicle located
    if (inl !== 3) continue;
    const [px, py] = toPicture(pic, fw, fh, x, y);
    arrow(c, px, py, dx * k * GAIN.motion, dy * k * GAIN.motion, COL.ignored, 1.1, [4, 3]); dot(c, px, py, 2, COL.ignored);
  }
  for (const [x, y, dx, dy, inl] of m.points) {                    // passing traffic: tracked, but the speed ignores it (dashed, crossed out)
    if (inl !== 2) continue;
    const [px, py] = toPicture(pic, fw, fh, x, y);
    arrow(c, px, py, dx * k * GAIN.motion, dy * k * GAIN.motion, COL.traffic, 1.5, [4, 3]); cross(c, px, py, 3, COL.traffic);
  }
  for (const [x, y, dx, dy, inl] of m.points) {
    if (inl !== 1) continue;
    const [px, py] = toPicture(pic, fw, fh, x, y);
    arrow(c, px, py, dx * k * GAIN.motion, dy * k * GAIN.motion, COL.inlier, 1.5); dot(c, px, py, 2.4, COL.inlier);
  }
  const tr = m.traffic;
  if (tr && (tr.state === "replaced" || tr.state === "rejected"))
    label(c, tr.state === "rejected" ? "Fit ungenau: Bildpaar ignoriert (grau)" : "Verkehr erkannt: magenta ignoriert", pic.x + 6, pic.y + 18, tr.state === "rejected" ? COL.ignored : COL.traffic);
}

/** the band whose points are drawn: the one the series uses, else the first with a fit, else the widest */
export function shownBand(f: InspectFrame): FrameBand | null {
  const r = f.rotation;
  if (!r || !r.bands.length) return null;
  return r.bands[r.chosen] ?? r.bands.find((b) => b.ok) ?? r.bands[r.bands.length - 1];
}

function drawRotation(c: CanvasRenderingContext2D, pic: Rect, f: InspectFrame) {
  const r = f.rotation!, fw = r.width || f.frame_width, fh = r.height || f.frame_height, k = pic.w / fw;
  r.band_ends.forEach((e, i) => {
    const [, y] = toPicture(pic, fw, fh, 0, e);
    hline(c, pic, y, COL.band, [2, 5], 1.2);
    label(c, `Band ${i + 1}`, pic.x + pic.w - 6, y - 2, COL.band, "right");
  });
  if (r.horizon !== null && r.horizon !== undefined) {
    const [, y] = toPicture(pic, fw, fh, 0, r.horizon);
    hline(c, pic, y, COL.horizon, [3, 4], 1);
  }
  const b = shownBand(f);
  if (b) {
    for (const [x, y, dx, dy, inl] of b.points) {
      if (inl) continue;
      const [px, py] = toPicture(pic, fw, fh, x, y);
      arrow(c, px, py, dx * k * GAIN.rotation, dy * k * GAIN.rotation, COL.farOut, 1.1); dot(c, px, py, 2, COL.farOut);
    }
    for (const [x, y, dx, dy, inl] of b.points) {
      if (!inl) continue;
      const [px, py] = toPicture(pic, fw, fh, x, y);
      arrow(c, px, py, dx * k * GAIN.rotation, dy * k * GAIN.rotation, COL.farIn, 1.5); dot(c, px, py, 2.4, COL.farIn);
    }
  }
  // the yaw rate as an arrow at the top: left turn points left
  const yaw = r.yaw_deg_s;
  const cx = pic.x + pic.w / 2, ay = pic.y + 26;
  if (yaw !== null && yaw !== undefined && Number.isFinite(yaw)) {
    const len = Math.max(-pic.w * 0.35, Math.min(pic.w * 0.35, -yaw * pic.w * 0.012));       // 1 °/s = 1.2 % of the width
    c.lineCap = "round"; arrow(c, cx, ay, len, 0, COL.farIn, 4);
    const s = Math.sign(len) || 1;
    c.beginPath(); c.moveTo(cx + len, ay); c.lineTo(cx + len - s * 9, ay - 6); c.lineTo(cx + len - s * 9, ay + 6); c.closePath(); c.fillStyle = COL.farIn; c.fill(); c.lineCap = "butt";
    label(c, `Gierrate ${yaw > 0 ? "links" : yaw < 0 ? "rechts" : ""} ${de(Math.abs(yaw), 1)} °/s`, cx, ay - 8, COL.farIn, "center");
  } else {
    label(c, "kein Fernmerkmal-Fit in diesem Fenster", cx, ay, COL.farOut, "center");
  }
}
