// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AppFiles,
  type AthleteProfile,
  athleteProfileSchema,
  athleteProfileState,
  athleteProfileUpdateService,
  libraryWorkoutSchema,
  authBrowserSignInCapability,
  definePlugin,
  type HttpClient,
  type HttpResponse,
  type CompletedWorkout,
  completedWorkoutSchema,
  type LibraryWorkout,
  type DataSourceStatus,
  type DataWriteResult,
  netHttpCapability,
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
  trainingLibraryState,
  trainingRefreshService,
  type TrainingUpload,
  trainingUploadService,
  trainingUploadState,
} from '@ridrs/contracts';
import { ftpField, libraryDocs, localDate, toActivities, toAthlete, toLibrary, toWorkouts } from './intervals.ts';
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
/** The planned workouts of today and the next 13 days. */
const PLAN_DAYS = 14;
const TOKEN_KEY = 'intervals-icu.token';
const CACHE_FILE = 'training/intervals-icu-plan.json';
const SERVICE = 'intervals.icu';
const LABEL = 'intervals.icu';

/** How many days of done rides are read. */
const HISTORY_DAYS = 14;

/** The service answered 401 or 403: the token is no longer valid. */
class TokenRejected extends Error {}

/** What is kept for a start without network. */
interface Cache {
  readonly fetchedAt: number;
  readonly athlete: AthleteProfile;
  /** The field of the Ride settings the FTP was read from, which a change is written to. */
  readonly ftpField: 'indoor_ftp' | 'ftp';
  readonly workouts: PlannedWorkout[];
  /** The rides done in the last days (ADR 0076); none from before, or without the scope. */
  readonly history?: CompletedWorkout[];
  /** None when the token lacks the scope of the library. */
  readonly library?: LibraryWorkout[];
  /** The `workout_doc` of each library workout by its id, as intervals.icu has it. */
  readonly libraryDocs?: Record<string, unknown>;
}

/** What the last load read for the writes (see `Cache`). */
interface Held {
  ftpField: Cache['ftpField'];
  libraryDocs: Record<string, unknown>;
}

interface Services {
  readonly http: HttpClient;
  readonly secrets: Secrets;
  readonly files: AppFiles;
}

/**
 * The rider's intervals.icu account, athlete profile and plan (ADR 0048, 0075). Signs in with PKCE as a public client,
 * keeps the token in `storage.secrets`, and loads the athlete and the planned cycling workouts
 * at start, after a saved ride and on request. The account, the plan and every upload are app
 * state beside the bus (ADR 0068): the keys `intervals.icu` of `training.account`, of the
 * athlete profile and of the calendar (the data types of ADR 0075, which the rider chooses a
 * source of), and a ride's session id in `training.upload`; the token never is. Connect,
 * disconnect, refresh and upload are services that answer once the work started: none of them
 * is recorded, so a continued ride never does them again. The last plan is cached in app files
 * for a start without network.
 */
