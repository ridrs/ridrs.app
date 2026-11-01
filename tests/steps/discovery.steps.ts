// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
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

Given('a plugin directory containing:', async function (this: RidrsWorld, table: DataTable) {
  const rows = table.hashes();
  for (const row of rows) {
    await this.writeProbePluginFolder({
      folder: row.folder ?? '',
      id: row.id ?? '',
      types: splitCsv(row.types),
      provides: splitCsv(row.provides),
      requires: splitCsv(row.requires),
    });
  }
});

Given(
  'the plugin directory contains a folder {string} without a manifest.json',
  async function (this: RidrsWorld, folder: string) {
    await mkdir(join(this.tempPluginDir, folder), { recursive: true });
  },
);

Given(
  'the plugin directory contains a folder {string} with the manifest {string}',
  async function (this: RidrsWorld, folder: string, rawManifest: string) {
    const folderPath = join(this.tempPluginDir, folder);
    await mkdir(folderPath, { recursive: true });
    await writeFile(join(folderPath, 'manifest.json'), rawManifest, 'utf8');
  },
);

When('the host discovers plugins in the plugin directory', async function (this: RidrsWorld) {
  const host = this.ensureHost();
  await host.discover();
});

Then('the known plugins are {string}', function (this: RidrsWorld, expectedCsv: string) {
  const host = this.ensureHost();
  const actual = host.getKnownPlugins().map((m) => m.id);
  const expected = splitCsv(expectedCsv);
  assert.deepEqual(actual, expected);
});

Then(
  'the plugin {string} has the types {string}',
  function (this: RidrsWorld, pluginId: string, expectedTypesCsv: string) {
    const host = this.ensureHost();
    const manifest = host.getPluginManifest(pluginId);
    assert.ok(manifest, `Expected plugin "${pluginId}" to be known`);
    assert.deepEqual(manifest.types, splitCsv(expectedTypesCsv));
  },
);

Then('the discovery reported no problems', function (this: RidrsWorld) {
  const host = this.ensureHost();
  assert.deepEqual(host.getDiagnostics(), []);
});

Then(
  'the discovery reported a(n) {string} problem for folder {string}',
  function (this: RidrsWorld, code: string, folder: string) {
    const host = this.ensureHost();
    const match = host.getDiagnostics().find((d) => d.code === code && d.folder === folder);
    assert.ok(
      match,
      `Expected diagnostic "${code}" for folder "${folder}", got: ${JSON.stringify(host.getDiagnostics())}`,
    );
  },
);

Then(
  'the discovery reported a(n) {string} problem for folder {string} mentioning {string}',
  function (this: RidrsWorld, code: string, folder: string, snippet: string) {
    const host = this.ensureHost();
    const match = host
      .getDiagnostics()
      .find((d) => d.code === code && d.folder === folder && d.message.includes(snippet));
    assert.ok(
      match,
      `Expected diagnostic "${code}" for folder "${folder}" mentioning "${snippet}", got: ${JSON.stringify(host.getDiagnostics())}`,
    );
  },
);

Then(
  'the discovery reported a(n) {string} problem for plugin {string} naming the folders {string}',
  function (this: RidrsWorld, code: string, pluginId: string, foldersCsv: string) {
    const host = this.ensureHost();
    const expectedFolders = splitCsv(foldersCsv);
    const match = host.getDiagnostics().find((d) => {
      if (d.code !== code || d.pluginId !== pluginId) {
        return false;
      }
      return expectedFolders.every((folder) => d.message.includes(folder));
    });
    assert.ok(
      match,
      `Expected diagnostic "${code}" for plugin "${pluginId}" naming folders "${foldersCsv}", got: ${JSON.stringify(host.getDiagnostics())}`,
    );
  },
);
