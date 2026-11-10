// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AppFiles,
  type AthleteProfile,
  athleteProfileSchema,
  athleteProfileState,
  athleteProfileUpdateService,
  libraryWorkoutSchema,
  linkIdOf,
  authBrowserSignInCapability,
  definePlugin,
  type HttpResponse,
  type CompletedWorkout,
  completedWorkoutSchema,
  type LibraryWorkout,
  type DataSourceStatus,
  type DataWriteResult,
  netHttpCapability,
  netWebSocketCapability,
  type PlannedWorkout,
  type PluginContext,
  RidrsError,
  recordingRideState,
  type Secrets,
  storageAppFilesCapability,
  storageSecretsCapability,
  type TrainingAccount,
  trainingAccountState,
  trainingCalendarMoveService,
  trainingCalendarPlanService,
  trainingCalendarRemoveService,
  trainingCalendarSchema,
  trainingCalendarState,
  trainingConnectService,
  trainingDisconnectService,
  trainingHistoryState,
  trainingLibraryLoadService,
  trainingLibraryState,
  trainingRefreshService,
  type TrainingUpload,
  trainingUploadService,
  trainingUploadState,
} from '@ridrs/contracts';
import { createGateway, type Gateway, type Purpose, RateLimited } from './gateway.ts';
import { ftpField, libraryDocs, localDate, toActivities, toAthlete, toLibrary, toWorkouts } from './intervals.ts';
import { createMailbox, mailboxConfig } from './mailbox.ts';
import { createMailboxSocket } from './mailbox-socket.ts';
import { type Applied, interpret, newApplied } from './mailbox-events.ts';
import { codeChallenge, randomUnreserved } from './pkce.ts';

/** The public OAuth client "Ridrs.APP" (ADR 0048): configuration, not a secret. */
const CLIENT_ID = '1697';
/**
 * The OAuth scopes (names and their `:READ`/`:WRITE` form confirmed on intervals.icu's OAuth
 * support thread, https://forum.intervals.icu/t/intervals-icu-oauth-support/2759; WRITE includes
 * READ). `WELLNESS` reads and writes the weight, `SETTINGS` writes the FTP, `CALENDAR` reads and
 * writes the planned workouts, `LIBRARY` reads the workout library. A token from before lacks them: the wellness read gets 403, which only leaves
 * the weight of the athlete in its place, the library read gets 403, which leaves the library
 * unavailable, and a write gets 403, which asks the rider to connect again.
 */
const SCOPES = 'SETTINGS:WRITE,CALENDAR:WRITE,WELLNESS:WRITE,LIBRARY:READ,ACTIVITY:WRITE';
const SITE = 'https://intervals.icu';
const CALLBACK_PATH = '/oauth/callback';
/** The redirect URI of the relay, registered with the OAuth client: it bounces to `ridrs://oauth/intervals`. */
const RELAY_CALLBACK_PATH = '/intervals/oauth/callback';
/** The planned workouts of today and the next 13 days. */
const PLAN_DAYS = 14;
const TOKEN_KEY = 'intervals-icu.token';
const CACHE_FILE = 'training/intervals-icu-plan.json';
const SERVICE = 'intervals.icu';
const LABEL = 'intervals.icu';

/** How many days of done rides are read. */
const HISTORY_DAYS = 14;

/**
 * How long what was read stays valid (ADR 0078). `events` are the planned workouts with the rides
 * done (the plan and its mirror), `library` the workouts and folders. Nothing reloads on a timer
 * or on focus: a stale resource is read when it is asked for (start, refresh, saved ride, library
 * shown), and shown from the cache meanwhile.
 */
const VALIDITY_MS = { athlete: 60 * 60_000, events: 15 * 60_000, library: 24 * 60 * 60_000 } as const;
type Stamped = keyof typeof VALIDITY_MS;
/** `settings` is the athlete's settings alone (one request): the mailbox says they changed (ADR 0079). */
type Resource = Stamped | 'settings';

/** The refresh button reads again at most once a minute. */
const REFRESH_COOLDOWN_MS = 60_000;

/** The open socket of each running plugin, closed when it stops. */
const sockets = new WeakMap<PluginContext, { stop(): void }>();

/** The service answered 401 or 403: the token is no longer valid. */
class TokenRejected extends Error {}

/** What is kept for a start without network. */
interface Cache {
  /** When the latest resource was read. Old readers of the file need it. */
  readonly fetchedAt: number;
  /** When each resource was read; a cache from before has none, and every resource is stale. */
  readonly fetched?: Partial<Record<Stamped, number>>;
  readonly athlete: AthleteProfile;
  /** The field of the Ride settings the FTP was read from, which a change is written to. */
  readonly ftpField: 'indoor_ftp' | 'ftp';
  readonly workouts: PlannedWorkout[];
  /** The rides done in the last days (ADR 0076); none from before, or without the scope. */
  readonly history?: CompletedWorkout[];
  /** None when the token lacks the scope of the library, or before it was loaded. */
  readonly library?: LibraryWorkout[];
  /** The `workout_doc` of each library workout by its id, as intervals.icu has it. */
  readonly libraryDocs?: Record<string, unknown>;
}

/** What the plugin holds between two requests. */
interface Held {
  ftpField: Cache['ftpField'];
  libraryDocs: Record<string, unknown>;
  /** What is shown, and kept: none before the first load. */
  cache?: Cache;
}

