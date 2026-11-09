// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  appLinkState,
  exportFitState,
  linkIdOf,
  recordingRideState,
  trainingCalendarMoveService,
  trainingCalendarRemoveService,
} from '@ridrs/contracts';
import FakeTimers from '@sinonjs/fake-timers';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { parseDeepLink, sessionForLink } from '../../plugins/auth-sign-in-tauri/deep-link.ts';
import { pacing } from '../../plugins/planner-intervals-icu/gateway.ts';
import { socketConfig } from '../../plugins/planner-intervals-icu/mailbox-socket.ts';
import {
  type PlannedEvent,
  parseDuration,
  SimulatedIntervalsIcu,
} from '../support/simulated-intervals-icu.ts';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';
import { savedRides } from './recording.steps.ts';

/** The secret store entry of ADR 0048. */
const TOKEN_KEY = 'intervals-icu.token';

const simulations = new WeakMap<RidrsWorld, SimulatedIntervalsIcu>();

function intervals(world: RidrsWorld): SimulatedIntervalsIcu {
  const simulation = simulations.get(world);
  assert.ok(simulation, 'Expected the simulated intervals.icu');
  return simulation;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

async function trainingTile(world: RidrsWorld): Promise<HTMLElement> {
  return await waitFor(() => {
    const tile = ui(world).querySelector<HTMLElement>(
      '[data-tile="ui-training-plan/next-workout"]',
    );
    assert.ok(tile, 'No training tile on the main screen');
    return tile;
  });
}

async function card(world: RidrsWorld): Promise<HTMLElement> {
  return within(await trainingTile(world)).findByTestId('next-workout');
}

/** Local midnight of `date` plus `time`: "today" is the rider's local date (ADR 0048). */
function localTime(date: string, time = '00:00'): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0).getTime();
}

function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ---- Setup -------------------------------------------------------------------------------

Given(
  'the ridrs plugins {string} together with the simulated intervals.icu',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    // The scenarios do not wait for the pacing of the gateway; its unit test covers it (ADR 0078).
    pacing.minIntervalMs = 0;
    pacing.writeSpacingMs = 0;
    const simulation = new SimulatedIntervalsIcu();
    simulations.set(this, simulation);
    const behavior = this.getBehavior('simulated-intervals-icu');
    behavior.providedImplementations.set('net.http', simulation.http);
    behavior.providedImplementations.set('auth.browser-sign-in', simulation.signIn);
    behavior.providedImplementations.set('storage.secrets', simulation.secretStore);
    await this.writeProbePluginFolder({
      folder: 'simulated-intervals-icu',
      id: 'simulated-intervals-icu',
      types: ['test'],
      provides: ['net.http', 'auth.browser-sign-in', 'storage.secrets'],
    });
    // Without the recorder, a stand-in owns the rides of the app state (ADR 0069).
    if (!this.realPluginIds.includes('recording-session')) {
      await this.writeProbePluginFolder({
        folder: 'test-recorder',
        id: 'test-recorder',
        types: ['recording'],
        state: { owns: [recordingRideState.id] },
      });
    }
    this.useMemoryStorage();
  },
);

Given(
  'intervals.icu knows the athlete {string} with an FTP of {int} W and a weight of {int} kg',
  function (this: RidrsWorld, name: string, ftp: number, weight: number) {
    intervals(this).athlete = { id: 'i4711', name, ftp, weight };
  },
);

Given('a test device plugin {string}', async function (this: RidrsWorld, deviceId: string) {
  await this.writeProbePluginFolder({ folder: deviceId, id: deviceId, types: ['device'] });
});

Given(
  'intervals.icu holds a wellness weight of {float} kg for {string}',
  function (this: RidrsWorld, weight: number, date: string) {
    intervals(this).wellnessWeights.set(date, weight);
  },
);

Given('intervals.icu has the library:', function (this: RidrsWorld, table: DataTable) {
  const simulation = intervals(this);
  const folders = new Map<string, number>();
  simulation.library = table.hashes().map((row, index) => {
    const folder = row.folder ?? '-';
    if (folder !== '-' && !folders.has(folder)) {
      folders.set(folder, 40 + folders.size);
    }
    return {
      id: 5000 + index,
      type: row.type ?? 'Ride',
      name: row.name ?? '',
      folder_id: folder === '-' ? null : folders.get(folder),
      moving_time: parseDuration(row.duration ?? '0s'),
      icu_training_load: Number(row.load),
    };
  });
  simulation.folders = [...folders].map(([name, id]) => ({ id, name, type: 'FOLDER' }));
});

Given(
  'the library workout {string} of intervals.icu has the steps:',
  function (this: RidrsWorld, name: string, table: DataTable) {
    const workout = intervals(this).library.find((entry) => entry.name === name);
    assert.ok(workout, `The library has no "${name}"`);
    workout.workout_doc = { steps: workoutDoc(table).steps };
  },
);

Given(
  'the library workout {string} of intervals.icu has the workout document:',
  function (this: RidrsWorld, name: string, json: string) {
    const workout = intervals(this).library.find((entry) => entry.name === name);
    assert.ok(workout, `The library has no "${name}"`);
    workout.workout_doc = JSON.parse(json) as { steps: unknown[] };
  },
);

Given('intervals.icu lacks the scope of the library', function (this: RidrsWorld) {
  intervals(this).libraryScope = false;
});

Given('intervals.icu rejects writes with 403', function (this: RidrsWorld) {
  intervals(this).writeStatus = 403;
});

Given('intervals.icu accepts writes', function (this: RidrsWorld) {
  intervals(this).writeStatus = 200;
});

Given('intervals.icu cannot be reached for writes', function (this: RidrsWorld) {
  intervals(this).writesReachable = false;
});

When('intervals.icu can be reached for writes', function (this: RidrsWorld) {
  intervals(this).writesReachable = true;
});

