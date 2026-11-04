// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';

/**
 * intervals.icu, the system browser and the OS keychain for the training scenarios (ADR 0048).
 * The plugins see it through the capabilities `net.http`, `auth.browser-sign-in` and
 * `storage.secrets`; the steps drive the athlete's side. It answers like the real API for the
 * paths ridrs uses and rejects everything else, so a wrong request fails the scenario.
 */

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SignInRequest {
  authorizationUrl(redirectUri: string): string;
  readonly callbackPath: string;
}

export interface SignInResult {
  readonly redirectUri: string;
  readonly callbackUrl: string;
}

/** A planned event as `GET /api/v1/athlete/{id}/events` returns it (the fields ridrs reads). */
export interface PlannedEvent {
  id: number;
  start_date_local: string;
  category: 'WORKOUT';
  type: string;
  name: string;
  description?: string;
  moving_time?: number;
  icu_training_load?: number;
  workout_doc?: { steps: unknown[] };
}

const API = 'https://intervals.icu';
export const LOOPBACK_PORT = 53682;
const ISSUED_TOKEN = 'simulated-token-7f3a9c';
const ISSUED_CODE = 'simulated-code-41d2';

export class SimulatedIntervalsIcu {
  athlete = { id: 'i4711', name: 'Athlete', ftp: 200, weight: 70 };
  events: PlannedEvent[] = [];
  reachable = true;
  /** The token the API accepts; `undefined` rejects every token. */
  validToken: string | undefined = ISSUED_TOKEN;
  readonly token = ISSUED_TOKEN;
  readonly requests: HttpRequest[] = [];
  readonly openedUrls: string[] = [];
  readonly secrets = new Map<string, string>();
  private pendingSignIn?: {
    readonly url: URL;
    readonly redirectUri: string;
    resolve(result: SignInResult): void;
    reject(error: Error): void;
  };

  // ---- net.http -------------------------------------------------------------------------

  readonly http = {
    request: async (request: HttpRequest): Promise<HttpResponse> => {
      this.requests.push(request);
      if (!this.reachable) {
        throw new Error('getaddrinfo ENOTFOUND intervals.icu');
      }
      const url = new URL(request.url);
      if (url.origin !== API) {
        return json(404, { error: `Unknown host ${url.origin}` });
      }
      if (request.method === 'POST' && url.pathname === '/api/oauth/token') {
        return this.exchange(request);
      }
      if (!this.authorized(request)) {
        return json(401, { error: 'Unauthorized' });
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/athlete/0') {
        return json(200, {
          id: this.athlete.id,
          name: this.athlete.name,
          icu_weight: this.athlete.weight,
          sportSettings: [
            {
              types: ['Ride', 'VirtualRide', 'GravelRide'],
              ftp: this.athlete.ftp,
              lthr: 165,
              max_hr: 185,
            },
            { types: ['Run', 'VirtualRun'], ftp: null, lthr: 170, max_hr: 190 },
          ],
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/athlete/0/events') {
        const oldest = url.searchParams.get('oldest') ?? '';
        const newest = url.searchParams.get('newest') ?? '';
        const category = url.searchParams.get('category');
        return json(
          200,
          this.events.filter((event) => {
            const date = event.start_date_local.slice(0, 10);
            return (
              date >= oldest &&
              date <= newest &&
              (category === null || category.split(',').includes(event.category))
            );
          }),
        );
      }
      if (request.method === 'DELETE' && url.pathname === '/api/v1/disconnect-app') {
        this.validToken = undefined;
        return json(200, {});
      }
      return json(404, { error: `No route ${request.method} ${url.pathname}` });
    },
  };

  private authorized(request: HttpRequest): boolean {
    const header = Object.entries(request.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    return this.validToken !== undefined && header === `Bearer ${this.validToken}`;
  }

  /** The verifier of every token request, and whether a secret came along. */
  readonly exchanges: Array<{ readonly fields: URLSearchParams; readonly accepted: boolean }> = [];

  private exchange(request: HttpRequest): HttpResponse {
    const fields = new URLSearchParams(request.body ?? '');
    const challenge = this.lastAuthorization?.searchParams.get('code_challenge');
    const verifier = fields.get('code_verifier') ?? '';
    const accepted =
      fields.get('code') === ISSUED_CODE &&
      fields.get('client_id') === this.lastAuthorization?.searchParams.get('client_id') &&
      challenge !== undefined &&
      challenge === createHash('sha256').update(verifier).digest('base64url');
    this.exchanges.push({ fields, accepted });
    if (!accepted) {
      return json(400, { error: 'invalid_grant' });
    }
    this.validToken = ISSUED_TOKEN;
    return json(200, {
      token_type: 'Bearer',
      access_token: ISSUED_TOKEN,
      scope: this.lastAuthorization?.searchParams.get('scope'),
      athlete: { id: this.athlete.id, name: this.athlete.name },
    });
  }

  // ---- auth.browser-sign-in -------------------------------------------------------------

  /** The authorization URL the browser was opened at last. */
  lastAuthorization?: URL;

  readonly signIn = {
    signIn: (request: SignInRequest): Promise<SignInResult> => {
      const redirectUri = `http://127.0.0.1:${LOOPBACK_PORT}${request.callbackPath}`;
      const url = new URL(request.authorizationUrl(redirectUri));
      this.openedUrls.push(url.toString());
      this.lastAuthorization = url;
      return new Promise((resolve, reject) => {
        this.pendingSignIn = { url, redirectUri, resolve, reject };
      });
    },
  };

  /** True while the browser shows the sign-in page. */
  get signInWaiting(): boolean {
    return this.pendingSignIn !== undefined;
  }

  private finishSignIn(params: Record<string, string>): void {
    const pending = this.pendingSignIn;
    if (!pending) {
      throw new Error('No sign-in is waiting for the athlete');
    }
    this.pendingSignIn = undefined;
    const callback = new URL(pending.redirectUri);
    for (const [name, value] of Object.entries(params)) {
      callback.searchParams.set(name, value);
    }
    pending.resolve({ redirectUri: pending.redirectUri, callbackUrl: callback.toString() });
  }

  approve(): void {
    const state = this.pendingSignIn?.url.searchParams.get('state') ?? '';
    this.finishSignIn({ code: ISSUED_CODE, state });
  }

  decline(): void {
    const state = this.pendingSignIn?.url.searchParams.get('state') ?? '';
    this.finishSignIn({ error: 'access_denied', state });
  }

  answerWithForeignState(): void {
    this.finishSignIn({ code: ISSUED_CODE, state: 'not-the-state-ridrs-sent' });
  }

  // ---- storage.secrets ------------------------------------------------------------------

  readonly secretStore = {
    get: async (key: string): Promise<string | undefined> => this.secrets.get(key),
    set: async (key: string, value: string): Promise<void> => {
      this.secrets.set(key, value);
    },
    remove: async (key: string): Promise<void> => {
      this.secrets.delete(key);
    },
  };
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** "1h15m", "40m", "30s" → seconds. */
export function parseDuration(text: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!match || text.trim() === '') {
    throw new Error(`Unrecognized duration "${text}"`);
  }
  const [, h = '0', m = '0', s = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
