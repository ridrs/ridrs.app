// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  activityAthleteEvent,
  activityStateChangedEvent,
  type Workout,
  workoutFinishedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import { mountShell } from '@ridrs/ui-shell';
import { workoutTimeline } from '@ridrs/workout';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

const SESSION = 'ride-1';
const PLAIN = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 5 times (4 minutes at 288 W with 95–105 rpm and a cue, 4 minutes at 125 W): the ride's workout, in watts. */
function vo2max(name: string): Workout {
  return {
    format: 'ridrs-workout',
    version: 1,
    id: 'vo2max-5x4',
    name,
    sport: 'virtual-ride',
    source: { kind: 'builtin' },
    steps: [
      {
        kind: 'repeat',
        id: 'sets',
        until: { kind: 'count', reps: 5 },
        steps: [
          {
            kind: 'interval',
            id: 'work',
            name: 'Work',
            intensity: 'interval',
            duration: { kind: 'time', seconds: 240 },
            effort: {
              kind: 'target',
              primary: { unit: 'watts', start: { low: 288, high: 288 } },
              secondary: [{ unit: 'rpm', start: { low: 95, high: 105 } }],
            },
            cues: [{ offsetSeconds: 30, durationSeconds: 15, text: 'Stay seated, spin it out' }],
          },
          {
            kind: 'interval',
            id: 'rest',
            name: 'Rest',
            intensity: 'rest',
            duration: { kind: 'time', seconds: 240 },
            effort: { kind: 'target', primary: { unit: 'watts', start: { low: 125, high: 125 } } },
          },
        ],
      },
    ],
  };
}

const segments = (name: string) => workoutTimeline(vo2max(name)).segments;

/** What the scenario's ride has seen so far: the clock is the host's, moved by the steps. */
interface Ride {
  readonly start: number;
  pausedAt?: number;
}
const rides = new WeakMap<RidrsWorld, Ride>();

function ride(world: RidrsWorld): Ride {
  const found = rides.get(world);
  assert.ok(found, 'No ride has started');
  return found;
}

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const hud = (world: RidrsWorld) =>
  ui(world).querySelector<HTMLElement>('[data-testid="widget-workout"]');
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const part = (world: RidrsWorld, testId: string) =>
  plain(hud(world)?.querySelector(`[data-testid="${testId}"]`)?.textContent);

async function shown(world: RidrsWorld): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = hud(world);
    assert.ok(found, 'The workout HUD is not shown');
  });
  return found as unknown as HTMLElement;
}

async function sees(world: RidrsWorld, testId: string, expected: string): Promise<void> {
  await shown(world);
  await waitFor(() => assert.equal(part(world, testId), expected));
}

Given(
  'the ridrs plugins {string} for the workout HUD',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(
      this,
      pluginsCsv.split(',').map((id) => id.trim()),
    );
  },
);

/** The UI over a started host: the World's bridge knows the player's events. */
Given('the workout HUD is shown', async function (this: RidrsWorld) {
  const host = this.ensureHost();
  await host.start();
  await this.settle();
  assert.ok(this.uiBridge);
  const root = document.createElement('div');
  root.style.position = 'relative';
  document.body.appendChild(root);
  const dispose = mountShell(root, this.uiBridge, { logger: PLAIN });
  this.uiViews.push({ root, dispose });
});

function publishStep(world: RidrsWorld, number: number, at: number): void {
  const segment = segments('x')[number - 1];
  assert.ok(segment, `The workout has no step ${number}`);
  world.ensureHost().publishEvent('ui-bridge', workoutStepChangedEvent, {
    stepId: segment.stepId,
    index: segment.index,
    startedAt: at,
  });
}

function startRide(world: RidrsWorld, workout: Workout | undefined, ftp: number | undefined) {
  const host = world.ensureHost();
  const start = world.fixedTime;
  rides.set(world, { start });
  if (ftp !== undefined) {
    host.publishEvent('ui-bridge', activityAthleteEvent, {
      sessionId: SESSION,
      athlete: { provider: 'local', ftp },
    });
  }
  host.publishEvent('ui-bridge', activityStateChangedEvent, {
    state: 'running',
    sessionId: SESSION,
    startedAt: start,
    ...(workout ? { workout: { workout } } : {}),
  });
}

Given(
  'a ride with the workout {string} starts for an athlete with an FTP of {int} W',
  async function (this: RidrsWorld, name: string, ftp: number) {
    startRide(this, vo2max(name), ftp);
    await this.settle();
  },
);

Given(
  'a ride with the workout {string} starts for an athlete without an FTP',
  async function (this: RidrsWorld, name: string) {
    startRide(this, vo2max(name), undefined);
    await this.settle();
  },
);

Given('a ride without a workout starts', async function (this: RidrsWorld) {
  startRide(this, undefined, 250);
  await this.settle();
});

Given(
  'the workout player reported step {int} of the workout in an earlier ride',
  async function (this: RidrsWorld, number: number) {
    publishStep(this, number, this.fixedTime - 3_600_000);
    await this.settle();
  },
);

