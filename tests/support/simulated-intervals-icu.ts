// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { SimulatedMailbox } from './simulated-mailbox.ts';

/**
 * intervals.icu, the system browser and the secret store for the training scenarios (ADR 0048).
 * The plugins see it through the capabilities `net.http`, `auth.browser-sign-in` and
 * `storage.secrets`; the steps drive the athlete's side. It answers like the real API for the
 * paths ridrs uses and rejects everything else, so a wrong request fails the scenario.
 */

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array<ArrayBuffer>;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SignInRequest {
  authorizationUrl(redirectUri: string): string;
  readonly callbackPath: string;
  readonly relayRedirectUri?: string;
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

/** An activity file as `POST /api/v1/athlete/{id}/activities` received it. */
export interface UploadedActivity {
  readonly externalId: string | null;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

const API = 'https://intervals.icu';
export const LOOPBACK_PORT = 53682;
const ISSUED_TOKEN = 'simulated-token-7f3a9c';
const ISSUED_CODE = 'simulated-code-41d2';

export class SimulatedIntervalsIcu {
  athlete = { id: 'i4711', name: 'Athlete', ftp: 200, weight: 70 };
  /** The indoor FTP of the Ride settings, when the athlete set one. */
  indoorFtp: number | undefined;
  /** The zones of the Ride settings (`power_zones`, `power_zone_names`, `hr_zones`, `hr_zone_names`), as `PUT sport-settings/Ride` keeps them. */
  rideZones: Record<string, unknown> = {};
  /** Wellness weights by date (`GET …/wellness/{date}`); a day without one answers 404. */
  readonly wellnessWeights = new Map<string, number>();
  events: PlannedEvent[] = [];
  /** The activities `GET …/activities` returns (the fields ridrs reads). */
  activities: Array<Record<string, unknown>> = [];
  /** The writes to events, in order: the method, the name of the event and the body. */
  readonly eventLog: Array<{ method: string; name: string; body: Record<string, unknown> }> = [];
  /** The workouts of the library as `GET …/workouts` returns them, and its folders. */
  library: Array<Record<string, unknown>> = [];
  folders: Array<{ id: number; name: string; type: string }> = [];
  /** The token has the scope of the library; without it the library answers 403. */
  libraryScope = true;
  reachable = true;
  /** The relay of ridrs (ADR 0079), reached through the same `net.http`; its requests are not intervals.icu's. */
  readonly mailbox = new SimulatedMailbox(() => this.validToken);
  /** Uploads fail as if the network were gone, while everything else answers. */
  uploadsReachable = true;
  /** Writes answer this status (403: the token lacks the scope); 200 accepts them. */
  writeStatus = 200;
  /** Writes wait here until `answerWrites` lets them through: the answer is still on its way. */
  holdWrites = false;
  private readonly held: Array<() => void> = [];
  answerWrites(): void {
    this.holdWrites = false;
    for (const release of this.held.splice(0)) release();
  }
  /** Writes fail as if the network were gone, while reads answer. */
  writesReachable = true;
  /** The status of the next uploads; 201 creates the activity. */
  uploadStatus = 201;
  readonly uploads: UploadedActivity[] = [];
  /** The token the API accepts; `undefined` rejects every token. */
  validToken: string | undefined = ISSUED_TOKEN;
  readonly token = ISSUED_TOKEN;
  readonly requests: HttpRequest[] = [];
  /** When each request arrived (epoch ms), in the order of `requests`. */
  readonly requestTimes: number[] = [];
  /** Every request answers 429 with this `Retry-After` (seconds) while it is set. */
  rateLimit: { readonly retryAfterSeconds: number } | undefined;

  /** Reads wait here until `answerReads` lets them through: the answers are still on their way. */
  holdReads = false;
  private readonly heldReads: Array<() => void> = [];
  answerReads(): void {
    this.holdReads = false;
    for (const release of this.heldReads.splice(0)) release();
  }

  /** The requests so far as `METHOD /path` (without the query), for the counting steps. */
  requestLines(): string[] {
    return this.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
  }

  /** How many requests matched `METHOD /path`; `*` at the end of the path matches any rest. */
  countRequests(call: string): number {
    const pattern = new RegExp(
      `^${call.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return this.requestLines().filter((line) => pattern.test(line)).length;
  }
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
      const relay = this.mailbox.handle(request);
      if (relay) {
        return relay;
      }
      this.requests.push(request);
      this.requestTimes.push(Date.now());
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
      if (this.rateLimit) {
        return {
          status: 429,
          headers: { 'retry-after': String(this.rateLimit.retryAfterSeconds) },
          body: '',
        };
      }
      if (!this.authorized(request)) {
        return json(401, { error: 'Unauthorized' });
      }
      if (this.holdReads && request.method === 'GET') {
        await new Promise<void>((resolve) => this.heldReads.push(resolve));
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
              ...(this.indoorFtp === undefined ? {} : { indoor_ftp: this.indoorFtp }),
              lthr: 165,
              max_hr: 185,
              ...this.rideZones,
            },
            { types: ['Run', 'VirtualRun'], ftp: null, lthr: 170, max_hr: 190 },
          ],
        });
      }
      if (this.holdWrites && request.method !== 'GET' && url.pathname.includes('/events')) {
        await new Promise<void>((resolve) => this.held.push(resolve));
      }
      const write = this.write(request, url);
      if (write) {
        return write;
      }
      const wellness = /^\/api\/v1\/athlete\/0\/wellness\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
      if (request.method === 'GET' && wellness) {
        const date = wellness[1] ?? '';
        const weight = this.wellnessWeights.get(date);
        return weight === undefined
          ? json(404, { error: 'No wellness record' })
          : json(200, { id: date, weight });
      }
      if (
        request.method === 'GET' &&
        (url.pathname === '/api/v1/athlete/0/workouts' ||
          url.pathname === '/api/v1/athlete/0/folders')
      ) {
        if (!this.libraryScope) {
          return json(403, { error: 'Forbidden' });
        }
        return json(200, url.pathname.endsWith('/workouts') ? this.library : this.folders);
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/athlete/0/activities') {
        const oldest = url.searchParams.get('oldest') ?? '';
        const newest = url.searchParams.get('newest') ?? '';
        return json(
          200,
          this.activities.filter((activity) => {
            const date = String(activity.start_date_local).slice(0, 10);
            return date >= oldest && date <= newest;
          }),
        );
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
      if (request.method === 'POST' && url.pathname === '/api/v1/athlete/0/activities') {
        return this.upload(request, url);
      }
      if (request.method === 'DELETE' && url.pathname === '/api/v1/disconnect-app') {
        this.validToken = undefined;
        return json(200, {});
      }
      return json(404, { error: `No route ${request.method} ${url.pathname}` });
    },
  };

  /** The writes of the profile; `undefined` for any other request. */
  private write(request: HttpRequest, url: URL): HttpResponse | undefined {
    const eventPath = /^\/api\/v1\/athlete\/0\/events(?:\/(\d+))?$/.exec(url.pathname);
    if (eventPath && request.method !== 'GET') {
      return this.writeEvent(request, eventPath[1]);
    }
    const wellness = /^\/api\/v1\/athlete\/0\/wellness\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
    const settings = url.pathname === '/api/v1/athlete/0/sport-settings/Ride';
    if (request.method !== 'PUT' || (!wellness && !settings)) {
      return undefined;
    }
    if (!this.writesReachable) {
      throw new Error('connect ETIMEDOUT intervals.icu');
    }
    if (this.writeStatus !== 200) {
      return json(this.writeStatus, { error: 'Forbidden' });
    }
    const body = JSON.parse(typeof request.body === 'string' ? request.body : '{}') as {
      weight?: number;
      ftp?: number;
      indoor_ftp?: number;
    };
    if (wellness && typeof body.weight === 'number') {
      this.wellnessWeights.set(wellness[1] ?? '', body.weight);
    }
    if (settings && typeof body.ftp === 'number') {
      this.athlete.ftp = body.ftp;
    }
    if (settings && typeof body.indoor_ftp === 'number') {
      this.indoorFtp = body.indoor_ftp;
    }
    if (settings) {
      for (const field of ['power_zones', 'power_zone_names', 'hr_zones', 'hr_zone_names']) {
        if (field in body) {
          this.rideZones[field] = (body as Record<string, unknown>)[field];
        }
      }
    }
    return json(200, { ...body });
  }

  /** `POST` creates an event, `PUT …/{id}` changes it, `DELETE …/{id}` removes it. */
  private writeEvent(request: HttpRequest, id: string | undefined): HttpResponse {
    if (!this.writesReachable) {
      throw new Error('connect ETIMEDOUT intervals.icu');
    }
    if (this.writeStatus !== 200) {
      return json(this.writeStatus, { error: 'Forbidden' });
    }
    const body = JSON.parse(typeof request.body === 'string' ? request.body : '{}') as Record<
      string,
      unknown
    >;
    const existing = this.events.find((event) => String(event.id) === id);
    this.eventLog.push({
      method: request.method,
      name: existing?.name ?? String(body.name ?? ''),
      body,
    });
    if (request.method === 'POST') {
      const created = { ...body, id: 80_000 + this.eventLog.length } as unknown as PlannedEvent;
      this.events.push(created);
      return json(200, created);
    }
    if (!existing) {
      return json(404, { error: 'No such event' });
    }
    if (request.method === 'DELETE') {
      this.events = this.events.filter((event) => event !== existing);
      return json(200, {});
    }
    Object.assign(existing, body);
    return json(200, existing);
  }

  /** Multipart with the activity in `file`, as the API takes it; a token without the scope gets 403. */
  private async upload(request: HttpRequest, url: URL): Promise<HttpResponse> {
    if (!this.uploadsReachable) {
      throw new Error('connect ETIMEDOUT intervals.icu');
    }
    if (this.uploadStatus !== 201) {
      return json(this.uploadStatus, { error: 'Upload refused' });
    }
    const contentType = Object.entries(request.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1];
    const form = await new Response(request.body, {
      headers: contentType ? { 'content-type': contentType } : {},
    }).formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return json(422, { error: 'No file' });
    }
    this.uploads.push({
      externalId: url.searchParams.get('external_id'),
      fileName: file instanceof File ? file.name : '',
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json(201, [{ icu_athlete_id: this.athlete.id, id: `i${90_000 + this.uploads.length}` }]);
  }

  private authorized(request: HttpRequest): boolean {
    const header = Object.entries(request.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    return this.validToken !== undefined && header === `Bearer ${this.validToken}`;
  }

  /** The verifier of every token request, and whether a secret came along. */
  readonly exchanges: Array<{ readonly fields: URLSearchParams; readonly accepted: boolean }> = [];

  /** The token endpoint refuses the code (a used or expired one). */
  rejectCodes = false;

  private exchange(request: HttpRequest): HttpResponse {
    const fields = new URLSearchParams(typeof request.body === 'string' ? request.body : '');
    const challenge = this.lastAuthorization?.searchParams.get('code_challenge');
    const verifier = fields.get('code_verifier') ?? '';
    const accepted =
      !this.rejectCodes &&
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

  /** The system receives `ridrs://` links: the sign-in uses the relay's redirect URI (ADR 0079). */
  deepLinks = false;

  readonly signIn = {
    get deepLink(): boolean {
      return this.owner.deepLinks;
    },
    owner: this as SimulatedIntervalsIcu,
    signIn: (request: SignInRequest): Promise<SignInResult> => {
      const redirectUri =
        this.deepLinks && request.relayRedirectUri
          ? request.relayRedirectUri
          : `http://127.0.0.1:${LOOPBACK_PORT}${request.callbackPath}`;
      const url = new URL(request.authorizationUrl(redirectUri));
      this.openedUrls.push(url.toString());
      this.lastAuthorization = url;
      return new Promise((resolve, reject) => {
        this.pendingSignIn = { url, redirectUri, resolve, reject };
      });
    },
  };

  /** What the sign-in resolved with last. */
  lastCallbackUrl?: string;

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
    // Through the relay the browser ends in the app's deep link, with the same query.
    const callback = new URL(
      pending.redirectUri.startsWith('https://') ? 'ridrs://oauth/intervals' : pending.redirectUri,
    );
    for (const [name, value] of Object.entries(params)) {
      callback.searchParams.set(name, value);
    }
    this.lastCallbackUrl = callback.toString();
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
