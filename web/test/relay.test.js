import { describe, expect, it } from "vitest";
import { route } from "../src/router.js";

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
