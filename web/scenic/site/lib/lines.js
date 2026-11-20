// SPDX-License-Identifier: AGPL-3.0-or-later
// Route lines of the overview map (lines.json: {id: [lon0, lat0, dlon, dlat, …]} in 1e-5 degrees). Shared by scripts/build.mjs (the
// lines of the export), src/worker.js (the lines set in the admin) and site/app.js (decoding). The dialog keeps the full line.

/** Douglas–Peucker tolerance in degrees (~30 m): enough for the overview, small enough to keep hairpins readable. */
export const TOL = 0.0003;

/** The points of [[lon, lat], …] that stay within TOL of the simplified line (Douglas–Peucker, ends always kept). */
export function simplify(pts, tol = TOL) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], k = Math.cos((ay * Math.PI) / 180);
    const dx = (bx - ax) * k, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const px = (pts[i][0] - ax) * k, py = pts[i][1] - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** [[lon, lat], …] → the simplified line, delta-encoded in 1e-5 degrees; null below two points. */
export function encodeLine(lonLat) {
  if (!Array.isArray(lonLat) || lonLat.length < 2) return null;
  const flat = []; let px = 0, py = 0;
  for (const [lo, la] of simplify(lonLat)) { const x = Math.round(lo * 1e5), y = Math.round(la * 1e5); flat.push(x - px, y - py); px = x; py = y; }
  return flat;
}

/** The encoded line back to [[lon, lat], …]. */
export function decodeLine(flat) {
  const c = []; let x = 0, y = 0;
  for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; c.push([x / 1e5, y / 1e5]); }
  return c;
}
