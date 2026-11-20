// SPDX-License-Identifier: AGPL-3.0-or-later
// ridrs Scenic (web/scenic) is its own Worker; ridrs.app hands every request under /scenic to it through the
// Service Binding SCENIC, unchanged (URL, method, headers, body), so its Access check and CSRF guard keep working.
import { describe, expect, it } from "vitest";
import { route } from "../src/router.js";
import { landingPage } from "../src/landing.js";

function scenicStub() {
  const seen = [];
  return {
    seen,
    fetch: async (request) => {
      seen.push({ url: request.url, method: request.method, origin: request.headers.get("origin"), body: request.body ? await request.text() : null });
      return new Response("from scenic", { status: 207 });
    },
  };
}

describe("/scenic goes to the ridrs Scenic worker", () => {
  it("forwards the page, the API and the admin with the original request", async () => {
    const SCENIC = scenicStub();
    for (const path of ["/scenic", "/scenic/", "/scenic/api/points?x=1", "/scenic/admin/"]) {
      const res = await route(new Request(`https://ridrs.app${path}`), { SCENIC });
      expect(res.status).toBe(207);
      expect(await res.text()).toBe("from scenic");
    }
    expect(SCENIC.seen.map((r) => r.url)).toEqual([
      "https://ridrs.app/scenic",
      "https://ridrs.app/scenic/",
      "https://ridrs.app/scenic/api/points?x=1",
      "https://ridrs.app/scenic/admin/",
    ]);
  });

  it("keeps method, headers and body of an admin write", async () => {
    const SCENIC = scenicStub();
    await route(new Request("https://ridrs.app/scenic/api/admin/collections", {
      method: "POST", headers: { origin: "https://ridrs.app", "content-type": "application/json" }, body: '{"title":"Pässe"}',
    }), { SCENIC });
    expect(SCENIC.seen[0]).toEqual({ url: "https://ridrs.app/scenic/api/admin/collections", method: "POST", origin: "https://ridrs.app", body: '{"title":"Pässe"}' });
  });

  it("leaves other paths alone", async () => {
    const SCENIC = scenicStub();
    expect(await route(new Request("https://ridrs.app/scenicx"), { SCENIC })).toBeNull();
    expect(await route(new Request("https://ridrs.app/"), { SCENIC })).toBeNull();
    expect(SCENIC.seen).toEqual([]);
  });

  it("answers 503 when the binding is missing (ridrs.app started alone)", async () => {
    const res = await route(new Request("https://ridrs.app/scenic/"), {});
    expect(res.status).toBe(503);
  });

  it("the landing page links to ridrs Scenic", () => {
    expect(landingPage).toContain('href="/scenic/"');
  });
});
