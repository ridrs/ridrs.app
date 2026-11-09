// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HttpRequest, HttpResponse, PluginLogger } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { createGateway, RateLimited, type RequestCounts } from './gateway.ts';

/** A manual clock whose `sleep` moves time on, so pacing is tested without waiting. */
function harness(answer: (request: HttpRequest) => HttpResponse = () => ok()) {
  let now = Date.UTC(2026, 10, 4, 8, 7, 0);
  const sent: Array<{ at: number; request: HttpRequest }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const gateway = createGateway({
    http: {
      request: async (request) => {
        sent.push({ at: now, request });
        return answer(request);
      },
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    logger: {
      info: ((bindings: Record<string, unknown>) => {
        logs.push(bindings);
      }) as PluginLogger['info'],
    },
    pacing: { minIntervalMs: 200, writeSpacingMs: 250 },
  });
  return { gateway, sent, logs, advance: (ms: number) => (now += ms), at: () => now };
}

const ok = (): HttpResponse => ({ status: 200, headers: {}, body: '{}' });
const get = (path: string): HttpRequest => ({ method: 'GET', url: `https://intervals.icu${path}` });

describe('the intervals.icu gateway', () => {
  it('sends at most 5 requests per second, also when they are asked for at once', async () => {
    const { gateway, sent } = harness();
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((p) => gateway.request('athlete', get(`/${p}`))));
    const times = sent.map((entry) => entry.at);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(200);
    }
    expect(sent.map((entry) => entry.request.url.slice(-1))).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('keeps writes 250 ms from the next request, and queues them with the reads', async () => {
    const { gateway, sent } = harness();
    await Promise.all([
      gateway.request('calendar-write', { method: 'POST', url: 'https://intervals.icu/w1' }),
      gateway.request('events', get('/r')),
      gateway.request('calendar-write', { method: 'DELETE', url: 'https://intervals.icu/w2' }),
    ]);
    expect(sent.map((entry) => entry.request.method)).toEqual(['POST', 'GET', 'DELETE']);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(250);
    expect(sent[2]!.at - sent[1]!.at).toBeGreaterThanOrEqual(200);
  });

  it('honours Retry-After on 429, stops sending, and does not retry', async () => {
    let calls = 0;
    const { gateway, sent, advance } = harness(() => {
      calls++;
      return { status: 429, headers: { 'Retry-After': '30' }, body: '' };
    });
    await expect(gateway.request('events', get('/a'))).rejects.toBeInstanceOf(RateLimited);
    await expect(gateway.request('events', get('/b'))).rejects.toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(calls).toBe(1);
    expect(sent).toHaveLength(1);
    advance(31_000);
    await expect(gateway.request('events', get('/c'))).rejects.toBeInstanceOf(RateLimited);
    expect(calls).toBe(2);
  });

  it('assumes a minute when 429 comes without a usable Retry-After', async () => {
    const { gateway } = harness(() => ({ status: 429, headers: {}, body: '' }));
    await expect(gateway.request('events', get('/a'))).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it('counts requests per day and 15 minutes by purpose, and logs the count', async () => {
    const { gateway, logs, advance } = harness();
    await gateway.request('athlete', get('/a'));
    await gateway.request('events', get('/b'));
    await gateway.request('events', get('/c'));
    const counts: RequestCounts = gateway.counts();
    expect(counts.byPurpose).toMatchObject({ athlete: 1, events: 2 });
    expect(counts.total).toBe(3);
    expect(logs.at(-1)).toMatchObject({ purpose: 'events', window: expect.stringMatching(/^2026-11-0\d \d\d:(00|15|30|45)$/), count: 2, dayTotal: 3 });
    advance(16 * 60_000);
    await gateway.request('events', get('/d'));
    expect(logs.at(-1)).toMatchObject({ count: 1, dayTotal: 4 });
  });
});
