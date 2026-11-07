// SPDX-License-Identifier: AGPL-3.0-or-later

// Stage 1 of ridrs_elephant/prompts/14-app-state-and-services.md: app state and services beside
// the simulation bus (ADR 0068).

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  defineService,
  defineState,
  type PluginContext,
  RidrsError,
  type ServiceDefinition,
  type StateDefinition,
} from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import { z } from 'zod';
import type { RidrsWorld } from '../support/world.ts';
import { openRecordingText } from './journal.steps.ts';

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stateDefinition(world: RidrsWorld, topicId: string): StateDefinition {
  return world.stateDefinitions.get(topicId) ?? defineState(topicId, z.unknown());
}

function serviceDefinition(world: RidrsWorld, serviceId: string): ServiceDefinition {
  return (
    world.serviceDefinitions.get(serviceId) ??
    defineService(serviceId, { request: z.unknown(), response: z.unknown() })
  );
}

function contextOf(world: RidrsWorld, pluginId: string): PluginContext {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected plugin "${pluginId}" to be running`);
  return ctx;
}

/** What a probe of ADR 0068 does: own and set keys, watch topics, provide and call services. */
interface AppProbe {
  readonly owns?: string;
  readonly sets?: readonly string[];
  readonly watches?: string;
  readonly provides?: string;
  readonly failsWith?: string;
  readonly calls?: string;
}

async function writeAppProbe(
  world: RidrsWorld,
  probeId: string,
  type: string,
  probe: AppProbe,
): Promise<void> {
  await world.writeProbePluginFolder({
    folder: probeId,
    id: probeId,
    types: [type],
    ...(probe.owns || probe.watches
      ? {
          state: {
            ...(probe.owns ? { owns: [probe.owns] } : {}),
            ...(probe.watches ? { watches: [probe.watches] } : {}),
          },
        }
      : {}),
    ...(probe.provides || probe.calls
      ? {
          services: {
            ...(probe.provides ? { provides: [probe.provides] } : {}),
            ...(probe.calls ? { calls: [probe.calls] } : {}),
          },
        }
      : {}),
  });
  world.getBehavior(probeId).onStart.push((ctx) => {
    if (probe.owns) {
      for (const key of probe.sets ?? []) {
        ctx.state.set(stateDefinition(world, probe.owns), key, { title: key });
      }
    }
    if (probe.watches) {
      const topic = probe.watches;
      ctx.state.watch(stateDefinition(world, topic), (view) => {
        const list = world.stateDeliveries.get(probeId) ?? [];
        list.push({ topic, view });
        world.stateDeliveries.set(probeId, list);
      });
    }
    if (probe.provides) {
      const service = probe.provides;
      ctx.services.provide(serviceDefinition(world, service), (request) => {
        const list = world.serviceCalls.get(probeId) ?? [];
        list.push({ service, request });
        world.serviceCalls.set(probeId, list);
        if (probe.failsWith) {
          throw new Error(probe.failsWith);
        }
        return service === 'test.ping' ? { echo: (request as { text: string }).text } : {};
      });
    }
  });
}

// ---- Probes ------------------------------------------------------------------------------

Given(
  'a probe plugin {string} of type {string}',
  async function (this: RidrsWorld, probeId: string, type: string) {
    await writeAppProbe(this, probeId, type, {});
  },
);

Given(
  'a probe plugin {string} of type {string} that owns {string}',
  async function (this: RidrsWorld, probeId: string, type: string, topic: string) {
    await writeAppProbe(this, probeId, type, { owns: topic });
  },
);

Given(
  'a probe plugin {string} of type {string} that owns {string} and sets {string} when it starts',
  async function (this: RidrsWorld, probeId: string, type: string, topic: string, keys: string) {
    await writeAppProbe(this, probeId, type, { owns: topic, sets: splitCsv(keys) });
  },
);

Given(
  'a probe plugin {string} of type {string} that owns {string}, sets {string} when it starts and provides {string}',
  async function (
    this: RidrsWorld,
    probeId: string,
    type: string,
    topic: string,
    keys: string,
    service: string,
  ) {
    await writeAppProbe(this, probeId, type, {
      owns: topic,
      sets: splitCsv(keys),
      provides: service,
    });
  },
);

Given(
  'a probe plugin {string} of type {string} that owns {string}, sets {string} when it starts and provides {string} failing with {string}',
  async function (
    this: RidrsWorld,
    probeId: string,
    type: string,
    topic: string,
    keys: string,
    service: string,
    message: string,
  ) {
    await writeAppProbe(this, probeId, type, {
      owns: topic,
      sets: splitCsv(keys),
      provides: service,
      failsWith: message,
    });
  },
);

Given(
  'a probe plugin {string} of type {string} that watches {string}',
  async function (this: RidrsWorld, probeId: string, type: string, topic: string) {
    await writeAppProbe(this, probeId, type, { watches: topic });
  },
);

Given(
  'a probe plugin {string} of type {string} that provides {string}',
  async function (this: RidrsWorld, probeId: string, type: string, service: string) {
    await writeAppProbe(this, probeId, type, { provides: service });
  },
);

Given(
  'a probe plugin {string} of type {string} that provides {string} and fails with {string}',
  async function (
    this: RidrsWorld,
    probeId: string,
    type: string,
    service: string,
    message: string,
  ) {
    await writeAppProbe(this, probeId, type, { provides: service, failsWith: message });
  },
);

Given(
  'a probe plugin {string} of type {string} that calls {string}',
  async function (this: RidrsWorld, probeId: string, type: string, service: string) {
    await writeAppProbe(this, probeId, type, { calls: service });
  },
);

for (const [phrase, field] of [
  ['owns the state', 'state'],
  ['watches the state', 'state'],
  ['provides the service', 'services'],
] as const) {
  Given(
    `a plugin folder {string} whose manifest declares the types {string} and ${phrase} {string}`,
    async function (this: RidrsWorld, folder: string, types: string, id: string) {
      const path = join(this.tempPluginDir, folder);
      await mkdir(path, { recursive: true });
      const manifest = {
        id: folder,
        name: folder,
        version: '1.0.0',
        types: splitCsv(types),
        provides: [],
        requires: [],
        entry: 'index.ts',
        [field]:
          field === 'services'
            ? { provides: [id] }
            : phrase === 'watches the state'
              ? { watches: [id] }
              : { owns: [id] },
      };
      await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest), 'utf8');
      await writeFile(join(path, 'index.ts'), 'export default {};\n', 'utf8');
    },
  );
}

// ---- Writing state -----------------------------------------------------------------------

When(
  '{string} sets the {string} state {string} to {string}',
  async function (this: RidrsWorld, probeId: string, topic: string, key: string, json: string) {
    this.lastStateError = undefined;
    try {
      contextOf(this, probeId).state.set(stateDefinition(this, topic), key, JSON.parse(json));
    } catch (error) {
      this.lastStateError = error;
    }
    await this.flushState();
  },
);

for (const verb of ['sets', 'set']) {
  Given(
    `{string} ${verb} the {string} state {string} {int} times in one turn, its progress rising to 1`,
    async function (this: RidrsWorld, probeId: string, topic: string, key: string, times: number) {
      const ctx = contextOf(this, probeId);
      const definition = stateDefinition(this, topic);
      // As a download reports its progress: many writes of one key while a turn runs.
      this.ensureHost().input(() => {
        for (let i = 1; i <= times; i += 1) {
          ctx.state.set(definition, key, { title: key, progress: i / times });
        }
      });
      await this.flushState();
      await this.flushState();
    },
  );
}

Then('the state write failed with {string}', function (this: RidrsWorld, code: string) {
  const error = this.lastStateError;
  assert.ok(error instanceof RidrsError, `Expected a RidrsError, got ${String(error)}`);
  assert.equal(error.code, code, error.message);
});

Then(
  'the state write failed with {string} mentioning {string}',
  function (this: RidrsWorld, code: string, snippet: string) {
    const error = this.lastStateError;
    assert.ok(error instanceof RidrsError, `Expected a RidrsError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.ok(error.message.includes(snippet), error.message);
  },
);

