// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { RidrsError } from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';

/** The settings document each real device plugin's link keeps (ADR 0054). */
const DEVICE_DOCUMENTS: Readonly<Record<string, string>> = {
  'device-heart-rate': 'device-heart-rate',
  'device-ftms-trainer': 'device-trainer',
  'device-zwift-ride': 'device-controller',
};

Given(
  'a plugin folder {string} whose manifest declares the types {string} and the persistence {string}',
  async function (this: RidrsWorld, folder: string, types: string, scope: string) {
    const path = join(this.tempPluginDir, folder);
    await mkdir(path, { recursive: true });
    const manifest = {
      id: folder,
      name: folder,
      version: '1.0.0',
      types: types.split(',').map((t) => t.trim()),
      provides: [],
      requires: [],
      entry: 'index.ts',
      persistence: [scope],
    };
    await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(path, 'index.ts'), 'export default {};\n', 'utf8');
  },
);

async function startSettingsProbe(
  world: RidrsWorld,
  probeId: string,
  type: string,
  persistence: boolean,
): Promise<void> {
  await world.writeProbePluginFolder({
    folder: probeId,
    id: probeId,
    types: [type],
    module: 'settings-probe-plugin.ts',
    ...(persistence ? { persistence: ['machine'] } : {}),
  });
  // The host has no runtime discovery: compose it again with the probe, like an app restart.
  await world.disposeHost();
  await world.ensureHost().start();
  await world.settle();
}

Given(
  'a probe plugin {string} of type {string} without persistence reads its machine settings',
  async function (this: RidrsWorld, probeId: string, type: string) {
    this.settingsProbe = { read: 'favourite' };
    await startSettingsProbe(this, probeId, type, false);
  },
);

Given(
  'a probe plugin {string} of type {string} with persistence writes the machine setting {string} as {string}',
  async function (this: RidrsWorld, probeId: string, type: string, name: string, value: string) {
    this.settingsProbe = { write: { name, value } };
    await startSettingsProbe(this, probeId, type, true);
    assert.equal(this.lastHostCallError, undefined);
    // From the next start on, the probe only reads.
    this.settingsProbe = { read: name };
  },
);

Then("the probe's settings call failed with {string}", function (this: RidrsWorld, code: string) {
  const error = this.lastHostCallError;
  assert.ok(error instanceof RidrsError, `Expected a RidrsError, got ${String(error)}`);
  assert.equal(error.code, code);
});

Then(
  'the probe reads the machine setting {string} as {string}',
  function (this: RidrsWorld, name: string, value: string) {
    assert.equal(this.settingsProbe?.read, name);
    assert.equal(this.settingsProbeValue, value);
  },
);

Then('the machine settings hold the file {string}', function (this: RidrsWorld, path: string) {
  assert.ok(this.settingsFiles.files.has(path), `Files: ${[...this.settingsFiles.files.keys()]}`);
});

Given(
  'the machine settings of {string} hold {string}',
  async function (this: RidrsWorld, pluginId: string, text: string) {
    const document = DEVICE_DOCUMENTS[pluginId];
    assert.ok(document, `No settings document known for "${pluginId}"`);
    await this.settingsFiles.write(
      `config/machine/${pluginId}/${document}.json`,
      new TextEncoder().encode(text),
    );
  },
);

When('ridrs restarted', async function (this: RidrsWorld) {
  await this.disposeHost();
  await this.ensureHost().start();
  await this.settle();
});