Given('intervals.icu keeps an indoor FTP of {int} W', function (this: RidrsWorld, ftp: number) {
  intervals(this).indoorFtp = ftp;
});

Given('the local time is {string}', function (this: RidrsWorld, text: string) {
  const [date = '', time] = text.split(' ');
  // Only the date is fake: the UI's waitFor needs real timers. The clock still runs from here.
  this.fakeClock ??= FakeTimers.install({ toFake: ['Date'], shouldAdvanceTime: true });
  this.fakeClock.setSystemTime(localTime(date, time));
});

Given('the secret store holds a token for intervals.icu', function (this: RidrsWorld) {
  const simulation = intervals(this);
  simulation.secrets.set(TOKEN_KEY, simulation.token);
});

Given('intervals.icu rejects the token', function (this: RidrsWorld) {
  intervals(this).validToken = undefined;
});

Given('intervals.icu holds back its answers to writes', function (this: RidrsWorld) {
  intervals(this).holdWrites = true;
});

When('intervals.icu answers its writes', async function (this: RidrsWorld) {
  intervals(this).answerWrites();
  await this.settle();
});

let nextActivityId = 70_001;

Given('intervals.icu has done:', function (this: RidrsWorld, table: DataTable) {
  intervals(this).activities = table.hashes().map((row) => ({
    id: `i${nextActivityId++}`,
    start_date_local: `${row.date}T${row.time ?? '08:00'}:00`,
    // No UTC start: the ride is placed by its date, and by the session id where it has one.
    type: row.type ?? 'Ride',
    name: row.name ?? '',
    moving_time: parseDuration(row.duration ?? '0s'),
    icu_training_load: Number(row.load),
    ...(row['external id'] ? { external_id: row['external id'] } : {}),
  }));
});