Then(
  'the {string} state {string} is {string}',
  function (this: RidrsWorld, topic: string, key: string, json: string) {
    assert.deepEqual(this.ensureHost().getState(topic).get(key), JSON.parse(json));
  },
);

Then(
  'the {string} state holds no {string}',
  function (this: RidrsWorld, topic: string, key: string) {
    assert.equal(this.ensureHost().getState(topic).has(key), false);
  },
);

// ---- Deliveries --------------------------------------------------------------------------

function deliveries(world: RidrsWorld, topic: string, probeId: string) {
  return (world.stateDeliveries.get(probeId) ?? []).filter((d) => d.topic === topic);
}

function delivery(world: RidrsWorld, topic: string, probeId: string, which: 'first' | 'latest') {
  const list = deliveries(world, topic, probeId);
  const found = which === 'first' ? list[0] : list.at(-1);
  assert.ok(found, `"${probeId}" received no "${topic}" delivery`);
  return found.view;
}

for (const which of ['first', 'latest'] as const) {
  Then(
    `the ${which} {string} delivery to {string} changed {string} and holds {string}`,
    function (this: RidrsWorld, topic: string, probeId: string, changed: string, keys: string) {
      const view = delivery(this, topic, probeId, which);
      assert.deepEqual([...view.changed].sort(), splitCsv(changed).sort());
      assert.deepEqual([...view.entries.keys()].sort(), splitCsv(keys).sort());
    },
  );
}