export default definePlugin({
  start(ctx) {
    const services: Services = {
      http: ctx.capabilities.get(netHttpCapability),
      secrets: ctx.capabilities.get(storageSecretsCapability),
      files: ctx.capabilities.get(storageAppFilesCapability),
    };
    const signIn = ctx.capabilities.get(authBrowserSignInCapability);
    let busy = false;
    /** What the last load read, for the writes. */
    const held: Held = { ftpField: 'ftp', libraryDocs: {} };

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
        });
    };

    // Read when asked: the time of the request decides what "today" is.
    const load = (now: number) => run(() => loadPlan(ctx, services, held, now, { fromStart: false }));

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
        try {
          const result = await signIn.signIn({
            callbackPath: CALLBACK_PATH,
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
          response = await services.http.request({
            method: 'POST',
            url: `${SITE}/api/oauth/token`,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: CLIENT_ID,
              code,
              code_verifier: verifier,
            }).toString(),
          });
        } catch {
          account('failed', { reason: 'unreachable' });
          return;
        }
        const token = response.status === 200 ? accessToken(response.body) : undefined;
        if (!token) {
          ctx.logger.warn({ status: response.status }, 'intervals.icu: the code exchange failed');
          account('failed', { reason: 'sign-in-rejected' });
          return;
        }
        await services.secrets.set(TOKEN_KEY, token);
        await loadPlan(ctx, services, held, now, { fromStart: false });
      });
      return {};
    });

    ctx.services.provide(trainingDisconnectService, () => {
      // Not queued behind a running sign-in or load: the rider wants out now. Whatever that work
      // reports later is overtaken by the "disconnected" of this one, or by the next start.
      void (async () => {
        const token = await services.secrets.get(TOKEN_KEY).catch(() => undefined);
        if (token) {
          // Best effort: offline, the token is still forgotten here.
          await services.http
            .request({
              method: 'DELETE',
              url: `${SITE}/api/v1/disconnect-app`,
              headers: { authorization: `Bearer ${token}` },
            })
            .catch(() => undefined);
        }
        await services.secrets.remove(TOKEN_KEY);
        await services.files.remove(CACHE_FILE).catch(() => undefined);
        account('disconnected');
        setSources(ctx, 'unavailable');
      })().catch((error: unknown) =>
        ctx.logger.error({ error }, 'intervals.icu: disconnecting failed'),
      );
      return {};
    });

    ctx.services.provide(trainingUploadService, ({ sessionId, file }) => {
      ctx.state.set(trainingUploadState, sessionId, { service: SERVICE, sessionId, state: 'uploading' });
      // Not queued behind a load: the rider waits for this one.
      void uploadActivity(ctx, services, sessionId, file);
      return {};
    });

    ctx.services.provide(athleteProfileUpdateService, ({ key: _key, ...change }) =>
      writeProfile(ctx, services, held, change),
    );

    ctx.services.provide(trainingCalendarPlanService, ({ key: _key, ...plan }) =>
      writeCalendar(ctx, services, held, { plan }),
    );
    ctx.services.provide(trainingCalendarMoveService, ({ key: _key, ...move }) =>
      writeCalendar(ctx, services, held, { move }),
    );
    ctx.services.provide(trainingCalendarRemoveService, ({ key: _key, ...remove }) =>
      writeCalendar(ctx, services, held, { remove }),
    );

    ctx.services.provide(trainingRefreshService, () => {
      load(ctx.clock.now());
      return {};
    });
    // A saved ride may complete a planned workout: load again once one is saved. The first
    // delivery is every ride of the run so far; the plan loads at start anyway.
    let first = true;
    ctx.state.watch(recordingRideState, ({ entries, changed }) => {
      const saved = changed.some((key) => entries.get(key)?.state === 'saved');
      if (!first && saved) {
        load(ctx.clock.now());
      }
      first = false;
    });

    const startedAt = ctx.clock.now();
    run(() => loadPlan(ctx, services, held, startedAt, { fromStart: true }));
  },
});

/**
 * Uploads a ride's FIT file as a done activity (`ACTIVITY:WRITE`). The session id goes along as
 * `external_id`; intervals.icu also knows a file it already has by its hash, so a second upload
 * creates no second activity. A rejected token is forgotten like on a load: the rider connects
 * again, which asks for the scope as well.
 */
