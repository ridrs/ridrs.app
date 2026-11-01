// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import type { CapabilityCardinality, PluginState } from '@ridrs/contracts';
import type { LifecycleHookName, RidrsWorld } from '../support/world.ts';

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

Given('the capability contracts:', function (this: RidrsWorld, table: DataTable) {
  for (const row of table.hashes()) {
    const capId = row.capability ?? '';
    const cardinality = (row.cardinality ?? 'single') as CapabilityCardinality;
    this.getOrRegisterCapability(capId, cardinality);
  }
});

Given('the plugins:', async function (this: RidrsWorld, table: DataTable) {
  for (const row of table.hashes()) {
    const id = row.id ?? '';
    await this.writeProbePluginFolder({
      folder: id,
      id,
      provides: splitCsv(row.provides),
      requires: splitCsv(row.requires),
    });
  }
});

Given(
  'the {string} hook of {string} completes asynchronously',
  function (this: RidrsWorld, hook: string, pluginId: string) {
    this.getBehavior(pluginId).asyncHooks.add(hook as LifecycleHookName);
  },
);

Given(
  'the {string} hook of {string} throws {string}',
  function (this: RidrsWorld, hook: string, pluginId: string, errorMessage: string) {
    this.getBehavior(pluginId).throwInHook.set(hook as LifecycleHookName, errorMessage);
  },
);

Given(
  'the entry module of {string} does not exist',
  async function (this: RidrsWorld, pluginId: string) {
    this.getBehavior(pluginId).missingEntry = true;
    await rm(join(this.tempPluginDir, pluginId, 'index.ts'), { force: true });
  },
);

Given('the host has started', async function (this: RidrsWorld) {
  const host = this.ensureHost();
  await host.start();
  await this.settle();
});

When('the host starts', async function (this: RidrsWorld) {
  const host = this.ensureHost();
  await host.start();
  await this.settle();
});

When('the host stops', async function (this: RidrsWorld) {
  const host = this.ensureHost();
  await host.stop();
});

When('the host is disposed', async function (this: RidrsWorld) {
  const host = this.ensureHost();
  await host.dispose();
});

When('the plugin {string} is stopped', async function (this: RidrsWorld, pluginId: string) {
  const host = this.ensureHost();
  this.stopMarks.set(pluginId, {
    observed: this.observed.length,
    hostObserved: this.hostObserved.length,
    connectAttempts: this.bleSimulator?.connectAttemptCount() ?? 0,
  });
  await host.stopPlugin(pluginId);
  await this.settle();
});

Then('the host is running', function (this: RidrsWorld) {
  const host = this.ensureHost();
  assert.equal(host.isRunning(), true);
});

Then(
  'the plugins were initialized in the order {string}',
  function (this: RidrsWorld, expectedCsv: string) {
    const actual = this.lifecycleCalls.filter((c) => c.hook === 'initialize').map((c) => c.plugin);
    assert.deepEqual(actual, splitCsv(expectedCsv));
  },
);

Then(
  'the plugins were started in the order {string}',
  function (this: RidrsWorld, expectedCsv: string) {
    const actual = this.lifecycleCalls.filter((c) => c.hook === 'start').map((c) => c.plugin);
    assert.deepEqual(actual, splitCsv(expectedCsv));
  },
);

Then(
  'the {string} hooks were called in the order {string}',
  function (this: RidrsWorld, hook: string, expectedCsv: string) {
    const actual = this.lifecycleCalls.filter((c) => c.hook === hook).map((c) => c.plugin);
    assert.deepEqual(actual, splitCsv(expectedCsv));
  },
);

Then(
  'the plugin {string} was initialized after {string}',
  function (this: RidrsWorld, dependentId: string, providersCsv: string) {
    const initOrder = this.lifecycleCalls
      .filter((c) => c.hook === 'initialize')
      .map((c) => c.plugin);
    const dependentIndex = initOrder.indexOf(dependentId);
    assert.notEqual(dependentIndex, -1, `Expected "${dependentId}" to be initialized`);
    for (const providerId of splitCsv(providersCsv)) {
      const providerIndex = initOrder.indexOf(providerId);
      assert.notEqual(providerIndex, -1, `Expected "${providerId}" to be initialized`);
      assert.ok(
        providerIndex < dependentIndex,
        `Expected "${providerId}" (index ${providerIndex}) before "${dependentId}" (index ${dependentIndex})`,
      );
    }
  },
);

Then('all plugins are in the state {string}', function (this: RidrsWorld, expectedState: string) {
  const host = this.ensureHost();
  const known = host.getKnownPlugins();
  assert.ok(known.length > 0, 'Expected at least one known plugin');
  for (const manifest of known) {
    assert.equal(host.getPluginState(manifest.id), expectedState as PluginState);
  }
});

Then(
  'the plugin {string} is in the state {string}',
  function (this: RidrsWorld, pluginId: string, expectedState: string) {
    const host = this.ensureHost();
    assert.equal(host.getPluginState(pluginId), expectedState as PluginState);
  },
);