Then(
  'the latest {string} delivery to {string} changed {string} and holds nothing',
  function (this: RidrsWorld, topic: string, probeId: string, changed: string) {
    const view = delivery(this, topic, probeId, 'latest');
    assert.deepEqual([...view.changed].sort(), splitCsv(changed).sort());
    assert.equal(view.entries.size, 0);
  },
);

Then(
  'the latest {string} delivery to {string} changed {string} to {string}',
  function (this: RidrsWorld, topic: string, probeId: string, key: string, json: string) {
    const view = delivery(this, topic, probeId, 'latest');
    assert.deepEqual(view.changed, [key]);
    assert.deepEqual(view.entries.get(key), JSON.parse(json));
  },
);

Then(
  '{string} received {int} {string} deliveries',
  function (this: RidrsWorld, probeId: string, count: number, topic: string) {
    assert.equal(deliveries(this, topic, probeId).length, count);
  },
);

// ---- Services ----------------------------------------------------------------------------

async function settleCall(world: RidrsWorld, call: () => Promise<unknown>): Promise<void> {
  const settled = call().then(
    (value) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  await world.flushState();
  world.lastCall = await settled;
}

for (const verb of ['calls', 'called']) {
  When(
    `the UI bridge ${verb} {string} with {string}`,
    async function (this: RidrsWorld, service: string, json: string) {
      // As the in-process bridge calls for client code: with the caller "ui-bridge".
      await settleCall(this, () =>
        this.ensureHost().callService(service, JSON.parse(json), { pluginId: 'ui-bridge' }),
      );
    },
  );
}

When(
  '{string} calls {string} with {string}',
  async function (this: RidrsWorld, probeId: string, service: string, json: string) {
    const ctx = contextOf(this, probeId);
    await settleCall(this, () =>
      ctx.services.call(serviceDefinition(this, service), JSON.parse(json)),
    );
  },
);

Then('the call resolved with {string}', function (this: RidrsWorld, json: string) {
  const call = this.lastCall;
  assert.ok(call, 'No call was made');
  assert.ok(call.resolved, `The call was rejected: ${String(!call.resolved && call.error)}`);
  assert.deepEqual(call.value, JSON.parse(json));
});

function rejection(world: RidrsWorld): RidrsError {
  const call = world.lastCall;
  assert.ok(call && !call.resolved, `Expected a rejected call, got ${JSON.stringify(call)}`);
  assert.ok(call.error instanceof RidrsError, `Expected a RidrsError, got ${String(call.error)}`);
  return call.error;
}

Then('the call was rejected with {string}', function (this: RidrsWorld, code: string) {
  const error = rejection(this);
  assert.equal(error.code, code, error.message);
});

Then(
  'the call was rejected with {string} and the message {string}',
  function (this: RidrsWorld, code: string, message: string) {
    const error = rejection(this);
    assert.equal(error.code, code, error.message);
    assert.equal(error.message, message);
  },
);

Then(
  /^"([^"]*)" handled (\d+) "([^"]*)" calls?$/,
  function (this: RidrsWorld, probeId: string, count: string, service: string) {
    const handled = (this.serviceCalls.get(probeId) ?? []).filter((c) => c.service === service);
    assert.equal(handled.length, Number(count));
  },
);

// ---- Recording ---------------------------------------------------------------------------

Then(
  'the open recording on the disk holds nothing of the {string} state',
  function (this: RidrsWorld, topic: string) {
    const written = this.stateOf(topic);
    assert.ok(written.length > 0, `Nothing was written to "${topic}"`);
    const { text } = openRecordingText(this);
    assert.ok(!text.includes(topic), `The recording names "${topic}"`);
    for (const { key } of written) {
      assert.ok(!text.includes(JSON.stringify(key)), `The recording holds the key "${key}"`);
    }
  },
);

// ---- UI ----------------------------------------------------------------------------------

function shownUi(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

Then('the page lists the offers {string}', async function (this: RidrsWorld, offers: string) {
  await waitFor(() => {
    const items = [...shownUi(this).querySelectorAll('li')].map((item) =>
      (item.firstChild?.textContent ?? '').trim(),
    );
    assert.deepEqual(items, splitCsv(offers));
  });
});

Then('the page shows the status {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    assert.equal(within(shownUi(this)).getByRole('status').textContent, text);
  });
});

