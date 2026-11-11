// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then } from '@cucumber/cucumber';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

/**
 * The palette variable a chart paints a 1-based zone of `count` zones with: the ten colours are
 * spread over the zones (`paletteSlot` of `ui-workout-chart`). Written out here, so a change of
 * the spread shows up as a failing scenario and not silently.
 */
const colourOf = (zone: number, count: number) =>
  `var(--wc-z${Math.round(((zone - 1) * 9) / (count - 1)) + 1})`;

/** The fills of the shapes of one step id in a drawn chart. */
const fills = (chart: Element, stepId: string): string[] =>
  [...chart.querySelectorAll<SVGGElement>(`g[data-shape][data-step-id="${stepId}"]`)].map(
    (shape) => shape.querySelector('path[data-fill]')?.getAttribute('fill') ?? '',
  );

function expectZone(chart: Element, stepId: string, zone: number, count: number): void {
  const shown = fills(chart, stepId);
  assert.ok(shown.length > 0, `The chart draws no step "${stepId}"`);
  assert.deepEqual(
    shown,
    shown.map(() => colourOf(zone, count)),
  );
}

Then(
  'the steps {string} of the mini chart of {string} are drawn in zone {int} of {int} zones',
  async function (this: RidrsWorld, stepId: string, name: string, zone: number, count: number) {
    await waitFor(() => {
      const card = [
        ...ui(this).querySelectorAll<HTMLElement>('article[data-library-workout]'),
      ].find((each) => each.querySelector('h4')?.textContent?.trim() === name);
      assert.ok(card, `No library card "${name}"`);
      const chart = card.querySelector('[data-testid="workout-chart"][data-variant="mini"]');
      assert.ok(chart, 'No mini chart');
      expectZone(chart, stepId, zone, count);
    });
  },
);

const detailsChart = (world: RidrsWorld) =>
  within(within(ui(world)).getByTestId('workout-details')).getByTestId('workout-chart');

Then(
  'the steps {string} of the workout chart in the details are drawn in zone {int} of {int} zones',
  async function (this: RidrsWorld, stepId: string, zone: number, count: number) {
    await waitFor(() => expectZone(detailsChart(this), stepId, zone, count));
  },
);

Then(
  'the workout chart in the details has the step {string} selected',
  async function (this: RidrsWorld, stepId: string) {
    await waitFor(() =>
      assert.equal(
        detailsChart(this)
          .querySelector('g[data-step][data-selected]')
          ?.getAttribute('data-step-id'),
        stepId,
      ),
    );
  },
);

Then(
  'the focus is on the planned workout {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() => {
      const entry = document.activeElement?.closest('li.tr-entry');
      assert.ok(entry && ui(this).contains(entry), 'The focus is on no planned workout');
      assert.equal(entry.querySelector('.tw-entry-name')?.textContent?.trim(), name);
    });
  },
);
