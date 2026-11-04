// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, type HttpClient, netHttpCapability } from '@ridrs/contracts';
import { fetch } from '@tauri-apps/plugin-http';

/**
 * `net.http` in the native app (ADR 0049): requests run in Rust through the official Tauri http
 * plugin, so the webview's CSP stays closed and CORS does not apply. Which URLs are allowed is
 * the plugin's scope in `src-tauri/capabilities/default.json`.
 */
const tauriHttp: HttpClient = {
  async request({ method, url, headers, body }) {
    const response = await fetch(url, { method, headers, body });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(netHttpCapability, tauriHttp);
  },
});