Then(
  'the plugins {string} are in the state {string}',
  function (this: RidrsWorld, pluginsCsv: string, expectedState: string) {
    const host = this.ensureHost();
    for (const pluginId of splitCsv(pluginsCsv)) {
      assert.equal(host.getPluginState(pluginId), expectedState as PluginState);
    }
  },
);

Then('no lifecycle hook of {string} was called', function (this: RidrsWorld, pluginsCsv: string) {
  const forbidden = new Set(splitCsv(pluginsCsv));
  const called = this.lifecycleCalls.filter((c) => forbidden.has(c.plugin));
  assert.deepEqual(called, []);
});

Then(
  'the lifecycle hooks were called in this order:',
  function (this: RidrsWorld, table: DataTable) {
    const expected = table.hashes().map((r) => ({
      plugin: r.plugin ?? '',
      hook: (r.hook ?? '') as LifecycleHookName,
    }));
    assert.deepEqual(this.lifecycleCalls, expected);
  },
);

Then(
  'the {string} hook of {string} completed before the {string} hook of {string} was called',
  function (
    this: RidrsWorld,
    firstHook: string,
    firstPlugin: string,
    secondHook: string,
    secondPlugin: string,
  ) {
    const completedIdx = this.hookTimeline.findIndex(
      (e) => e.plugin === firstPlugin && e.hook === firstHook && e.phase === 'completed',
    );
    const calledIdx = this.hookTimeline.findIndex(
      (e) => e.plugin === secondPlugin && e.hook === secondHook && e.phase === 'called',
    );
    assert.notEqual(completedIdx, -1, `Expected ${firstPlugin}.${firstHook} to complete`);
    assert.notEqual(calledIdx, -1, `Expected ${secondPlugin}.${secondHook} to be called`);
    assert.ok(
      completedIdx < calledIdx,
      `Expected ${firstPlugin}.${firstHook} completion (${completedIdx}) before ${secondPlugin}.${secondHook} call (${calledIdx})`,
    );
  },
);

Then(
  'the {string} hook of {string} was not called',
  function (this: RidrsWorld, hook: string, pluginId: string) {
    const found = this.lifecycleCalls.find((c) => c.plugin === pluginId && c.hook === hook);
    assert.equal(found, undefined);
  },
);

Then(
  'the {string} hook of {string} was called',
  function (this: RidrsWorld, hook: string, pluginId: string) {
    const found = this.lifecycleCalls.find((c) => c.plugin === pluginId && c.hook === hook);
    assert.ok(found, `Expected ${pluginId}.${hook} to have been called`);
  },
);

Then(
  'the host reported a(n) {string} problem for plugin {string} mentioning {string}',
  function (this: RidrsWorld, code: string, pluginId: string, snippet: string) {
    const host = this.ensureHost();
    const match = host
      .getDiagnostics()
      .find((d) => d.code === code && d.pluginId === pluginId && d.message.includes(snippet));
    assert.ok(
      match,
      `Expected diagnostic "${code}" for plugin "${pluginId}" mentioning "${snippet}", got: ${JSON.stringify(host.getDiagnostics())}`,
    );
  },
);

Then(
  'the host reported a(n) {string} problem for plugin {string}',
  function (this: RidrsWorld, code: string, pluginId: string) {
    const host = this.ensureHost();
    const match = host.getDiagnostics().find((d) => d.code === code && d.pluginId === pluginId);
    assert.ok(
      match,
      `Expected diagnostic "${code}" for plugin "${pluginId}", got: ${JSON.stringify(host.getDiagnostics())}`,
    );
  },
);

Then(
  'the host reported a(n) {string} problem involving the plugins {string}',
  function (this: RidrsWorld, code: string, pluginsCsv: string) {
    const host = this.ensureHost();
    const expectedPlugins = splitCsv(pluginsCsv);
    const match = host.getDiagnostics().find((d) => {
      if (d.code !== code) {
        return false;
      }
      return expectedPlugins.every((p) => d.message.includes(p));
    });
    assert.ok(
      match,
      `Expected diagnostic "${code}" involving "${pluginsCsv}", got: ${JSON.stringify(host.getDiagnostics())}`,
    );
  },
);

Then(
  'the host reported a(n) {string} problem for capability {string} naming the plugins {string}',
  function (this: RidrsWorld, code: string, capabilityId: string, pluginsCsv: string) {
    const host = this.ensureHost();
    const expectedPlugins = splitCsv(pluginsCsv);
    const match = host.getDiagnostics().find((d) => {
      if (d.code !== code || !d.message.includes(capabilityId)) {
        return false;
      }
      return expectedPlugins.every((p) => d.message.includes(p));
    });
    assert.ok(
      match,
      `Expected diagnostic "${code}" for capability "${capabilityId}" naming "${pluginsCsv}", got: ${JSON.stringify(host.getDiagnostics())}`,
    );
  },
);
