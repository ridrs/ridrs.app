// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { recordingCompletedEvent } from '@ridrs/contracts';
import FakeTimers from '@sinonjs/fake-timers';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import {
  type PlannedEvent,
  parseDuration,
  SimulatedIntervalsIcu,
} from '../support/simulated-intervals-icu.ts';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

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

async function mainPanel(world: RidrsWorld): Promise<HTMLElement> {
  return within(ui(world)).findByTestId('slot-main-panel');
}

async function card(world: RidrsWorld): Promise<HTMLElement> {
  return within(await mainPanel(world)).findByTestId('next-workout');
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
    this.useMemoryStorage();
  },
);

Given(
  'intervals.icu knows the athlete {string} with an FTP of {int} W and a weight of {int} kg',
  function (this: RidrsWorld, name: string, ftp: number, weight: number) {
    intervals(this).athlete = { id: 'i4711', name, ftp, weight };
  },
);

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
  this.ensureHost().publishEvent('recording-session', recordingCompletedEvent, {
    sessionId: 'session-1',
    file: 'recordings/2026-11-04-ride.ridrs',
    bytes: 1024,
    events: 10,
    durationMs: 60_000,
  });
  await this.settle();
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

// ---- The main panel and the card ---------------------------------------------------------

Then('the main panel shows {string}', async function (this: RidrsWorld, text: string) {
  const panel = await mainPanel(this);
  await waitFor(() => assert.ok(textOf(panel).includes(text), `"${textOf(panel)}"`));
});

Then('the main panel offers a {string} button', async function (this: RidrsWorld, label: string) {
  await within(await mainPanel(this)).findByRole('button', { name: label });
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
