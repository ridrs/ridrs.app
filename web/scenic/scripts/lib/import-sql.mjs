// SPDX-License-Identifier: AGPL-3.0-or-later
// SQL of the import (scripts/import.mjs): ../export -> D1 upserts. Pure, so test/import.test.mjs can run it
// against the migrations in node:sqlite.
//
// "Manual fields always win" (CLOUDFLARE-KONZEPT.md 3.5, 4.3): the import never writes
//   - editorial fields: stars, editor_note, editors_pick, hidden (not in the upsert at all),
//   - video columns with a manual_field row (MANUAL_VIDEO_COLS: place, region, pin, country): new videos get
//     the export's values on INSERT; existing ones are updated per column from a scratch table, skipping manual ones,
//   - a route, localization or sync row whose video has manual_field 'route', 'localization' or 'sync'
//     (manual route, discarded route, anchors, Prüfmodus result),
//   - a localization a person verified (verified_at set).

/** Video columns the admin can edit and the export also sets. */
export const MANUAL_VIDEO_COLS = ['place', 'region', 'lat', 'lon', 'position_exact', 'country', 'country_name'];

export const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'object') v = JSON.stringify(v);
  return `'${String(v).replaceAll("'", "''")}'`;
};
const notManual = (field, id = 'excluded.video_id') => `NOT EXISTS (SELECT 1 FROM manual_field m WHERE m.video_id = ${id} AND m.field = '${field}')`;
/** INSERT … ON CONFLICT DO UPDATE. `keep`: columns written on INSERT only. `guard`: manual_field that blocks insert and update. */
export const upsert = (table, key, row, { keep = [], guard = null } = {}) => {
  const cols = Object.keys(row);
  const set = cols.filter((c) => c !== key && !keep.includes(c)).map((c) => `${c}=excluded.${c}`).join(', ');
  const vals = cols.map((c) => q(row[c])).join(', ');
  if (!guard) return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals}) ON CONFLICT(${key}) DO UPDATE SET ${set};`;
  return `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${vals} WHERE ${notManual(guard, q(row[key]))} ON CONFLICT(${key}) DO UPDATE SET ${set};`;
};

/**
 * @param {{videos: object[], yt: Map<string, object>, sync: Map<string, object>, today: string, at?: string}} o
 * @returns {{sql: string[], routes: number, channels: number, countries: Map<string|null, number>}}
 */
export function buildImportSql({ videos, yt, sync, today, at = new Date().toISOString() }) {
  const sql = [];
  const channels = new Map();
  for (const s of yt.values()) {
    if (s.channel_id) channels.set(s.channel_id, { channel_id: s.channel_id, name: s.channel_title, country: s.channel_country, api_fetched_at: s.fetched_at });
  }
  for (const c of channels.values()) sql.push(upsert('channel', 'channel_id', c));
  // Videos the YouTube snapshot does not cover yet still reference their channel: insert a bare row, never overwrite.
  for (const id of new Set(videos.map((v) => v.channel_id).filter((id) => id && !channels.has(id)))) {
    sql.push(`INSERT INTO channel (channel_id) VALUES (${q(id)}) ON CONFLICT(channel_id) DO NOTHING;`);
  }

  let routes = 0;
  const countries = new Map();
  for (const v of videos) {
    const a = yt.get(v.video_id) || {};
    countries.set(v.country ?? null, (countries.get(v.country ?? null) ?? 0) + 1);
    sql.push(upsert('video', 'video_id', {
      video_id: v.video_id, channel_id: a.channel_id || v.channel_id,
      title: a.title, published_at: a.published_at, duration_s: a.duration_s, view_count: a.view_count, like_count: a.like_count,
      definition: a.definition, projection: a.projection, embeddable: a.embeddable, region_blocked: a.region_blocked,
      region_allowed: a.region_allowed, audio_language: a.audio_language, status: a.status, api_fetched_at: a.fetched_at,
      region: v.region, place: v.place, lat: v.lat, lon: v.lon, position_exact: v.position_exact,
      country: v.country ?? null, country_name: v.country_name ?? null,
      footage: v.footage, footage_source: v.footage_source, vehicle: v.vehicle, topics: v.topics,
      added_at: today, updated_at: today,
    }, { keep: ['added_at', ...MANUAL_VIDEO_COLS] })); // keep the first import date; manual columns: see below
    if (v.tech) {
      sql.push(upsert('video_tech', 'video_id', {
        video_id: v.video_id, max_height: v.tech.max_height, max_width: v.tech.max_width, fps: v.tech.fps, hdr: v.tech.hdr,
        codecs: v.tech.codecs, bitrate_kbps: v.tech.bitrate_kbps, aspect: v.tech.aspect, source: v.tech.source, checked_at: v.tech.checked_at,
      }));
    }
    if (v.route) {
      routes++;
      sql.push(upsert('route', 'video_id', {
        video_id: v.video_id, distance_km: v.route.distance_km, method: v.route.method, polyline: v.route.line,
        gpx_path: `gpx/${v.video_id}.gpx`, creator_links: v.route.creator_links,
        check_status: v.route.check?.[0] ?? null, check_note: v.route.check?.[1] ?? null, built_at: v.exported_at,
        ascent_m: v.route.elevation?.ascent_m ?? null, descent_m: v.route.elevation?.descent_m ?? null,
        min_ele_m: v.route.elevation?.min_ele_m ?? null, max_ele_m: v.route.elevation?.max_ele_m ?? null,
        max_gradient: v.route.elevation?.max_gradient ?? null, profile: v.route.elevation?.profile ?? null,
        ele_source: v.route.elevation?.source ?? null,
        main_road_class: v.route.roads?.main_class ?? null, unpaved_share: v.route.roads?.unpaved_share ?? null,
        tunnel_km: v.route.roads?.tunnel_km ?? null, bridge_km: v.route.roads?.bridge_km ?? null,
      }, { guard: 'route' }));
      sql.push(`DELETE FROM route_road WHERE video_id = ${q(v.video_id)} AND ${notManual('route', q(v.video_id))};`);
      for (const [dim, shares] of [['class', v.route.roads?.class_share], ['surface', v.route.roads?.surface_share]]) {
        for (const [value, share] of Object.entries(shares ?? {})) {
          sql.push(`INSERT INTO route_road (video_id, dim, value, share, source) SELECT ${q(v.video_id)}, ${q(dim)}, ${q(value)}, ${q(share)}, 'valhalla_osm' WHERE ${notManual('route', q(v.video_id))};`);
        }
      }
    } else {
      sql.push(`DELETE FROM route_road WHERE video_id = ${q(v.video_id)} AND ${notManual('route', q(v.video_id))};`,
        `DELETE FROM route WHERE video_id = ${q(v.video_id)} AND ${notManual('route', q(v.video_id))};`);
    }
    // Lokalisierungsstufe (concept 2.5): an unverified video2gpx track is level 2, otherwise the export's level.
    const t = sync.get(v.video_id);
    const loc = t ? { loc_level: 2, loc_key: 'anchored', method: t.method } : { loc_level: v.localization.level, loc_key: v.localization.key, method: v.route?.method ?? (v.position_exact ? 'pin' : 'gazetteer') };
    sql.push(`INSERT INTO localization (video_id, loc_level, loc_key, method, rules_version, updated_at) VALUES (${q(v.video_id)}, ${loc.loc_level}, ${q(loc.loc_key)}, ${q(loc.method)}, ${v.localization.rules_version}, ${q(today)})
      ON CONFLICT(video_id) DO UPDATE SET loc_level=excluded.loc_level, loc_key=excluded.loc_key, method=excluded.method, rules_version=excluded.rules_version, updated_at=excluded.updated_at
      WHERE localization.verified_at IS NULL AND ${notManual('localization')};`);
    if (t) {
      sql.push(upsert('route_sync', 'video_id', { video_id: v.video_id, method: t.method, t_start_s: t.tStart, t_end_s: t.tEnd, path: `sync/${v.video_id}.json`, hash: t.hash, built_at: today }, { guard: 'sync' }));
    }
  }

  // Manual video columns: existing rows get the export's value only where the column is not manual.
  sql.push(`CREATE TABLE IF NOT EXISTS _import_video (video_id TEXT PRIMARY KEY, ${MANUAL_VIDEO_COLS.join(', ')});`, 'DELETE FROM _import_video;');
  for (let i = 0; i < videos.length; i += 250) { // D1: at most 100 KB per statement
    sql.push(`INSERT INTO _import_video (video_id, ${MANUAL_VIDEO_COLS.join(', ')}) VALUES ${videos.slice(i, i + 250)
      .map((v) => `(${[v.video_id, ...MANUAL_VIDEO_COLS.map((c) => (c === 'country' || c === 'country_name' ? v[c] ?? null : v[c]))].map(q).join(', ')})`).join(',')};`);
  }
  for (const c of MANUAL_VIDEO_COLS) {
    sql.push(`UPDATE video SET ${c} = s.${c} FROM _import_video s WHERE s.video_id = video.video_id AND video.${c} IS NOT s.${c} AND ${notManual(c, 'video.video_id')};`);
  }
  sql.push('DROP TABLE _import_video;');

  // Videos that left the export, and channels that opted out, are removed with all their pipeline rows.
  // D1 limits a statement to 100 KB, so the id list goes into a scratch table in batches.
  sql.push('CREATE TABLE IF NOT EXISTS _import_ids (video_id TEXT PRIMARY KEY);', 'DELETE FROM _import_ids;');
  for (let i = 0; i < videos.length; i += 500) {
    sql.push(`INSERT INTO _import_ids VALUES ${videos.slice(i, i + 500).map((v) => `(${q(v.video_id)})`).join(',')};`);
  }
  const gone = 'SELECT video_id FROM video WHERE video_id NOT IN (SELECT video_id FROM _import_ids) OR channel_id IN (SELECT channel_id FROM channel_optout)';
  // sync_anchor and localization_log reference video (D1 enforces foreign keys); manual_field, edit_log and the
  // other phase-4 tables keep their rows, so a video that comes back keeps its manual data.
  for (const t of ['video_tech', 'route_road', 'route', 'route_sync', 'localization', 'sync_anchor', 'localization_log', 'sync_track']) sql.push(`DELETE FROM ${t} WHERE video_id IN (${gone});`);
  sql.push(`DELETE FROM video WHERE video_id IN (${gone});`, 'DROP TABLE _import_ids;');

  sql.push('DELETE FROM video_fts;');
  sql.push('INSERT INTO video_fts (video_id, title, place, region, channel) SELECT v.video_id, v.title, v.place, v.region, c.name FROM video v LEFT JOIN channel c ON c.channel_id = v.channel_id;');
  sql.push(`INSERT INTO import_run (at, source, videos, routes, note) VALUES (${q(at)}, 'export', ${videos.length}, ${routes}, ${q(`${sync.size} sync tracks`)});`);
  return { sql, routes, channels: channels.size, countries };
}

