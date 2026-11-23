// Interactive route drag/drop on the Ergebnis stage:
// - Drag the route line onto another street/path to add a via-dot (no fixed timestamp; timeline is re-fitted).
// - Drag Start or Ende dots to move the beginning or end of the route.
// - Drag existing via-dots to adjust them, right-click (or use the chip ×) to remove them, or reset to the original route.
import L from "leaflet";
import { api } from "./api";
import { currentRoute } from "./app/router";
import { active, loadResult } from "./features/run";
import { getMap, isRouteVisible } from "./mapPanel";
import { emptyEdit, insertVia, isRouteEdited, moveVia, normalizeEdit, removeVia } from "./routeEdit";
import { S, bus, toast } from "./state";
import type { RouteEditState, RoutePoint } from "./types";
import { btn } from "./ui/components";
import { el, nearestPoint } from "./util";

const DRAG_THRESHOLD_PX = 6;
const ROUTE_HIT_PX = 16;
const HANDLE_AVOID_PX = 15;

let barEl: HTMLElement, statusEl: HTMLElement, chipsEl: HTMLElement, resetBtn: HTMLButtonElement;
let layer: L.LayerGroup | null = null;
let hoverMarker: L.Marker | null = null;
let rubberLine: L.Polyline | null = null;
let dragMarker: L.Marker | null = null;

let busy = false;
let suppressClick = false;
let stage: string | null = null;
let hoverPt: RoutePoint | null = null;
let pending: { x: number; y: number; origin: RoutePoint } | null = null;
let draggingRoute = false;

const currentEdit = (): RouteEditState => normalizeEdit(S.result?.reroute);

const onErgebnis = (): boolean => {
  if (stage === "ergebnis") return true;
  const r = currentRoute();
  return r.view === "project" && r.stage === "ergebnis";
};

const canEdit = (): boolean => {
  const map = getMap();
  if (!map || !S.cur || !S.result || !onErgebnis() || !isRouteVisible()) return false;
  if (busy || S.run.running || !!active.project) return false;
  if (map.getContainer().classList.contains("drawing")) return false;
  return S.result.points.length >= 2;
};

const metersPerPixel = (map: L.Map): number =>
  (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (256 * Math.pow(2, map.getZoom()));

function handleIcon(kind: "start" | "end" | "via" | "hover" | "drag", label = ""): L.DivIcon {
  const size = kind === "hover" ? 16 : 20;
  return L.divIcon({
    className: `re-handle re-${kind}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<span class="re-dot">${label}</span>`,
  });
}

export function mountRouteEditor(container: HTMLElement) {
  statusEl = el("span", { class: "small muted" });
  chipsEl = el("div", { class: "row wrap re-chips" });
  resetBtn = btn("Route zurücksetzen", () => void resetEdit(), { size: "sm" });
  resetBtn.hidden = true;
  barEl = el("div", { class: "re-bar adjust-sec row wrap between" },
    el("div", { class: "row wrap re-left" }, el("span", { class: "label" }, "Strecke auf Karte"), statusEl, chipsEl),
    resetBtn);
  container.prepend(barEl);

  bus.on("stage", (s: string | null) => {
    stage = s;
    cancelRouteDrag();
    sync();
  });
  for (const ev of ["project", "result", "run"]) {
    bus.on(ev, () => {
      cancelRouteDrag();
      sync();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (pending || draggingRoute)) cancelRouteDrag();
  });
  queueMicrotask(() => initMap());
}

function initMap() {
  const map = getMap();
  if (!map) { setTimeout(initMap, 200); return; }
  layer = L.layerGroup().addTo(map);
  const c = map.getContainer();

  // Suppress mapPanel's click-to-seek right after a route drag finishes
  c.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); }
  }, true);

  map.on("mousemove", (e: L.LeafletMouseEvent) => {
    if (pending || draggingRoute) return;
    if (!canEdit()) { clearHover(); return; }
    const pts = S.result!.points;
    const hit = hitRoute(map, pts, e.latlng);
    if (hit) {
      hoverPt = hit;
      if (!hoverMarker) {
        hoverMarker = L.marker([hit.lat, hit.lon], { icon: handleIcon("hover"), interactive: false, zIndexOffset: 880 }).addTo(map);
      } else {
        hoverMarker.setLatLng([hit.lat, hit.lon]);
      }
      c.classList.add("route-grab");
    } else {
      clearHover();
    }
  });

  map.on("mouseout", () => {
    if (!pending && !draggingRoute) clearHover();
  });

  map.on("mousedown", (e: L.LeafletMouseEvent) => {
    if (e.originalEvent.button !== 0 || !canEdit()) return;
    // Ignore mousedown on an existing draggable handle marker (Leaflet handles those directly)
    if ((e.originalEvent.target as HTMLElement | null)?.closest(".re-handle")) return;
    const pts = S.result!.points;
    const hit = hoverPt ?? hitRoute(map, pts, e.latlng);
    if (!hit) return;
    pending = { x: e.originalEvent.clientX, y: e.originalEvent.clientY, origin: hit };
    map.dragging.disable();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!pending) return;
    const dx = e.clientX - pending.x, dy = e.clientY - pending.y;
    if (!draggingRoute) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      draggingRoute = true;
      clearHover();
      c.classList.add("route-dragging");
      const ll = map.mouseEventToLatLng(e);
      rubberLine = L.polyline([[pending.origin.lat, pending.origin.lon], [ll.lat, ll.lng]], {
        color: "#2563eb", weight: 3, dashArray: "6 6", opacity: 0.9, interactive: false,
      }).addTo(map);
      dragMarker = L.marker(ll, { icon: handleIcon("drag"), interactive: false, zIndexOffset: 960 }).addTo(map);
    } else {
      const ll = map.mouseEventToLatLng(e);
      rubberLine?.setLatLngs([[pending.origin.lat, pending.origin.lon], [ll.lat, ll.lng]]);
      dragMarker?.setLatLng(ll);
    }
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    if (!pending) return;
    const origin = pending.origin;
    const wasDrag = draggingRoute;
    pending = null;
    draggingRoute = false;
    map.dragging.enable();
    c.classList.remove("route-dragging");
    rubberLine?.remove(); rubberLine = null;
    dragMarker?.remove(); dragMarker = null;
    if (!wasDrag || !canEdit() || !S.result) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const ll = map.mouseEventToLatLng(e);
    const pts = S.result.points;
    const cur = currentEdit();
    const dragArc = origin.arc_m ?? pts.indexOf(origin);
    const next: RouteEditState = {
      ...cur,
      vias: insertVia(cur.vias, { lat: ll.lat, lon: ll.lng, orig_s: origin.arc_m }, dragArc, pts),
    };
    void applyEdit(next);
  });

  sync();
}

