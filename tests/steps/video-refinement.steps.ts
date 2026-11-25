// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { type ActivityState, activityStateChangedEvent } from '@ridrs/contracts';
import { PluginHost } from '@ridrs/core';
import { parseRefinement, REFINE_FILE } from '@ridrs/ride';
import { TestInterpolator } from '../support/test-interpolator.ts';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The refinement of a downloaded route (ADR 0110), headless: the real source, downloader and
 * media storage with the simulated downloads, and a test interpolator in place of the device's
 * frame rate conversion.
 */

const MEDIA_DIR_ENV = 'RIDRS_MEDIA_DIR';
const PROBE = 'test-interpolator';

const interpolators = new WeakMap<RidrsWorld, TestInterpolator>();
/** How many stretches the interpolator was asked for before the host started again. */
const askedBefore = new WeakMap<RidrsWorld, number>();

function interpolator(world: RidrsWorld): TestInterpolator {
  const found = interpolators.get(world);
  assert.ok(found, 'Expected the test interpolator');
  return found;
}

const folderOf = (key: string) =>
  join(process.env[MEDIA_DIR_ENV] ?? '', 'videos', ...key.split('/'));

Given('a test interpolator computes in-between frames', async function (this: RidrsWorld) {
  const test = new TestInterpolator(process.env[MEDIA_DIR_ENV] ?? '');
  interpolators.set(this, test);
  this.getBehavior(PROBE).providedImplementations.set('video.interpolate', test.interpolator);
  await this.writeProbePluginFolder({
    folder: PROBE,
    id: PROBE,
    types: ['test'],
    provides: ['video.interpolate'],
  });
});

Given('the device cannot compute in-between frames', async function (this: RidrsWorld) {
  this.getBehavior(PROBE).providedImplementations.delete('video.interpolate');
  await this.writeProbePluginFolder({ folder: PROBE, id: PROBE, types: ['test'] });
});

Given('the test interpolator stops halfway', function (this: RidrsWorld) {
  interpolator(this).stopHalfway = true;
});

Given(
  'the test interpolator fails with {string} for the stretches after {int} s',
  function (this: RidrsWorld, reason: string, after: number) {
    interpolator(this).failure = reason;
    interpolator(this).failingFrom = after;
  },
);

Given('the test interpolator fails with {string}', function (this: RidrsWorld, reason: string) {
  interpolator(this).failure = reason;
});

When(/^the test interpolator (?:goes on|works again at once)$/, async function (this: RidrsWorld) {
  interpolator(this).goOn();
  await this.settle();
});

/** The refinement state of `key`, as the app state has it last. */
const refinementOf = (world: RidrsWorld, key: string) =>
  world.ensureHost().getState('video.refinement').get(key) as
    | { status: string; progress?: number; stretches?: number; reason?: string }
    | undefined;

async function waitForRefinement(
  world: RidrsWorld,
  key: string,
  expected: Record<string, unknown>,
): Promise<void> {
  const matches = () => {
    const state = refinementOf(world, key);
    return (
      state !== undefined &&
      Object.entries(expected).every(
        ([field, value]) => state[field as keyof typeof state] === value,
      )
    );
  };
  try {
    await world.waitForIo(matches, `the refinement ${JSON.stringify(expected)}`);
  } catch {
    assert.fail(
      `The refinement of "${key}" is ${JSON.stringify(refinementOf(world, key))}, not ${JSON.stringify(expected)}`,
    );
  }
}

Then(
  /^the refinement of "([^"]*)" is done with (\d+) stretch(?:es)?$/,
  async function (this: RidrsWorld, key: string, stretches: string) {
    await waitForRefinement(this, key, { status: 'done', stretches: Number(stretches) });
  },
);

When(
  /^the refinement of "([^"]*)" is refining at (\d+) %$/,
  async function (this: RidrsWorld, key: string, percent: string) {
    await waitForRefinement(this, key, { status: 'refining', progress: Number(percent) / 100 });
  },
);

Then('the refinement of {string} is waiting', async function (this: RidrsWorld, key: string) {
  await waitForRefinement(this, key, { status: 'waiting' });
});

Then(
  'the refinement of {string} is skipped because {string}',
  async function (this: RidrsWorld, key: string, reason: string) {
    await waitForRefinement(this, key, { status: 'skipped', reason });
  },
);

Then(
  'the refinement of {string} failed because {string}',
  async function (this: RidrsWorld, key: string, reason: string) {
    await waitForRefinement(this, key, { status: 'failed', reason });
  },
);