interface Env {
  readonly ctx: PluginContext;
  readonly gateway: Gateway;
  readonly secrets: Secrets;
  readonly files: AppFiles;
  readonly held: Held;
}

/** Whether a resource is there and still valid at `now`. */
const isFresh = (cache: Cache | undefined, resource: Resource, now: number): boolean => {
  if (resource === 'settings') {
    return false;
  }
  const at = cache?.fetched?.[resource];
  return at !== undefined && now - at < VALIDITY_MS[resource] && now >= at;
};

/**
 * The rider's intervals.icu account, athlete profile and plan (ADR 0048, 0075, 0077). Signs in with PKCE as a public client,
 * keeps the token in `storage.secrets`, and loads the athlete and the planned cycling workouts
 * at start, after a saved ride and on request. The account, the plan and every upload are app
 * state beside the bus (ADR 0068): the keys `intervals.icu` of `training.account`, of the
 * athlete profile and of the calendar (the data types of ADR 0075, which the rider chooses a
 * source of), and a ride's session id in `training.upload`; the token never is. Connect,
 * disconnect, refresh and upload are services that answer once the work started: none of them
 * is recorded, so a continued ride never does them again. The last plan is cached in app files
 * for a start without network. Every request goes through the gateway (ADR 0078).
 */
export default definePlugin({
  stop(ctx) {
    sockets.get(ctx)?.stop();
  },
  start(ctx) {
    const http = ctx.capabilities.get(netHttpCapability);
    const secrets = ctx.capabilities.get(storageSecretsCapability);
    const files = ctx.capabilities.get(storageAppFilesCapability);
    // Pacing and the rest `Retry-After` asks for are wall-clock time of I/O, not simulation time: the
    // logical clock stands still inside a turn, and no ride depends on this.
    const gateway = createGateway({ http, now: () => Date.now(), logger: ctx.logger });
    const held: Held = { ftpField: 'ftp', libraryDocs: {} };
    const env: Env = { ctx, gateway, secrets, files, held };
    const signIn = ctx.capabilities.get(authBrowserSignInCapability);
    const mailbox = createMailbox({
      http,
      secrets,
      files,
      logger: ctx.logger,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });
    const applied = newApplied();
    /** The session ids this device uploaded as `external_id`: their echo from the mailbox is not news. */
    const sentExternalIds = new Set<string>();
    let busy = false;
    /** What is asked for and not yet read: one piece of work reads all of it. */
    const pending = new Set<Resource>();
    let lastRefreshAt: number | undefined;

    // The sources are there from the start, so the rider can choose them while they load.
    setSources(ctx, 'loading');
    const account = (state: TrainingAccount['state'], extra: Partial<TrainingAccount> = {}) =>
      ctx.state.set(trainingAccountState, SERVICE, { service: SERVICE, state, ...extra });

    /** Runs one piece of asynchronous work at a time; requests during it are dropped. */
    const run = (work: () => Promise<void>) => {
      if (busy) {
        return;
      }
      busy = true;
      work()
        .catch((error: unknown) => ctx.logger.error({ error }, 'intervals.icu: unexpected failure'))
        .finally(() => {
          busy = false;
          if (pending.size > 0) {
            drain();
          }
        });
    };

    /** Reads what was asked for while other work ran, once, together. */
    const drain = () =>
      run(async () => {
        const resources = [...pending];
        pending.clear();
        await loadResources(env, resources, ctx.clock.now());
      });

    /** Reads the stale ones of `resources`; a fresh one costs nothing. `force` reads them all. */
    const want = (resources: readonly Resource[], force = false) => {
      const now = ctx.clock.now();
      for (const resource of resources) {
        if (force || !isFresh(held.cache, resource, now)) {
          pending.add(resource);
        }
      }
      if (pending.size > 0) {
        drain();
      }
    };

    /** Fetches what the mailbox holds, applies it, and acknowledges it. Silent when the relay is not there. */
    let mailboxWork: Promise<unknown> = Promise.resolve();
    const pickUp = (): Promise<void> => {
      const work = mailboxWork.then(async () => {
        const picked = await mailbox.pickup();
        if (!picked) {
          return;
        }
        await applyMailbox(env, picked.events, { clientId: CLIENT_ID, externalIds: sentExternalIds }, applied, want);
        if (picked.next > (await mailbox.cursor())) {
          await mailbox.acknowledge(picked.next);
        }
      });
      mailboxWork = work.catch((error: unknown) => ctx.logger.warn({ error }, 'mailbox: pickup failed'));
      return mailboxWork as Promise<void>;
    };

    // The socket is a fast path beside the pickup; without the capability there is none (ADR 0079).
    const webSocket = ctx.capabilities.find(netWebSocketCapability);
    const socket = webSocket
      ? createMailboxSocket({
          socket: webSocket,
          url: async () => {
            const query = await mailbox.signSocketQuery();
            return query ? `${mailboxConfig.baseUrl.replace(/^http/, 'ws')}/updates/ws?${query}` : undefined;
          },
          // The same path as a pickup: opened, checked, applied once (by cursor), acknowledged.
          onEvent: async (raw) => {
            mailboxWork = mailboxWork.then(async () => {
              const opened = await mailbox.open(raw);
              if (!opened || opened.cursor <= (await mailbox.cursor())) {
                return;
              }
              await applyMailbox(env, [opened], { clientId: CLIENT_ID, externalIds: sentExternalIds }, applied, want);
              await mailbox.keepCursor(opened.cursor);
              if (!socket?.ack(opened.cursor)) {
                await mailbox.acknowledge(opened.cursor);
              }
            });
            await mailboxWork;
          },
          catchUp: pickUp,
          onInvalid: () => mailbox.checkRegistration(),
          logger: ctx.logger,
        })
      : undefined;
    if (socket) {
      sockets.set(ctx, socket);
    }
    /** The socket lives while the account is connected and the device registered. */
    const syncSocket = async () => {
      const token = await secrets.get(TOKEN_KEY).catch(() => undefined);
      if (token && (await mailbox.registered())) {
        socket?.start();
      } else {
        socket?.stop();
      }
    };
    // In a webview, a hidden app closes the socket; coming back opens it and catches up.
    const page = (globalThis as { document?: { hidden: boolean; addEventListener(type: string, listener: () => void): void } }).document;
    page?.addEventListener('visibilitychange', () => {
      if (page.hidden) {
        socket?.stop();
      } else {
        void syncSocket();
      }
    });

    // A connect during other work of the plugin is dropped, like a second press.
    ctx.services.provide(trainingConnectService, () => {
      if (busy) {
        return {};
      }
      const now = ctx.clock.now();
      account('connecting');
      run(async () => {
        const verifier = randomUnreserved(64);
        const state = randomUnreserved(32);
        const challenge = await codeChallenge(verifier);
        let callback: URL;
        /** The sign-in answered through the relay's page, which waits for the report below. */
        let viaRelay = false;
        const relayUri = `${mailboxConfig.baseUrl}${RELAY_CALLBACK_PATH}`;
        /** Best effort and not awaited: the report never fails or delays the connect. */
        const report = (ok: boolean) => {
          if (viaRelay) {
            void mailbox.reportSignIn(state, ok);
          }
        };
        try {
          const result = await signIn.signIn({
            callbackPath: CALLBACK_PATH,
            // With deep links the relay's page bounces the answer to the app; else the loopback (ADR 0079).
            ...(signIn.deepLink ? { relayRedirectUri: relayUri } : {}),
            authorizationUrl: (redirectUri) => {
              const url = new URL('/oauth/authorize', SITE);
              url.search = new URLSearchParams({
                client_id: CLIENT_ID,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: SCOPES,
                state,
                code_challenge: challenge,
                code_challenge_method: 'S256',
              }).toString();
              return url.toString();
            },
          });
          callback = new URL(result.callbackUrl);
          viaRelay = result.redirectUri === relayUri;
        } catch (error) {
          const cancelled = error instanceof RidrsError && error.code === 'sign-in-cancelled';
          if (!cancelled) {
            ctx.logger.warn({ error }, 'intervals.icu: sign-in failed');
          }
          account('failed', { reason: cancelled ? 'sign-in-cancelled' : 'sign-in-rejected' });
          return;
        }
        const code = callback.searchParams.get('code');
        if (callback.searchParams.get('state') !== state) {
          ctx.logger.warn('intervals.icu: the sign-in answered with a different state');
          account('failed', { reason: 'sign-in-rejected' });
          return;
        }
        if (callback.searchParams.get('error') === 'access_denied' || !code) {
          account('failed', { reason: 'sign-in-cancelled' });
          return;
        }
        let response: HttpResponse;
        try {
          response = await gateway.request('auth', {
            method: 'POST',
            url: `${SITE}/api/oauth/token`,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: CLIENT_ID,
              code,
              code_verifier: verifier,
            }).toString(),
          });
        } catch (error) {
          report(false);
          account('failed', { reason: error instanceof RateLimited ? 'rate-limited' : 'unreachable' });
          return;
        }
        const token = response.status === 200 ? accessToken(response.body) : undefined;
        if (!token) {
          report(false);
          ctx.logger.warn({ status: response.status }, 'intervals.icu: the code exchange failed');
          account('failed', { reason: 'sign-in-rejected' });
          return;
        }
        await secrets.set(TOKEN_KEY, token);
        // The relay learns the athlete from the token, once, over TLS, and keeps the public keys.
        socket?.stop();
        await mailbox.register(token).catch(() => false);
        // The token is exchanged and kept; whether the registration worked does not decide this.
        report(true);
        // A new connection reads everything it shows again.
        held.cache = undefined;
        await loadResources(env, ['athlete', 'events'], now);
        await pickUp();
        await syncSocket();
      });
      return {};
    });

    ctx.services.provide(trainingDisconnectService, () => {
      // Not queued behind a running sign-in or load: the rider wants out now. Whatever that work
      // reports later is overtaken by the "disconnected" of this one, or by the next start.
      void (async () => {
        const token = await secrets.get(TOKEN_KEY).catch(() => undefined);
        if (token) {
          // Best effort: offline, or while rate limited, the token is still forgotten here.
          await gateway
            .request('auth', {
              method: 'DELETE',
              url: `${SITE}/api/v1/disconnect-app`,
              headers: { authorization: `Bearer ${token}` },
            })
            .catch(() => undefined);
        }
        socket?.stop();
        await mailbox.disconnect().catch(() => undefined);
        await secrets.remove(TOKEN_KEY);
        await files.remove(CACHE_FILE).catch(() => undefined);
        held.cache = undefined;
        held.libraryDocs = {};
        pending.clear();
        account('disconnected');
        setSources(ctx, 'unavailable');
      })().catch((error: unknown) =>
        ctx.logger.error({ error }, 'intervals.icu: disconnecting failed'),
      );
      return {};
    });

    ctx.services.provide(trainingUploadService, ({ sessionId, file }) => {
      ctx.state.set(trainingUploadState, sessionId, { service: SERVICE, sessionId, state: 'uploading' });
      // Not queued behind a load by `busy`: the rider waits for this one (the gateway orders the requests).
      sentExternalIds.add(linkIdOf(sessionId));
      void uploadActivity(env, sessionId, file);
      return {};
    });

    ctx.services.provide(athleteProfileUpdateService, ({ key: _key, ...change }) =>
      writeProfile(env, change),
    );

    ctx.services.provide(trainingCalendarPlanService, ({ key: _key, ...plan }) =>
      writeCalendar(env, { plan }),
    );
    ctx.services.provide(trainingCalendarMoveService, ({ key: _key, ...move }) =>
      writeCalendar(env, { move }),
    );
    ctx.services.provide(trainingCalendarRemoveService, ({ key: _key, ...remove }) =>
      writeCalendar(env, { remove }),
    );

    // The refresh button: the athlete and the plan, at most once a minute.
    ctx.services.provide(trainingRefreshService, () => {
      const now = ctx.clock.now();
      if (lastRefreshAt === undefined || now - lastRefreshAt >= REFRESH_COOLDOWN_MS || now < lastRefreshAt) {
        lastRefreshAt = now;
        want(['athlete', 'events'], true);
      }
      return {};
    });
    // The library is read when it is shown, if it is not there or a day old.
    ctx.services.provide(trainingLibraryLoadService, () => {
      want(['library']);
      return {};
    });
    // A saved ride may complete a planned workout: read the plan again once one is saved. The
    // first delivery is every ride of the run so far; the plan loads at start anyway.
    let first = true;
    ctx.state.watch(recordingRideState, ({ entries, changed }) => {
      const saved = changed.some((key) => entries.get(key)?.state === 'saved');
      if (!first && saved) {
        want(['events'], true);
      }
      first = false;
    });

    run(async () => {
      await startUp(env, ctx.clock.now(), want);
      await pickUp();
      await syncSocket();
    });
  },
});

