// SPDX-License-Identifier: AGPL-3.0-or-later

import { After, Before } from '@cucumber/cucumber';
import { type RidrsWorld, setActiveWorld } from './world.ts';

Before(async function (this: RidrsWorld) {
  setActiveWorld(this);
  await this.initTempDir();
});

After(async function (this: RidrsWorld) {
  await this.cleanup();
  setActiveWorld(undefined);
});
