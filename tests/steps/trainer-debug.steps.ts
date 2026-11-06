// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import {
  type PhysicsState,
  type PluginContext,
  physicsStateEvent,
  type TrainerCommand,
  trainerCommandEvent,
} from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

/** How long "eventually" waits: the ui profile runs on real time. */
const EVENTUALLY = { timeout: 25_000, interval: 100 } as const;
const EVENTUALLY_STEP = { timeout: 30_000 } as const;

function pluginContext(world: RidrsWorld, pluginId: string): PluginContext {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected the plugin "${pluginId}" to be running`);
  return ctx;
}

async function sent(world: RidrsWorld, pluginId: string, command: TrainerCommand): Promise<void> {
  // A stand-in for the trainer's device plugin: what it sends enters as an input.
  pluginContext(world, pluginId).inputs.accept(trainerCommandEvent, {
    deviceId: 'trainer-1',
    command,
  });
  await world.settle();
}

/** The value the debug HUD shows for a term, or undefined without the term. */
function shown(term: string): string | undefined {
  const hud = within(document.body).getByTestId('debug-trainer');
  for (const dt of hud.querySelectorAll('dt')) {
    if (dt.textContent === term) {
      return dt.nextElementSibling?.textContent ?? '';
    }
  }
  return undefined;
}

When(
  '{string} sent its trainer the target power {int} W',
  async function (this: RidrsWorld, pluginId: string, watts: number) {
    await sent(this, pluginId, { kind: 'target-power', watts });
  },
);

When(
  '{string} sent its trainer the simulation gradient {float}, crr {float}, cw {float} and wind {int}',
  async function (
    this: RidrsWorld,
    pluginId: string,
    gradient: number,
    crr: number,
    cw: number,
    windSpeed: number,
  ) {
    await sent(this, pluginId, { kind: 'simulation', gradient, crr, cw, windSpeed });
  },
);

When(
  'the physics reports a road gradient of {float} and a trainer gradient of {float} in gear {int}',
  async function (this: RidrsWorld, road: number, trainer: number, gear: number) {
    const load = {
      rollingResistanceCoefficient: 0.004,
      windResistanceCoefficient: 0.5,
      windSpeed: 0,
    };
    const state: PhysicsState = {
      sessionId: 'session-1',
      step: 0,
      at: 0,
      speed: 8,
      distance: 0,
      acceleration: 0,
      mass: 85,
      riderPower: { status: 'unavailable', at: 0, reason: 'no-source' },
      wheelPower: 0,
      driveForce: 0,
      resistance: { total: 0, contributions: [] },
      road: { gradient: road, surface: 'asphalt', origin: 'default' },
      trainerLoad: {
        resistance: { ...load, gradient: road },
        resistanceWithVirtualGear: { ...load, gradient: trainer },
        virtualGear: { index: gear, ratio: 2 },
      },
    };
    // A stand-in for the physics: no physics plugin runs in these scenarios.
    pluginContext(this, 'test-device').inputs.accept(physicsStateEvent, state);
    await this.settle();
  },
);

Then(
  'the trainer debug HUD shows {string} {string}',
  async function (this: RidrsWorld, term: string, value: string) {
    await waitFor(() => assert.equal(shown(term), value));
  },
);

Then(
  'eventually the trainer debug HUD shows {string} {string}',
  EVENTUALLY_STEP,
  async function (this: RidrsWorld, term: string, value: string) {
    await waitFor(() => assert.equal(shown(term), value), EVENTUALLY);
  },
);

Then('the trainer debug HUD is not shown', async function (this: RidrsWorld) {
  await this.settle();
  // A boolean, not the element: a diff of a DOM element exhausts the memory.
  await waitFor(() =>
    assert.equal(document.querySelector('[data-testid="debug-trainer"]') === null, true),
  );
});

Then('the trainer debug HUD has nothing focusable', async function (this: RidrsWorld) {
  const hud = await within(document.body).findByTestId('debug-trainer');
  assert.equal(hud.querySelectorAll('button, [tabindex], input, a[href]').length, 0);
  assert.equal(hud.hasAttribute('tabindex'), false);
});
