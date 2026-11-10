import { route, scheduled } from "./router.js";
import { landingPage } from "./landing.js";

export { MailboxHub } from "./hub.js";

export default {
  async fetch(request, env, ctx) {
    const routed = await route(request, env);
    if (routed) return routed;

    return new Response(landingPage, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "cache-control": "no-cache",
      },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env));
  },
};
