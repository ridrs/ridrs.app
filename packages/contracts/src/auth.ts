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
}

export interface BrowserSignInRequest {
  /** Builds the service's authorization URL for the redirect URI the provider listens on. */
  authorizationUrl(redirectUri: string): string;
  /** The path of the redirect URI, e.g. `/oauth/callback`. */
  readonly callbackPath: string;
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
