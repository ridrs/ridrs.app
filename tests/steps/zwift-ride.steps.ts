// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given } from '@cucumber/cucumber';
import type { RidrsWorld } from '../support/world.ts';

Given(
  'the simulated BLE environment also contains a heart-rate sensor {string}',
  function (this: RidrsWorld, name: string) {
    assert.ok(this.bleSimulator, 'Expected a simulated BLE environment');
    this.heartRateSensor = this.bleSimulator.addHeartRateSensor(name);
  },
);
