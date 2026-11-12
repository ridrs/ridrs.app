// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { When } from '@cucumber/cucumber';
import type { RidrsWorld } from '../support/world.ts';
import { simulatedIntervalsIcu } from './training.steps.ts';

When(
  'intervals.icu renames the plan {string} to {string}',
  function (this: RidrsWorld, from: string, to: string) {
    const event = simulatedIntervalsIcu(this).events.find((each) => each.name === from);
    assert.ok(event, `No plan "${from}" in intervals.icu`);
    event.name = to;
  },
);
