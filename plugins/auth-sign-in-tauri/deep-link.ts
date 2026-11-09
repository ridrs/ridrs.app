// SPDX-License-Identifier: AGPL-3.0-or-later

import { linkIdOf } from '@ridrs/contracts';

/**
 * The deep links of ridrs (ADR 0079). A link is untrusted input: its shape is checked, and
 * anything that is not exactly one of these is ignored.
 *
 * - `ridrs://oauth/intervals?code=…&state=…`: the answer of the sign-in, bounced by the relay.
 * - `ridrs://activity/<external_id>`: a ride of this device (`^[A-Za-z0-9._-]{1,128}$`).
 */
export type DeepLink =
  | { readonly kind: 'oauth'; readonly url: string }
  | { readonly kind: 'activity'; readonly sessionId: string };

const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function parseDeepLink(raw: string): DeepLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'ridrs:' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  if (url.hostname === 'oauth' && url.pathname === '/intervals') {
    return { kind: 'oauth', url: url.toString() };
  }
  if (url.hostname === 'activity') {
    const id = decodeURIComponent(url.pathname.slice(1));
    return EXTERNAL_ID.test(id) ? { kind: 'activity', sessionId: id } : undefined;
  }
  return undefined;
}


/** The session a link names: the one whose `linkIdOf` it is, the same mapping the upload uses. */
export const sessionForLink = (sessionIds: Iterable<string>, linkId: string): string | undefined =>
  [...sessionIds].find((sessionId) => linkIdOf(sessionId) === linkId);