Then(
  'the test interpolator was asked for {int} s to {int} s of {string} with {int} frames per frame',
  function (this: RidrsWorld, from: number, to: number, video: string, factor: number) {
    const asked = interpolator(this).requested.at(-1);
    assert.ok(asked, 'The test interpolator was asked for no stretch');
    assert.deepEqual(
      [asked.video, Math.round(asked.from), Math.round(asked.to), asked.factor],
      [video, from, to, factor],
    );
  },
);

/** The route's refinement as its folder has it. */
const refinementFile = (key: string) =>
  parseRefinement(readFileSync(join(folderOf(key), ...REFINE_FILE.split('/')), 'utf8'));

Then(
  /^the route "([^"]*)" has (\d+) refined stretch(?:es)?$/,
  function (this: RidrsWorld, key: string, count: string) {
    assert.equal(refinementFile(key).segments.length, Number(count));
  },
);

Then(
  'the route {string} has the refined stretch from {int} s to {int} s with {int} frames per frame',
  function (this: RidrsWorld, key: string, from: number, to: number, factor: number) {
    const { video, segments } = refinementFile(key);
    assert.equal(video, 'FR_Test.mp4');
    assert.equal(segments.length, 1);
    const [segment] = segments;
    assert.deepEqual(
      [Math.round(segment?.from ?? -1), Math.round(segment?.to ?? -1), segment?.factor],
      [from, to, factor],
    );
    assert.ok(
      existsSync(join(folderOf(key), 'refine', segment?.file ?? '')),
      `No file ${segment?.file}`,
    );
  },
);

Then(
  'the route offer {string} names the files of its refinement',
  async function (this: RidrsWorld, key: string) {
    const files = () =>
      (
        this.ensureHost().getState('route.offer').get(key) as
          | { availability?: { files?: Record<string, string> } }
          | undefined
      )?.availability?.files ?? {};
    const expected = () => [
      REFINE_FILE,
      ...refinementFile(key).segments.map((segment) => `refine/${segment.file}`),
    ];
    await this.waitForIo(
      () => expected().every((path) => path in files()),
      'the offer to name the refinement',
    );
  },
);

Then(
  'the route {string} has no half-done refined stretch',
  function (this: RidrsWorld, key: string) {
    const folder = join(folderOf(key), 'refine');
    const parts = existsSync(folder)
      ? readdirSync(folder).filter((name) => name.endsWith('.part'))
      : [];
    assert.deepEqual(parts, []);
  },
);

Given(
  'the route {string} was downloaded and refined',
  async function (this: RidrsWorld, key: string) {
    const host = this.ensureHost();
    await host.start();
    await this.settle();
    await host.callService('route.fetch', { key, option: 'package' }, { pluginId: 'ui-bridge' });
    await waitForRefinement(this, key, { status: 'done', stretches: 1 });
    askedBefore.set(this, interpolator(this).requested.length);
  },
);

When('the host has started again', async function (this: RidrsWorld) {
  // A new host on the same media folder, as the app starting again.
  await this.ensureHost().stop();
  this.attachHost(new PluginHost(this.hostOptions()));
  await this.ensureHost().start();
  await this.settle();
});

Then(
  'the test interpolator was asked for {int} stretches',
  function (this: RidrsWorld, count: number) {
    assert.equal(interpolator(this).requested.length, count);
  },
);

Then('the test interpolator was asked for no stretch since', function (this: RidrsWorld) {
  assert.equal(interpolator(this).requested.length, askedBefore.get(this));
});

/** Tells the plugins the ride's state, as the activity session does. */
async function rideState(world: RidrsWorld, state: ActivityState): Promise<void> {
  const ctx = world.ensureHost().getPluginContext(PROBE);
  assert.ok(ctx, `Expected plugin "${PROBE}" to be running`);
  // From outside the host, as the activity session's state reaches the plugins: an external input.
  ctx.inputs.accept(world.getEventDefinition(activityStateChangedEvent.id), state);
  await world.settle();
}

When('a ride starts', async function (this: RidrsWorld) {
  await rideState(this, { state: 'running', sessionId: 'refinement-ride', startedAt: 0 });
});

When('the ride ends', async function (this: RidrsWorld) {
  await rideState(this, {
    state: 'finished',
    sessionId: 'refinement-ride',
    startedAt: 0,
    endedAt: 60_000,
  });
});
