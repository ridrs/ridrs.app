// Webhook mailbox: device registry, intervals.icu webhook intake, encrypted
// event queue per device (PROTOCOL.md). Parameterised SQL only; errors are
// generic codes without internals.
import { b64uDecode, encryptForDevice, randomId, sha256Hex, timingSafeEqualStr } from "./crypto.js";
import { authenticate, readBody } from "./signing.js";
import { OAUTH_RESULT_TTL_SECONDS } from "./relay.js";

export const MAX_WEBHOOK_BODY = 256 * 1024;
const MAX_REGISTER_BODY = 4096;
const MAX_EVENTS_PER_WEBHOOK = 500;
const MAX_DEVICES_PER_ATHLETE = 5;
const MAX_LIMIT = 100;
const REGISTER_PER_HOUR = 10;
const RETENTION_SECONDS = 30 * 24 * 3600;
const DEVICE_IDLE_SECONDS = 180 * 24 * 3600;
export const EVENT_TYPES = new Set([
  "ACTIVITY_UPLOADED",
  "ACTIVITY_ANALYZED",
  "CALENDAR_UPDATED",
  "SPORT_SETTINGS_UPDATED",
  "WELLNESS_UPDATED",
  "APP_SCOPE_CHANGED",
]);
const ATHLETE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const now = () => Math.floor(Date.now() / 1000);

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
const fail = (code, status) => json({ error: code }, status);
const unauthorized = (code = "unauthorized") => fail(code, 401);

function parseJson(bytes) {
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function rowToEvent(r) {
  return {
    cursor: r.cursor,
    id: r.id,
    type: r.type,
    timestamp: r.timestamp,
    eph_pub: r.eph_pub,
    ciphertext: r.ciphertext,
  };
}

// ---- POST /intervals/webhook ----------------------------------------------

export async function handleWebhook(request, env) {
  const body = await readBody(request, MAX_WEBHOOK_BODY);
  if (!body) return fail("too_large", 413);
  const data = parseJson(body);
  const provided = request.headers.get("x-webhook-authorization") ?? (typeof data?.secret === "string" ? data.secret : null);
  const expected = env.INTERVALS_WEBHOOK_SECRET;
  // Compare even when something is missing so the timing stays the same.
  const ok = await timingSafeEqualStr(provided ?? "", expected ?? "");
  if (!expected || provided === null || !ok) return unauthorized();
  if (!data || !Array.isArray(data.events)) return json({});

  const events = [];
  for (const ev of data.events.slice(0, MAX_EVENTS_PER_WEBHOOK)) {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) continue;
    const athlete = typeof ev.athlete_id === "number" ? String(ev.athlete_id) : ev.athlete_id;
    if (typeof athlete !== "string" || !ATHLETE_RE.test(athlete)) continue;
    if (typeof ev.type !== "string" || !EVENT_TYPES.has(ev.type)) continue;
    if (typeof ev.timestamp !== "string" || ev.timestamp.length < 1 || ev.timestamp.length > 64) continue;
    events.push({ athlete, type: ev.type, timestamp: ev.timestamp, plaintext: JSON.stringify(ev) });
  }

  const devicesByAthlete = new Map();
  for (const ev of events) {
    if (devicesByAthlete.has(ev.athlete)) continue;
    const res = await env.DB.prepare("SELECT device_id, enc_pub FROM devices WHERE athlete_id = ?").bind(ev.athlete).all();
    devicesByAthlete.set(ev.athlete, res.results ?? []);
  }
  const created = now();
  for (const ev of events) {
    for (const device of devicesByAthlete.get(ev.athlete)) {
      try {
        const encPub = b64uDecode(device.enc_pub);
        const id = await sha256Hex(`${ev.athlete}|${ev.type}|${ev.timestamp}|${device.device_id}`);
        const exists = await env.DB.prepare("SELECT 1 AS x FROM events WHERE id = ?").bind(id).first();
        if (exists) continue;
        const { ephPub, ciphertext } = await encryptForDevice({
          encPub,
          deviceId: device.device_id,
          type: ev.type,
          timestamp: ev.timestamp,
          plaintext: ev.plaintext,
        });
        const row = await env.DB.prepare(
          "INSERT OR IGNORE INTO events (id, device_id, athlete_id, type, timestamp, eph_pub, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING cursor",
        )
          .bind(id, device.device_id, ev.athlete, ev.type, ev.timestamp, ephPub, ciphertext, created)
          .first();
        if (row && env.notifyDevice) {
          await env.notifyDevice(device.device_id, {
            cursor: row.cursor,
            id,
            type: ev.type,
            timestamp: ev.timestamp,
            eph_pub: ephPub,
            ciphertext,
          });
        }
      } catch {
        // one broken device or event never fails the webhook
      }
    }
  }
  return json({});
}

// ---- POST /devices ----------------------------------------------------------

async function rateLimited(env, request) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = await sha256Hex(`ip|${ip}`);
  const window = Math.floor(now() / 3600);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(key, window)
    .first();
  return row.count > REGISTER_PER_HOUR;
}

async function validPublicKey(str, algorithm, usages) {
  const raw = b64uDecode(str);
  if (!raw || raw.length !== 32) return null;
  try {
    await crypto.subtle.importKey("raw", raw, algorithm, false, usages);
  } catch {
    return null;
  }
  return raw;
}