Then(
  'the UI bridge refuses to watch {string} with {string}',
  function (this: RidrsWorld, topic: string, code: string) {
    assert.ok(this.uiBridge, 'The UI bridge exists only in @ui scenarios');
    const bridge = this.uiBridge;
    assert.throws(
      () => bridge.watchState(topic, () => {}),
      (error: unknown) => error instanceof RidrsError && error.code === code,
    );
  },
);

Then(
  'the UI bridge refuses to call {string} with {string}',
  async function (this: RidrsWorld, service: string, code: string) {
    assert.ok(this.uiBridge, 'The UI bridge exists only in @ui scenarios');
    await assert.rejects(
      this.uiBridge.call(service, { text: 'hello' }),
      (error: unknown) => error instanceof RidrsError && error.code === code,
    );
  },
);

// ---- Services of a composition root ------------------------------------------------------

/** What `provideService` of a composition root threw. */
const rootErrors = new WeakMap<RidrsWorld, unknown>();

for (const verb of ['provides', 'provided']) {
  Given(
    `the composition root provides {string}`.replace('provides', verb),
    function (this: RidrsWorld, service: string) {
      try {
        this.ensureHost().provideService(
          'test-root',
          serviceDefinition(this, service),
          (request) => ({
            echo: (request as { text: string }).text,
          }),
        );
      } catch (error) {
        rootErrors.set(this, error);
      }
    },
  );
}

Then('providing it failed with {string}', function (this: RidrsWorld, code: string) {
  const error = rootErrors.get(this);
  assert.ok(error instanceof RidrsError, `Expected a RidrsError, got ${String(error)}`);
  assert.equal(error.code, code);
});
