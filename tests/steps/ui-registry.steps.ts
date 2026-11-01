// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import type { UiRegistry } from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function registry(world: RidrsWorld): UiRegistry {
  return world.ensureHost().getUiRegistry();
}

function problems(world: RidrsWorld) {
  return JSON.stringify(world.ensureHost().getDiagnostics());
}

async function writeUiPlugin(world: RidrsWorld, pluginId: string): Promise<void> {
  await world.writeProbePluginFolder({
    folder: pluginId,
    id: pluginId,
    types: ['ui'],
    ui: world.pendingUi.get(pluginId),
  });
}

Given(
  'the plugin {string} with the UI manifest:',
  async function (this: RidrsWorld, pluginId: string, uiJson: string) {
    this.pendingUi.set(pluginId, JSON.parse(uiJson) as Record<string, unknown>);
    await writeUiPlugin(this, pluginId);
  },
);

Given(
  'the plugin {string} contributes {string} to {string} with order {int}',
  async function (
    this: RidrsWorld,
    pluginId: string,
    contributionId: string,
    extensionPoint: string,
    order: number,
  ) {
    const ui = this.pendingUi.get(pluginId) ?? { client: 'client/index.js', contributions: [] };
    (ui.contributions as unknown[]).push({
      id: contributionId,
      extensionPoint,
      export: 'Contribution',
      order,
    });
    this.pendingUi.set(pluginId, ui);
    await writeUiPlugin(this, pluginId);
  },
);

Given('the plugin {string} is running', async function (this: RidrsWorld, pluginId: string) {
  await this.writeProbePluginFolder({ folder: pluginId, id: pluginId });
});

Given(
  'the client file of {string} does not exist',
  async function (this: RidrsWorld, pluginId: string) {
    const client = this.pendingUi.get(pluginId)?.client;
    assert.equal(typeof client, 'string', `Plugin "${pluginId}" declares no client`);
    await rm(join(this.tempPluginDir, pluginId, client as string));
  },
);

When('the plugin {string} is started', async function (this: RidrsWorld, pluginId: string) {
  await this.ensureHost().startPlugin(pluginId);
  await this.settle();
});

Then(
  'the UI registry contains the screen {string} from the plugin {string}',
  function (this: RidrsWorld, screenId: string, pluginId: string) {
    const screen = registry(this).screens.find((s) => s.id === screenId);
    assert.equal(screen?.pluginId, pluginId, JSON.stringify(registry(this)));
  },
);

Then('the UI registry contains no screen {string}', function (this: RidrsWorld, screenId: string) {
  assert.equal(
    registry(this).screens.some((s) => s.id === screenId),
    false,
  );
});

Then(
  'the UI registry contains the extension points {string}',
  function (this: RidrsWorld, pointsCsv: string) {
    const { screens, contributions } = registry(this);
    const offered = new Set([...screens, ...contributions].flatMap((e) => e.extensionPoints));
    for (const point of splitCsv(pointsCsv)) {
      assert.ok(offered.has(point), `Expected extension point "${point}" in ${[...offered]}`);
    }
  },
);

Then(
  'the contributions to {string} are in this order:',
  function (this: RidrsWorld, extensionPoint: string, table: DataTable) {
    const actual = registry(this)
      .contributions.filter((c) => c.extensionPoint === extensionPoint)
      .map((c) => [c.pluginId, c.id]);
    assert.deepEqual(
      actual,
      table.hashes().map((row) => [row.plugin, row.contribution]),
    );
  },
);

Then(
  'the UI registry contains no contribution from the plugin {string}',
  function (this: RidrsWorld, pluginId: string) {
    assert.equal(
      registry(this).contributions.some((c) => c.pluginId === pluginId),
      false,
    );
  },
);

Then(
  'the extension point {string} is offered by the plugin {string}',
  function (this: RidrsWorld, point: string, pluginId: string) {
    const { screens, contributions } = registry(this);
    const owners = [...screens, ...contributions]
      .filter((e) => e.extensionPoints.includes(point))
      .map((e) => e.pluginId);
    assert.deepEqual(owners, [pluginId]);
  },
);

Then(
  'a {string} event was published after the plugin stopped',
  function (this: RidrsWorld, eventId: string) {
    const mark = [...this.stopMarks.values()].at(-1);
    assert.ok(mark, 'Expected a plugin to have been stopped');
    assert.ok(
      this.hostObserved.slice(mark.hostObserved).some((e) => e.type === eventId),
      `Expected a "${eventId}" event after the stop`,
    );
  },
);

Then(
  'the UI registry allows subscribing to {string}',
  function (this: RidrsWorld, eventsCsv: string) {
    assert.deepEqual(registry(this).events.subscribe, splitCsv(eventsCsv));
  },
);

Then('the UI registry allows publishing {string}', function (this: RidrsWorld, eventsCsv: string) {
  assert.deepEqual(registry(this).events.publish, splitCsv(eventsCsv));
});

Then(
  'the host reported a(n) {string} problem for the folder {string} mentioning {string}',
  function (this: RidrsWorld, code: string, folder: string, snippet: string) {
    const match = this.ensureHost()
      .getDiagnostics()
      .find((d) => d.code === code && d.folder === folder && d.message.includes(snippet));
    assert.ok(
      match,
      `Expected "${code}" for folder "${folder}" mentioning "${snippet}", got ${problems(this)}`,
    );
  },
);

Then('the plugin {string} is not discovered', function (this: RidrsWorld, pluginId: string) {
  assert.equal(this.ensureHost().getPluginManifest(pluginId), undefined);
});

Then('the host reported no problems', function (this: RidrsWorld) {
  assert.deepEqual(this.ensureHost().getDiagnostics(), []);
});