export async function handleRegister(request, env) {
  if (await rateLimited(env, request)) return fail("rate_limited", 429);
  const body = await readBody(request, MAX_REGISTER_BODY);
  if (!body) return fail("too_large", 413);
  const data = parseJson(body);
  if (!data || typeof data.token !== "string" || data.token.length < 1 || data.token.length > 512) return fail("bad_request", 400);
  if (data.name !== undefined && (typeof data.name !== "string" || data.name.length > 64)) return fail("bad_request", 400);
  const signPub = await validPublicKey(data.sign_pub, { name: "Ed25519" }, ["verify"]);
  const encPub = await validPublicKey(data.enc_pub, { name: "X25519" }, []);
  if (!signPub || !encPub) return fail("bad_request", 400);

  let athlete;
  try {
    const res = await fetch("https://intervals.icu/api/v1/athlete/0", {
      headers: { authorization: `Bearer ${data.token}`, accept: "application/json" },
    });
    if (res.status !== 200) return unauthorized();
    const profile = await res.json();
    athlete = typeof profile?.id === "string" ? profile.id : null;
  } catch {
    return fail("upstream_error", 502);
  }
  if (!athlete || !ATHLETE_RE.test(athlete)) return fail("upstream_error", 502);

  const deviceId = randomId();
  const t = now();
  const dropped = ((await env.DB.prepare("SELECT device_id FROM devices WHERE athlete_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?")
    .bind(athlete, MAX_DEVICES_PER_ATHLETE - 1)
    .all()).results ?? []).map((r) => r.device_id);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO devices (device_id, athlete_id, sign_pub, enc_pub, name, created_at, last_seen, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    ).bind(deviceId, athlete, data.sign_pub, data.enc_pub, data.name ?? null, t, t),
    env.DB.prepare(
      "DELETE FROM events WHERE device_id IN (SELECT device_id FROM devices WHERE athlete_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
    ).bind(athlete, MAX_DEVICES_PER_ATHLETE),
    env.DB.prepare(
      "DELETE FROM devices WHERE device_id IN (SELECT device_id FROM devices WHERE athlete_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
    ).bind(athlete, MAX_DEVICES_PER_ATHLETE),
  ]);
  await closeDevices(env, dropped);
  return json({ device_id: deviceId });
}

async function closeDevices(env, ids) {
  if (!env.closeDevice) return;
  for (const id of ids) {
    try {
      await env.closeDevice(id);
    } catch {
      // best effort
    }
  }
}

// ---- signed endpoints -------------------------------------------------------

export async function getUpdates(env, deviceId, since, limit) {
  const res = await env.DB.prepare(
    "SELECT cursor, id, type, timestamp, eph_pub, ciphertext FROM events WHERE device_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
  )
    .bind(deviceId, since, limit + 1)
    .all();
  const rows = res.results ?? [];
  const more = rows.length > limit;
  const events = rows.slice(0, limit).map(rowToEvent);
  return { events, next: events.length ? events[events.length - 1].cursor : since, more };
}

export async function ackUpdates(env, deviceId, upto) {
  await env.DB.prepare("DELETE FROM events WHERE device_id = ? AND cursor <= ?").bind(deviceId, upto).run();
}

export async function maxCursor(env, deviceId) {
  const row = await env.DB.prepare("SELECT MAX(cursor) AS c FROM events WHERE device_id = ?").bind(deviceId).first();
  return row?.c ?? 0;
}

export async function handleUpdates(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return unauthorized(auth.error);
  const params = new URL(request.url).searchParams;
  const since = params.has("since") ? Number(params.get("since")) : 0;
  const limit = params.has("limit") ? Number(params.get("limit")) : 50;
  if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1) return fail("bad_request", 400);
  const deviceId = auth.device.device_id;
  await env.DB.prepare("DELETE FROM events WHERE device_id = ? AND created_at < ?").bind(deviceId, now() - RETENTION_SECONDS).run();
  return json(await getUpdates(env, deviceId, since, Math.min(limit, MAX_LIMIT)));
}

export async function handleAck(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return unauthorized(auth.error);
  const data = parseJson(auth.body);
  if (!data || !Number.isSafeInteger(data.upto) || data.upto < 0) return fail("bad_request", 400);
  await ackUpdates(env, auth.device.device_id, data.upto);
  return json({});
}

export async function deleteDeviceRows(env, deviceId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE device_id = ?").bind(deviceId),
    env.DB.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceId),
  ]);
}

export async function handleDeleteDevice(request, env, pathId) {
  const auth = await authenticate(request, env);
  if (auth.error) return unauthorized(auth.error);
  if (auth.device.device_id !== pathId) return unauthorized("bad_signature");
  await deleteDeviceRows(env, pathId);
  await closeDevices(env, [pathId]);
  return json({});
}

// ---- retention --------------------------------------------------------------

export async function purge(env, t = now()) {
  const idle = ((await env.DB.prepare("SELECT device_id FROM devices WHERE last_seen < ?").bind(t - DEVICE_IDLE_SECONDS).all()).results ?? []).map(
    (r) => r.device_id,
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE created_at < ?").bind(t - RETENTION_SECONDS),
    env.DB.prepare("DELETE FROM events WHERE device_id IN (SELECT device_id FROM devices WHERE last_seen < ?)").bind(t - DEVICE_IDLE_SECONDS),
    env.DB.prepare("DELETE FROM devices WHERE last_seen < ?").bind(t - DEVICE_IDLE_SECONDS),
    env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(Math.floor(t / 3600) - 2),
    env.DB.prepare("DELETE FROM oauth_results WHERE created_at < ?").bind(t - OAUTH_RESULT_TTL_SECONDS),
  ]);
  await closeDevices(env, idle);
}
