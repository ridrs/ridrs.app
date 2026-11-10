// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HttpRequest, HttpResponse } from '@ridrs/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMailbox, mailboxConfig } from './mailbox.ts';

const mailboxWith = (request: (r: HttpRequest) => Promise<HttpResponse>) =>
  createMailbox({
    http: { request },
    secrets: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    files: {} as never,
    logger: { warn: () => {} },
    nowSeconds: () => 0,
  });

afterEach(() => vi.useRealTimers());

describe('reportSignIn', () => {
  it('posts the state and the outcome, unsigned, to the relay', async () => {
    const sent: HttpRequest[] = [];
    await mailboxWith(async (r) => {
      sent.push(r);
      return { status: 204, headers: {}, body: '' };
    }).reportSignIn('s'.repeat(32), true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${mailboxConfig.baseUrl}/intervals/oauth/result`);
    expect(JSON.parse(String(sent[0]?.body))).toEqual({ state: 's'.repeat(32), ok: true });
    expect(Object.keys(sent[0]?.headers ?? {})).toEqual(['content-type']);
  });

  it('swallows a failing request', async () => {
    await expect(
      mailboxWith(async () => {
        throw new Error('offline');
      }).reportSignIn('s'.repeat(32), false),
    ).resolves.toBeUndefined();
  });

  it('gives up on a request that hangs', async () => {
    vi.useFakeTimers();
    const done = mailboxWith(() => new Promise<HttpResponse>(() => {})).reportSignIn('s', true);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBeUndefined();
  });
});