/**
 * At start: the cache is shown at once, and what in it is stale is read in the background. Without
 * a cache, the athlete and the plan are read. A fresh cache costs no request.
 */
async function startUp(
  env: Env,
  now: number,
  want: (resources: readonly Resource[]) => void,
): Promise<void> {
  const { ctx, secrets, files, held } = env;
  let token: string | undefined;
  try {
    token = await secrets.get(TOKEN_KEY);
  } catch (error) {
    ctx.logger.warn({ error }, 'intervals.icu: the secret store could not be read');
  }
  if (!token) {
    ctx.state.set(trainingAccountState, SERVICE, { service: SERVICE, state: 'disconnected' });
    setSources(ctx, 'unavailable');
    return;
  }
  const cached = await readCache(files);
  if (cached) {
    held.cache = cached;
    held.ftpField = cached.ftpField;
    held.libraryDocs = cached.libraryDocs ?? {};
    ctx.state.set(trainingAccountState, SERVICE, {
      service: SERVICE,
      state: 'connected',
      ...(cached.athlete.name ? { athleteName: cached.athlete.name } : {}),
    });
    setSources(ctx, 'ready', cached);
  }
  // Called after this work: `run` is busy until it ends, so what is wanted is read right after.
  want(['athlete', 'events']);
}

