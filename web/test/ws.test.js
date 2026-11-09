import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64uEncode, sha256Hex } from "../src/crypto.js";
import { MailboxHub } from "../src/hub.js";
import { route } from "../src/router.js";
import { makeEnv, newClient } from "./helpers.js";

class FakeWs {
  constructor() {
    this.sent = [];
    this.closed = null;
    this.attachment = null;
  }
  send(m) {
    this.sent.push(m);
  }
  close(code) {
    this.closed = code;
  }
  serializeAttachment(a) {
    this.attachment = a;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}
class FakeState {
  constructor() {
    this.sockets = [];
  }
  acceptWebSocket(ws) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((s) => s.closed === null);
  }
  setWebSocketAutoResponse(pair) {
    this.auto = pair;
  }
}

let env;
beforeEach(() => {
  env = makeEnv();
  vi.stubGlobal("WebSocketRequestResponsePair", class { constructor(req, res) { this.request = req; this.response = res; } });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "i42" })));
});
afterEach(() => vi.unstubAllGlobals());

async function registerDevice() {
  const c = newClient();
  const res = await route(
    new Request("https://ridrs.app/devices", { method: "POST", body: JSON.stringify({ token: "t", sign_pub: c.signPub, enc_pub: c.encPub }) }),
    env,
  );
  return { c, id: (await res.json()).device_id };
}

async function wsUrl(c, id, { ts = Math.floor(Date.now() / 1000), tamper = false, path = "/updates/ws" } = {}) {
  const msg = `GET\n${path}\n${ts}\n${await sha256Hex(new Uint8Array(0))}`;
  const sig = tamper ? Buffer.alloc(64) : crypto.sign(null, Buffer.from(msg), c.sign.privateKey);
  return `https://ridrs.app/updates/ws?device=${id}&ts=${ts}&sig=${b64uEncode(sig)}`;
}

describe("GET /updates/ws handshake (Worker side)", () => {
  let forwarded;
  beforeEach(() => {
    forwarded = [];
    env.MAILBOX_HUB = {
      idFromName: (n) => n,
      get: (id) => ({
        fetch: async (url, init) => {
          forwarded.push({ id, url: String(url), init });
          return new Response("forwarded");
        },
      }),
    };
  });
  const upgrade = (url) => route(new Request(url, { headers: { upgrade: "websocket" } }), env);

  it("forwards a valid signature to the device's Durable Object", async () => {
    const { c, id } = await registerDevice();
    const res = await upgrade(await wsUrl(c, id));
    expect(await res.text()).toBe("forwarded");
    expect(forwarded[0].id).toBe(id);
    expect(forwarded[0].url).toBe("https://hub/ws");
    expect(forwarded[0].init.headers["x-ridrs-device"]).toBe(id);
  });
  it("rejects bad signature, replay, old timestamp, unknown device, extra params with 401 before forwarding", async () => {
    const { c, id } = await registerDevice();
    const now = Math.floor(Date.now() / 1000);
    expect((await upgrade(await wsUrl(c, id, { ts: now + 1, tamper: true }))).status).toBe(401);
    expect((await upgrade(await wsUrl(c, id, { ts: now - 1000 }))).status).toBe(401);
    expect((await upgrade(await wsUrl(c, "nope", { ts: now + 2 }))).status).toBe(401);
    expect((await upgrade(`${await wsUrl(c, id, { ts: now + 3 })}&x=1`)).status).toBe(401);
    expect((await upgrade(await wsUrl(c, id, { path: "/updates", ts: now + 4 }))).status).toBe(401);
    expect((await upgrade(await wsUrl(c, id, { ts: now + 5 }))).status).toBe(200);
    expect((await upgrade(await wsUrl(c, id, { ts: now + 5 }))).status).toBe(401); // replay
    expect(forwarded.length).toBe(1);
  });
  it("reports unknown_device, bad_signature and stale_timestamp on the upgrade", async () => {
    const { c, id } = await registerDevice();
    const now = Math.floor(Date.now() / 1000);
    const code = async (url) => {
      const res = await upgrade(url);
      expect(res.status).toBe(401);
      return (await res.json()).error;
    };
    expect(await code(await wsUrl(c, "nope", { ts: now + 1 }))).toBe("unknown_device");
    expect(await code(await wsUrl(c, id, { ts: now + 1, tamper: true }))).toBe("bad_signature");
    expect(await code(await wsUrl(c, id, { ts: now - 1000 }))).toBe("stale_timestamp");
  });
  it("needs a websocket upgrade", async () => {
    const { c, id } = await registerDevice();
    expect((await route(new Request(await wsUrl(c, id)), env)).status).toBe(426);
  });
  it("webhook and delete reach the hub", async () => {
    const { c, id } = await registerDevice();
    await route(
      new Request("https://ridrs.app/intervals/webhook", {
        method: "POST",
        headers: { "x-webhook-authorization": "s3cret-value" },
        body: JSON.stringify({ events: [{ athlete_id: "i42", type: "WELLNESS_UPDATED", timestamp: "t1" }] }),
      }),
      env,
    );
    const n = forwarded.find((f) => f.url === "https://hub/notify");
    expect(n.id).toBe(id);
    expect(JSON.parse(n.init.body)).toMatchObject({ type: "WELLNESS_UPDATED", timestamp: "t1", cursor: 1 });
  });
});

