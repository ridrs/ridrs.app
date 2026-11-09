// Routes the relay and mailbox endpoints; returns null for everything else so
// the existing site handling in index.js stays untouched.
import { verifySigned } from "./signing.js";
import { handleActivity, handleOAuthCallback, methodNotAllowed } from "./relay.js";
import {
  handleAck,
  handleDeleteDevice,
  handleRegister,
  handleUpdates,
  handleWebhook,
  json,
  purge,
} from "./mailbox.js";

const DEVICE_PATH = /^\/devices\/([A-Za-z0-9_-]{1,64})$/;

// Gives the mailbox code access to the per-device Durable Object, if bound.
function withHub(env) {
  const ns = env.MAILBOX_HUB;
  if (!ns) return env;
  const stub = (id) => ns.get(ns.idFromName(id));
  return {
    ...env,
    notifyDevice: (id, event) => stub(id).fetch("https://hub/notify", { method: "POST", body: JSON.stringify(event) }),
    closeDevice: (id) => stub(id).fetch("https://hub/close", { method: "POST" }),
  };
}

// GET /updates/ws?device=&ts=&sig= : signature over "GET\n/updates/ws\n<ts>\n<sha256 of empty>".
async function handleSocket(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
  const params = new URL(request.url).searchParams;
  const unique = [...params.keys()].length === 3 && ["device", "ts", "sig"].every((k) => params.getAll(k).length === 1);
  const result = unique
    ? await verifySigned(
        { deviceId: params.get("device"), tsHeader: params.get("ts"), sigHeader: params.get("sig"), method: "GET", pathAndQuery: "/updates/ws", body: new Uint8Array(0) },
        env,
      )
    : { error: "bad_signature" };
  if (result.error) return json({ error: result.error }, 401);
  const device = result.device;
  if (!env.MAILBOX_HUB) return json({ error: "unavailable" }, 503);
  const hub = env.MAILBOX_HUB.get(env.MAILBOX_HUB.idFromName(device.device_id));
  return hub.fetch("https://hub/ws", { headers: { upgrade: "websocket", "x-ridrs-device": device.device_id } });
}

function allow(request, method, fn) {
  return request.method === method ? fn() : methodNotAllowed(method);
}

export async function route(request, rawEnv) {
  const env = withHub(rawEnv);
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/intervals/oauth/callback") return await handleOAuthCallback(request);
    if (pathname.startsWith("/activities/")) {
      let id = pathname.slice("/activities/".length);
      try {
        id = decodeURIComponent(id);
      } catch {
        id = "";
      }
      return await handleActivity(request, id);
    }
    if (pathname === "/intervals/webhook") return await allow(request, "POST", () => handleWebhook(request, env));
    if (pathname === "/devices") return await allow(request, "POST", () => handleRegister(request, env));
    if (pathname === "/updates/ws") return await handleSocket(request, env);
    if (pathname === "/updates") return await allow(request, "GET", () => handleUpdates(request, env));
    if (pathname === "/updates/ack") return await allow(request, "POST", () => handleAck(request, env));
    const m = DEVICE_PATH.exec(pathname);
    if (m) return await allow(request, "DELETE", () => handleDeleteDevice(request, env, m[1]));
    return null;
  } catch {
    return json({ error: "internal" }, 500);
  }
}

export async function scheduled(rawEnv) {
  await purge(withHub(rawEnv));
}
