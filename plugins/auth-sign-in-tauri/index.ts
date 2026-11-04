// SPDX-License-Identifier: AGPL-3.0-or-later

import { cancel, onUrl, start } from '@fabianlars/tauri-plugin-oauth';
import {
  authBrowserSignInCapability,
  type BrowserSignIn,
  definePlugin,
  RidrsError,
} from '@ridrs/contracts';
import { openUrl } from '@tauri-apps/plugin-opener';

/** Without a callback by then, the rider has left the sign-in. */
const TIMEOUT_MS = 5 * 60_000;

/** What the browser shows once it has handed the answer to ridrs. */
const RESPONSE = `<!doctype html><html><head><meta charset="utf-8"><title>ridrs</title></head>
<body style="font: 16px system-ui, sans-serif; text-align: center; padding: 48px">
<h1>Signed in</h1><p>You can close this tab and return to ridrs.</p></body></html>`;

/**
 * `auth.browser-sign-in` in the native app (ADR 0049): a one-shot server on 127.0.0.1 and a free
 * port (tauri-plugin-oauth) receives the redirect; the system browser (tauri-plugin-opener) shows
 * the service's page. The server accepts any request on its port, so the caller checks the
 * answer's `state`. One sign-in at a time.
 */
const tauriSignIn: BrowserSignIn = {
  async signIn({ authorizationUrl, callbackPath }) {
    const port = await start({ response: RESPONSE });
    const redirectUri = `http://127.0.0.1:${port}${callbackPath}`;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const callbackUrl = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new RidrsError('sign-in-cancelled', 'The sign-in timed out')),
          TIMEOUT_MS,
        );
        onUrl((url) => resolve(url))
          .then((stop) => {
            unlisten = stop;
            return openUrl(authorizationUrl(redirectUri));
          })
          .catch(reject);
      });
      return { redirectUri, callbackUrl };
    } finally {
      clearTimeout(timer);
      unlisten?.();
      // The server stops by itself after the first callback; this covers the timeout.
      await cancel(port).catch(() => undefined);
    }
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(authBrowserSignInCapability, tauriSignIn);
  },
});
