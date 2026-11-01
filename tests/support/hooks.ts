// SPDX-License-Identifier: AGPL-3.0-or-later

import { After, Before, setDefaultTimeout } from '@cucumber/cucumber';
import FakeTimers from '@sinonjs/fake-timers';
import { type RidrsWorld, setActiveWorld } from './world.ts';

setDefaultTimeout(20_000);

export const DEFAULT_FAKE_START = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

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
