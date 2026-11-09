// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { linkIdOf } from '@ridrs/contracts';
import { parseDeepLink, sessionForLink } from './deep-link.ts';

describe('parseDeepLink', () => {
  it('knows the sign-in answer and an activity', () => {
    expect(parseDeepLink('ridrs://oauth/intervals?code=c&state=s')).toEqual({
      kind: 'oauth',
      url: 'ridrs://oauth/intervals?code=c&state=s',
    });
    expect(parseDeepLink('ridrs://activity/session-1.a_b')).toEqual({ kind: 'activity', sessionId: 'session-1.a_b' });
  });

  it('ignores everything else', () => {
    for (const link of [
      'https://ridrs.app/activities/x',
      'ridrs://oauth/other',
      'ridrs://activity/',
      'ridrs://activity/a%2Fb',
      `ridrs://activity/${'a'.repeat(129)}`,
      'ridrs://unknown/x',
      'ridrs://user:pw@activity/x',
      'not a url',
    ]) {
      expect(parseDeepLink(link)).toBeUndefined();
    }
  });
});

describe('a ride named in a link', () => {
  it('is found by the form of its session id that the upload sends, also with colons', () => {
    const session = '3ad2129d6adf605c:activity-session:1793775600080:0';
    expect(linkIdOf(session)).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    const link = parseDeepLink(`ridrs://activity/${linkIdOf(session)}`);
    expect(link).toEqual({ kind: 'activity', sessionId: linkIdOf(session) });
    expect(sessionForLink(['other:1', session], linkIdOf(session))).toBe(session);
    expect(sessionForLink(['other:1'], linkIdOf(session))).toBeUndefined();
  });
});