/** Check if `latlng` is within ROUTE_HIT_PX of the route and not too close to an existing Start/Ende/Via handle. */
function hitRoute(map: L.Map, pts: RoutePoint[], latlng: L.LatLng): RoutePoint | null {
  const { p, dM } = nearestPoint(pts, latlng.lat, latlng.lng);
  const dPx = dM / metersPerPixel(map);
  if (dPx > ROUTE_HIT_PX) return null;
  const ptPx = map.latLngToContainerPoint(latlng);
  const cur = currentEdit();
  const avoid: [number, number][] = [
    [pts[0].lat, pts[0].lon],
    [pts[pts.length - 1].lat, pts[pts.length - 1].lon],
    ...cur.vias.map((v) => [v.lat, v.lon] as [number, number]),
  ];
  for (const [la, lo] of avoid) {
    const hp = map.latLngToContainerPoint([la, lo]);
    if (ptPx.distanceTo(hp) < HANDLE_AVOID_PX) return null;
  }
  return p;
}

function clearHover() {
  hoverPt = null;
  hoverMarker?.remove();
  hoverMarker = null;
  getMap()?.getContainer().classList.remove("route-grab");
}

function cancelRouteDrag() {
  const map = getMap();
  if (pending || draggingRoute) {
    pending = null;
    draggingRoute = false;
    map?.dragging.enable();
    map?.getContainer().classList.remove("route-dragging");
  }
  rubberLine?.remove(); rubberLine = null;
  dragMarker?.remove(); dragMarker = null;
  clearHover();
}

function sync() {
  renderBar();
  drawHandles();
}

