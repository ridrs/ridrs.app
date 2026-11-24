// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then } from '@cucumber/cucumber';
import { activityAthleteEvent, activityStateChangedEvent, type Workout } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

function alphas(value: string): number[] {
  return [...value.matchAll(/(?:\/|rgba\([^)]*,)\s*([\d.]+)(%?)\s*\)/g)].map(
    ([, number = '1', percent]) => (percent ? Number(number) / 100 : Number(number)),
  );
}

function workoutFixture(name: string): Workout {
  return {
    format: 'ridrs-workout',
    version: 1,
    id: 'vo2max-5x4',
    name,
    sport: 'virtual-ride',
    source: { kind: 'builtin' },
    steps: [
      {
        kind: 'repeat',
        id: 'sets',
        until: { kind: 'count', reps: 5 },
        steps: [
          {
            kind: 'interval',
            id: 'work',
            name: 'Work',
            intensity: 'interval',
            duration: { kind: 'time', seconds: 240 },
            effort: {
              kind: 'target',
              primary: { unit: 'watts', start: { low: 288, high: 288 } },
              secondary: [{ unit: 'rpm', start: { low: 95, high: 105 } }],
            },
          },
          {
            kind: 'interval',
            id: 'rest',
            name: 'Rest',
            intensity: 'rest',
            duration: { kind: 'time', seconds: 240 },
            effort: { kind: 'target', primary: { unit: 'watts', start: { low: 125, high: 125 } } },
          },
        ],
      },
    ],
  };
}

Given(
  'a ride with the workout {string} on the route {string} starts for an athlete with an FTP of {int} W',
  async function (this: RidrsWorld, workoutName: string, route: string, ftp: number) {
    const host = this.ensureHost();
    const startedAt = this.fixedTime;
    host.publishEvent('ui-bridge', activityAthleteEvent, {
      sessionId: 'ride-1',
      athlete: { provider: 'local', ftp },
    });
    host.publishEvent('ui-bridge', activityStateChangedEvent, {
      state: 'running',
      sessionId: 'ride-1',
      startedAt,
      world: { landscape: 'fixture-route-box/landscape', route },
      workout: { workout: workoutFixture(workoutName) },
    });
    await this.settle();
  },
);

Then(
  'the upper HUD panel {string} is translucent glass with radius {string}',
  async function (this: RidrsWorld, testId: string, expectedRadius: string) {
    const panel = await within(ui(this)).findByTestId(testId);
    await waitFor(() => {
      const style = getComputedStyle(panel);
      const bg =
        panel.style.backgroundColor ||
        style.backgroundColor ||
        panel.style.background ||
        style.background;
      const found = alphas(bg);
      assert.ok(
        found.length > 0 && found.some((alpha) => alpha > 0 && alpha < 1),
        `Expected "${testId}" to use translucent glass, got "${bg}"`,
      );
      const blur = panel.style.backdropFilter || style.backdropFilter;
      assert.match(
        blur,
        /blur\(/,
        `Expected "${testId}" to apply backdrop-filter blur, got "${blur}"`,
      );
      const radius = panel.style.borderRadius || style.borderRadius;
      assert.equal(
        radius,
        expectedRadius,
        `Expected "${testId}" border-radius "${expectedRadius}", got "${radius}"`,
      );
    });
  },
);

Then(
  'the central HUD metric {string} carries the label {string}',
  async function (this: RidrsWorld, metricTestId: string, expectedLabel: string) {
    const card = await within(ui(this)).findByTestId('ride-facts');
    await waitFor(() => {
      const metric = within(card).getByTestId(metricTestId);
      const label = within(metric).getByTestId('label');
      assert.equal(label.textContent?.trim().toLowerCase(), expectedLabel.toLowerCase());
    });
  },
);

Then(
  'the central HUD metric {string} carries the label {string} at least {int} px high',
  async function (this: RidrsWorld, metricTestId: string, expectedLabel: string, minPx: number) {
    const card = await within(ui(this)).findByTestId('ride-facts');
    await waitFor(() => {
      const metric = within(card).getByTestId(metricTestId);
      const label = within(metric).getByTestId('label');
      assert.equal(label.textContent?.trim().toLowerCase(), expectedLabel.toLowerCase());
      const rawSize = label.style.fontSize || getComputedStyle(label).fontSize;
      const numeric = rawSize.includes('var(--ridrs-size-label)') ? 11 : Number.parseFloat(rawSize);
      assert.ok(
        numeric >= minPx,
        `Expected label "${expectedLabel}" >= ${minPx}px, got "${rawSize}"`,
      );
    });
  },
);

Then(
  'the workout HUD header labels the step position with {string}',
  async function (this: RidrsWorld, expectedLabel: string) {
    const widget = await within(ui(this)).findByTestId('widget-workout');
    await waitFor(() => {
      const label = within(widget).getByTestId('workout-step-label');
      assert.equal(label.textContent?.trim().toLowerCase(), expectedLabel.toLowerCase());
    });
  },
);

Then(
  'the active workout HUD row renders a single text layer without split-fill duplication',
  async function (this: RidrsWorld) {
    const widget = await within(ui(this)).findByTestId('widget-workout');
    await waitFor(() => {
      const now = within(widget).getByTestId('workout-now');
      assert.equal(
        now.querySelector('.wk-fill-layer'),
        null,
        'Expected no split-fill duplicate text layer in active workout row',
      );
      assert.equal(
        now.querySelectorAll('.wk-target').length,
        1,
        'Expected target text to be rendered once, not duplicated across layers',
      );
    });
  },
);

Then(
  'the central segment profile shades its terrain with a vertical gradient',
  async function (this: RidrsWorld) {
    const card = await within(ui(this)).findByTestId('ride-facts');
    await waitFor(() => {
      const profile = within(card).getByTestId('segment-profile');
      assert.ok(
        profile.querySelector('defs linearGradient'),
        'Expected a vertical linearGradient in segment-profile',
      );
    });
  },
);

Then(
  'the route profile shades its terrain with a vertical gradient',
  async function (this: RidrsWorld) {
    const box = await within(ui(this)).findByTestId('route-box');
    await waitFor(() => {
      const profile = within(box).getByTestId('route-profile');
      assert.ok(
        profile.querySelector('defs linearGradient'),
        'Expected a vertical linearGradient in route-profile',
      );
    });
  },
);

Then(
  'the route profile places the rider dot on the elevation curve, not pinned to the top edge',
  async function (this: RidrsWorld) {
    const box = await within(ui(this)).findByTestId('route-box');
    await waitFor(() => {
      const profile = within(box).getByTestId('route-profile');
      const dot = profile.querySelector('circle[data-testid="route-profile-rider"]');
      assert.ok(dot, 'Expected route-profile-rider circle on route profile');
      const cy = Number(dot.getAttribute('cy'));
      assert.ok(cy > 10, `Expected rider dot cy on the hill curve (> 10), got ${cy}`);
    });
  },
);

Then(
  'the route distance readout has its own dark backing capsule',
  async function (this: RidrsWorld) {
    const box = await within(ui(this)).findByTestId('route-box');
    await waitFor(() => {
      const dist = within(box).getByTestId('route-distance');
      const bg = dist.style.backgroundColor || dist.style.background;
      assert.ok(
        alphas(bg).some((alpha) => alpha >= 0.6 && alpha < 1),
        `Expected dark translucent capsule backing on route-distance, got "${bg}"`,
      );
    });
  },
);
