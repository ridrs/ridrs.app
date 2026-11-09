// Verification of signed device requests (PROTOCOL.md section 5).
import { b64uDecode, sha256Hex } from "./crypto.js";

const encoder = new TextEncoder();
export const MAX_SIGNED_BODY = 4096;
const MAX_SKEW = 300;

export async function readBody(request, max) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Checks device, time window, replay and signature, then stores last_ts
// atomically. Returns { device } or { error } with error one of
// "unknown_device", "stale_timestamp", "bad_signature" (callers answer 401).
export async function verifySigned({ deviceId, tsHeader, sigHeader, method, pathAndQuery, body }, env, now = Math.floor(Date.now() / 1000)) {
  if (!deviceId || !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return { error: "unknown_device" };
  const device = await env.DB.prepare("SELECT device_id, athlete_id, sign_pub, enc_pub, last_ts FROM devices WHERE device_id = ?")
    .bind(deviceId)
    .first();
  if (!device) return { error: "unknown_device" };
  if (!tsHeader || !/^[0-9]{1,12}$/.test(tsHeader)) return { error: "bad_signature" };
  const ts = Number(tsHeader);
  if (Math.abs(now - ts) > MAX_SKEW || ts <= device.last_ts) return { error: "stale_timestamp" };
  const sig = b64uDecode(sigHeader ?? "");
  if (!sig || sig.length !== 64) return { error: "bad_signature" };
  const message = `${method}\n${pathAndQuery}\n${tsHeader}\n${await sha256Hex(body)}`;
  let ok = false;
  try {
    const pub = b64uDecode(device.sign_pub);
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, encoder.encode(message));
  } catch {
    ok = false;
  }
  if (!ok) return { error: "bad_signature" };
  const res = await env.DB.prepare("UPDATE devices SET last_ts = ?, last_seen = ? WHERE device_id = ? AND last_ts < ?")
    .bind(ts, now, deviceId, ts)
    .run();
  if (!res.meta || res.meta.changes !== 1) return { error: "stale_timestamp" };
  return { device };
}

// Returns { device, body } for a valid signed request, otherwise { error }.
export async function authenticate(request, env, now) {
  const body = await readBody(request, MAX_SIGNED_BODY);
  if (!body) return { error: "bad_signature" };
  const url = new URL(request.url);
  const r = await verifySigned(
    {
      deviceId: request.headers.get("x-ridrs-device"),
      tsHeader: request.headers.get("x-ridrs-timestamp"),
      sigHeader: request.headers.get("x-ridrs-signature"),
      method: request.method,
      pathAndQuery: `${url.pathname}${url.search}`,
      body,
    },
    env,
    now,
  );
  return r.error ? r : { device: r.device, body };
}
