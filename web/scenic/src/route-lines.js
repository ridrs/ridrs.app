// SPDX-License-Identifier: AGPL-3.0-or-later
// The route lines of the overview maps ({id: delta line}, site/lib/lines.js): the build's lines (scripts/build.mjs, from the export)
// with the lines set in the admin laid over them. Shared by the public lines.json (visible videos, src/worker.js) and the admin's
// map (every video, src/admin.js).
import { encodeLine } from '../site/lib/lines.js';

/**
 * `built` is the build's lines.json; `where` an SQL condition on `video v` that picks the videos. A manual route (set by hand or taken
 * from an uploaded video2gpx track: manual_field 'route') replaces the build's line; an uploaded video2gpx track gives a line to a
 * video that has none.
 */
export async function routeLines(env, built, where = '1') {
  const [{ results: ids }, { results: manual }] = await Promise.all([
    env.DB.prepare(`SELECT v.video_id FROM video v WHERE ${where}`).all(),
    env.DB.prepare(`SELECT r.video_id, r.polyline FROM route r JOIN video v ON v.video_id = r.video_id
      JOIN manual_field m ON m.video_id = r.video_id AND m.field = 'route' WHERE r.polyline IS NOT NULL AND ${where}`).all()]);
  const out = {};
  for (const { video_id: id } of ids) if (built[id]) out[id] = built[id];
  for (const { video_id: id, polyline } of manual) {
    const line = encodeLine(JSON.parse(polyline).map(([la, lo]) => [lo, la]));
    if (line) out[id] = line;
  }
  // uploaded tracks are up to 1.5 MB each: only the ones of videos still without a line are read
  const { results: uploaded } = await env.DB.prepare(`SELECT t.video_id FROM sync_track t JOIN route_sync s ON s.video_id = t.video_id AND s.method = 'video2gpx'
    JOIN video v ON v.video_id = t.video_id WHERE ${where}`).all();
  const missing = uploaded.map((r) => r.video_id).filter((id) => !out[id]);
  const tracks = await Promise.all(missing.map((id) => env.DB.prepare('SELECT json FROM sync_track WHERE video_id = ?1').bind(id).first('json')));
  missing.forEach((id, i) => { const line = tracks[i] && encodeLine(JSON.parse(tracks[i]).c); if (line) out[id] = line; });
  return out;
}