function renderBar() {
  if (!barEl) return;
  const show = !!S.cur && !!S.result && onErgebnis() && isRouteVisible();
  barEl.hidden = !show;
  if (!show) return;
  const ed = currentEdit();
  const edited = isRouteEdited(ed);
  chipsEl.replaceChildren();
  if (busy) {
    statusEl.textContent = "Route & Zeitleiste werden neu berechnet …";
    resetBtn.hidden = true;
    return;
  }
  if (!edited) {
    statusEl.textContent = "Tipp: Route, Start oder Ende auf der Karte ziehen, um die Strecke anzupassen.";
    resetBtn.hidden = true;
    return;
  }
  statusEl.textContent = "Angepasste Route:";
  const mkChip = (label: string, title: string, onRemove: () => void) =>
    el("span", { class: "chip hint re-chip" }, label,
      el("button", { type: "button", class: "re-chip-x", title, "aria-label": title, onclick: () => { if (!busy) onRemove(); } }, "×"));
  if (ed.start) chipsEl.append(mkChip("Start", "Start auf ursprünglichen Punkt zurücksetzen", () => void applyEdit({ ...ed, start: null })));
  ed.vias.forEach((_, i) => {
    chipsEl.append(mkChip(`Wegpunkt ${i + 1}`, `Wegpunkt ${i + 1} entfernen`, () => void applyEdit({ ...ed, vias: removeVia(ed.vias, i) })));
  });
  if (ed.end) chipsEl.append(mkChip("Ende", "Ende auf ursprünglichen Punkt zurücksetzen", () => void applyEdit({ ...ed, end: null })));
  resetBtn.hidden = false;
  resetBtn.disabled = busy;
}

function drawHandles() {
  if (!layer) return;
  layer.clearLayers();
  clearHover();
  if (!canEdit() || !S.result) return;
  const pts = S.result.points;
  const ed = currentEdit();

  // Draggable Start handle
  const startM = L.marker([pts[0].lat, pts[0].lon], {
    draggable: true, icon: handleIcon("start"), zIndexOffset: 910,
  }).bindTooltip("Start ziehen, um den Beginn zu verschieben", { direction: "top", offset: [0, -10] }).addTo(layer);
  startM.on("dragend", () => {
    const ll = startM.getLatLng();
    void applyEdit({ ...currentEdit(), start: { lat: ll.lat, lon: ll.lng } });
  });

  // Draggable Ende handle
  const last = pts[pts.length - 1];
  const endM = L.marker([last.lat, last.lon], {
    draggable: true, icon: handleIcon("end"), zIndexOffset: 910,
  }).bindTooltip("Ende ziehen, um das Ende zu verschieben", { direction: "top", offset: [0, -10] }).addTo(layer);
  endM.on("dragend", () => {
    const ll = endM.getLatLng();
    void applyEdit({ ...currentEdit(), end: { lat: ll.lat, lon: ll.lng } });
  });

  // Draggable Via-dots
  ed.vias.forEach((v, i) => {
    const m = L.marker([v.lat, v.lon], {
      draggable: true, icon: handleIcon("via", String(i + 1)), zIndexOffset: 930,
    }).bindTooltip(`Wegpunkt ${i + 1} ziehen · Rechtsklick zum Entfernen`, { direction: "top", offset: [0, -10] }).addTo(layer!);
    m.on("dragend", () => {
      const ll = m.getLatLng();
      void applyEdit({ ...currentEdit(), vias: moveVia(currentEdit().vias, i, ll.lat, ll.lng) });
    });
    m.on("contextmenu", (ev: L.LeafletMouseEvent) => {
      L.DomEvent.preventDefault(ev.originalEvent);
      L.DomEvent.stopPropagation(ev);
      const next = { ...currentEdit(), vias: removeVia(currentEdit().vias, i) };
      void applyEdit(next);
    });
  });
}

async function applyEdit(next: RouteEditState) {
  const id = S.cur?.app.id;
  if (!id || busy) return;
  if (!isRouteEdited(next)) {
    await resetEdit();
    return;
  }
  busy = true;
  sync();
  try {
    const res = await api.pipelineReroute(id, next, false);
    if (S.cur?.app.id !== id) return;
    await loadResult(true);
    toast(`Route angepasst (${res.path_km.toFixed(2).replace(".", ",")} km, ${res.seconds.toFixed(1).replace(".", ",")} s).`);
  } catch (e) {
    toast(`Route konnte nicht angepasst werden: ${e instanceof Error ? e.message : e}`, "error");
    drawHandles();
  } finally {
    busy = false;
    sync();
  }
}

async function resetEdit() {
  const id = S.cur?.app.id;
  if (!id || busy) return;
  busy = true;
  sync();
  try {
    await api.pipelineReroute(id, emptyEdit(), true);
    if (S.cur?.app.id !== id) return;
    await loadResult(true);
    toast("Ursprüngliche Route wiederhergestellt.");
  } catch (e) {
    toast(`Zurücksetzen fehlgeschlagen: ${e instanceof Error ? e.message : e}`, "error");
  } finally {
    busy = false;
    sync();
  }
}
