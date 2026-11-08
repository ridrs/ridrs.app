// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type ActivityAthletePayload,
  type AthleteProfileChangedPayload,
  activityAthleteEvent,
  athleteProfileChangedEvent,
  athleteProfileUpdateService,
  dataSelectService,
} from '@ridrs/contracts';
import { ATHLETE_DOCUMENT, type AthleteDocument } from '../../plugins/profile-local/athlete.ts';
import { DATA_SOURCES_DOCUMENT } from '../../plugins/ui-settings/data-sources.ts';
import type { RidrsWorld } from '../support/world.ts';
import { lastRecording } from './recording.steps.ts';

const ATHLETE_PATH = `config/user/profile-local/${ATHLETE_DOCUMENT.name}.json`;
const SOURCES_PATH = `config/user/ui-settings/${DATA_SOURCES_DOCUMENT.name}.json`;
const DATA_SOURCE_PLUGINS = resolve(import.meta.dirname, '../fixtures/plugins/data-source');
/** The World deletes it after the scenario. */
const FIXTURE_SYMBOL = Symbol.for('ridrs.fixture.data-source');

async function keepJson(world: RidrsWorld, path: string, version: number, value: unknown) {
  const text = `${JSON.stringify({ version, value })}\n`;
  await world.settingsFiles.write(path, new TextEncoder().encode(text));
}

/** The profile on this device, as `profile-local` keeps it. */
async function keepAthlete(world: RidrsWorld, values: Omit<AthleteDocument, 'changedAt'>) {
  await keepJson(world, ATHLETE_PATH, ATHLETE_DOCUMENT.version, { ...values, changedAt: 1 });
}

/** What the second provider is like when the host starts (the fixture reads it then). */
function configureFixture(config: { status?: string; weight?: number }) {
  const globals = globalThis as Record<symbol, unknown>;
  globals[FIXTURE_SYMBOL] = { ...(globals[FIXTURE_SYMBOL] as object | undefined), ...config };
}

Given('the test data source plugin is installed', function (this: RidrsWorld) {
  this.extraPluginDirs.push(DATA_SOURCE_PLUGINS);
});

Given(
  'the test data source offers a weight of {float} kg',
  function (this: RidrsWorld, kg: number) {
    configureFixture({ weight: kg });
  },
);

Given('the test data source is unavailable', function (this: RidrsWorld) {
  configureFixture({ status: 'unavailable' });
});

Given('the test data source is offline', function (this: RidrsWorld) {
  configureFixture({ status: 'offline' });
});

Given(
  'the athlete profile on this device holds a weight of {float} kg',
  async function (this: RidrsWorld, weight: number) {
    await keepAthlete(this, { weight });
  },
);

Given(
  'the athlete profile on this device holds an FTP of {int} W and a weight of {float} kg',
  async function (this: RidrsWorld, ftp: number, weight: number) {
    await keepAthlete(this, { ftp, weight });
  },
);

Given(
  'the rider chose the athlete profile of {string}',
  async function (this: RidrsWorld, provider: string) {
    await keepJson(this, SOURCES_PATH, DATA_SOURCES_DOCUMENT.version, {
      sources: { 'athlete.profile': provider },
    });
  },
);

/** As the Me area does it: through the service, which routes to the owner of the key. */
When(
  'the rider changes the weight in the athlete profile on this device to {float} kg',
  async function (this: RidrsWorld, weight: number) {
    const answer = await this.ensureHost().callService(athleteProfileUpdateService.id, {
      key: 'ridrs',
      weight,
    });
    assert.deepEqual(answer, { ok: true });
    await this.flushState();
  },
);

/** As the settings page does it. */
When(
  'the rider chooses the athlete profile of {string}',
  async function (this: RidrsWorld, provider: string) {
    await this.ensureHost().callService(dataSelectService.id, {
      key: 'athlete.profile',
      provider,
    });
    await this.flushState();
  },
);

function payloads<T>(world: RidrsWorld, type: string): T[] {
  return world.tapped.filter((e) => e.type === type).map((e) => e.payload as T);
}

function frozen(world: RidrsWorld): ActivityAthletePayload {
  const latest = payloads<ActivityAthletePayload>(world, activityAthleteEvent.id).at(-1);
  assert.ok(latest, 'Expected an "activity.athlete" event');
  return latest;
}

Then(
  'the ride froze an athlete of {float} kg from {string}',
  function (this: RidrsWorld, weight: number, provider: string) {
    assert.deepEqual(
      { provider: frozen(this).athlete.provider, weight: frozen(this).athlete.weight },
      { provider, weight },
    );
  },
);

Then(
  'the ride froze an athlete without a weight from {string}',
  function (this: RidrsWorld, provider: string) {
    assert.deepEqual(frozen(this).athlete, { provider });
  },
);

Then('the ride froze no athlete', function (this: RidrsWorld) {
  assert.deepEqual(payloads(this, activityAthleteEvent.id), []);
});

function latestHandedOver(world: RidrsWorld): AthleteProfileChangedPayload {
  const latest = payloads<AthleteProfileChangedPayload>(world, athleteProfileChangedEvent.id).at(
    -1,
  );
  assert.ok(latest, 'Expected an "athlete.profile-changed" event');
  return latest;
}

Then(
  'the latest athlete handed to the next ride is from {string} with an FTP of {int} W and a weight of {float} kg',
  function (this: RidrsWorld, provider: string, ftp: number, weight: number) {
    assert.deepEqual(latestHandedOver(this), { provider, ftp, weight });
  },
);

Then(
  'the latest athlete handed to the next ride is from {string} with a weight of {float} kg',
  function (this: RidrsWorld, provider: string, weight: number) {
    assert.deepEqual(latestHandedOver(this), { provider, weight });
  },
);

Then(
  'the latest athlete handed to the next ride is from {string} without values',
  function (this: RidrsWorld, provider: string) {
    assert.deepEqual(latestHandedOver(this), { provider });
  },
);

Then(
  'the snapshot section {string} reports a mass of {float} with the origin {string}',
  async function (this: RidrsWorld, section: string, mass: number, origin: string) {
    const recording = await lastRecording(this);
    const value = recording.snapshot.sections[section] as {
      mass?: { value: number; origin: string };
    };
    assert.deepEqual(value?.mass, { value: mass, origin });
  },
);
