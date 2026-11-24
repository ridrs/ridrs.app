// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { type PhysicsState, physicsStateEvent, worldPositionEvent } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

function testDevice(world: RidrsWorld) {
  const ctx = world.ensureHost().getPluginContext('test-device');
  assert.ok(ctx, 'Expected the test device');
  return ctx;
}

async function rideFacts(world: RidrsWorld): Promise<HTMLElement> {
  return within(ui(world)).findByTestId('ride-facts');
}

When(
  'the physics reports a road gradient of {float} % at {float} m\\/s after {int} m',
  async function (this: RidrsWorld, percent: number, speed: number, distance: number) {
    const state: PhysicsState = {
      sessionId: 'session-1',
      step: 1000,
      at: 10_000,
      speed,
      distance,
      acceleration: 0,
      mass: 85,
      riderPower: { status: 'unavailable', at: 0, reason: 'no-source' },
      wheelPower: 0,
      driveForce: 0,
      resistance: { total: 0, contributions: [] },
      road: { gradient: percent / 100, surface: 'asphalt', origin: 'default' },
    };
    testDevice(this).inputs.accept(physicsStateEvent, state);
    await this.settle();
  },
);

When(
  'the world reports the rider at {float}, {float} and altitude {float} m after {int} m',
  async function (
    this: RidrsWorld,
    latitude: number,
    longitude: number,
    altitude: number,
    distance: number,
  ) {
    testDevice(this).inputs.accept(worldPositionEvent, { distance, latitude, longitude, altitude });
    await this.settle();
  },
);

Then(
  'the current segment is shown in {string} mode',
  async function (this: RidrsWorld, mode: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const seg = within(card).getByTestId('current-segment');
      assert.equal(seg.dataset.mode, mode);
    });
  },
);

Then('the current segment is not shown', async function (this: RidrsWorld) {
  const card = await rideFacts(this);
  await this.settle();
  await waitFor(() => {
    assert.ok(
      within(card).queryByTestId('current-segment') === null,
      'Expected no current segment',
    );
  });
});

Then(
  'the current segment draws a fine-grained local elevation profile',
  async function (this: RidrsWorld) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const profile = within(card).getByTestId('segment-profile');
      assert.ok(profile.querySelector('polyline'), 'Expected local elevation polyline');
    });
  },
);

Then(
  'the current segment draws a climb-only local profile ending at the summit',
  async function (this: RidrsWorld) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const profile = within(card).getByTestId('segment-profile');
      assert.equal(profile.dataset.summitEdge, 'true');
      assert.ok(profile.querySelector('[data-testid="summit-marker"]'), 'Expected summit marker');
    });
  },
);

Then(
  'the current segment shows the gradient {string} {string}',
  async function (this: RidrsWorld, value: string, unit: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const grad = within(card).getByTestId('segment-gradient');
      assert.equal(within(grad).getByTestId('value').textContent, value);
      assert.equal(within(grad).getByTestId('unit').textContent, unit);
    });
  },
);

Then('the current segment shows no gradient', async function (this: RidrsWorld) {
  const card = await rideFacts(this);
  await waitFor(() => {
    assert.ok(within(card).queryByTestId('segment-gradient') === null, 'Expected no gradient');
  });
});

Then(
  'the current segment shows the local elevation {string} {string}',
  async function (this: RidrsWorld, value: string, unit: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const elev = within(card).getByTestId('segment-elevation');
      assert.equal(within(elev).getByTestId('value').textContent, value);
      assert.equal(within(elev).getByTestId('unit').textContent, unit);
    });
  },
);

Then(
  'the summit countdown on the left shows {string}',
  async function (this: RidrsWorld, expected: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const header = within(card).getByTestId('segment-summit-header');
      const countdown = within(header).getByTestId('segment-countdown');
      assert.equal(countdown.textContent, expected);
      assert.equal(
        header.firstElementChild,
        countdown,
        'Countdown should be first (left) in summit header',
      );
    });
  },
);

Then(
  'the summit header on the right shows {string} and {string}',
  async function (this: RidrsWorld, peakName: string, category: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const header = within(card).getByTestId('segment-summit-header');
      const right = within(header).getByTestId('segment-summit-info');
      assert.equal(
        header.lastElementChild,
        right,
        'Peak/category should be last (right) in summit header',
      );
      assert.ok(
        right.textContent?.includes(peakName),
        `Expected peak name "${peakName}" in "${right.textContent}"`,
      );
      assert.equal(within(right).getByTestId('segment-climb-category').textContent, category);
    });
  },
);

Then(
  'the current segment shows the climb gain {string}',
  async function (this: RidrsWorld, expected: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const gain = within(card).getByTestId('segment-climb-gain');
      assert.equal(gain.textContent, expected);
    });
  },
);

Then(
  'the workout segment shows target power {string} {string}',
  async function (this: RidrsWorld, value: string, unit: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const power = within(card).getByTestId('segment-workout-power');
      assert.equal(within(power).getByTestId('value').textContent, value);
      assert.equal(within(power).getByTestId('unit').textContent, unit);
    });
  },
);

Then(
  'the workout segment shows target cadence {string} {string}',
  async function (this: RidrsWorld, value: string, unit: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const cadence = within(card).getByTestId('segment-workout-cadence');
      assert.equal(within(cadence).getByTestId('value').textContent, value);
      assert.equal(within(cadence).getByTestId('unit').textContent, unit);
    });
  },
);

Then(
  'the workout segment shows step time {string} and {string}',
  async function (this: RidrsWorld, remaining: string, total: string) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const time = within(card).getByTestId('segment-workout-time');
      assert.equal(within(time).getByTestId('remaining').textContent, remaining);
      assert.equal(within(time).getByTestId('total').textContent, total);
    });
  },
);

Then(
  'the central HUD draws a workout progress ring with {int} segments and {int} filled',
  async function (this: RidrsWorld, total: number, filled: number) {
    const card = await rideFacts(this);
    await waitFor(() => {
      const ring = within(card).getByTestId('workout-progress-ring');
      assert.equal(ring.dataset.segments, String(total));
      assert.equal(ring.dataset.filled, String(filled));
      assert.equal(ring.querySelectorAll('path').length, total);
    });
  },
);