Given(
  'intervals.icu has the uploaded ride as an activity named {string}',
  function (this: RidrsWorld, name: string) {
    const upload = intervals(this).uploads.at(-1);
    assert.ok(upload?.externalId, 'No upload with an external id');
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    intervals(this).activities.push({
      id: `i${nextActivityId++}`,
      start_date_local: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`,
      type: 'VirtualRide',
      name,
      moving_time: 60,
      icu_training_load: 40,
      external_id: upload.externalId,
    });
  },
);

let nextEventId = 90_001;

Given('intervals.icu plans:', function (this: RidrsWorld, table: DataTable) {
  intervals(this).events = table.hashes().map(
    (row): PlannedEvent => ({
      id: nextEventId++,
      start_date_local: `${row.date}T00:00:00`,
      category: 'WORKOUT',
      type: row.type ?? 'Ride',
      name: row.name ?? '',
      moving_time: parseDuration(row.duration ?? '0s'),
      icu_training_load: Number(row.load),
    }),
  );
});

/** Rows `step | duration | power`: "warmup", "cooldown", "repeat" (duration "3x"), or "-". */
function workoutDoc(table: DataTable): { steps: unknown[]; duration: number } {
  const steps: Record<string, unknown>[] = [];
  let repeat: { reps: number; steps: Record<string, unknown>[] } | undefined;
  let total = 0;
  for (const row of table.hashes()) {
    const kind = (row.step ?? '').trim();
    if (kind === 'repeat') {
      repeat = { reps: Number.parseInt(row.duration ?? '', 10), steps: [] };
      steps.push(repeat);
      continue;
    }
    const duration = parseDuration(row.duration ?? '');
    const [start, end] = (row.power ?? '').replace('%', '').split('-').map(Number);
    const step: Record<string, unknown> = {
      duration,
      power: end === undefined ? { units: '%ftp', value: start } : { units: '%ftp', start, end },
      ...(end !== undefined ? { ramp: true } : {}),
      ...(kind === 'warmup' ? { warmup: true } : {}),
      ...(kind === 'cooldown' ? { cooldown: true } : {}),
    };
    if (kind === '-' && repeat) {
      repeat.steps.push(step);
    } else {
      repeat = undefined;
      steps.push(step);
    }
  }
  for (const step of steps) {
    if ('reps' in step) {
      const inner = (step.steps as { duration: number }[]).reduce((s, x) => s + x.duration, 0);
      total += inner * (step.reps as number);
    } else {
      total += step.duration as number;
    }
  }
  return { steps, duration: total };
}

function planStructured(
  world: RidrsWorld,
  name: string,
  date: string,
  table: DataTable,
  description?: string,
): void {
  const doc = workoutDoc(table);
  intervals(world).events = [
    {
      id: nextEventId++,
      start_date_local: `${date}T00:00:00`,
      category: 'WORKOUT',
      type: 'Ride',
      name,
      ...(description ? { description } : {}),
      moving_time: doc.duration,
      icu_training_load: 70,
      workout_doc: { steps: doc.steps },
    },
  ];
}

Given(
  'intervals.icu plans {string} on {string} with the steps:',
  function (this: RidrsWorld, name: string, date: string, table: DataTable) {
    planStructured(this, name, date, table);
  },
);

Given(
  'intervals.icu plans {string} on {string} with the description {string} and the steps:',
  function (this: RidrsWorld, name: string, date: string, description: string, table: DataTable) {
    planStructured(this, name, date, table, description);
  },
);

Given(
  'the host is restarted while intervals.icu is unreachable',
  async function (this: RidrsWorld) {
    await this.settle();
    await this.disposeHost();
    intervals(this).reachable = false;
    await this.ensureHost().start();
    await this.settle();
  },
);

// ---- The athlete in the browser ----------------------------------------------------------

/** The athlete acts once the page is there: the planner opens it after its PKCE hash. */
async function browserShowsSignIn(world: RidrsWorld): Promise<void> {
  const simulation = intervals(world);
  await world.waitForIo(() => simulation.signInWaiting, 'the sign-in page');
}

When('the athlete approves the sign-in', async function (this: RidrsWorld) {
  await browserShowsSignIn(this);
  intervals(this).approve();
  await this.settle();
});

When('the athlete declines the sign-in', async function (this: RidrsWorld) {
  await browserShowsSignIn(this);
  intervals(this).decline();
  await this.settle();
});

When('the browser returns a code with a different state', async function (this: RidrsWorld) {
  await browserShowsSignIn(this);
  intervals(this).answerWithForeignState();
  await this.settle();
});

When('a ride is saved', async function (this: RidrsWorld) {
  const recorder = this.ensureHost().getPluginContext('test-recorder');
  assert.ok(recorder, 'Expected the stand-in recorder');
  recorder.state.set(recordingRideState, 'session-1', {
    sessionId: 'session-1',
    state: 'saved',
    file: 'recordings/2026-11-04-ride.ridrs',
    bytes: 1024,
    events: 10,
    durationMs: 60_000,
  });
  await this.flushState();
});

When('I open the next workout', async function (this: RidrsWorld) {
  fireEvent.click(await card(this));
  await this.settle();
});

// ---- intervals.icu -----------------------------------------------------------------------

Then('no request reached intervals.icu', async function (this: RidrsWorld) {
  await this.settle();
  assert.deepEqual(intervals(this).requests, []);
});

Then(
  'the browser was opened at {string} with:',
  async function (this: RidrsWorld, base: string, table: DataTable) {
    await browserShowsSignIn(this);
    const opened = intervals(this).lastAuthorization;
    assert.ok(opened, 'Expected the browser to be opened');
    assert.equal(`${opened.origin}${opened.pathname}`, base);
    for (const [name, value] of table.raw()) {
      assert.equal(opened.searchParams.get(name ?? ''), value, `Query parameter "${name}"`);
    }
  },
);

Then('the sign-in asked for a code challenge and a state', function (this: RidrsWorld) {
  const opened = intervals(this).lastAuthorization;
  assert.ok(opened, 'Expected the browser to be opened');
  assert.match(opened.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.ok((opened.searchParams.get('state') ?? '').length >= 16, 'Expected a random state');
  assert.equal(opened.searchParams.get('response_type') ?? 'code', 'code');
});

Then('the browser was not opened', async function (this: RidrsWorld) {
  await this.settle();
  assert.deepEqual(intervals(this).openedUrls, []);
});

Then(
  'the code was exchanged with the verifier of the challenge and without a client secret',
  function (this: RidrsWorld) {
    const simulation = intervals(this);
    const exchange = simulation.exchanges.at(-1);
    assert.ok(exchange, 'Expected a token request');
    const verifier = exchange.fields.get('code_verifier') ?? '';
    assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.equal(
      createHash('sha256').update(verifier).digest('base64url'),
      simulation.lastAuthorization?.searchParams.get('code_challenge'),
    );
    assert.equal(exchange.fields.get('client_id'), '1697');
    assert.equal(exchange.fields.has('client_secret'), false);
    assert.equal(exchange.accepted, true);
  },
);

Then('no code was exchanged', async function (this: RidrsWorld) {
  await this.settle();
  assert.deepEqual(intervals(this).exchanges, []);
});

Then(
  'intervals.icu received {string} with the token',
  async function (this: RidrsWorld, call: string) {
    const [method, path] = call.split(' ');
    const simulation = intervals(this);
    await this.waitForIo(
      () =>
        simulation.requests.some((request) => {
          const url = new URL(request.url);
          return request.method === method && `${url.pathname}${url.search}` === path;
        }),
      `${call} to reach intervals.icu`,
    );
    const request = simulation.requests.find((r) => {
      const url = new URL(r.url);
      return r.method === method && `${url.pathname}${url.search}` === path;
    });
    const authorization = Object.entries(request?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    assert.equal(authorization, `Bearer ${simulation.token}`);
  },
);

Then(
  'intervals.icu received {string} with the body:',
  async function (this: RidrsWorld, call: string, table: DataTable) {
    const [method, path] = call.split(' ');
    const simulation = intervals(this);
    const matching = () =>
      simulation.requests.filter(
        (request) => request.method === method && new URL(request.url).pathname === path,
      );
    await this.waitForIo(() => matching().length > 0, `${call} to reach intervals.icu`);
    const request = matching().at(-1);
    const body = JSON.parse(typeof request?.body === 'string' ? request.body : '{}') as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      Object.fromEntries(table.raw().map(([name]) => [name, String(body[name ?? ''])])),
      Object.fromEntries(table.raw()),
    );
  },
);

Then(
  'the event created in intervals.icu has the steps:',
  async function (this: RidrsWorld, table: DataTable) {
    const simulation = intervals(this);
    await this.waitForIo(
      () => simulation.eventLog.some((entry) => entry.method === 'POST'),
      'the event to reach intervals.icu',
    );
    const created = simulation.eventLog.filter((entry) => entry.method === 'POST').at(-1);
    assert.deepEqual(
      (created?.body.workout_doc as { steps: unknown[] } | undefined)?.steps,
      workoutDoc(table).steps,
    );
  },
);

Then(
  'the event created in intervals.icu has the workout document of the library workout {string}',
  async function (this: RidrsWorld, name: string) {
    const simulation = intervals(this);
    await this.waitForIo(
      () => simulation.eventLog.some((entry) => entry.method === 'POST'),
      'the event to reach intervals.icu',
    );
    const created = simulation.eventLog.filter((entry) => entry.method === 'POST').at(-1);
    const workout = simulation.library.find((entry) => entry.name === name);
    assert.deepEqual(created?.body.workout_doc, workout?.workout_doc);
  },
);

function eventNamed(world: RidrsWorld, name: string): string {
  const event = intervals(world).events.find((candidate) => candidate.name === name);
  assert.ok(event, `intervals.icu plans no "${name}"`);
  return String(event.id);
}

When(
  'the rider moves the planned workout {string} of {string} to {string}',
  async function (this: RidrsWorld, name: string, provider: string, date: string) {
    const answer = await this.ensureHost().callService(trainingCalendarMoveService.id, {
      key: provider,
      id: eventNamed(this, name),
      date,
    });
    assert.deepEqual(answer, { ok: true });
    await this.flushState();
  },
);

When(
  'the rider removes the planned workout {string} of {string}',
  async function (this: RidrsWorld, name: string, provider: string) {
    const answer = await this.ensureHost().callService(trainingCalendarRemoveService.id, {
      key: provider,
      id: eventNamed(this, name),
    });
    assert.deepEqual(answer, { ok: true });
    await this.flushState();
  },
);

Then(
  'intervals.icu received {string} for the event {string} with the body:',
  async function (this: RidrsWorld, method: string, name: string, table: DataTable) {
    const simulation = intervals(this);
    await this.waitForIo(
      () => simulation.eventLog.some((entry) => entry.method === method && entry.name === name),
      `${method} of "${name}" to reach intervals.icu`,
    );
    const entry = simulation.eventLog.filter((e) => e.method === method && e.name === name).at(-1);
    assert.deepEqual(
      Object.fromEntries(table.raw().map(([field]) => [field, String(entry?.body[field ?? ''])])),
      Object.fromEntries(table.raw()),
    );
  },
);

Then(
  'intervals.icu received {string} for the event {string}',
  async function (this: RidrsWorld, method: string, name: string) {
    const simulation = intervals(this);
    await this.waitForIo(
      () => simulation.eventLog.some((entry) => entry.method === method && entry.name === name),
      `${method} of "${name}" to reach intervals.icu`,
    );
  },
);

Then('intervals.icu received no write to its events', async function (this: RidrsWorld) {
  await this.settle();
  assert.deepEqual(intervals(this).eventLog, []);
});

Then('no request changed the athlete of intervals.icu', async function (this: RidrsWorld) {
  await this.settle();
  const changes = intervals(this)
    .requests.filter(
      (request) =>
        request.method !== 'GET' && new URL(request.url).pathname === '/api/v1/athlete/0',
    )
    .map((request) => `${request.method} ${request.url}`);
  assert.deepEqual(changes, []);
});

// ---- Keychain and leaks ------------------------------------------------------------------

Then('the secret store holds the intervals.icu token', async function (this: RidrsWorld) {
  const simulation = intervals(this);
  await this.waitForIo(() => simulation.secrets.get(TOKEN_KEY) === simulation.token, 'the token');
});

Then('the secret store holds no intervals.icu token', async function (this: RidrsWorld) {
  await this.settle();
  assert.equal(intervals(this).secrets.has(TOKEN_KEY), false);
});

Then('no event on the bus contains the intervals.icu token', async function (this: RidrsWorld) {
  await this.settle();
  const token = intervals(this).token;
  const leaking = this.tapped.filter((envelope) => JSON.stringify(envelope).includes(token));
  assert.deepEqual(
    leaking.map((envelope) => envelope.type),
    [],
  );
  // Nor does any app state value or service call beside the bus (ADR 0068).
  assert.ok(this.stateWrites.length > 0, 'Expected app state writes');
  const leakingState = this.stateWrites.filter((write) => JSON.stringify(write).includes(token));
  assert.deepEqual(
    leakingState.map((write) => `${write.topic} ${write.key}`),
    [],
  );
  assert.ok(this.serviceTraffic.length > 0, 'Expected service calls');
  const leakingCalls = this.serviceTraffic.filter((call) => JSON.stringify(call).includes(token));
  assert.deepEqual(
    leakingCalls.map((call) => call.service),
    [],
  );
});

Then('no app file contains the intervals.icu token', async function (this: RidrsWorld) {
  await this.settle();
  const token = intervals(this).token;
  const files = this.useMemoryStorage().files;
  const decoder = new TextDecoder();
  const leaking = [...files].filter(([, bytes]) => decoder.decode(bytes).includes(token));
  assert.deepEqual(
    leaking.map(([path]) => path),
    [],
  );
});

// ---- The training tile and the card ---------------------------------------------------------

Then('the training tile shows {string}', async function (this: RidrsWorld, text: string) {
  const panel = await trainingTile(this);
  await waitFor(() => assert.ok(textOf(panel).includes(text), `"${textOf(panel)}"`));
});

Then(
  'the training tile offers a {string} button',
  async function (this: RidrsWorld, label: string) {
    await within(await trainingTile(this)).findByRole('button', { name: label });
  },
);

/** Checked once the tile shows its card: what it offers then is what it offers. */
Then(
  'the training tile offers no {string} button',
  async function (this: RidrsWorld, label: string) {
    const panel = await trainingTile(this);
    await within(panel).findByTestId('next-workout');
    assert.equal(within(panel).queryByRole('button', { name: label }), null);
  },
);

// ---- The account in the Me area ---------------------------------------------------------------

async function meConnection(world: RidrsWorld): Promise<HTMLElement> {
  return await waitFor(() => {
    const panel = ui(world).querySelector<HTMLElement>(
      '[data-testid="slot-me-connection"] [data-testid="intervals-connection"]',
    );
    assert.ok(panel, 'No intervals.icu account in the Me area');
    return panel;
  });
}

Then('the Me area shows {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(async () => {
    const panel = await meConnection(this);
    assert.ok(textOf(panel).includes(text), `"${textOf(panel)}"`);
  });
});

Then('the Me area offers a {string} button', async function (this: RidrsWorld, label: string) {
  await within(await meConnection(this)).findByRole('button', { name: label });
});

Then('the next workout card shows:', async function (this: RidrsWorld, table: DataTable) {
  for (const [field, expected] of table.raw()) {
    await waitFor(async () => {
      const value = within(await card(this)).getByTestId(`next-workout-${field}`);
      assert.equal(textOf(value), expected);
    });
  }
});

Then(
  'the next workout card shows a power profile of {int} bars',
  async function (this: RidrsWorld, bars: number) {
    const profile = await within(await card(this)).findByTestId('next-workout-profile');
    assert.equal(profile.querySelectorAll('[data-bar]').length, bars);
  },
);

Then('the next workout card shows no power profile', async function (this: RidrsWorld) {
  const found = await card(this);
  await this.settle();
  assert.equal(within(found).queryByTestId('next-workout-profile'), null);
});

Then('the focus is on the next workout card', async function (this: RidrsWorld) {
  const found = await card(this);
  assert.equal(document.activeElement, found);
});

// ---- The details -------------------------------------------------------------------------

function details(world: RidrsWorld): HTMLElement {
  const screen = ui(world).querySelector<HTMLElement>('[data-screen="training-workout"]');
  assert.ok(screen, 'Expected the workout details');
  return screen;
}

Then('the workout details show {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => assert.ok(textOf(details(this)).includes(text), textOf(details(this))));
});

Then(
  "the workout details show the athlete's FTP {string} and weight {string}",
  async function (this: RidrsWorld, ftp: string, weight: string) {
    const screen = details(this);
    assert.equal(textOf(await within(screen).findByTestId('workout-ftp')), ftp);
    assert.equal(textOf(await within(screen).findByTestId('workout-weight')), weight);
  },
);

Then('the workout details list the steps:', async function (this: RidrsWorld, table: DataTable) {
  const rows = await within(details(this)).findAllByTestId('workout-step');
  const shown = rows.map((row) => ({
    step: textOf(row.querySelector('[data-field="step"]') ?? document.createElement('span')),
    duration: textOf(
      row.querySelector('[data-field="duration"]') ?? document.createElement('span'),
    ),
    target: textOf(row.querySelector('[data-field="target"]') ?? document.createElement('span')),
  }));
  assert.deepEqual(shown, table.hashes());
});

// ---- The debriefing and the upload of a ride ---------------------------------------------

/**
 * Settles the host and lets real time pass until `done()` holds: in the app scenarios, the
 * recording is written by a running app on real I/O, which takes longer than I/O turns.
 */
async function until(world: RidrsWorld, done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await world.settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function debriefing(world: RidrsWorld): Promise<HTMLElement> {
  return await waitFor(() => {
    const screen = ui(world).querySelector<HTMLElement>('[data-testid="debriefing"]');
    assert.ok(screen, 'No debriefing shown');
    return screen;
  });
}

/** The ride's files once written; compression and the FIT export run on real I/O turns. */
async function rideFiles(
  world: RidrsWorld,
): Promise<{ readonly recording: string; readonly fit: string }> {
  let files: { recording: string; fit: string } | undefined;
  await world.waitForIo(() => {
    const completed = savedRides(world).at(-1);
    const written = world.stateValues<{ file: string }>(exportFitState.id).at(-1);
    if (completed?.file && written) {
      files = { recording: completed.file, fit: written.file };
    }
    return files !== undefined;
  }, 'the recording and its FIT file');
  assert.ok(files);
  return files;
}

Then('the debriefing shows {string}', async function (this: RidrsWorld, text: string) {
  const screen = await debriefing(this);
  await until(this, () => textOf(screen).includes(text), `"${text}" in "${textOf(screen)}"`);
});

Then(/^the debriefing offers (.+)$/, async function (this: RidrsWorld, list: string) {
  const expected = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
  const screen = await debriefing(this);
  await until(
    this,
    () => {
      const buttons = [...screen.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      return expected.every((label) => buttons.some((button) => textOf(button) === label));
    },
    `the buttons ${expected.join(', ')}`,
  );
});

Given('intervals.icu cannot be reached for uploads', function (this: RidrsWorld) {
  intervals(this).uploadsReachable = false;
});

When('intervals.icu can be reached for uploads again', function (this: RidrsWorld) {
  intervals(this).uploadsReachable = true;
});

Given('intervals.icu answers uploads with {int}', function (this: RidrsWorld, status: number) {
  intervals(this).uploadStatus = status;
});

Then(
  "intervals.icu received the ride's FIT file as an activity with the session as its external id",
  async function (this: RidrsWorld) {
    const simulation = intervals(this);
    const { fit } = await rideFiles(this);
    await this.waitForIo(() => simulation.uploads.length > 0, 'an upload to reach intervals.icu');
    assert.equal(simulation.uploads.length, 1);
    const [upload] = simulation.uploads;
    const session = this.stateValues<{ sessionId: string }>(exportFitState.id).at(-1);
    assert.equal(upload?.externalId, linkIdOf(session?.sessionId ?? ''));
    // The relay carries only this form of an external id.
    assert.match(upload?.externalId ?? '', /^[A-Za-z0-9._-]{1,128}$/);
    assert.equal(upload?.fileName, fit.slice(fit.lastIndexOf('/') + 1));
    assert.deepEqual(upload?.bytes, this.memoryFiles?.files.get(fit));
  },
);

Then('intervals.icu received no upload', async function (this: RidrsWorld) {
  await this.settle();
  assert.deepEqual(intervals(this).uploads, []);
  assert.equal(
    intervals(this).requests.some(
      (request) => request.method === 'POST' && request.url.includes('/activities'),
    ),
    false,
  );
});

Then('the sign-in asked for the scope {string}', function (this: RidrsWorld, scope: string) {
  assert.equal(intervals(this).lastAuthorization?.searchParams.get('scope'), scope);
});

Then(
  "the memory storage keeps the ride's recording and FIT file",
  async function (this: RidrsWorld) {
    const { recording, fit } = await rideFiles(this);
    await this.settle();
    assert.ok(this.memoryFiles?.files.has(recording), `No "${recording}"`);
    assert.ok(this.memoryFiles?.files.has(fit), `No "${fit}"`);
  },
);

Given("the ride's FIT file is written", async function (this: RidrsWorld) {
  await rideFiles(this);
});

Then('the memory storage holds no recording and no FIT file', async function (this: RidrsWorld) {
  const ride = (path: string) => /\.(ridrs|ridrs\.jsonl|fit)$/.test(path);
  await this.waitForIo(
    () =>
      this.stateValues<{ state: string }>(recordingRideState.id).some(
        (ride) => ride.state === 'deleted',
      ),
    'the recording to be deleted',
  );
  await this.waitForIo(
    () => ![...(this.memoryFiles?.files.keys() ?? [])].some(ride),
    'the recording and the FIT file to be deleted',
  );
});

// ---- A slow disk -------------------------------------------------------------------------

Given('the app files are written slowly from now on', function (this: RidrsWorld) {
  // The recording and its FIT file are written in the background; here they wait.
  this.useMemoryStorage().hold();
});

When('the app files are written again', async function (this: RidrsWorld) {
  this.useMemoryStorage().release();
  await this.settle();
});

// ---- The request budget (ADR 0078) -------------------------------------------------------

/** The file the planner caches its last reads in (ADR 0048). */
const CACHE_FILE = 'training/intervals-icu-plan.json';

function writeCache(files: Map<string, Uint8Array>, cache: Record<string, unknown>): void {
  files.set(CACHE_FILE, new TextEncoder().encode(JSON.stringify(cache)));
}

function cachedPlan(world: RidrsWorld, name: string, date: string): Record<string, unknown> {
  const now = Date.now();
  return {
    fetchedAt: now - 60_000,
    athlete: { name: 'Alex Rider', ftp: 250, weight: 72 },
    ftpField: 'ftp',
    workouts: [{ id: '4001', date, name, sport: 'ride', steps: [] }],
    history: [],
  };
}

Given(
  'the plan cache of intervals.icu was read {int} minutes ago and plans {string} on {string}',
  function (this: RidrsWorld, minutes: number, name: string, date: string) {
    const at = Date.now() - minutes * 60_000;
    writeCache(this.useMemoryStorage().files, {
      ...cachedPlan(this, name, date),
      fetchedAt: at,
      fetched: { athlete: at, events: at },
    });
  },
);

Given(
  'the plan cache of intervals.icu is from before its resources had times and plans {string} on {string}',
  function (this: RidrsWorld, name: string, date: string) {
    writeCache(this.useMemoryStorage().files, cachedPlan(this, name, date));
  },
);

Given('the simulated intervals.icu forgets the requests so far', async function (this: RidrsWorld) {
  await this.settle();
  intervals(this).requests.length = 0;
  intervals(this).requestTimes.length = 0;
});

Given('intervals.icu holds back its answers to reads', function (this: RidrsWorld) {
  intervals(this).holdReads = true;
});

When('intervals.icu answers its reads', async function (this: RidrsWorld) {
  intervals(this).answerReads();
  await this.settle();
});

Given('intervals.icu asks for {int} seconds of rest', function (this: RidrsWorld, seconds: number) {
  intervals(this).rateLimit = { retryAfterSeconds: seconds };
});

Given('intervals.icu no longer asks for rest', function (this: RidrsWorld) {
  intervals(this).rateLimit = undefined;
});

/** Waits until the count has been reached, then until nothing more comes: the budget is exact. */
async function requestsSettled(
  world: RidrsWorld,
  count: (s: SimulatedIntervalsIcu) => number,
  expected: number,
) {
  const simulation = intervals(world);
  await world.settle();
  // In real time: the paced requests of a scenario wait for their turn.
  for (
    let waited = 0;
    expected > 0 && count(simulation) < expected && waited < 8000;
    waited += 20
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await world.settle();
  }
  await world.settle();
  return count(simulation);
}

Then('intervals.icu received {int} requests', async function (this: RidrsWorld, expected: number) {
  assert.equal(
    await requestsSettled(this, (s) => s.requests.length, expected),
    expected,
    `Requests: ${intervals(this).requestLines().join(', ')}`,
  );
});

Then(
  'intervals.icu received {int} requests {string}',
  async function (this: RidrsWorld, expected: number, call: string) {
    assert.equal(
      await requestsSettled(this, (s) => s.countRequests(call), expected),
      expected,
      `Requests: ${intervals(this).requestLines().join(', ')}`,
    );
  },
);

Then('intervals.icu received no write', async function (this: RidrsWorld) {
  await this.settle();
  const writes = intervals(this).requests.filter((request) => request.method !== 'GET');
  assert.deepEqual(
    writes.map((request) => `${request.method} ${request.url}`),
    [],
  );
});

When(
  'the rider asks the athlete profile of {string} to change to an FTP of {int} W and a weight of {float} kg',
  async function (this: RidrsWorld, provider: string, ftp: number, weight: number) {
    const answer = await this.ensureHost().callService('athlete.profile.update', {
      key: provider,
      ftp,
      weight,
    });
    assert.deepEqual(answer, { ok: true });
    await this.flushState();
  },
);

When('the library of {string} is asked for', async function (this: RidrsWorld, provider: string) {
  await this.ensureHost().callService('training.library.load', { key: provider });
  await this.settle();
});

When('the plan of {string} is refreshed', async function (this: RidrsWorld, provider: string) {
  await this.ensureHost().callService('training.refresh', { key: provider });
  await this.settle();
});

Then(
  'the account of {string} is {string} because {string}',
  async function (this: RidrsWorld, service: string, state: string, reason: string) {
    await this.waitForIo(() => {
      const account = this.stateValues<{ service: string; state: string; reason?: string }>(
        'training.account',
      ).findLast((value) => value.service === service);
      return account?.state === state && account.reason === reason;
    }, `the account to be ${state} because ${reason}`);
  },
);

Then(
  'the account of {string} is {string}',
  async function (this: RidrsWorld, service: string, state: string) {
    await this.waitForIo(
      () =>
        this.stateValues<{ service: string; state: string }>('training.account').findLast(
          (value) => value.service === service,
        )?.state === state,
      `the account to be ${state}`,
    );
  },
);

Given('the requests to intervals.icu are paced as in the app', function (this: RidrsWorld) {
  pacing.minIntervalMs = 200;
  pacing.writeSpacingMs = 250;
});

Then(
  'the writes reached intervals.icu at least {int} ms apart',
  async function (this: RidrsWorld, gap: number) {
    const simulation = intervals(this);
    await this.settle();
    const times = simulation.requests.flatMap((request, index) =>
      request.method === 'GET' ? [] : [simulation.requestTimes[index] ?? 0],
    );
    assert.ok(times.length >= 2, `Expected several writes, got ${times.length}`);
    for (let i = 1; i < times.length; i++) {
      // The wall clock of the test runs on a fake Date that ticks every 20 ms.
      assert.ok(
        (times[i] ?? 0) - (times[i - 1] ?? 0) >= gap - 25,
        `Writes ${i - 1} and ${i} were ${(times[i] ?? 0) - (times[i - 1] ?? 0)} ms apart`,
      );
    }
  },
);

// ---- The relay and its mailbox (ADR 0079) ------------------------------------------------

/** `<id:Name>` in a payload is the id of the planned event of that name. */
function withEventIds(world: RidrsWorld, json: string): Record<string, unknown> {
  return JSON.parse(
    json.replace(/<id:([^>]+)>/g, (_, name: string) => eventNamed(world, name)),
  ) as Record<string, unknown>;
}

When(
  'intervals.icu sends the webhook {string}:',
  function (this: RidrsWorld, type: string, json: string) {
    intervals(this).mailbox.push(type, withEventIds(this, json));
  },
);

When(
  'intervals.icu sends the webhook {string} at {string}:',
  function (this: RidrsWorld, type: string, timestamp: string, json: string) {
    intervals(this).mailbox.push(type, withEventIds(this, json), timestamp);
  },
);

When('the relay delivers the last event again', function (this: RidrsWorld) {
  const mailbox = intervals(this).mailbox;
  const last = mailbox.events.at(-1);
  assert.ok(last, 'The relay holds no event');
  mailbox.duplicate(last);
});

Given('the relay cannot be reached', function (this: RidrsWorld) {
  intervals(this).mailbox.reachable = false;
});

When('the relay can be reached again', function (this: RidrsWorld) {
  intervals(this).mailbox.reachable = true;
});

Given('the relay forgets the requests so far', function (this: RidrsWorld) {
  intervals(this).mailbox.requests.length = 0;
});

Then('the relay registered a device', async function (this: RidrsWorld) {
  const mailbox = intervals(this).mailbox;
  await this.waitForIo(() => mailbox.device !== undefined, 'the device to be registered');
});

Then('the relay got the token once, in the registration', async function (this: RidrsWorld) {
  const simulation = intervals(this);
  await this.settle();
  assert.deepEqual(simulation.mailbox.tokensSeen, [simulation.token]);
  assert.equal(simulation.mailbox.count('POST /devices'), 1);
});

Then(
  'the relay received {int} requests {string}',
  async function (this: RidrsWorld, expected: number, call: string) {
    const mailbox = intervals(this).mailbox;
    for (
      let waited = 0;
      expected > 0 && mailbox.count(call) < expected && waited < 5000;
      waited += 20
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await this.settle();
    }
    await this.settle();
    assert.equal(mailbox.count(call), expected, `Relay requests: ${mailbox.requests.join(', ')}`);
  },
);

Then('the relay holds {int} events', async function (this: RidrsWorld, expected: number) {
  const mailbox = intervals(this).mailbox;
  for (let waited = 0; mailbox.events.length !== expected && waited < 5000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await this.settle();
  }
  assert.equal(mailbox.events.length, expected);
});

Then('the relay forgot the device', async function (this: RidrsWorld) {
  const mailbox = intervals(this).mailbox;
  await this.waitForIo(() => mailbox.deleted, 'the device to be deleted at the relay');
  assert.equal(mailbox.device, undefined);
});

/** The mailbox's entries in the secret store (ADR 0079). */
const MAILBOX_SECRETS = [
  'ridrs-mailbox.sign-private',
  'ridrs-mailbox.enc-private',
  'ridrs-mailbox.device-id',
];

Then(
  'the secret store holds the keys and the device id of the mailbox',
  async function (this: RidrsWorld) {
    const simulation = intervals(this);
    await this.waitForIo(
      () => MAILBOX_SECRETS.every((key) => simulation.secrets.has(key)),
      'the mailbox keys in the secret store',
    );
  },
);

Then(
  'the secret store holds no keys and no device id of the mailbox',
  async function (this: RidrsWorld) {
    const simulation = intervals(this);
    await this.waitForIo(
      () => MAILBOX_SECRETS.every((key) => !simulation.secrets.has(key)),
      'the mailbox keys to be gone from the secret store',
    );
  },
);

Then('no app file holds a key or a token', async function (this: RidrsWorld) {
  await this.settle();
  const simulation = intervals(this);
  const secrets = [...simulation.secrets.values()];
  const stored = this.useMemoryStorage().files;
  for (const [name, bytes] of stored) {
    const text = new TextDecoder().decode(bytes);
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), `The app file "${name}" holds a secret`);
    }
  }
});

Given('the system hands ridrs deep links to the app', function (this: RidrsWorld) {
  intervals(this).deepLinks = true;
});

Then('the sign-in came back as a deep link', function (this: RidrsWorld) {
  assert.match(intervals(this).lastCallbackUrl ?? '', /^ridrs:\/\/oauth\/intervals\?/);
});

Given('a test link plugin', async function (this: RidrsWorld) {
  await this.writeProbePluginFolder({
    folder: 'test-link',
    id: 'test-link',
    types: ['transport'],
    state: { owns: [appLinkState.id] },
  });
});

When('a link opens the last ride', async function (this: RidrsWorld) {
  await this.waitForIo(() => this.stateOf(recordingRideState.id).length > 0, 'a recorded ride');
  const ride = { sessionId: String(this.stateOf(recordingRideState.id).at(-1)?.key) };
  const context = this.ensureHost().getPluginContext('test-link');
  assert.ok(context, 'Expected the test link plugin');
  context.state.set(appLinkState, 'activity', { sessionId: ride.sessionId, at: Date.now() });
  await this.flushState();
});

// ---- The socket to the relay (ADR 0079) --------------------------------------------------

Given('the relay offers a socket', async function (this: RidrsWorld) {
  // The delays of a real connection are shortened; the unit test covers the real ones.
  Object.assign(socketConfig, {
    reconnectBaseMs: 20,
    reconnectMaxMs: 200,
    pingMs: 30_000,
    stableMs: 60_000,
  });
  this.getBehavior('simulated-relay-socket').providedImplementations.set(
    'net.websocket',
    intervals(this).mailbox.webSocket,
  );
  await this.writeProbePluginFolder({
    folder: 'simulated-relay-socket',
    id: 'simulated-relay-socket',
    types: ['test'],
    provides: ['net.websocket'],
  });
});

Then('the app holds a socket to the relay', async function (this: RidrsWorld) {
  const mailbox = intervals(this).mailbox;
  for (let waited = 0; !mailbox.socketOpen && waited < 5000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await this.settle();
  }
  assert.equal(mailbox.socketOpen, true);
});

Then('the app holds no socket to the relay', async function (this: RidrsWorld) {
  const mailbox = intervals(this).mailbox;
  for (let waited = 0; mailbox.socketOpen && waited < 2000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await this.settle();
  }
  assert.equal(mailbox.socketOpen, false);
});

When('the network drops the socket', function (this: RidrsWorld) {
  intervals(this).mailbox.dropSocket();
});

When('another connection of the device replaces the socket', function (this: RidrsWorld) {
  intervals(this).mailbox.replaceSocket();
});

When('a moment passes', async function (this: RidrsWorld) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  await this.settle();
});

Then('the relay accepted {int} sockets', async function (this: RidrsWorld, expected: number) {
  const mailbox = intervals(this).mailbox;
  for (let waited = 0; mailbox.accepted < expected && waited < 5000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await this.settle();
  }
  assert.equal(mailbox.accepted, expected);
});

Then(
  'the next workout card shows {string} at once',
  async function (this: RidrsWorld, name: string) {
    await waitFor(
      () => assert.equal(textOf(within(ui(this)).getByTestId('next-workout')).includes(name), true),
      { timeout: 4000 },
    );
  },
);

Then(
  'the upload of the last ride has an external id the relay accepts',
  async function (this: RidrsWorld) {
    const simulation = intervals(this);
    await this.waitForIo(() => simulation.uploads.length > 0, 'an upload');
    const externalId = simulation.uploads.at(-1)?.externalId ?? '';
    assert.match(externalId, /^[A-Za-z0-9._-]{1,128}$/);
    const session = String(this.stateOf(recordingRideState.id).at(-1)?.key);
    assert.ok(session.includes(':'), 'The session id of the host holds colons');
    assert.equal(externalId, linkIdOf(session));
  },
);

Then('the link to the last ride names it by that external id', function (this: RidrsWorld) {
  const externalId = intervals(this).uploads.at(-1)?.externalId ?? '';
  const session = String(this.stateOf(recordingRideState.id).at(-1)?.key);
  const link = parseDeepLink(`ridrs://activity/${externalId}`);
  assert.equal(link?.kind, 'activity');
  assert.equal(sessionForLink([session], link?.kind === 'activity' ? link.sessionId : ''), session);
});

// ---- 401s of the relay (ADR 0079) -----------------------------------------------------------

Given(
  'the relay answers {int} requests with a 401 for the time of the request',
  function (this: RidrsWorld, count: number) {
    intervals(this).mailbox.skewedRequests = count;
  },
);

When('the relay no longer knows the device', function (this: RidrsWorld) {
  intervals(this).mailbox.forgetDevice();
});

Then(
  'the secret store still holds the keys and the device id of the mailbox',
  async function (this: RidrsWorld) {
    await this.settle();
    const simulation = intervals(this);
    assert.ok(
      MAILBOX_SECRETS.every((key) => simulation.secrets.has(key)),
      'The mailbox keys were forgotten',
    );
  },
);

const notedKeys = new WeakMap<RidrsWorld, { signPrivate?: string; deviceId?: string }>();

Given('the keys and the device id of the mailbox are noted', function (this: RidrsWorld) {
  const secrets = intervals(this).secrets;
  notedKeys.set(this, {
    signPrivate: secrets.get('ridrs-mailbox.sign-private'),
    deviceId: secrets.get('ridrs-mailbox.device-id'),
  });
});

Then(
  'the mailbox has other keys and another device id than noted',
  async function (this: RidrsWorld) {
    const simulation = intervals(this);
    const before = notedKeys.get(this);
    assert.ok(before?.deviceId, 'Nothing was noted');
    await this.waitForIo(
      () => simulation.secrets.get('ridrs-mailbox.device-id') !== before.deviceId,
      'a new device id',
    );
    assert.notEqual(simulation.secrets.get('ridrs-mailbox.sign-private'), before.signPrivate);
  },
);

Then('the relay deleted the noted device', async function (this: RidrsWorld) {
  const simulation = intervals(this);
  const before = notedKeys.get(this);
  await this.waitForIo(
    () => simulation.mailbox.deletedIds.includes(before?.deviceId ?? '-'),
    'the old device to be deleted',
  );
});

Then('the relay registered {int} devices', async function (this: RidrsWorld, count: number) {
  const mailbox = intervals(this).mailbox;
  await this.waitForIo(() => mailbox.registered.length >= count, `${count} devices`);
  assert.equal(mailbox.registered.length, count);
});