describe("MailboxHub", () => {
  async function hubWithDevice() {
    const { c, id } = await registerDevice();
    const state = new FakeState();
    const hub = new MailboxHub(state, env);
    return { c, id, state, hub };
  }

  it("registers the ping/pong auto response", async () => {
    const { state } = await hubWithDevice();
    expect([state.auto.request, state.auto.response]).toEqual(["ping", "pong"]);
  });
  it("sends hello with the highest cursor, then pushes events", async () => {
    const { id, hub } = await hubWithDevice();
    env.DB.raw.prepare("INSERT INTO events (id, device_id, athlete_id, type, timestamp, eph_pub, ciphertext, created_at) VALUES ('x', ?, 'i42', 'T', 't', 'e', 'c', 1)").run(id);
    const ws = new FakeWs();
    await hub.connect(ws, id);
    expect(JSON.parse(ws.sent[0])).toEqual({ t: "hello", next: 1 });
    const event = { cursor: 2, id: "y", type: "ACTIVITY_UPLOADED", timestamp: "t2", eph_pub: "e", ciphertext: "c" };
    await hub.notify(event);
    expect(JSON.parse(ws.sent[1])).toEqual({ t: "event", event });
  });
  it("hello next is 0 without rows", async () => {
    const { id, hub } = await hubWithDevice();
    const ws = new FakeWs();
    await hub.connect(ws, id);
    expect(JSON.parse(ws.sent[0])).toEqual({ t: "hello", next: 0 });
  });
  it("a new connection closes the older one with 4000", async () => {
    const { id, hub } = await hubWithDevice();
    const a = new FakeWs();
    const b = new FakeWs();
    await hub.connect(a, id);
    await hub.connect(b, id);
    expect(a.closed).toBe(4000);
    expect(b.closed).toBeNull();
    await hub.notify({ cursor: 1 });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(2);
  });
  it("ack over the socket deletes this device's rows only", async () => {
    const { id, hub } = await hubWithDevice();
    const ins = env.DB.raw.prepare("INSERT INTO events (id, device_id, athlete_id, type, timestamp, eph_pub, ciphertext, created_at) VALUES (?, ?, 'i42', 'T', 't', 'e', 'c', 1)");
    ins.run("a", id);
    ins.run("b", id);
    ins.run("c", "otherdevice");
    const ws = new FakeWs();
    await hub.connect(ws, id);
    await hub.webSocketMessage(ws, JSON.stringify({ t: "ack", upto: 1 }));
    expect(env.DB.raw.prepare("SELECT id FROM events ORDER BY cursor").all().map((r) => r.id)).toEqual(["b", "c"]);
    await hub.webSocketMessage(ws, JSON.stringify({ t: "ack", upto: -3 }));
    await hub.webSocketMessage(ws, "garbage");
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM events").get().n).toBe(2);
  });
  it("closes with 4401 when the device is gone, and on /close", async () => {
    const { id, hub } = await hubWithDevice();
    const ws = new FakeWs();
    await hub.connect(ws, id);
    env.DB.raw.prepare("DELETE FROM devices").run();
    await hub.webSocketMessage(ws, JSON.stringify({ t: "ack", upto: 1 }));
    expect(ws.closed).toBe(4401);
    const ws2 = new FakeWs();
    await hub.connect(ws2, id);
    await hub.fetch(new Request("https://hub/close", { method: "POST" }));
    expect(ws2.closed).toBe(4401);
  });
  it("rejects messages over 4 KiB", async () => {
    const { id, hub } = await hubWithDevice();
    const ws = new FakeWs();
    await hub.connect(ws, id);
    await hub.webSocketMessage(ws, "x".repeat(4097));
    expect(ws.closed).toBe(1009);
  });
});
