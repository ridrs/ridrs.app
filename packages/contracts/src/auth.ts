// SPDX-License-Identifier: Apache-2.0

import { defineCapability } from './capabilities.ts';

/**
 * An OAuth sign-in in the system browser with a loopback redirect (ADR 0048, 0049). The rider
 * types the password into the service's page, never into ridrs. The provider listens on
 * `127.0.0.1` and a free port while the sign-in runs, opens `authorizationUrl(redirectUri)`, and
 * resolves with the URL the browser was redirected to. It rejects with the code
 * `sign-in-cancelled` when the rider abandons the flow.
 */
export interface BrowserSignIn {
  signIn(request: BrowserSignInRequest): Promise<BrowserSignInResult>;
  /**
   * True when the provider receives `ridrs://` deep links (ADR 0079): a sign-in may then use the
   * redirect URI of the relay (`relayRedirectUri`), which bounces to `ridrs://oauth/…`. False or
   * absent where the scheme is not registered (`tauri dev` on the Mac, headless): the loopback
   * redirect is used.
   */
  readonly deepLink?: boolean;
}

export interface BrowserSignInRequest {
  /** Builds the service's authorization URL for the redirect URI the provider listens on. */
  authorizationUrl(redirectUri: string): string;
  /** The path of the redirect URI, e.g. `/oauth/callback`. */
  readonly callbackPath: string;
  /**
   * The redirect URI of a relay that bounces the answer to the app's deep link. Used only by a
   * provider with `deepLink`, which then resolves with the deep link as `callbackUrl`.
   */
  readonly relayRedirectUri?: string;
}

export interface BrowserSignInResult {
  readonly redirectUri: string;
  /** The full URL the browser was redirected to, with the service's query parameters. */
  readonly callbackUrl: string;
}

export const authBrowserSignInCapability = defineCapability<
  BrowserSignIn,
  'single',
  'auth.browser-sign-in'
>('auth.browser-sign-in', { cardinality: 'single' });
