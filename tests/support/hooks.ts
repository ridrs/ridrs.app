// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, AfterAll, Before, BeforeAll, setDefaultTimeout } from '@cucumber/cucumber';
import FakeTimers from '@sinonjs/fake-timers';
import { type RidrsWorld, setActiveWorld } from './world.ts';

setDefaultTimeout(20_000);

export const DEFAULT_FAKE_START = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

/**
 * Apps started by scenarios (headless processes, the native composition) store files with
 * `storage-files-node`: never in the developer's real app data directory.
 */
let scenarioDataDir: string | undefined;

BeforeAll(() => {
  if (!process.env.RIDRS_DATA_DIR) {
    scenarioDataDir = mkdtempSync(join(tmpdir(), 'ridrs-scenario-data-'));
    process.env.RIDRS_DATA_DIR = scenarioDataDir;
  }
});

AfterAll(() => {
  if (scenarioDataDir) {
    rmSync(scenarioDataDir, { recursive: true, force: true });
    delete process.env.RIDRS_DATA_DIR;
  }
});

Before(async function (this: RidrsWorld) {
  setActiveWorld(this);
  await this.initTempDir();
});

Before({ tags: '@fake-timers' }, function (this: RidrsWorld) {
  this.fakeClock = FakeTimers.install({
    now: DEFAULT_FAKE_START,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
});

After(async function (this: RidrsWorld) {
  await this.cleanup();
  setActiveWorld(undefined);
});
