// Interactive route editing (drag/drop route, start, end on the Ergebnis page): pure data & ordering helpers.
// Only type imports here: the module also runs under `node --test` (tests/routeEdit/routeEdit.test.ts).
import type { RouteDot, RouteEditState, RoutePoint } from "./types";

export const emptyEdit = (): RouteEditState => ({ start: null, end: null, vias: [] });

export const isRouteEdited = (st: RouteEditState | null | undefined): boolean =>
  !!st && (st.start !== null || st.end !== null || st.vias.length > 0);

const okCoord = (x: unknown): x is { lat: number; lon: number } =>
  !!x && typeof x === "object" && typeof (x as any).lat === "number" && typeof (x as any).lon === "number" &&
  isFinite((x as any).lat) && isFinite((x as any).lon) &&
  (x as any).lat >= -90 && (x as any).lat <= 90 && (x as any).lon >= -180 && (x as any).lon <= 180;

const normDot = (x: unknown, keepS = false): RouteDot | null => {
  if (!okCoord(x)) return null;
  const out: RouteDot = { lat: Number((x as any).lat), lon: Number((x as any).lon) };
  if (keepS && typeof (x as any).orig_s === "number" && isFinite((x as any).orig_s)) out.orig_s = Number((x as any).orig_s);
  return out;
};

/** Normalize a stored/returned reroute spec into a clean RouteEditState. */
export function normalizeEdit(raw: unknown): RouteEditState {
  if (!raw || typeof raw !== "object") return emptyEdit();
  const o = raw as Record<string, unknown>;
  const vias = Array.isArray(o.vias) ? o.vias.map((v) => normDot(v, true)).filter((v): v is RouteDot => v !== null) : [];
  return { start: normDot(o.start), end: normDot(o.end), vias };
}

/** Approximate distance^2 in local equirectangular metres^2 between two WGS84 points. */
function dist2M(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cos = Math.cos(((aLat + bLat) * Math.PI) / 360);
  const dy = (aLat - bLat) * 111195;
  const dx = (aLon - bLon) * 111195 * cos;
  return dx * dx + dy * dy;
}

/** Arc length (m) of the nearest point on `pts` to (lat, lon). Falls back to index if `arc_m` is missing. */
export function nearestArc(pts: RoutePoint[], lat: number, lon: number): number {
  if (!pts.length) return 0;
  let bestI = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist2M(lat, lon, pts[i].lat, pts[i].lon);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return pts[bestI].arc_m ?? bestI;
}

/** Insert a newly dragged via-dot into `vias` at the right sequential position along the current route `pts`.
 *  `dragArcM` is the arc_m on the current route where the user started dragging the route line. */
export function insertVia(vias: RouteDot[], dot: RouteDot, dragArcM: number, pts: RoutePoint[]): RouteDot[] {
  if (!vias.length) return [dot];
  // Order existing vias by their current position along `pts` so the new via lands strictly between its neighbours
  const arcs = vias.map((v) => nearestArc(pts, v.lat, v.lon));
  let idx = vias.length;
  for (let i = 0; i < arcs.length; i++) {
    if (dragArcM < arcs[i]) { idx = i; break; }
  }
  const out = vias.slice();
  out.splice(idx, 0, dot);
  return out;
}

/** Move an existing via-dot (keeps its sequential position in the route). */
export function moveVia(vias: RouteDot[], index: number, lat: number, lon: number): RouteDot[] {
  if (index < 0 || index >= vias.length) return vias.slice();
  return vias.map((v, i) => (i === index ? { ...v, lat, lon } : v));
}

/** Remove an existing via-dot by index. */
export const removeVia = (vias: RouteDot[], index: number): RouteDot[] => vias.filter((_, i) => i !== index);
