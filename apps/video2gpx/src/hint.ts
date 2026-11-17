// Route hint files (.gpx track or route, .kml LineString / gx:Track / MultiGeometry): geometry only, timestamps are ignored.
// The pipeline parses the same files (rsm/pipeline/hints.py); this parser only draws them.
import type { Bbox } from "./types";

export type Line = [number, number][]; // [lat, lon]

export function parseHint(text: string): Line[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Die Datei ist kein gültiges XML.");
  const root = doc.documentElement.localName.toLowerCase();
  const lines: Line[] = [];
  const all = Array.from(doc.getElementsByTagName("*"));
  const kids = (e: Element, name: string) => Array.from(e.children).filter((c) => c.localName.toLowerCase() === name);
  const ok = (la: number, lo: number) => isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
  if (root === "gpx") {
    for (const e of all) {
      const n = e.localName.toLowerCase();
      if (n === "trkseg" || n === "rte") {
        const l: Line = [];
        for (const p of Array.from(e.children)) {
          const pn = p.localName.toLowerCase();
          if (pn === "trkpt" || pn === "rtept") { const la = parseFloat(p.getAttribute("lat") ?? ""), lo = parseFloat(p.getAttribute("lon") ?? ""); if (ok(la, lo)) l.push([la, lo]); }
        }
        lines.push(l);
      }
    }
  } else if (root === "kml") {
    for (const e of all) {
      const n = e.localName.toLowerCase();
      if (n === "linestring") {
        const l: Line = [];
        for (const c of kids(e, "coordinates")) for (const tok of (c.textContent ?? "").trim().split(/\s+/)) {
          const v = tok.split(",").map(parseFloat); if (v.length >= 2 && ok(v[1], v[0])) l.push([v[1], v[0]]);
        }
        lines.push(l);
      } else if (n === "track") {
        const l: Line = [];
        for (const c of kids(e, "coord")) { const v = (c.textContent ?? "").trim().split(/\s+/).map(parseFloat); if (v.length >= 2 && ok(v[1], v[0])) l.push([v[1], v[0]]); }
        lines.push(l);
      }
    }
  } else throw new Error("Nur .gpx- und .kml-Dateien werden unterstützt.");
  const res = lines.filter((l) => l.length >= 2);
  if (!res.length) throw new Error("In der Datei wurde keine Strecke gefunden (Track, Route oder Linie).");
  return res;
}

export function hintBounds(lines: Line[]): Bbox {
  let s = 90, w = 180, n = -90, e = -180;
  for (const l of lines) for (const [la, lo] of l) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  return [s, w, n, e];
}

/** a box grown by a margin in km on every side */
export function growBbox(b: Bbox, km: number): Bbox {
  const dLat = km / 111.2, dLon = km / (111.32 * Math.cos((((b[0] + b[2]) / 2) * Math.PI) / 180));
  return [b[0] - dLat, b[1] - dLon, b[2] + dLat, b[3] + dLon];
}
