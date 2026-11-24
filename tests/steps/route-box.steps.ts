// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { type PhysicsState, physicsStateEvent, worldPositionEvent } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/plugins/route-box');

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

async function box(world: RidrsWorld): Promise<HTMLElement> {
  return within(ui(world)).findByTestId('route-box');
}

function testDevice(world: RidrsWorld) {
  const ctx = world.ensureHost().getPluginContext('test-device');
  assert.ok(ctx, 'Expected the test device');
  return ctx;
}

Given('the route box fixture route is installed', function (this: RidrsWorld) {
  this.extraPluginDirs.push(FIXTURES);
});

When(
  'the world reports the rider at {float}, {float} after {int} m',
  async function (this: RidrsWorld, latitude: number, longitude: number, distance: number) {
    testDevice(this).inputs.accept(worldPositionEvent, { distance, latitude, longitude });
    await this.settle();
  },
);

When(
  'the physics reports a road gradient of {float} % after {int} m',
  async function (this: RidrsWorld, percent: number, distance: number) {
    const state: PhysicsState = {
      sessionId: 'session-1',
      step: 1000,
      at: 10_000,
      speed: 6,
      distance,
      acceleration: 0,
      mass: 85,
      riderPower: { status: 'unavailable', at: 0, reason: 'no-source' },
      wheelPower: 0,
      driveForce: 0,
      resistance: { total: 0, contributions: [] },
      road: { gradient: percent / 100, surface: 'asphalt', origin: 'default' },
    };
    // A stand-in for the physics: no physics plugin runs in these scenarios.
    testDevice(this).inputs.accept(physicsStateEvent, state);
    await this.settle();
  },
);

// happy-dom has no layout: the place is asserted on the declared position.
Then('the route box sits at the top right', async function (this: RidrsWorld) {
  const element = await box(this);
  assert.equal(element.style.position, 'absolute');
  assert.equal(element.style.top, '16px');
  assert.equal(element.style.right, '16px');
});

Then(
  'the route box shows, in this order, {string}',
  async function (this: RidrsWorld, csv: string) {
    const element = await box(this);
    const expected = csv.split(',').map((part) => `route-${part.trim()}`);
    await waitFor(() =>
      assert.deepEqual(
        [...element.children].map((child) => child.getAttribute('data-testid')),
        expected,
      ),
    );
  },
);

Then(
  'the route map draws a track of {int} points',
  async function (this: RidrsWorld, count: number) {
    const element = await box(this);
    await waitFor(() => {
      const track = element.querySelector('[data-testid="route-track"]');
      assert.ok(track, 'No track on the map');
      assert.equal(track.getAttribute('points')?.trim().split(/\s+/).length, count);
    });
  },
);

Then('the route map is the track alone', async function (this: RidrsWorld) {
  const map = await within(await box(this)).findByTestId('route-map');
  assert.equal(map.getAttribute('data-map'), 'track');
});

Then('the route map is tilted', async function (this: RidrsWorld) {
  const map = await within(await box(this)).findByTestId('route-map');
  const tilted = map.querySelector<HTMLElement>('[data-tilt]');
  assert.ok(tilted, 'No tilted plane in the map');
  assert.match(tilted.style.transform, /perspective\(\d+px\) rotateX\(\d+deg\)/);
});

Then('the route map marks the rider', async function (this: RidrsWorld) {
  const element = await box(this);
  await waitFor(() =>
    assert.ok(element.querySelector('[data-testid="route-rider"]'), 'No rider on the map'),
  );
});

Then(
  'the route map shows {int} points of the track as ridden',
  async function (this: RidrsWorld, count: number) {
    const element = await box(this);
    await waitFor(() => {
      const ridden = element.querySelector('[data-testid="route-ridden"]');
      assert.ok(ridden, 'No ridden part on the map');
      assert.equal(ridden.getAttribute('points')?.trim().split(/\s+/).length, count);
    });
  },
);

Then(
  'the route profile marks the rider at {int} % of the route',
  async function (this: RidrsWorld, percent: number) {
    const profile = await within(await box(this)).findByTestId('route-profile');
    await waitFor(() => assert.equal(profile.getAttribute('data-at'), String(percent / 100)));
  },
);

Then(
  'the route profile marks the rider at about {int} % of the route',
  async function (this: RidrsWorld, percent: number) {
    const profile = await within(await box(this)).findByTestId('route-profile');
    await waitFor(() =>
      assert.equal(Math.round(Number(profile.getAttribute('data-at')) * 100), percent),
    );
  },
);

Then(
  'the route box shows the gradient {string} {string}',
  async function (this: RidrsWorld, value: string, unit: string) {
    const gradient = await within(await box(this)).findByTestId('route-gradient');
    await waitFor(() => {
      assert.equal(within(gradient).getByTestId('value').textContent, value);
      assert.equal(within(gradient).getByTestId('unit').textContent, unit);
    });
  },
);
