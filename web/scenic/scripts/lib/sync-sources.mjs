// SPDX-License-Identifier: AGPL-3.0-or-later
// Time-synced tracks (concept 2.7) that already exist elsewhere in Ridrs.
// For now: the video2gpx tracks of the Ridrs catalogue (catalog-web/dist), matched by YouTube id.
// Each track is {t: [video seconds], c: [[lon, lat], …]}, the format catalog-web's player uses.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function loadSyncTracks(ridrsRoot) {
  const catalog = join(ridrsRoot, 'catalog-web/dist');
  const routesFile = join(catalog, 'data/routes.json');
  if (!existsSync(routesFile)) return [];
  const out = [];
  for (const e of JSON.parse(readFileSync(routesFile, 'utf8'))) {
    if (!e.youtube?.id || !e.youtube?.track) continue;
    const file = join(catalog, e.youtube.track);
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf8');
    const track = JSON.parse(raw);
    if (!track.t?.length || track.t.length !== track.c?.length) continue;
    out.push({
      videoId: e.youtube.id,
      method: e.id.startsWith('v2g-') ? 'video2gpx' : 'other',
      raw,
      tStart: Math.round(track.t[0]),
      tEnd: Math.round(track.t.at(-1)),
      hash: createHash('sha1').update(raw).digest('hex').slice(0, 16),
    });
  }
  return out;
}
