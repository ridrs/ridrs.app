// SPDX-License-Identifier: AGPL-3.0-or-later
// Wishlist for video2gpx (migrations/0009_wishlist.sql). Visitors put a video on the wishlist in the public dialog
// (POST /api/videos/:id/wish); the admin shows the wishes as a queue: which videos video2gpx refines next.
//   vote()        public: one vote per visitor, video and day, at most WISHES_PER_DAY videos per visitor and day
//   wishHandler   admin: queue state {status, priority} of a video, logged in edit_log and undoable (src/admin.js `change`)
//   queue()       admin: the queue in working order, with each video's job file for video2gpx

export const WISHES_PER_DAY = 30;
export const WISH_STATUS = ['open', 'done', 'dismissed'];
/** A video video2gpx can refine: a YouTube video without a secured track (level 3 and worse). */
export const REFINABLE = "v.source = 'youtube' AND COALESCE(l.loc_level, 7) > 2";
/** SQL: the video's track is secured by video2gpx already (the wish is done without anyone setting it). */
export const REFINED = "(COALESCE(s.method, '') = 'video2gpx' OR COALESCE(l.loc_level, 7) <= 2)";

const today = () => new Date().toISOString().slice(0, 10);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Visitor key of the day: no IP address is stored, and keys of two days cannot be linked. */
export async function voterKey(request, env, day = today()) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'local';
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${ip}|${env.WISH_SALT ?? ''}`))).slice(0, 32);
}

/**
 * A visitor's wish for a visible video. `visible`: the public visibility condition on `video v` (src/worker.js VISIBLE).
 * Returns {status, body}: 200 {ok, votes, counted}, 404 for an unknown or hidden video, 409 when the video cannot be
 * refined (not on YouTube or already secured), 429 above WISHES_PER_DAY.
 */
export async function vote(env, request, id, visible) {
  const v = await env.DB.prepare(`SELECT v.video_id, ${REFINABLE} AS refinable FROM video v LEFT JOIN localization l ON l.video_id = v.video_id
    WHERE v.video_id = ?1 AND ${visible}`).bind(id).first();
  if (!v) return { status: 404, body: { error: 'not found' } };
  if (!v.refinable) return { status: 409, body: { error: 'not refinable' } };
  const day = today(), voter = await voterKey(request, env, day), at = new Date().toISOString();
  const [, mine, dup] = await env.DB.batch([
    env.DB.prepare('DELETE FROM wish_vote WHERE day < ?1').bind(day),
    env.DB.prepare('SELECT count(*) AS n FROM wish_vote WHERE voter = ?1').bind(voter),
    env.DB.prepare('SELECT 1 AS x FROM wish_vote WHERE video_id = ?1 AND voter = ?2').bind(id, voter),
  ]);
  const counted = !dup.results.length;
  if (counted && mine.results[0].n >= WISHES_PER_DAY) return { status: 429, body: { error: 'too many wishes' } };
  if (counted) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO wish_vote (video_id, voter, day) VALUES (?1, ?2, ?3)').bind(id, voter, day),
      env.DB.prepare(`INSERT INTO wish (video_id, votes, first_at, last_at) VALUES (?1, 1, ?2, ?2)
        ON CONFLICT (video_id) DO UPDATE SET votes = votes + 1, last_at = ?2`).bind(id, at),
    ]);
  }
  const w = await env.DB.prepare('SELECT votes FROM wish WHERE video_id = ?1').bind(id).first();
  return { status: 200, body: { ok: true, counted, votes: w?.votes ?? 0 } };
}

/**
 * Admin entity `wish` for src/admin.js `change`: value {status, priority} or null (not on the list). Votes stay as they are;
 * null deletes the row only when nobody voted (undo of an editor's own entry).
 */
export const wishHandler = {
  async get(env, id) {
    const r = await env.DB.prepare('SELECT status, priority FROM wish WHERE video_id = ?1').bind(id).first();
    return r ? { status: r.status, priority: r.priority ?? null } : null;
  },
  set(env, id, field, v, who) {
    const at = new Date().toISOString();
    if (!v) return [env.DB.prepare('DELETE FROM wish WHERE video_id = ?1 AND votes = 0').bind(id),
      env.DB.prepare("UPDATE wish SET status = 'dismissed', priority = NULL, status_by = ?2, status_at = ?3 WHERE video_id = ?1").bind(id, who, at)];
    return [env.DB.prepare(`INSERT INTO wish (video_id, votes, first_at, priority, status, status_by, status_at) VALUES (?1, 0, ?5, ?2, ?3, ?4, ?5)
      ON CONFLICT (video_id) DO UPDATE SET priority = ?2, status = ?3, status_by = ?4, status_at = ?5`).bind(id, v.priority ?? null, v.status, who, at)];
  },
};

/** Priority that puts a video first: one below the smallest of the open queue. */
export async function topPriority(env) {
  const r = await env.DB.prepare("SELECT min(priority) AS p FROM wish WHERE status = 'open'").first();
  return (r?.p ?? 1) - 1;
}

/**
 * The queue in working order: prioritised first (smallest priority), then by votes, then oldest wish.
 * `all`: also done and dismissed wishes (after the open ones). Each row carries its position among the open, unrefined wishes.
 */
export async function queue(env, { all = false, origin = '' } = {}) {
  const { results } = await env.DB.prepare(`SELECT w.video_id, w.votes, w.first_at, w.last_at, w.priority, w.status, w.status_by, w.status_at,
      v.title, v.place, v.country, v.duration_s, v.view_count, v.site_published, c.name AS channel, l.loc_level, r.distance_km,
      s.method AS sync_method, ${REFINED} AS refined
    FROM wish w JOIN video v ON v.video_id = w.video_id LEFT JOIN channel c ON c.channel_id = v.channel_id
    LEFT JOIN localization l ON l.video_id = w.video_id LEFT JOIN route r ON r.video_id = w.video_id LEFT JOIN route_sync s ON s.video_id = w.video_id
    ${all ? '' : `WHERE w.status = 'open' AND NOT ${REFINED}`}
    ORDER BY (w.status = 'open' AND NOT ${REFINED}) DESC, (w.priority IS NULL), w.priority, w.votes DESC, w.first_at, w.video_id`).all();
  let pos = 0;
  return results.map((r) => {
    const waiting = r.status === 'open' && !r.refined;
    return { ...r, refined: !!r.refined, site_published: !!r.site_published, position: waiting ? ++pos : null,
      job: `${origin}/api/admin/videos/${r.video_id}/video2gpx-job.json` };
  });
}