/**
 * Takes over what the mailbox reported (ADR 0079): planned events change the calendar at once, an
 * FTP in the payload changes the profile, and what the payload cannot say is read again, together
 * (one piece of work for a whole batch). Nothing here sends a request by itself.
 */
async function applyMailbox(
  env: Env,
  events: Parameters<typeof interpret>[0],
  own: Parameters<typeof interpret>[1],
  applied: Applied,
  want: (resources: readonly Resource[], force?: boolean) => void,
): Promise<void> {
  const effects = interpret(events, own, applied);
  const cache = env.held.cache;
  if (cache) {
    let next = cache;
    const { events: changed, deleted } = effects.calendar;
    if (changed.length > 0 || deleted.length > 0) {
      const incoming = toWorkouts(changed, cache.athlete.ftp);
      // An event that is no longer a planned ride (another category or sport) leaves the calendar too.
      const replaced = new Set([...deleted, ...changed.map((entry) => String(entry.id))]);
      const first = localDate(env.ctx.clock.now());
      const last = localDate(env.ctx.clock.now(), PLAN_DAYS - 1);
      next = {
        ...next,
        workouts: [...cache.workouts.filter((workout) => !replaced.has(workout.id)), ...incoming]
          .filter((workout) => workout.date >= first && workout.date <= last)
          .sort((a, b) => a.date.localeCompare(b.date)),
      };
    }
    if (effects.ftp) {
      env.held.ftpField = effects.ftp.field;
      next = { ...next, athlete: { ...next.athlete, ftp: effects.ftp.value }, ftpField: effects.ftp.field };
    }
    if (next !== cache) {
      await keep(env, next);
    }
  }
  const stale: Resource[] = [
    ...(effects.refreshAthlete ? (['athlete'] as const) : []),
    ...(effects.refreshSettings ? (['settings'] as const) : []),
    ...(effects.refreshEvents ? (['events'] as const) : []),
  ];
  if (stale.length > 0) {
    want(stale, true);
  }
}

