// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Given, Then } from '@cucumber/cucumber';
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { incyclistPackage } from '../support/simulated-downloads.ts';
import { RIDE_CATALOG, scenic } from '../support/simulated-scenic.ts';
import type { RidrsWorld } from '../support/world.ts';

configure({ useWebWorkers: false });

/*
 * Video routes from ridrs Scenic (tests/features/world/scenic-routes.feature): the simulated
 * Scenic (tests/support/simulated-scenic.ts) and the offers of `video-source-scenic`.
 */

const offerKeys = (world: RidrsWorld, plugin: string) =>
  [...world.ensureHost().getState('route.offer').keys()].filter((key) =>
    key.startsWith(`${plugin}/`),
  );

const catalogRequests = (world: RidrsWorld) =>
  scenic(world).requests.filter((request) => request.url === RIDE_CATALOG);

Then(
  'the video source {string} offers {int} routes',
  async function (this: RidrsWorld, plugin: string, count: number) {
    await this.waitForIo(
      () => offerKeys(this, plugin).length === count,
      `"${plugin}" to offer ${count} routes, not ${offerKeys(this, plugin).length}`,
    );
  },
);

Then('there is no route offer {string}', async function (this: RidrsWorld, key: string) {
  await this.waitForIo(
    () => !this.ensureHost().getState('route.offer').has(key),
    `no route offer "${key}"`,
  );
});

Given('ridrs Scenic cannot be reached', function (this: RidrsWorld) {
  scenic(this).offline = true;
});

Given(
  'ridrs Scenic no longer lists {string} and {string}',
  function (this: RidrsWorld, first: string, second: string) {
    scenic(this).withdrawn.add(first);
    scenic(this).withdrawn.add(second);
  },
);

Then('ridrs Scenic was asked for its ride catalog', async function (this: RidrsWorld) {
  await this.waitForIo(() => catalogRequests(this).length > 0, 'a request for the ride catalog');
});

Then(
  'ridrs Scenic was asked for its ride catalog with the ETag of the last one',
  async function (this: RidrsWorld) {
    const { served } = scenic(this);
    await this.waitForIo(
      () => catalogRequests(this).length >= 2,
      'a second request for the ride catalog',
    );
    const last = catalogRequests(this).at(-1);
    assert.equal(last?.headers['If-None-Match'], served[0], JSON.stringify(last?.headers));
    assert.equal(served.length, 1, 'the unchanged catalog was served again');
  },
);

Given(
  'the media storage holds the route {string} downloaded by the former Van Gestel source',
  async function (this: RidrsWorld, id: string) {
    // As the plugin `video-source-vangestel` left it (ADR 0094): the package unpacked in its folder.
    const folder = join(process.env.RIDRS_MEDIA_DIR ?? '', 'videos', 'video-source-vangestel', id);
    mkdirSync(folder, { recursive: true });
    const reader = new ZipReader(new Uint8ArrayReader(await incyclistPackage()));
    for (const entry of await reader.getEntries()) {
      if (!entry.directory)
        writeFileSync(join(folder, entry.filename), await entry.getData(new Uint8ArrayWriter()));
    }
    await reader.close();
  },
);
