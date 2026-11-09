import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { route, scheduled } from "../src/router.js";
import { decryptEvent, makeEnv, newClient, signedRequest } from "./helpers.js";

let env;
let athleteOfToken;
beforeEach(() => {
  env = makeEnv();
  athleteOfToken = { good: "i42" };
  vi.stubGlobal("fetch", async (url, init) => {
    expect(String(url)).toBe("https://intervals.icu/api/v1/athlete/0");
    const t = init.headers.authorization.replace("Bearer ", "");
    const id = athleteOfToken[t];
    return id ? new Response(JSON.stringify({ id }), { status: 200 }) : new Response("no", { status: 401 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const post = (path, body, headers = {}) =>
  route(new Request(`https://ridrs.app${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers }), env);

async function register(client, token = "good") {
  const res = await post("/devices", { token, sign_pub: client.signPub, enc_pub: client.encPub, name: "test" });
  expect(res.status).toBe(200);
  return (await res.json()).device_id;
}
const webhook = (events, headers = { "x-webhook-authorization": "s3cret-value" }) => post("/intervals/webhook", { events }, headers);
const ev = (o = {}) => ({ athlete_id: "i42", type: "ACTIVITY_UPLOADED", timestamp: "2026-01-01T10:00:00", activity: { id: "a1" }, ...o });
const count = (sql, ...a) => env.DB.raw.prepare(sql).get(...a).n;

describe("webhook auth", () => {
  it("rejects missing and wrong secrets", async () => {
    expect((await webhook([ev()], {})).status).toBe(401);
    expect((await webhook([ev()], { "x-webhook-authorization": "nope" })).status).toBe(401);
    expect((await post("/intervals/webhook", { secret: "nope", events: [] })).status).toBe(401);
  });
  it("rejects everything if no secret is configured", async () => {
    env.INTERVALS_WEBHOOK_SECRET = undefined;
    expect((await webhook([], { "x-webhook-authorization": "" })).status).toBe(401);
    expect((await post("/intervals/webhook", { events: [] })).status).toBe(401);
  });
  it("accepts header and body secret, answers 200 {}", async () => {
    const a = await webhook([ev()]);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({});
    const b = await post("/intervals/webhook", { secret: "s3cret-value", events: [ev()] });
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({});
  });
  it("limits the body size", async () => {
    const res = await post("/intervals/webhook", "x".repeat(256 * 1024 + 1), { "x-webhook-authorization": "s3cret-value" });
    expect(res.status).toBe(413);
  });
  it("tolerates malformed bodies and events once authorized", async () => {
    expect((await post("/intervals/webhook", "not json", { "x-webhook-authorization": "s3cret-value" })).status).toBe(200);
    expect((await webhook([null, 5, { athlete_id: 1 }, ev({ timestamp: 5 })])).status).toBe(200);
  });
});

describe("webhook delivery", () => {
  it("stores one encrypted row per device, idempotent, ignoring unknown types and athletes", async () => {
    const c1 = newClient();
    const c2 = newClient();
    const d1 = await register(c1);
    const d2 = await register(c2);
    await webhook([ev(), ev({ type: "SOMETHING_ELSE" }), ev({ athlete_id: "i999" })]);
    await webhook([ev()]);
    expect(count("SELECT COUNT(*) n FROM events")).toBe(2);
    const row = env.DB.raw.prepare("SELECT * FROM events WHERE device_id = ?").get(d1);
    expect(row.athlete_id).toBe("i42");
    expect(row.type).toBe("ACTIVITY_UPLOADED");
    expect(JSON.parse(decryptEvent(c1, d1, row))).toEqual(ev());
    const row2 = env.DB.raw.prepare("SELECT * FROM events WHERE device_id = ?").get(d2);
    expect(JSON.parse(decryptEvent(c2, d2, row2))).toEqual(ev());
    expect(() => decryptEvent(c2, d2, row)).toThrow();
  });
});

describe("register", () => {
  it("returns a device id and never stores the token", async () => {
    const c = newClient();
    const id = await register(c);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const dump = JSON.stringify(env.DB.raw.prepare("SELECT * FROM devices").all());
    expect(dump).not.toContain("good");
    expect(dump).toContain("i42");
  });
  it("401 on rejected token, 400 on bad keys", async () => {
    const c = newClient();
    expect((await post("/devices", { token: "bad", sign_pub: c.signPub, enc_pub: c.encPub })).status).toBe(401);
    expect((await post("/devices", { token: "good", sign_pub: "AAAA", enc_pub: c.encPub })).status).toBe(400);
    expect((await post("/devices", { token: "good", sign_pub: c.signPub, enc_pub: c.encPub, name: "x".repeat(65) })).status).toBe(400);
    expect((await post("/devices", "nope")).status).toBe(400);
  });
  it("keeps at most 5 devices per athlete, replacing the oldest", async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await register(newClient()));
      env.DB.raw.prepare("UPDATE devices SET created_at = created_at + ? WHERE device_id = ?").run(i, ids[i]);
    }
    expect(count("SELECT COUNT(*) n FROM devices")).toBe(5);
    expect(count("SELECT COUNT(*) n FROM devices WHERE device_id = ?", ids[0])).toBe(0);
  });
  it("rate limits per IP", async () => {
    const c = newClient();
    let last;
    for (let i = 0; i < 11; i++) last = await post("/devices", { token: "good", sign_pub: c.signPub, enc_pub: c.encPub }, { "cf-connecting-ip": "1.2.3.4" });
    expect(last.status).toBe(429);
  });
});

describe("signed requests", () => {
  it("accepts a valid signature and rejects replay, old timestamps, bad signatures and unknown devices", async () => {
    const c = newClient();
    const id = await register(c);
    const now = Math.floor(Date.now() / 1000);
    const send = async (device, opts) => route(await signedRequest(c, device, "GET", "/updates?since=0&limit=5", opts), env);
    expect((await send(id, { ts: now })).status).toBe(200);
    expect((await send(id, { ts: now })).status).toBe(401); // replay
    expect((await send(id, { ts: now - 1 })).status).toBe(401); // older than last_ts
    expect((await send(id, { ts: now - 1000 })).status).toBe(401);
    expect((await send(id, { ts: now + 1000 })).status).toBe(401);
    expect((await send(id, { ts: now + 5, tamper: true })).status).toBe(401);
    expect((await send("unknownDeviceId", { ts: now + 6 })).status).toBe(401);
    const other = newClient();
    await register(other);
    expect((await route(await signedRequest(other, id, "GET", "/updates", { ts: now + 7 }), env)).status).toBe(401);
    expect(count("SELECT last_ts n FROM devices WHERE device_id = ?", id)).toBe(now);
    expect((await send(id, { ts: now + 8 })).status).toBe(200);
  });
  it("tells the failure reasons apart", async () => {
    const c = newClient();
    const id = await register(c);
    const now = Math.floor(Date.now() / 1000);
    const err = async (device, opts) => {
      const res = await route(await signedRequest(c, device, "GET", "/updates", opts), env);
      expect(res.status).toBe(401);
      return (await res.json()).error;
    };
    expect(await err("unknownDeviceId", { ts: now })).toBe("unknown_device");
    expect(await err(id, { ts: now, tamper: true })).toBe("bad_signature");
    expect(await err(id, { ts: now - 1000 })).toBe("stale_timestamp");
    expect(await err(id, { ts: now + 1000 })).toBe("stale_timestamp");
    expect((await route(await signedRequest(c, id, "GET", "/updates", { ts: now }), env)).status).toBe(200);
    expect(await err(id, { ts: now })).toBe("stale_timestamp"); // replay
    const forged = new Request("https://ridrs.app/updates?since=1", { headers: (await signedRequest(c, id, "GET", "/updates?since=0", { ts: now + 1 })).headers });
    expect((await (await route(forged, env)).json()).error).toBe("bad_signature");
  });
  it("covers the path, query and body in the signature", async () => {
    const c = newClient();
    const id = await register(c);
    const ts = Math.floor(Date.now() / 1000);
    const req = await signedRequest(c, id, "GET", "/updates?since=0", { ts });
    const forged = new Request("https://ridrs.app/updates?since=1", { headers: req.headers });
    expect((await route(forged, env)).status).toBe(401);
  });
});

describe("updates, ack, delete", () => {
  it("pages by cursor and acks", async () => {
    const c = newClient();
    const id = await register(c);
    for (let i = 0; i < 5; i++) await webhook([ev({ timestamp: `t${i}` })]);
    let ts = Math.floor(Date.now() / 1000);
    const call = async (method, path, body = "") => route(await signedRequest(c, id, method, path, { ts: ++ts, body }), env);
    const p1 = await (await call("GET", "/updates?since=0&limit=2")).json();
    expect(p1.events.length).toBe(2);
    expect(p1.more).toBe(true);
    expect(p1.next).toBe(p1.events[1].cursor);
    expect(Object.keys(p1.events[0]).sort()).toEqual(["ciphertext", "cursor", "eph_pub", "id", "timestamp", "type"]);
    const p2 = await (await call("GET", `/updates?since=${p1.next}&limit=50`)).json();
    expect(p2.events.length).toBe(3);
    expect(p2.more).toBe(false);
    expect(p2.events[0].cursor).toBeGreaterThan(p1.next);
    expect(JSON.parse(decryptEvent(c, id, p2.events[2])).timestamp).toBe("t4");
    expect((await call("GET", "/updates?limit=1000")).status).toBe(200);
    expect(await (await call("POST", "/updates/ack", JSON.stringify({ upto: p1.next }))).json()).toEqual({});
    expect(count("SELECT COUNT(*) n FROM events")).toBe(3);
    expect((await call("POST", "/updates/ack", "{}")).status).toBe(400);
  });
  it("deletes the device and its rows; path must match header", async () => {
    const c = newClient();
    const id = await register(c);
    await webhook([ev()]);
    let ts = Math.floor(Date.now() / 1000);
    const other = await register(newClient());
    expect((await route(await signedRequest(c, id, "DELETE", `/devices/${other}`, { ts: ++ts }), env)).status).toBe(401);
    expect((await route(await signedRequest(c, id, "DELETE", `/devices/${id}`, { ts: ++ts }), env)).status).toBe(200);
    expect(count("SELECT COUNT(*) n FROM devices WHERE device_id = ?", id)).toBe(0);
    expect(count("SELECT COUNT(*) n FROM events WHERE device_id = ?", id)).toBe(0);
  });
});

describe("retention", () => {
  it("purges old rows and idle devices", async () => {
    const id = await register(newClient());
    await webhook([ev()]);
    const day = 24 * 3600;
    env.DB.raw.prepare("UPDATE events SET created_at = created_at - ?").run(31 * day);
    await scheduled(env);
    expect(count("SELECT COUNT(*) n FROM events")).toBe(0);
    expect(count("SELECT COUNT(*) n FROM devices")).toBe(1);
    env.DB.raw.prepare("UPDATE devices SET last_seen = last_seen - ?").run(181 * day);
    await scheduled(env);
    expect(count("SELECT COUNT(*) n FROM devices WHERE device_id = ?", id)).toBe(0);
  });
});
