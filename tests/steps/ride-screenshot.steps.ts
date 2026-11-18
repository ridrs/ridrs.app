// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { type ActivityState, activityStateChangedEvent } from '@ridrs/contracts';
import { screenshotPath } from '@ridrs/recording';
import { waitFor, within } from '@testing-library/dom';
import { createRideScreenshot } from '../../plugins/screenshot-tauri/screenshot.ts';
import { fixtureRideScreenshot } from '../fixtures/plugins/ride-screenshot/fixture-ride-screenshot/index.ts';
import type { RidrsWorld } from '../support/world.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/plugins/ride-screenshot');

// ---- Names -------------------------------------------------------------------------------

interface Naming {
  existing: string[];
  path?: string;
}

const namings = new WeakMap<object, Naming>();
const naming = (world: object): Naming => {
  let current = namings.get(world);
  if (!current) {
    current = { existing: [] };
    namings.set(world, current);
  }
  return current;
};

Given('the recordings hold no screenshots', function (this: RidrsWorld) {
  naming(this).existing = [];
});

Given('the recordings hold {string}', function (this: RidrsWorld, namesCsv: string) {
  naming(this).existing = namesCsv.split(',').map((name) => `recordings/${name.trim()}`);
});

When(
  'a screenshot of the ride started at {string} is named',
  function (this: RidrsWorld, startedAt: string) {
    const current = naming(this);
    current.path = screenshotPath(Date.parse(startedAt), current.existing);
  },
);

Then('its path is {string}', function (this: RidrsWorld, path: string) {
  assert.equal(naming(this).path, path);
});

// ---- The button --------------------------------------------------------------------------

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

Given("a stand-in takes the ride's screenshots", function (this: RidrsWorld) {
  this.extraPluginDirs.push(FIXTURES);
  const record = fixtureRideScreenshot();
  record.requests.length = 0;
  record.fails = false;
});

Given('the stand-in cannot take screenshots', () => {
  fixtureRideScreenshot().fails = true;
});

Then('the ERG button comes before the Screenshot button', function (this: RidrsWorld) {
  const erg = within(ui(this)).getByRole('button', { name: 'ERG' });
  const screenshot = within(ui(this)).getByRole('button', { name: 'Screenshot' });
  assert.ok(
    erg.compareDocumentPosition(screenshot) & Node.DOCUMENT_POSITION_FOLLOWING,
    'ERG comes first',
  );
});

Then(
  "a screenshot of the ride was asked for once, with the ride's start",
  async function (this: RidrsWorld) {
    await waitFor(() => assert.equal(fixtureRideScreenshot().requests.length, 1));
    const started = this.hostObserved
      .filter((e) => e.type === activityStateChangedEvent.id)
      .map((e) => e.payload as ActivityState)
      .find((state) => state.state === 'running');
    assert.ok(started && 'startedAt' in started, 'Expected a running ride');
    assert.deepEqual(fixtureRideScreenshot().requests[0], { startedAt: started.startedAt });
  },
);

Then(
  'a screenshot of the ride was asked for {int} times',
  async function (this: RidrsWorld, times: number) {
    await waitFor(() => assert.equal(fixtureRideScreenshot().requests.length, times));
  },
);

// ---- Taking it ---------------------------------------------------------------------------

interface Taking {
  steps: string[];
  fails: boolean;
  file?: string;
  error?: unknown;
}

const takings = new WeakMap<object, Taking>();
const taking = (world: object): Taking => {
  let current = takings.get(world);
  if (!current) {
    current = { steps: [], fails: false };
    takings.set(world, current);
  }
  return current;
};

function screenshotOf(world: object) {
  const current = taking(world);
  const files = naming(world).existing;
  return createRideScreenshot({
    list: async () => [...files],
    capture: (on) => current.steps.push(on ? 'capture on' : 'capture off'),
    settle: async () => {
      current.steps.push('settle');
    },
    snapshot: async (path) => {
      // A snapshot takes a while: a second request must wait for it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      current.steps.push(`snapshot ${path}`);
      if (current.fails) throw new Error('The snapshot failed');
      files.push(path);
    },
  });
}

Given('the snapshot fails', function (this: RidrsWorld) {
  taking(this).fails = true;
});

When(
  'a screenshot of the ride started at {string} is taken',
  async function (this: RidrsWorld, startedAt: string) {
    const current = taking(this);
    try {
      current.file = (await screenshotOf(this)(Date.parse(startedAt))).file;
    } catch (error) {
      current.error = error;
    }
  },
);

When(
  'two screenshots of the ride started at {string} are asked for at once',
  async function (this: RidrsWorld, startedAt: string) {
    const take = screenshotOf(this);
    await Promise.all([take(Date.parse(startedAt)), take(Date.parse(startedAt))]);
  },
);

Then('the steps were {string}', function (this: RidrsWorld, stepsCsv: string) {
  assert.deepEqual(
    taking(this).steps,
    stepsCsv.split(',').map((step) => step.trim()),
  );
});

Then('the screenshot is {string}', function (this: RidrsWorld, path: string) {
  assert.equal(taking(this).error, undefined);
  assert.equal(taking(this).file, path);
});

Then('the screenshot failed', function (this: RidrsWorld) {
  assert.ok(taking(this).error instanceof Error, 'Expected the screenshot to fail');
});
