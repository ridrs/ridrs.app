// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AppFiles,
  authBrowserSignInCapability,
  definePlugin,
  type HttpClient,
  type HttpResponse,
  netHttpCapability,
  type PluginContext,
  RidrsError,
  recordingCompletedEvent,
  type Secrets,
  storageAppFilesCapability,
  storageSecretsCapability,
  type TrainingAccount,
  type TrainingPlan,
  trainingAccountChangedEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingPlanChangedEvent,
  trainingPlanSchema,
  trainingRefreshRequestedEvent,
} from '@ridrs/contracts';
import { localDate, toAthlete, toWorkouts } from './intervals.ts';
import { codeChallenge, randomUnreserved } from './pkce.ts';

/** The public OAuth client "Ridrs.APP" (ADR 0048): configuration, not a secret. */
const CLIENT_ID = '1697';
const SCOPES = 'SETTINGS:READ,CALENDAR:READ';
const SITE = 'https://intervals.icu';
const CALLBACK_PATH = '/oauth/callback';
/** The planned workouts of today and the next 13 days. */
const PLAN_DAYS = 14;
const TOKEN_KEY = 'intervals-icu.token';
const CACHE_FILE = 'training/intervals-icu-plan.json';
const SERVICE = 'intervals.icu';

/** The service answered 401 or 403: the token is no longer valid. */
class TokenRejected extends Error {}

interface Services {
  readonly http: HttpClient;
  readonly secrets: Secrets;
  readonly files: AppFiles;
}

/**
 * The rider's intervals.icu account and plan (ADR 0048). Signs in with PKCE as a public client,
 * keeps the token in `storage.secrets`, and loads the athlete and the planned cycling workouts
 * at start, after a saved ride and on request. Every result of this asynchronous work enters
 * through `ctx.inputs` as `training.account-changed` and `training.plan-changed`; the token
 * never does. The last plan is cached in app files for a start without network.
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

    const account = (state: TrainingAccount['state'], extra: Partial<TrainingAccount> = {}) =>
      ctx.inputs.accept(trainingAccountChangedEvent, { service: SERVICE, state, ...extra });

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

    // Read in the turn that asks: the logical time of the request decides what "today" is.
    const load = (now: number) => run(() => loadPlan(ctx, services, now, { fromStart: false }));

    ctx.events.subscribe(trainingConnectRequestedEvent, () => {
      if (busy) {
        return;
      }
      const now = ctx.clock.now();
      ctx.events.publish(trainingAccountChangedEvent, { service: SERVICE, state: 'connecting' });
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
        await loadPlan(ctx, services, now, { fromStart: false });
      });
    });

    ctx.events.subscribe(trainingDisconnectRequestedEvent, () => {
      const now = ctx.clock.now();
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
        ctx.inputs.accept(trainingPlanChangedEvent, {
          service: SERVICE,
          fetchedAt: now,
          offline: false,
          workouts: [],
        });
      })().catch((error: unknown) =>
        ctx.logger.error({ error }, 'intervals.icu: disconnecting failed'),
      );
    });

    ctx.events.subscribe(trainingRefreshRequestedEvent, () => load(ctx.clock.now()));
    ctx.events.subscribe(recordingCompletedEvent, () => load(ctx.clock.now()));

    const startedAt = ctx.clock.now();
    run(() => loadPlan(ctx, services, startedAt, { fromStart: true }));
  },
});

function accessToken(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const token = (parsed as { access_token?: unknown }).access_token;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads the athlete and the plan with the stored token. Without a token the rider is
 * disconnected. Offline, the cached plan stands in, marked `offline`.
 */
async function loadPlan(
  ctx: PluginContext,
  { http, secrets, files }: Services,
  now: number,
  { fromStart }: { readonly fromStart: boolean },
): Promise<void> {
  const account = (state: TrainingAccount['state'], extra: Partial<TrainingAccount> = {}) =>
    ctx.inputs.accept(trainingAccountChangedEvent, { service: SERVICE, state, ...extra });

  let token: string | undefined;
  try {
    token = await secrets.get(TOKEN_KEY);
  } catch (error) {
    ctx.logger.warn({ error }, 'intervals.icu: the secret store could not be read');
  }
  if (!token) {
    if (fromStart) {
      account('disconnected');
    }
    return;
  }

  const get = async (path: string): Promise<unknown> => {
    const response = await http.request({
      method: 'GET',
      url: `${SITE}${path}`,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      throw new TokenRejected();
    }
    if (response.status !== 200) {
      throw new Error(`intervals.icu answered ${response.status} for ${path}`);
    }
    return JSON.parse(response.body);
  };

  try {
    const query = new URLSearchParams({
      oldest: localDate(now),
      newest: localDate(now, PLAN_DAYS - 1),
      category: 'WORKOUT',
    });
    const [athleteBody, eventsBody] = await Promise.all([
      get('/api/v1/athlete/0'),
      get(`/api/v1/athlete/0/events?${query}`),
    ]);
    const athlete = toAthlete(athleteBody);
    const plan: TrainingPlan = {
      service: SERVICE,
      fetchedAt: now,
      offline: false,
      athlete,
      workouts: toWorkouts(eventsBody, athlete.ftp),
    };
    account('connected', { athleteName: athlete.name });
    ctx.inputs.accept(trainingPlanChangedEvent, plan);
    await files
      .write(CACHE_FILE, new TextEncoder().encode(JSON.stringify(plan)))
      .catch((error: unknown) => ctx.logger.warn({ error }, 'intervals.icu: plan not cached'));
  } catch (error) {
    if (error instanceof TokenRejected) {
      await secrets.remove(TOKEN_KEY);
      account('failed', { reason: 'token-rejected' });
      return;
    }
    ctx.logger.warn({ error }, 'intervals.icu: the plan could not be loaded');
    const cached = await readCache(files);
    if (cached) {
      account('connected', { athleteName: cached.athlete?.name });
      ctx.inputs.accept(trainingPlanChangedEvent, { ...cached, offline: true });
    } else {
      account('failed', { reason: 'unreachable' });
    }
  }
}

async function readCache(files: AppFiles): Promise<TrainingPlan | undefined> {
  try {
    const bytes = await files.read(CACHE_FILE);
    const parsed = trainingPlanSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
