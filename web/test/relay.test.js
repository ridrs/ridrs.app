import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { route, scheduled } from "../src/router.js";
import { makeEnv } from "./helpers.js";

const get = (path) => route(new Request(`https://ridrs.app${path}`), {});
const STATE = "abcdEFGH1234";

describe("OAuth bounce page", () => {
  it("bounces code and state to the fixed target", async () => {
    const res = await get(`/intervals/oauth/callback?code=abc.DEF-1&state=${STATE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain(`ridrs://oauth/intervals?code=abc.DEF-1&amp;state=${STATE}`);
    expect(html).toContain("Open ridrs");
    expect(html).not.toMatch(/https?:\/\//);
  });
  it("passes an error through, escaped", async () => {
    const res = await get(`/intervals/oauth/callback?error=access_denied&error_description=${encodeURIComponent('<script>"x"</script>')}&state=${STATE}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>\"x\"");
    expect(html).toContain("%3Cscript%3E");
  });
  it.each([
    "/intervals/oauth/callback",
    `/intervals/oauth/callback?code=abc`,
    `/intervals/oauth/callback?state=${STATE}`,
    `/intervals/oauth/callback?code=a%20b&state=${STATE}`,
    `/intervals/oauth/callback?code=abc&state=short`,
    `/intervals/oauth/callback?code=abc&state=${STATE}&redirect=https://evil.example`,
    `/intervals/oauth/callback?code=abc&code=def&state=${STATE}`,
    `/intervals/oauth/callback?code=%3Cx%3E&state=${STATE}`,
    `/intervals/oauth/callback?error=a%3Cb`,
    `/intervals/oauth/callback?code=${"a".repeat(513)}&state=${STATE}`,
  ])("rejects %s", async (p) => {
    expect((await get(p)).status).toBe(400);
  });
});

describe("activity bounce page", () => {
  it("bounces a valid id", async () => {
    const res = await get("/activities/i123_abc-1.x");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ridrs://activity/i123_abc-1.x");
  });
  it.each(["/activities/", "/activities/a%2Fb", "/activities/a%3Cb", "/activities/a/b", `/activities/${"a".repeat(129)}`, "/activities/%E0%A4%A"])(
    "404 for %s",
    async (p) => {
      expect((await get(p)).status).toBe(404);
    },
  );
});

describe("OAuth bounce page waits for the app", () => {
  const STATE32 = "A".repeat(10) + "b.c~d-" + "9".repeat(16);
  const page = async (q) => {
    const res = await get(`/intervals/oauth/callback?${q}`);
    return { res, html: await res.text(), csp: res.headers.get("content-security-policy") };
  };
  it("shows a status line and allows only same-origin requests and the one script", async () => {
    const { html, csp, res } = await page(`code=abc&state=${STATE32}`);
    expect(html).toContain('<p id="s">');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
    const hash = createHash("sha256").update(script).digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(script).toContain("/intervals/oauth/status");
    expect(script).toContain(`ridrs://oauth/intervals?code=abc&state=${STATE32}`);
    expect(script).toContain("Connected. You can close this page.");
    expect(script).toContain("The connection failed. Go back to ridrs and try again.");
    expect(script).toContain("Nothing heard from the app. Is ridrs open?");
  });
  it("does not poll after a denied sign-in", async () => {
    const { html, csp } = await page(`error=access_denied&state=${STATE32}`);
    expect(html).toContain("Sign-in was cancelled");
    expect(html).not.toContain("/intervals/oauth/status");
    expect(csp).not.toContain("connect-src");
  });
  it("keeps the activity bounce without polling", async () => {
    const res = await get("/activities/abc");
    expect(res.headers.get("content-security-policy")).not.toContain("connect-src");
    expect(await res.text()).not.toContain("/intervals/oauth/status");
  });
});

describe("OAuth result", () => {
  const STATE = "S".repeat(40);
  let env;
  beforeEach(() => {
    env = makeEnv();
  });
  const post = (path, body, { type = "application/json", ip = "9.9.9.9" } = {}) =>
    route(
      new Request(`https://ridrs.app${path}`, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { ...(type ? { "content-type": type } : {}), "cf-connecting-ip": ip },
      }),
      env,
    );
  const report = (state, ok, o) => post("/intervals/oauth/result", { state, ok }, o);
  const status = async (state, o) => {
    const res = await post("/intervals/oauth/status", { state }, o);
    expect(res.status).toBe(200);
    return (await res.json()).status;
  };

  it("is pending until the app reports, then ok", async () => {
    expect(await status(STATE)).toBe("pending");
    const res = await report(STATE, true);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await status(STATE)).toBe("ok");
    expect(await status("T".repeat(40))).toBe("pending");
  });
  it("reports failed", async () => {
    expect((await report(STATE, false)).status).toBe(204);
    expect(await status(STATE)).toBe("failed");
  });
  it("first write wins", async () => {
    await report(STATE, false);
    expect((await report(STATE, true)).status).toBe(204);
    expect(await status(STATE)).toBe("failed");
  });
  it("stores only a hash of the state", async () => {
    await report(STATE, true);
    const rows = env.DB.raw.prepare("SELECT * FROM oauth_results").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].state_hash).toBe(createHash("sha256").update(STATE).digest("base64url"));
    expect(JSON.stringify(rows)).not.toContain(STATE);
  });
  it.each([
    ["short state", { state: "short", ok: true }],
    ["long state", { state: "a".repeat(129), ok: true }],
    ["bad characters", { state: "a".repeat(20) + "/", ok: true }],
    ["ok not boolean", { state: "a".repeat(20), ok: "true" }],
    ["ok missing", { state: "a".repeat(20) }],
    ["state not a string", { state: 5, ok: true }],
    ["array", [1]],
    ["not json", "nope"],
  ])("rejects %s", async (_n, body) => {
    expect((await post("/intervals/oauth/result", body)).status).toBe(400);
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM oauth_results").get().n).toBe(0);
  });
  it("rejects a wrong content type, a big body and other methods", async () => {
    expect((await post("/intervals/oauth/result", { state: STATE, ok: true }, { type: "text/plain" })).status).toBe(415);
    expect((await post("/intervals/oauth/result", { state: STATE, ok: true }, { type: null })).status).toBe(415);
    expect((await post("/intervals/oauth/result", { state: STATE, ok: true, pad: "x".repeat(600) })).status).toBe(413);
    expect((await post("/intervals/oauth/status", "x".repeat(600))).status).toBe(413);
    const get = await route(new Request("https://ridrs.app/intervals/oauth/status"), env);
    expect(get.status).toBe(405);
    expect((await route(new Request("https://ridrs.app/intervals/oauth/result"), env)).status).toBe(405);
  });
  it("validates the status query like the report", async () => {
    expect((await post("/intervals/oauth/status", { state: "short" })).status).toBe(400);
    expect((await post("/intervals/oauth/status", {}, {})).status).toBe(400);
  });
  it("rate limits per IP", async () => {
    let last;
    for (let i = 0; i < 1201; i++) last = await post("/intervals/oauth/status", { state: STATE }, { ip: "1.1.1.1" });
    expect(last.status).toBe(429);
    expect((await post("/intervals/oauth/status", { state: STATE }, { ip: "2.2.2.2" })).status).toBe(200);
  });
  it("forgets a result after ten minutes", async () => {
    await report(STATE, true);
    const old = Math.floor(Date.now() / 1000) - 11 * 60;
    env.DB.raw.prepare("UPDATE oauth_results SET created_at = ?").run(old);
    expect(await status(STATE)).toBe("pending");
    await scheduled(env);
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM oauth_results").get().n).toBe(0);
  });
  it("purges old rows when a new one is written", async () => {
    await report(STATE, true);
    env.DB.raw.prepare("UPDATE oauth_results SET created_at = 1").run();
    await report("U".repeat(40), true);
    expect(env.DB.raw.prepare("SELECT COUNT(*) n FROM oauth_results").get().n).toBe(1);
  });
});
