// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { type ActivityState, activityStateChangedEvent } from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';

/** "10:00:00.250" means that time on 2026-11-01 UTC. */
function parseTime(text: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(text);
  assert.ok(match, `Unrecognized time "${text}"`);
  const [, h, m, s, ms] = match.map(Number);
  return Date.UTC(2026, 10, 1, h, m, s, ms);
}

function activityStates(world: RidrsWorld): ActivityState[] {
  return world.hostObserved
    .filter((e) => e.type === activityStateChangedEvent.id)
    .map((e) => e.payload as ActivityState);
}

function latest(world: RidrsWorld): ActivityState {
  const state = activityStates(world).at(-1);
  assert.ok(state, 'Expected an "activity.state-changed" event');
  return state;
}

function withSession(state: ActivityState): Exclude<ActivityState, { state: 'idle' }> {
  assert.notEqual(state.state, 'idle', 'Expected a ride with a session');
  return state as Exclude<ActivityState, { state: 'idle' }>;
}

async function publishFrom(world: RidrsWorld, pluginId: string, eventId: string): Promise<void> {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected plugin "${pluginId}" to be running`);
  ctx.events.publish(world.getEventDefinition(eventId), {});
  await world.settle();
}

Given(
  'the ridrs plugin {string} together with a probe plugin {string}',
  async function (this: RidrsWorld, pluginId: string, probeId: string) {
    this.realPluginIds = [pluginId];
    await this.writeProbePluginFolder({ folder: probeId, id: probeId, types: ['test'] });
  },
);

When(
  '{string} publishes {string}',
  async function (this: RidrsWorld, pluginId: string, eventId: string) {
    await publishFrom(this, pluginId, eventId);
  },
);

Given(
  '{string} published {string}',
  async function (this: RidrsWorld, pluginId: string, eventId: string) {
    await publishFrom(this, pluginId, eventId);
  },
);

Given('the ride is idle', function (this: RidrsWorld) {
  assert.equal(latest(this).state, 'idle');
});

Given('the ride is finished', async function (this: RidrsWorld) {
  await publishFrom(this, 'test-ui', 'activity.start-requested');
  await publishFrom(this, 'test-ui', 'activity.finish-requested');
  assert.equal(latest(this).state, 'finished');
});

Then(
  'the latest {string} event has the state {string}',
  function (this: RidrsWorld, eventId: string, state: string) {
    assert.equal(eventId, activityStateChangedEvent.id);
    assert.equal(latest(this).state, state);
  },
);

Then('it was started at {string}', function (this: RidrsWorld, time: string) {
  assert.equal(withSession(latest(this)).startedAt, parseTime(time));
});

Then('it ended at {string}', function (this: RidrsWorld, time: string) {
  const state = latest(this);
  assert.equal(state.state, 'finished');
  assert.equal(state.endedAt, parseTime(time));
});

Then('it carries a session id', function (this: RidrsWorld) {
  assert.ok(withSession(latest(this)).sessionId.length > 0);
});

Then(
  'it carries the same session id as the {string} event',
  function (this: RidrsWorld, state: string) {
    const earlier = activityStates(this).findLast((s) => s.state === state);
    assert.ok(earlier, `Expected a "${state}" event`);
    assert.equal(withSession(latest(this)).sessionId, withSession(earlier).sessionId);
  },
);

Then('its session id differs from the one of the finished ride', function (this: RidrsWorld) {
  const finished = activityStates(this).findLast((s) => s.state === 'finished');
  assert.ok(finished, 'Expected a finished ride');
  assert.notEqual(withSession(latest(this)).sessionId, withSession(finished).sessionId);
});

Then(
  'exactly one {string} event with the state {string} was published',
  function (this: RidrsWorld, eventId: string, state: string) {
    assert.equal(eventId, activityStateChangedEvent.id);
    assert.equal(activityStates(this).filter((s) => s.state === state).length, 1);
  },
);
