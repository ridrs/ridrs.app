// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { RidrsError } from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

Given(
  'the event type {string} with the payload schema:',
  function (this: RidrsWorld, eventId: string, table: DataTable) {
    const fields = table.hashes().map((r) => ({
      field: r.field ?? '',
      type: r.type ?? 'string',
    }));
    this.registerEventSchema(eventId, fields);
  },
);

Given('the running plugins {string}', async function (this: RidrsWorld, pluginsCsv: string) {
  for (const id of splitCsv(pluginsCsv)) {
    await this.writeProbePluginFolder({
      folder: id,
      id,
    });
  }
  const host = this.ensureHost();
  await host.start();
});

Given(
  '{string} subscribes to {string}',
  function (this: RidrsWorld, pluginId: string, eventId: string) {
    const host = this.ensureHost();
    const ctx = host.getPluginContext(pluginId);
    assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
    const def = this.getEventDefinition(eventId);
    const sub = ctx.events.subscribe(def, (envelope) => {
      this.recordEvent(pluginId, envelope);
    });
    let pluginSubs = this.subscriptions.get(pluginId);
    if (!pluginSubs) {
      pluginSubs = new Map();
      this.subscriptions.set(pluginId, pluginSubs);
    }
    pluginSubs.set(eventId, sub);
  },
);

Given(
  '{string} subscribes to {string} and answers each greeting with a {string} echoing the text',
  function (this: RidrsWorld, pluginId: string, listenEventId: string, replyEventId: string) {
    const host = this.ensureHost();
    const ctx = host.getPluginContext(pluginId);
    assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
    const listenDef = this.getEventDefinition(listenEventId);
    const replyDef = this.getEventDefinition(replyEventId);

    ctx.events.subscribe(listenDef, (envelope) => {
      this.recordEvent(pluginId, envelope);
      const payload = envelope.payload as { text: string };
      ctx.events.publish(replyDef, { text: payload.text });
    });
  },
);

Given(
  '{string} subscribes to {string} and throws {string} while handling it',
  function (this: RidrsWorld, pluginId: string, eventId: string, errorMessage: string) {
    const host = this.ensureHost();
    const ctx = host.getPluginContext(pluginId);
    assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
    const def = this.getEventDefinition(eventId);

    ctx.events.subscribe(def, () => {
      throw new Error(errorMessage);
    });
  },
);

When(
  '{string} publishes {string} with text {string}',
  function (this: RidrsWorld, pluginId: string, eventId: string, text: string) {
    const host = this.ensureHost();
    const ctx = host.getPluginContext(pluginId);
    assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
    const def = this.getEventDefinition(eventId);
    this.lastPublishError = undefined;
    try {
      // From the scenario, outside any turn: an external input.
      ctx.inputs.accept(def, { text });
    } catch (error) {
      this.lastPublishError = error;
    }
  },
);

When(
  '{string} publishes {string} with the payload {string}',
  function (this: RidrsWorld, pluginId: string, eventId: string, rawPayload: string) {
    const host = this.ensureHost();
    const ctx = host.getPluginContext(pluginId);
    assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
    const def = this.getEventDefinition(eventId);
    const parsedPayload: unknown = JSON.parse(rawPayload);
    this.lastPublishError = undefined;
    try {
      ctx.inputs.accept(def, parsedPayload);
    } catch (error) {
      this.lastPublishError = error;
    }
  },
);

When(
  '{string} cancels its subscription to {string}',
  function (this: RidrsWorld, pluginId: string, eventId: string) {
    const sub = this.subscriptions.get(pluginId)?.get(eventId);
    assert.ok(sub, `Expected subscription of "${pluginId}" to "${eventId}"`);
    sub.unsubscribe();
  },
);

Then('the publication succeeded', function (this: RidrsWorld) {
  assert.equal(this.lastPublishError, undefined);
});

Then(
  'the publication is rejected with a(n) {string} error mentioning {string}',
  function (this: RidrsWorld, expectedCode: string, snippet: string) {
    assert.ok(this.lastPublishError instanceof RidrsError, 'Expected a RidrsError');
    assert.equal(this.lastPublishError.code, expectedCode);
    assert.ok(
      this.lastPublishError.message.includes(snippet),
      `Expected error message "${this.lastPublishError.message}" to mention "${snippet}"`,
    );
  },
);

Then(
  'the publication is rejected with a(n) {string} error',
  function (this: RidrsWorld, expectedCode: string) {
    assert.ok(this.lastPublishError instanceof RidrsError, 'Expected a RidrsError');
    assert.equal(this.lastPublishError.code, expectedCode);
  },
);

Then(
  '{string} received exactly these events:',
  function (this: RidrsWorld, pluginId: string, table: DataTable) {
    const received = this.receivedEvents.get(pluginId) ?? [];
    const actual = received.map((env) => ({
      type: env.type,
      text: String((env.payload as { text?: unknown }).text ?? ''),
      source: env.source,
    }));
    const expected = table.hashes().map((row) => ({
      type: row.type ?? '',
      text: row.text ?? '',
      source: row.source ?? '',
    }));
    assert.deepEqual(actual, expected);
  },
);

Then(
  'every event received by {string} carries an id and the current time of the host clock',
  function (this: RidrsWorld, pluginId: string) {
    const received = this.receivedEvents.get(pluginId) ?? [];
    assert.ok(received.length > 0, `Expected "${pluginId}" to have received events`);
    for (const env of received) {
      assert.ok(typeof env.id === 'string' && env.id.length > 0);
      assert.equal(env.timestamp, this.fixedTime);
    }
  },
);

Then(
  '{string} received {int} {string} event(s)',
  function (this: RidrsWorld, pluginId: string, count: number, eventType: string) {
    const received = (this.receivedEvents.get(pluginId) ?? []).filter((e) => e.type === eventType);
    assert.equal(received.length, count);
  },
);

Then(
  '{string} and {string} received the same event id',
  function (this: RidrsWorld, firstPlugin: string, secondPlugin: string) {
    const first = this.receivedEvents.get(firstPlugin)?.[0];
    const second = this.receivedEvents.get(secondPlugin)?.[0];
    assert.ok(first, `Expected "${firstPlugin}" to have received an event`);
    assert.ok(second, `Expected "${secondPlugin}" to have received an event`);
    assert.equal(first.id, second.id);
  },
);

Then('{string} received no events', function (this: RidrsWorld, pluginId: string) {
  const received = this.receivedEvents.get(pluginId) ?? [];
  assert.deepEqual(received, []);
});

Then(
  'the event bus holds no subscriptions of {string}',
  function (this: RidrsWorld, pluginId: string) {
    const host = this.ensureHost();
    assert.equal(host.getSubscriptionCount(pluginId), 0);
  },
);

Then('the event bus holds no subscriptions', function (this: RidrsWorld) {
  const host = this.ensureHost();
  assert.equal(host.getSubscriptionCount(), 0);
});
