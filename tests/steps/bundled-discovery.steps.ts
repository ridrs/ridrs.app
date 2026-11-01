// SPDX-License-Identifier: AGPL-3.0-or-later

import { type DataTable, Given, When } from '@cucumber/cucumber';
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

Given('a bundled plugin set containing:', function (this: RidrsWorld, table: DataTable) {
  for (const row of table.hashes()) {
    this.addBundledProbePlugin({
      folder: row.folder ?? '',
      id: row.id ?? '',
      types: splitCsv(row.types),
      provides: splitCsv(row.provides),
      requires: splitCsv(row.requires),
    });
  }
});

Given(
  'the bundled plugin set contains a folder {string} with the manifest {string}',
  function (this: RidrsWorld, folder: string, rawManifest: string) {
    this.bundle().manifests[`plugins/${folder}/manifest.json`] = rawManifest;
  },
);

Given(
  'the entry module of {string} is not part of the bundle',
  function (this: RidrsWorld, folder: string) {
    delete this.bundle().modules[`plugins/${folder}/index.ts`];
  },
);

When('the host discovers the bundled plugins', async function (this: RidrsWorld) {
  await this.ensureHost().discover();
});
