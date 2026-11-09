// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HttpClient, HttpRequest, HttpResponse, PluginLogger } from '@ridrs/contracts';
import { localDate } from './intervals.ts';

/**
 * The one way out to intervals.icu (ADR 0076): every request, read, write or upload, goes through
 * `request`. It paces them (at most 5 a second, writes a little wider), puts writes in the same
 * queue as loads, counts them by purpose, and on 429 stops: nothing is sent until the time of
 * `Retry-After` has passed, and nothing is ever retried by itself.
 */

/** Why a request is made; the counter groups by it. */
export type Purpose =
  | 'athlete'
  | 'events'
  | 'history'
  | 'library'
  | 'profile-write'
  | 'calendar-write'
  | 'upload'
  | 'auth';

export interface Pacing {
  /** Time between two requests: 200 ms is 5 a second. */
  minIntervalMs: number;
  /** Time after a write before the next request. */
  writeSpacingMs: number;
}

/** The pacing of the app. Scenarios set it to zero; a unit test covers the real values. */
export const pacing: Pacing = { minIntervalMs: 200, writeSpacingMs: 250 };

/** The service said 429: nothing is sent before `retryAfterMs` has passed. */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`intervals.icu asks for ${Math.round(retryAfterMs / 1000)} s of rest`);
  }
}

export interface RequestCounts {
  readonly total: number;
  readonly byPurpose: Readonly<Partial<Record<Purpose, number>>>;
}

export interface GatewayOptions {
  readonly http: HttpClient;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger: Pick<PluginLogger, 'info'>;
  readonly pacing?: Pacing;
}

export interface Gateway {
  request(purpose: Purpose, request: HttpRequest): Promise<HttpResponse>;
  /** What was sent today (the local day of the last request). */
  counts(): RequestCounts;
}

const DEFAULT_RETRY_AFTER_MS = 60_000;
const WINDOW_MS = 15 * 60_000;

/** `Retry-After` is seconds, or an HTTP date. */
function retryAfter(headers: HttpResponse['headers'], now: number): number {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (value === undefined) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  if (/^\d+$/.test(value.trim())) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : DEFAULT_RETRY_AFTER_MS;
}

export function createGateway(options: GatewayOptions): Gateway {
  const { http, now, logger } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pace = options.pacing ?? pacing;
  let tail: Promise<unknown> = Promise.resolve();
  let nextAt = 0;
  let blockedUntil = 0;
  let day = '';
  let dayTotal = 0;
  const byPurpose = new Map<Purpose, number>();
  const windows = new Map<string, number>();

  const count = (purpose: Purpose, at: number) => {
    const today = localDate(at);
    if (today !== day) {
      day = today;
      dayTotal = 0;
      byPurpose.clear();
      windows.clear();
    }
    const start = new Date(Math.floor(at / WINDOW_MS) * WINDOW_MS);
    const pad = (n: number) => String(n).padStart(2, '0');
    const window = `${today} ${pad(start.getHours())}:${pad(start.getMinutes())}`;
    dayTotal++;
    byPurpose.set(purpose, (byPurpose.get(purpose) ?? 0) + 1);
    const key = `${window}|${purpose}`;
    windows.set(key, (windows.get(key) ?? 0) + 1);
    // The counter is the log: one line per request, with how many of its purpose this window.
    logger.info({ purpose, window, count: windows.get(key), dayTotal }, 'intervals.icu: request');
  };

  const send = async (purpose: Purpose, request: HttpRequest): Promise<HttpResponse> => {
    if (now() < blockedUntil) {
      throw new RateLimited(blockedUntil - now());
    }
    const wait = nextAt - now();
    if (wait > 0) {
      await sleep(wait);
    }
    count(purpose, now());
    const write = request.method !== 'GET';
    nextAt = now() + (write ? pace.writeSpacingMs : pace.minIntervalMs);
    const response = await http.request(request);
    nextAt = now() + (write ? pace.writeSpacingMs : pace.minIntervalMs);
    if (response.status === 429) {
      const rest = retryAfter(response.headers, now());
      blockedUntil = now() + rest;
      throw new RateLimited(rest);
    }
    return response;
  };

  return {
    request(purpose, request) {
      const result = tail.then(() => send(purpose, request));
      // The next one waits for this one, whether it worked or not.
      tail = result.catch(() => undefined);
      return result;
    },
    counts: () => ({ total: dayTotal, byPurpose: Object.fromEntries(byPurpose) }),
  };
}