async function uploadActivity(
  ctx: PluginContext,
  { http, secrets, files }: Services,
  sessionId: string,
  file: string,
): Promise<void> {
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
  const query = new URLSearchParams({ external_id: sessionId });
  let response: HttpResponse;
  try {
    response = await http.request({
      method: 'POST',
      url: `${SITE}/api/v1/athlete/0/activities?${query}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data',
      },
      body,
    });
  } catch {
    upload('failed', 'unreachable');
    return;
  }
  if (response.status === 200 || response.status === 201) {
    upload('uploaded');
    return;
  }
  if (response.status === 401 || response.status === 403) {
    await secrets.remove(TOKEN_KEY);
    ctx.state.set(trainingAccountState, SERVICE, {
      service: SERVICE,
      state: 'failed',
      reason: 'token-rejected',
    });
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

/** What is shown now, for a state that changes only part of it; none before the first load. */
function shown(ctx: PluginContext, held: Held): Cache | undefined {
  const profile = ctx.state.entries(athleteProfileState).get(SERVICE);
  const calendar = ctx.state.entries(trainingCalendarState).get(SERVICE);
  const library = ctx.state.entries(trainingLibraryState).get(SERVICE)?.data?.workouts;
  return profile?.data && calendar?.data
    ? {
        fetchedAt: profile.fetchedAt ?? ctx.clock.now(),
        athlete: profile.data,
        ftpField: held.ftpField,
        workouts: calendar.data.workouts,
        ...(library ? { library, libraryDocs: held.libraryDocs } : {}),
      }
    : undefined;
}

/** Shows what an accepted change made of the data, and keeps it for a start without network. */
async function keep(ctx: PluginContext, { files }: Services, loaded: Cache): Promise<void> {
  setSources(ctx, 'ready', loaded);
  await files
    .write(CACHE_FILE, new TextEncoder().encode(JSON.stringify(loaded)))
    .catch((error: unknown) => ctx.logger.warn({ error }, 'intervals.icu: plan not cached'));
}

type Sent = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: 'read-only' | 'unreachable' };

/**
 * Sends one change to intervals.icu. A write is refused, not queued: when the service cannot be
 * reached or does not take it, the old data stays. A token without the scope (401 or 403) is
 * forgotten like on an upload (ADR 0064) and the rider connects again; what is shown stays, as
 * the last copy of the service and read only until then.
 */
async function send(
  ctx: PluginContext,
  { http, secrets }: Services,
  held: Held,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Sent> {
  const token = await secrets.get(TOKEN_KEY).catch(() => undefined);
  if (!token) {
    return { ok: false, reason: 'unreachable' };
  }
  let response: HttpResponse;
  try {
    response = await http.request({
      method,
      url: `${SITE}${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status === 401 || response.status === 403) {
    await secrets.remove(TOKEN_KEY);
    ctx.state.set(trainingAccountState, SERVICE, {
      service: SERVICE,
      state: 'failed',
      reason: 'token-rejected',
    });
    const loaded = shown(ctx, held);
    if (loaded) {
      setSources(ctx, 'offline', loaded, false);
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
 * settings, into the field it was read from. `icu_weight` is never written.
 */
async function writeProfile(
  ctx: PluginContext,
  services: Services,
  held: Held,
  change: { readonly ftp?: number; readonly weight?: number },
): Promise<DataWriteResult> {
  if (change.weight !== undefined) {
    const sent = await send(ctx, services, held, 'PUT', `/api/v1/athlete/0/wellness/${localDate(ctx.clock.now())}`, {
      weight: change.weight,
    });
    if (!sent.ok) {
      return sent;
    }
  }
  if (change.ftp !== undefined) {
    const sent = await send(ctx, services, held, 'PUT', '/api/v1/athlete/0/sport-settings/Ride', {
      [held.ftpField]: change.ftp,
    });
    if (!sent.ok) {
      return sent;
    }
  }
  const loaded = shown(ctx, held);
  if (loaded) {
    await keep(ctx, services, { ...loaded, athlete: { ...loaded.athlete, ...change } });
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
 * at once: it holds the planned rides of the next 14 days, as a load does.
 */
async function writeCalendar(
  ctx: PluginContext,
  services: Services,
  held: Held,
  change: CalendarChange,
): Promise<DataWriteResult> {
  const now = ctx.clock.now();
  const loaded = shown(ctx, held);
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
    const sent = await send(ctx, services, held, 'POST', '/api/v1/athlete/0/events', {
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
    const sent = await send(ctx, services, held, 'PUT', `/api/v1/athlete/0/events/${encodeURIComponent(id)}`, {
      start_date_local: `${date}T00:00:00`,
    });
    if (!sent.ok) {
      return sent;
    }
    workouts = workouts.map((workout) => (workout.id === id ? { ...workout, date } : workout));
  } else {
    const { id } = change.remove;
    const sent = await send(ctx, services, held, 'DELETE', `/api/v1/athlete/0/events/${encodeURIComponent(id)}`);
    if (!sent.ok) {
      return sent;
    }
    workouts = workouts.filter((workout) => workout.id !== id);
  }
  if (loaded) {
    const first = localDate(now);
    const last = localDate(now, PLAN_DAYS - 1);
    await keep(ctx, services, {
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
 * disconnected or rejected account is not served from the cache.
 */
function setSources(
  ctx: PluginContext,
  status: DataSourceStatus,
  loaded?: {
    readonly fetchedAt: number;
    readonly athlete: AthleteProfile;
    readonly workouts: PlannedWorkout[];
    readonly history?: CompletedWorkout[];
    readonly library?: LibraryWorkout[];
  },
  writable = status === 'ready' || status === 'offline',
): void {
  const common = {
    provider: SERVICE,
    label: LABEL,
    status,
    writable,
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
      ? { provider: SERVICE, label: LABEL, status: 'unavailable', writable: false }
      : { ...common, writable: false, ...(loaded?.history ? { data: { workouts: loaded.history } } : {}) },
  );
  // The library is read only, and unavailable where the token lacks its scope.
  const library = loaded?.library;
  ctx.state.set(
    trainingLibraryState,
    SERVICE,
    loaded && !library
      ? { provider: SERVICE, label: LABEL, status: 'unavailable', writable: false }
      : { ...common, writable: false, ...(library ? { data: { workouts: library } } : {}) },
  );
}

/**
 * Loads the athlete and the plan with the stored token. Without a token the rider is
 * disconnected. Offline, the cached plan stands in, marked `offline`.
 */
async function loadPlan(
  ctx: PluginContext,
  { http, secrets, files }: Services,
  held: Held,
  now: number,
  { fromStart }: { readonly fromStart: boolean },
): Promise<void> {
  const account = (state: TrainingAccount['state'], extra: Partial<TrainingAccount> = {}) =>
    ctx.state.set(trainingAccountState, SERVICE, { service: SERVICE, state, ...extra });

  let token: string | undefined;
  try {
    token = await secrets.get(TOKEN_KEY);
  } catch (error) {
    ctx.logger.warn({ error }, 'intervals.icu: the secret store could not be read');
  }
  if (!token) {
    if (fromStart) {
      account('disconnected');
      setSources(ctx, 'unavailable');
    }
    return;
  }

  const request = (path: string) =>
    http.request({
      method: 'GET',
      url: `${SITE}${path}`,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  const get = async (path: string): Promise<unknown> => {
    const response = await request(path);
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
    const response = await request(`/api/v1/athlete/0/wellness/${localDate(now)}`);
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
    const [workouts, folders] = await Promise.all([
      request('/api/v1/athlete/0/workouts'),
      request('/api/v1/athlete/0/folders'),
    ]);
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
    const response = await request(`/api/v1/athlete/0/activities?${query}`);
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
    const query = new URLSearchParams({
      oldest: localDate(now),
      newest: localDate(now, PLAN_DAYS - 1),
      category: 'WORKOUT',
    });
    const [athleteBody, eventsBody, weight, libraryBodies, history] = await Promise.all([
      get('/api/v1/athlete/0'),
      get(`/api/v1/athlete/0/events?${query}`),
      wellnessWeight(),
      libraryBodiesOf(),
      historyOf(),
    ]);
    const athlete = toAthlete(athleteBody, weight);
    held.ftpField = ftpField(athleteBody);
    held.libraryDocs = libraryBodies ? libraryDocs(libraryBodies[0]) : {};
    const loaded: Cache = {
      fetchedAt: now,
      athlete,
      ftpField: held.ftpField,
      workouts: toWorkouts(eventsBody, athlete.ftp),
      ...(history ? { history } : {}),
      ...(libraryBodies
        ? {
            library: toLibrary(libraryBodies[0], libraryBodies[1], athlete.ftp),
            libraryDocs: held.libraryDocs,
          }
        : {}),
    };
    account('connected', { athleteName: athlete.name });
    setSources(ctx, 'ready', loaded);
    await files
      .write(CACHE_FILE, new TextEncoder().encode(JSON.stringify(loaded)))
      .catch((error: unknown) => ctx.logger.warn({ error }, 'intervals.icu: plan not cached'));
  } catch (error) {
    if (error instanceof TokenRejected) {
      await secrets.remove(TOKEN_KEY);
      account('failed', { reason: 'token-rejected' });
      setSources(ctx, 'unavailable');
      return;
    }
    ctx.logger.warn({ error }, 'intervals.icu: the plan could not be loaded');
    const cached = await readCache(files);
    if (cached) {
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
 * fields, plus a plan state and an athlete name that may be empty.
 */
async function readCache(files: AppFiles): Promise<Cache | undefined> {
  try {
    const bytes = await files.read(CACHE_FILE);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      fetchedAt?: unknown;
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
    return athlete.success && calendar.success && typeof parsed.fetchedAt === 'number'
      ? {
          fetchedAt: parsed.fetchedAt,
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