When(
  'the workout player reports step {int} of the workout',
  async function (this: RidrsWorld, number: number) {
    publishStep(this, number, this.fixedTime);
    await this.settle();
  },
);

When('the workout player reports the workout finished', async function (this: RidrsWorld) {
  this.ensureHost().publishEvent('ui-bridge', workoutFinishedEvent, { at: this.fixedTime });
  await this.settle();
});

/** The ride's clock is the host's: moving it is time going by, and the frames read it. */
When('{int} second(s) go(es) by', async function (this: RidrsWorld, seconds: number) {
  this.fixedTime += seconds * 1000;
  await this.settle();
});

When('the workout ride is paused', async function (this: RidrsWorld) {
  const current = ride(this);
  current.pausedAt = this.fixedTime;
  this.ensureHost().publishEvent('ui-bridge', activityStateChangedEvent, {
    state: 'paused',
    sessionId: SESSION,
    startedAt: current.start,
    pausedAt: this.fixedTime,
    reason: 'rider',
    workout: { workout: vo2max('VO2max 5×4') },
  });
  await this.settle();
});

When('the workout ride goes on', async function (this: RidrsWorld) {
  const current = ride(this);
  assert.ok(current.pausedAt !== undefined, 'The ride is not paused');
  this.ensureHost().publishEvent('ui-bridge', activityStateChangedEvent, {
    state: 'running',
    sessionId: SESSION,
    startedAt: current.start,
    resumedAt: this.fixedTime,
    workout: { workout: vo2max('VO2max 5×4') },
  });
  current.pausedAt = undefined;
  await this.settle();
});

Then('the workout HUD shows the name {string}', async function (this: RidrsWorld, name: string) {
  await sees(this, 'workout-name', name);
});

Then('the workout HUD shows the set {string}', async function (this: RidrsWorld, set: string) {
  await sees(this, 'workout-set', set);
});

Then(
  'the workout HUD shows the current step {string}',
  async function (this: RidrsWorld, text: string) {
    await sees(this, 'workout-now', text);
  },
);

Then(
  'the workout HUD shows the next step {string}',
  async function (this: RidrsWorld, text: string) {
    await sees(this, 'workout-next', text);
  },
);

Then(
  'the workout HUD shows the time left {string}',
  async function (this: RidrsWorld, text: string) {
    await sees(this, 'workout-time-left', text);
  },
);

Then(
  'the workout HUD shows the bar at {int} %',
  async function (this: RidrsWorld, percent: number) {
    await shown(this);
    await waitFor(() => {
      const bar = hud(this)?.querySelector<HTMLElement>('[role="progressbar"]');
      assert.equal(bar?.getAttribute('aria-valuenow'), String(percent));
    });
  },
);

Then('the workout HUD shows no note', async function (this: RidrsWorld) {
  await shown(this);
  await waitFor(() => assert.equal(part(this, 'workout-note'), ''));
});

Then('the workout HUD shows the note {string}', async function (this: RidrsWorld, text: string) {
  await sees(this, 'workout-note', text);
});

Then('the workout HUD counts nothing down', async function (this: RidrsWorld) {
  await shown(this);
  await waitFor(() => assert.equal(part(this, 'workout-countdown'), ''));
});

Then('the workout HUD counts down {string}', async function (this: RidrsWorld, text: string) {
  await sees(this, 'workout-countdown', text);
});

Then('the workout HUD says {string}', async function (this: RidrsWorld, text: string) {
  await sees(this, 'workout-done', text);
});

Then('the workout HUD is not shown', async function (this: RidrsWorld) {
  // The activity screen is up: the ride's HUD is there, the widget is not.
  await within(ui(this)).findByTestId('hud');
  await this.settle();
  assert.equal(hud(this), null);
});

const chart = (world: RidrsWorld) =>
  hud(world)?.querySelector<HTMLElement>('[data-testid="workout-chart"]') ?? null;

Then(
  'the chart of the workout HUD is the variant {string} with its mark at {int} seconds',
  async function (this: RidrsWorld, variant: string, seconds: number) {
    await shown(this);
    await waitFor(() => {
      const drawn = chart(this);
      assert.ok(drawn, 'The HUD draws no chart');
      assert.equal(drawn.dataset.variant, variant);
      const mark = drawn.querySelector<HTMLElement>('[data-testid="workout-chart-progress"]');
      assert.equal(mark?.dataset.seconds, String(seconds));
    });
  },
);

Then(
  'the chart of the workout HUD highlights the step {string} at {int} seconds',
  async function (this: RidrsWorld, stepId: string, seconds: number) {
    await waitFor(() => {
      const current = chart(this)?.querySelector<HTMLElement>('[data-current]');
      assert.ok(current, 'No step of the chart is highlighted');
      assert.equal(current.dataset.stepId, stepId);
      assert.equal(current.dataset.startSeconds, String(seconds));
    });
  },
);

Then('the workout HUD offers nothing to focus', async function (this: RidrsWorld) {
  const widget = await shown(this);
  const focusable = widget.querySelectorAll(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable]',
  );
  assert.equal(focusable.length, 0);
});
