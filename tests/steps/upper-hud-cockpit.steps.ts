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

function isFlatTransparent(bg: string): boolean {
  const trimmed = bg.trim();
  return (
    trimmed === '' ||
    trimmed === 'none' ||
    trimmed === 'transparent' ||
    trimmed === 'rgba(0, 0, 0, 0)'
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
  'the route box bleeds its map and profile edge-to-edge with zero outer padding and no inner rounded frames',
  async function (this: RidrsWorld) {
    const box = await within(ui(this)).findByTestId('route-box');
    await waitFor(() => {
      assert.ok(
        box.style.padding === '0px' || box.style.padding === '0',
        `Expected route-box padding to be 0, got "${box.style.padding}"`,
      );
      const map = within(box).getByTestId('route-map');
      assert.ok(
        map.style.borderRadius === '' ||
          map.style.borderRadius === '0px' ||
          map.style.borderRadius === '0',
        `Expected route-map to have no inner border-radius, got "${map.style.borderRadius}"`,
      );
      const profile = within(box).getByTestId('route-profile');
      assert.ok(
        profile.style.padding === '' ||
          profile.style.padding === '0px' ||
          profile.style.padding === '0',
        `Expected route-profile to have no inner padding, got "${profile.style.padding}"`,
      );
      assert.ok(
        isFlatTransparent(profile.style.backgroundColor) &&
          isFlatTransparent(profile.style.background),
        `Expected route-profile to have no nested well background, got "${profile.style.backgroundColor || profile.style.background}"`,
      );
    });
  },
);

Then(
  'the workout HUD aligns its header, rows and footer on one padding grid without nested row boxes',
  async function (this: RidrsWorld) {
    const widget = await within(ui(this)).findByTestId('widget-workout');
    await waitFor(() => {
      const head = widget.querySelector<HTMLElement>('.wk-head');
      const foot = widget.querySelector<HTMLElement>('.wk-foot');
      const coming = widget.querySelector<HTMLElement>('.wk-row[data-state="coming"]');
      const now = within(widget).getByTestId('workout-now');
      assert.ok(head && foot && coming, 'Expected workout header, coming row and footer');
      assert.equal(getComputedStyle(head).paddingLeft, '0px');
      assert.equal(getComputedStyle(head).paddingRight, '0px');
      assert.equal(getComputedStyle(foot).paddingLeft, '0px');
      assert.equal(getComputedStyle(foot).paddingRight, '0px');
      assert.ok(
        isFlatTransparent(getComputedStyle(coming).backgroundColor),
        `Expected coming row to have no nested box background, got "${getComputedStyle(coming).backgroundColor}"`,
      );
      const nowRadius = getComputedStyle(now).borderRadius;
      assert.ok(
        nowRadius === '' || nowRadius === '0px' || nowRadius === '0',
        `Expected active workout row to have no nested rounded card radius, got "${nowRadius}"`,
      );
    });
  },
);

Then(
  'the central HUD segment section sits flat without a nested background fill',
  async function (this: RidrsWorld) {
    const card = await within(ui(this)).findByTestId('ride-facts');
    await waitFor(() => {
      const segment = within(card).getByTestId('current-segment');
      assert.ok(
        isFlatTransparent(segment.style.backgroundColor) &&
          isFlatTransparent(segment.style.background),
        `Expected current-segment to sit flat without background fill, got "${segment.style.backgroundColor || segment.style.background}"`,
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
  'the central segment profile sits directly in the segment section without a wrapper box and fades to transparent',
  async function (this: RidrsWorld) {
    const card = await within(ui(this)).findByTestId('ride-facts');
    await waitFor(() => {
      const segment = within(card).getByTestId('current-segment');
      const profile = within(segment).getByTestId('segment-profile');
      assert.equal(
        profile.parentElement,
        segment,
        'Expected segment-profile SVG to sit directly in current-segment without a wrapper div box',
      );
      const stops = [...profile.querySelectorAll('defs linearGradient stop')];
      assert.ok(stops.length >= 2, 'Expected gradient stops in segment-profile');
      assert.equal(stops.at(-1)?.getAttribute('stop-opacity'), '0');
    });
  },
);

Then(
  'the route profile fades its terrain to transparent and places the rider dot on the elevation curve',
  async function (this: RidrsWorld) {
    const box = await within(ui(this)).findByTestId('route-box');
    await waitFor(() => {
      const profile = within(box).getByTestId('route-profile');
      const stops = [...profile.querySelectorAll('defs linearGradient stop')];
      assert.ok(stops.length >= 2, 'Expected gradient stops in route-profile');
      assert.equal(stops.at(-1)?.getAttribute('stop-opacity'), '0');
      const dot = profile.querySelector('circle[data-testid="route-profile-rider"]');
      assert.ok(dot, 'Expected route-profile-rider circle on route profile');
      const cy = Number(dot.getAttribute('cy'));
      assert.ok(cy > 10, `Expected rider dot cy on the hill curve (> 10), got ${cy}`);
    });
  },
);

Then(
  'the route distance readout is flat text without a backing capsule',
  async function (this: RidrsWorld) {
    const box = await within(ui(this)).findByTestId('route-box');
    await waitFor(() => {
      const dist = within(box).getByTestId('route-distance');
      assert.ok(
        isFlatTransparent(dist.style.backgroundColor) && isFlatTransparent(dist.style.background),
        `Expected route-distance to have no capsule background, got "${dist.style.backgroundColor || dist.style.background}"`,
      );
    });
  },
);

Then(
  'the summit header items are flat text without pill backgrounds',
  async function (this: RidrsWorld) {
    const card = await within(ui(this)).findByTestId('ride-facts');
    await waitFor(() => {
      const countdown = within(card).getByTestId('segment-countdown');
      const category = within(card).getByTestId('segment-climb-category');
      assert.ok(
        isFlatTransparent(countdown.style.backgroundColor) &&
          isFlatTransparent(countdown.style.background),
        `Expected segment-countdown to have no pill background, got "${countdown.style.backgroundColor || countdown.style.background}"`,
      );
      assert.ok(
        isFlatTransparent(category.style.backgroundColor) &&
          isFlatTransparent(category.style.background),
        `Expected segment-climb-category to have no pill background, got "${category.style.backgroundColor || category.style.background}"`,
      );
    });
  },
);