/** The text of the account state for a token; the rider is asked to connect again. */
async function rejectToken(env: Env): Promise<void> {
  await env.secrets.remove(TOKEN_KEY);
  env.ctx.state.set(trainingAccountState, SERVICE, {
    service: SERVICE,
    state: 'failed',
    reason: 'token-rejected',
  });
}

/** The service asked for rest: what is shown stays, as the last copy, and the account says why. */
function rateLimited(env: Env): void {
  const { ctx, held } = env;
  ctx.state.set(trainingAccountState, SERVICE, {
    service: SERVICE,
    state: 'failed',
    reason: 'rate-limited',
    ...(held.cache?.athlete.name ? { athleteName: held.cache.athlete.name } : {}),
  });
  if (held.cache) {
    setSources(ctx, 'offline', held.cache);
  }
}

/**
 * Uploads a ride's FIT file as a done activity (`ACTIVITY:WRITE`). The session id goes along as
 * `external_id`; intervals.icu also knows a file it already has by its hash, so a second upload
 * creates no second activity. A rejected token is forgotten like on a load: the rider connects
 * again, which asks for the scope as well.
 */
async function uploadActivity(env: Env, sessionId: string, file: string): Promise<void> {
  const { ctx, gateway, secrets, files } = env;
  const upload = (state: TrainingUpload['state'], reason?: TrainingUpload['reason']) =>
    ctx.state.set(trainingUploadState, sessionId, {
      service: SERVICE,
      sessionId,
      state,
      ...(reason ? { reason } : {}),
    });

  const token = await secrets.get(TOKEN_KEY).catch(() => undefined);
  if (!token) {
    upload('failed', 'not-connected');
    return;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await files.read(file));
  } catch (error) {
    ctx.logger.warn({ error, file }, 'intervals.icu: the FIT file could not be read');
    upload('failed', 'rejected');
    return;
  }
  // The platform encodes the multipart body and its boundary.
  const form = new FormData();
  // A File carries its name itself; not every FormData keeps the name given to append.
  form.append(
    'file',
    new File([bytes], file.slice(file.lastIndexOf('/') + 1), { type: 'application/octet-stream' }),
  );
  const encoded = new Request(SITE, { method: 'POST', body: form });
  const body = new Uint8Array(await encoded.arrayBuffer());
  // The relay's links name a ride by this form of the session id (ADR 0079).
  const query = new URLSearchParams({ external_id: linkIdOf(sessionId) });
  let response: HttpResponse;
  try {
    response = await gateway.request('upload', {
      method: 'POST',
      url: `${SITE}/api/v1/athlete/0/activities?${query}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data',
      },
      body,
    });
  } catch (error) {
    if (error instanceof RateLimited) {
      rateLimited(env);
    }
    upload('failed', 'unreachable');
    return;
  }
  if (response.status === 200 || response.status === 201) {
    upload('uploaded');
    return;
  }
  if (response.status === 401 || response.status === 403) {
    await rejectToken(env);
    upload('failed', 'token-rejected');
    return;
  }
  ctx.logger.warn({ status: response.status, body: response.body }, 'intervals.icu: the upload was rejected');
  upload('failed', 'rejected');
}

function accessToken(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const token = (parsed as { access_token?: unknown }).access_token;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Shows what an accepted change made of the data, and keeps it for a start without network. */
async function keep(env: Env, loaded: Cache, status: DataSourceStatus = 'ready'): Promise<void> {
  env.held.cache = loaded;
  setSources(env.ctx, status, loaded);
  await env.files
    .write(CACHE_FILE, new TextEncoder().encode(JSON.stringify(loaded)))
    .catch((error: unknown) => env.ctx.logger.warn({ error }, 'intervals.icu: plan not cached'));
}

type Sent = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: 'read-only' | 'unreachable' };

/**
 * Sends one change to intervals.icu. A write is refused, not queued: when the service cannot be
 * reached or does not take it, the old data stays. A token without the scope (401 or 403) is
 * forgotten like on an upload (ADR 0064) and the rider connects again; what is shown stays, as
 * the last copy of the service and read only until then.
 */
async function send(
  env: Env,
  purpose: Purpose,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Sent> {
  const { ctx, gateway, secrets, held } = env;
  const token = await secrets.get(TOKEN_KEY).catch(() => undefined);
  if (!token) {
    return { ok: false, reason: 'unreachable' };
  }
  let response: HttpResponse;
  try {
    response = await gateway.request(purpose, {
      method,
      url: `${SITE}${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error instanceof RateLimited) {
      rateLimited(env);
    }
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status === 401 || response.status === 403) {
    await rejectToken(env);
    if (held.cache) {
      setSources(ctx, 'offline', held.cache, false);
    }
    return { ok: false, reason: 'read-only' };
  }
  if (response.status < 200 || response.status >= 300) {
    ctx.logger.warn({ status: response.status, path }, 'intervals.icu: the change was rejected');
    return { ok: false, reason: 'unreachable' };
  }
  let answer: unknown;
  try {
    answer = response.body === '' ? undefined : JSON.parse(response.body);
  } catch {
    answer = undefined;
  }
  return { ok: true, body: answer };
}

/**
 * Writes a change of the profile: the weight to today's wellness record, the FTP to the Ride
 * settings, into the field it was read from. `icu_weight` is never written. A value the profile
 * already has is not sent (ADR 0078): at most two requests, none for no change.
 */
async function writeProfile(
  env: Env,
  asked: { readonly ftp?: number; readonly weight?: number },
): Promise<DataWriteResult> {
  const { ctx, held } = env;
  const current = held.cache?.athlete;
  const change = {
    ...(asked.weight !== undefined && asked.weight !== current?.weight ? { weight: asked.weight } : {}),
    ...(asked.ftp !== undefined && asked.ftp !== current?.ftp ? { ftp: asked.ftp } : {}),
  };
  if (change.weight !== undefined) {
    const sent = await send(env, 'profile-write', 'PUT', `/api/v1/athlete/0/wellness/${localDate(ctx.clock.now())}`, {
      weight: change.weight,
    });
    if (!sent.ok) {
      return sent;
    }
  }
  if (change.ftp !== undefined) {
    const sent = await send(env, 'profile-write', 'PUT', '/api/v1/athlete/0/sport-settings/Ride', {
      [held.ftpField]: change.ftp,
    });
    if (!sent.ok) {
      return sent;
    }
  }
  if (held.cache && Object.keys(change).length > 0) {
    await keep(env, { ...held.cache, athlete: { ...held.cache.athlete, ...change } });
  }
  return { ok: true };
}

/** A change of the calendar: a library workout on a day, a workout moved, a workout removed. */
type CalendarChange =
  | { readonly plan: { readonly date: string; readonly workoutId: string; readonly from: string } }
  | { readonly move: { readonly id: string; readonly date: string } }
  | { readonly remove: { readonly id: string } };

/**
 * Writes a change of the calendar to the events of intervals.icu (`POST`, `PUT`, `DELETE`). A
 * planned library workout is created with its steps. The calendar shown follows an accepted change
 * at once: it holds the planned rides of the next 14 days, as a load does. A move to the day the
 * workout is on sends nothing (ADR 0078).
 */
async function writeCalendar(env: Env, change: CalendarChange): Promise<DataWriteResult> {
  const { ctx, held } = env;
  const now = ctx.clock.now();
  const loaded = held.cache;
  let workouts = loaded?.workouts ?? [];
  if ('plan' in change) {
    const { date, workoutId, from } = change.plan;
    // The steps go as intervals.icu has them: ridrs reads only part of a workout document (no
    // zones, no difference between a range and a ramp), so its steps would change the workout.
    const workout = ctx.state
      .entries(trainingLibraryState)
      .get(from)
      ?.data?.workouts.find((candidate) => candidate.id === workoutId);
    // A workout of another library (the built-in workouts of ridrs) has no document: it is planned by its name and length.
    const doc = from === SERVICE ? held.libraryDocs[workoutId] : undefined;
    if (!workout || (from === SERVICE && doc === undefined)) {
      throw new Error(`The library of "${SERVICE}" has no workout "${workoutId}" of "${from}"`);
    }
    const sent = await send(env, 'calendar-write', 'POST', '/api/v1/athlete/0/events', {
      category: 'WORKOUT',
      start_date_local: `${date}T00:00:00`,
      type: workout.sport === 'virtual-ride' ? 'VirtualRide' : 'Ride',
      name: workout.name,
      ...(workout.description !== undefined ? { description: workout.description } : {}),
      ...(workout.durationSeconds !== undefined ? { moving_time: workout.durationSeconds } : {}),
      ...(doc !== undefined ? { workout_doc: doc } : {}),
    });
    if (!sent.ok) {
      return sent;
    }
    const created = toWorkouts([sent.body], loaded?.athlete.ftp);
    workouts = [...workouts, ...created];
  } else if ('move' in change) {
    const { id, date } = change.move;
    if (workouts.find((workout) => workout.id === id)?.date === date) {
      return { ok: true };
    }
    const sent = await send(env, 'calendar-write', 'PUT', `/api/v1/athlete/0/events/${encodeURIComponent(id)}`, {
      start_date_local: `${date}T00:00:00`,
    });
    if (!sent.ok) {
      return sent;
    }
    workouts = workouts.map((workout) => (workout.id === id ? { ...workout, date } : workout));
  } else {
    const { id } = change.remove;
    const sent = await send(env, 'calendar-write', 'DELETE', `/api/v1/athlete/0/events/${encodeURIComponent(id)}`);
    if (!sent.ok) {
      return sent;
    }
    workouts = workouts.filter((workout) => workout.id !== id);
  }
  if (loaded) {
    const first = localDate(now);
    const last = localDate(now, PLAN_DAYS - 1);
    await keep(env, {
      ...loaded,
      workouts: workouts
        .filter((workout) => workout.date >= first && workout.date <= last)
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  }
  return { ok: true };
}

/**
 * Both data types of this provider, with the data when there is any. `unavailable` has none: a
 * disconnected or rejected account is not served from the cache. The library is `loading` until
 * the first time it was asked for, and `unavailable` where the token lacks its scope.
 */
function setSources(
  ctx: PluginContext,
  status: DataSourceStatus,
  loaded?: Cache,
  writable = status === 'ready' || status === 'offline',
): void {
  const common = {
    provider: SERVICE,
    label: LABEL,
    status,
    writable,
    // Behind an external API: a page collects changes in a draft (ADR 0078).
    remote: true,
    ...(loaded ? { fetchedAt: loaded.fetchedAt } : {}),
  };
  ctx.state.set(athleteProfileState, SERVICE, {
    ...common,
    ...(loaded ? { data: loaded.athlete } : {}),
  });
  ctx.state.set(trainingCalendarState, SERVICE, {
    ...common,
    ...(loaded ? { data: { workouts: loaded.workouts } } : {}),
  });
  // The rides done are read only too (ADR 0076).
  ctx.state.set(
    trainingHistoryState,
    SERVICE,
    loaded && !loaded.history
      ? { provider: SERVICE, label: LABEL, status: 'unavailable', writable: false, remote: true }
      : { ...common, writable: false, ...(loaded?.history ? { data: { workouts: loaded.history } } : {}) },
  );
  // The library is read only.
  const library = loaded?.library;
  const asked = loaded?.fetched?.library !== undefined;
  const librarySource =
    loaded && !library && asked
      ? { provider: SERVICE, label: LABEL, status: 'unavailable' as const, writable: false, remote: true }
      : loaded && !library
        ? { provider: SERVICE, label: LABEL, status: 'loading' as const, writable: false, remote: true }
        : { ...common, writable: false, ...(library ? { data: { workouts: library } } : {}) };
  ctx.state.set(trainingLibraryState, SERVICE, librarySource);
}

/**
 * Reads `resources` with the stored token and keeps each as soon as it is read. Without a token
 * the rider is disconnected. Offline, what is held stands in, marked `offline`; rate limited, the
 * same, and the account says so.
 */
async function loadResources(env: Env, resources: readonly Resource[], now: number): Promise<void> {
  const { ctx, gateway, secrets, files, held } = env;
  const account = (state: TrainingAccount['state'], extra: Partial<TrainingAccount> = {}) =>
    ctx.state.set(trainingAccountState, SERVICE, { service: SERVICE, state, ...extra });

  let token: string | undefined;
  try {
    token = await secrets.get(TOKEN_KEY);
  } catch (error) {
    ctx.logger.warn({ error }, 'intervals.icu: the secret store could not be read');
  }
  if (!token) {
    return;
  }

  const request = (purpose: Purpose, path: string) =>
    gateway.request(purpose, {
      method: 'GET',
      url: `${SITE}${path}`,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  const get = async (purpose: Purpose, path: string): Promise<unknown> => {
    const response = await request(purpose, path);
    if (response.status === 401 || response.status === 403) {
      throw new TokenRejected();
    }
    if (response.status !== 200) {
      throw new Error(`intervals.icu answered ${response.status} for ${path}`);
    }
    return JSON.parse(response.body);
  };
  /** Today's wellness weight; none on a day without a record or with a token without the scope. */
  const wellnessWeight = async (): Promise<number | undefined> => {
    const response = await request('athlete', `/api/v1/athlete/0/wellness/${localDate(now)}`);
    if (response.status === 401) {
      throw new TokenRejected();
    }
    if (response.status === 404 || response.status === 403) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new Error(`intervals.icu answered ${response.status} for the wellness record`);
    }
    const weight = (JSON.parse(response.body) as { weight?: unknown }).weight;
    return typeof weight === 'number' ? weight : undefined;
  };

  /** The library and its folders; none where the token lacks the scope. */
  const libraryBodiesOf = async (): Promise<[unknown, unknown] | undefined> => {
    const workouts = await request('library', '/api/v1/athlete/0/workouts');
    const folders = await request('library', '/api/v1/athlete/0/folders');
    if (workouts.status === 401 || folders.status === 401) {
      throw new TokenRejected();
    }
    if (workouts.status === 403 || folders.status === 403) {
      return undefined;
    }
    if (workouts.status !== 200 || folders.status !== 200) {
      throw new Error('intervals.icu did not answer with the library');
    }
    return [JSON.parse(workouts.body), JSON.parse(folders.body)];
  };

  /** The rides of the last days; none where the token lacks the scope. */
  const historyOf = async (): Promise<CompletedWorkout[] | undefined> => {
    const query = new URLSearchParams({
      oldest: localDate(now, -(HISTORY_DAYS - 1)),
      newest: localDate(now),
    });
    const response = await request('history', `/api/v1/athlete/0/activities?${query}`);
    if (response.status === 401) {
      throw new TokenRejected();
    }
    if (response.status === 403) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new Error(`intervals.icu answered ${response.status} for the activities`);
    }
    return toActivities(JSON.parse(response.body));
  };

  try {
    const wanted = new Set(resources);
    // Without anything held, the athlete and the plan come first: they are what everything shows.
    if (!held.cache) {
      wanted.add('athlete');
      wanted.add('events');
    }
    let next: Cache = held.cache ?? {
      fetchedAt: now,
      athlete: {},
      ftpField: 'ftp',
      workouts: [],
    };
    const stamp = (resource: Stamped): Cache['fetched'] => ({ ...next.fetched, [resource]: now });

    if (wanted.has('settings') && !wanted.has('athlete') && held.cache) {
      // Only the settings changed: the weight stays as it was read, one request.
      const athleteBody = await get('athlete', '/api/v1/athlete/0');
      const athlete = toAthlete(athleteBody, held.cache.athlete.weight);
      held.ftpField = ftpField(athleteBody);
      next = { ...next, athlete, ftpField: held.ftpField };
      await keep(env, next);
    }
    if (wanted.has('athlete')) {
      const athleteBody = await get('athlete', '/api/v1/athlete/0');
      const weight = await wellnessWeight();
      const athlete = toAthlete(athleteBody, weight);
      held.ftpField = ftpField(athleteBody);
      next = { ...next, fetchedAt: now, fetched: stamp('athlete'), athlete, ftpField: held.ftpField };
      account('connected', { athleteName: athlete.name });
      await keep(env, next);
    }
    if (wanted.has('events')) {
      const query = new URLSearchParams({
        oldest: localDate(now),
        newest: localDate(now, PLAN_DAYS - 1),
        category: 'WORKOUT',
      });
      const eventsBody = await get('events', `/api/v1/athlete/0/events?${query}`);
      const history = await historyOf();
      next = {
        ...next,
        fetchedAt: now,
        fetched: stamp('events'),
        workouts: toWorkouts(eventsBody, next.athlete.ftp),
        ...(history ? { history } : {}),
      };
      account('connected', { athleteName: next.athlete.name });
      await keep(env, next);
    }
    if (wanted.has('library')) {
      const bodies = await libraryBodiesOf();
      held.libraryDocs = bodies ? libraryDocs(bodies[0]) : {};
      const { library: _old, libraryDocs: _docs, ...rest } = next;
      next = {
        ...rest,
        fetchedAt: now,
        fetched: stamp('library'),
        ...(bodies
          ? { library: toLibrary(bodies[0], bodies[1], next.athlete.ftp), libraryDocs: held.libraryDocs }
          : {}),
      };
      await keep(env, next);
    }
  } catch (error) {
    if (error instanceof TokenRejected) {
      await rejectToken(env);
      held.cache = undefined;
      setSources(ctx, 'unavailable');
      return;
    }
    if (error instanceof RateLimited) {
      ctx.logger.warn({ retryAfterMs: error.retryAfterMs }, 'intervals.icu: rate limited, nothing more is sent for now');
      rateLimited(env);
      if (!held.cache) {
        setSources(ctx, 'unavailable');
      }
      return;
    }
    ctx.logger.warn({ error }, 'intervals.icu: the plan could not be loaded');
    const cached = held.cache ?? (await readCache(files));
    if (cached) {
      held.cache = cached;
      held.ftpField = cached.ftpField;
      held.libraryDocs = cached.libraryDocs ?? {};
      account('connected', { athleteName: cached.athlete.name });
      setSources(ctx, 'offline', cached);
    } else {
      account('failed', { reason: 'unreachable' });
      setSources(ctx, 'unavailable');
    }
  }
}

/**
 * The last load, if it can be read. A cache from before the data sources (ADR 0075) has the same
 * fields, plus a plan state and an athlete name that may be empty; one from before the budget
 * (ADR 0078) has no `fetched`, and every resource is stale.
 */
async function readCache(files: AppFiles): Promise<Cache | undefined> {
  try {
    const bytes = await files.read(CACHE_FILE);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      fetchedAt?: unknown;
      fetched?: unknown;
      ftpField?: unknown;
      athlete?: { name?: unknown };
      workouts?: unknown;
      history?: unknown;
      library?: unknown;
      libraryDocs?: unknown;
    };
    const { name, ...rest } = parsed.athlete ?? {};
    const athlete = athleteProfileSchema.safeParse({ ...rest, ...(name ? { name } : {}) });
    const calendar = trainingCalendarSchema.safeParse({ workouts: parsed.workouts });
    const history = completedWorkoutSchema.array().safeParse(parsed.history);
    const library = trainingCalendarSchema
      .extend({ workouts: libraryWorkoutSchema.array() })
      .safeParse({ workouts: parsed.library });
    const fetched = Object.fromEntries(
      (['athlete', 'events', 'library'] as const).flatMap((resource) => {
        const at = isRecord(parsed.fetched) ? parsed.fetched[resource] : undefined;
        return typeof at === 'number' ? [[resource, at] as const] : [];
      }),
    );
    return athlete.success && calendar.success && typeof parsed.fetchedAt === 'number'
      ? {
          fetchedAt: parsed.fetchedAt,
          ...(Object.keys(fetched).length > 0 ? { fetched } : {}),
          athlete: athlete.data,
          ftpField: parsed.ftpField === 'indoor_ftp' ? 'indoor_ftp' : 'ftp',
          workouts: calendar.data.workouts,
          ...(history.success ? { history: history.data } : {}),
          ...(library.success ? { library: library.data.workouts } : {}),
          ...(isRecord(parsed.libraryDocs) ? { libraryDocs: parsed.libraryDocs } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
