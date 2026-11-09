// SPDX-License-Identifier: AGPL-3.0-or-later

import { cancel, onUrl, start } from '@fabianlars/tauri-plugin-oauth';
import {
  appLinkState,
  authBrowserSignInCapability,
  type BrowserSignIn,
  definePlugin,
  type PluginContext,
  RidrsError,
  recordingRideState,
} from '@ridrs/contracts';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { parseDeepLink, sessionForLink } from './deep-link.ts';

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
/**
 * `tauri dev` on the Mac does not register URL schemes, so there the sign-in stays on the
 * loopback (ADR 0079); a build registers `ridrs://` and uses the relay's redirect.
 */
const SCHEME_REGISTERED = (import.meta as { env?: { DEV?: boolean } }).env?.DEV !== true;

/** The sign-in that waits for the relay's deep link, if one is running. */
let pendingLink: { resolve(url: string): void } | undefined;

const tauriSignIn: BrowserSignIn = {
  deepLink: SCHEME_REGISTERED,
  async signIn({ authorizationUrl, callbackPath, relayRedirectUri }) {
    if (SCHEME_REGISTERED && relayRedirectUri) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const callbackUrl = await new Promise<string>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new RidrsError('sign-in-cancelled', 'The sign-in timed out')),
            TIMEOUT_MS,
          );
          pendingLink = { resolve };
          openUrl(authorizationUrl(relayRedirectUri)).catch(reject);
        });
        return { redirectUri: relayRedirectUri, callbackUrl };
      } finally {
        clearTimeout(timer);
        pendingLink = undefined;
      }
    }
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

/**
 * Hands a link to whoever waits for it: the answer of a sign-in goes to the pending sign-in (its
 * state is checked by the planner, as for the loopback); a ride goes to `app.link` when it exists
 * on this device. A link that started the app has no sign-in to answer and is ignored then.
 */
function handleLinks(ctx: PluginContext, urls: readonly string[] | null | undefined): void {
  for (const raw of urls ?? []) {
    const link = parseDeepLink(raw);
    if (link?.kind === 'oauth') {
      pendingLink?.resolve(link.url);
    } else if (link?.kind === 'activity') {
      const sessionId = sessionForLink(ctx.state.entries(recordingRideState).keys(), link.sessionId);
      if (sessionId !== undefined) {
        ctx.state.set(appLinkState, 'activity', { sessionId, at: ctx.clock.now() });
      }
    }
  }
}

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(authBrowserSignInCapability, tauriSignIn);
  },
  start(ctx) {
    // Not a Tauri webview (a headless run): no links, no error.
    onOpenUrl((urls) => handleLinks(ctx, urls)).catch(() => undefined);
    getCurrent()
      .then((urls) => handleLinks(ctx, urls))
      .catch(() => undefined);
  },
});
