// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then } from '@cucumber/cucumber';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

async function layout(world: RidrsWorld): Promise<HTMLElement> {
  return within(ui(world)).findByTestId('main-layout');
}

/** The cells of the tile grid that are shown, in order, with the columns they span. */
function shownTiles(grid: HTMLElement) {
  return [...grid.querySelectorAll<HTMLElement>(':scope > [data-tile]')]
    .filter((cell) => !cell.hidden)
    .map((cell) => ({ tile: cell.dataset.tile ?? '', columns: cell.dataset.columns ?? '' }));
}

function happyDom(): { setViewport(viewport: { width: number; height: number }): void } {
  return (globalThis as unknown as { happyDOM: ReturnType<typeof happyDom> }).happyDOM;
}

Given('the main screen is {int} px wide', async function (this: RidrsWorld, width: number) {
  // The layout follows the viewport through media queries, as in the app's window.
  happyDom().setViewport({ width, height: 900 });
  await this.settle();
});

Then("the main screen's breakpoint is {string}", async function (this: RidrsWorld, name: string) {
  const root = await layout(this);
  await waitFor(() => assert.equal(root.dataset.breakpoint, name));
});

Then('the main screen shows the tiles:', async function (this: RidrsWorld, table: DataTable) {
  const grid = await within(ui(this)).findByTestId('slot-main-tile');
  await waitFor(() => assert.deepEqual(shownTiles(grid), table.hashes()));
});

Then('the main screen shows no tiles', async function (this: RidrsWorld) {
  await waitFor(() =>
    assert.equal(within(ui(this)).queryByTestId('slot-main-tile'), null, 'The tiles are shown'),
  );
});

Then(
  'the tile {string} is mounted but hidden',
  async function (this: RidrsWorld, contribution: string) {
    const grid = await within(ui(this)).findByTestId('slot-main-tile');
    await waitFor(() => {
      const cell = grid.querySelector<HTMLElement>(`:scope > [data-tile="${contribution}"]`);
      assert.ok(cell, `No cell for "${contribution}"`);
      assert.ok(
        cell.querySelector(`[data-contribution="${contribution}"]`),
        `"${contribution}" is not mounted`,
      );
      assert.equal(cell.hidden, true, `"${contribution}" is shown`);
    });
  },
);

Then(
  'no contribution {string} is mounted',
  async function (this: RidrsWorld, contribution: string) {
    await this.settle();
    assert.equal(ui(this).querySelector(`[data-contribution="${contribution}"]`), null);
  },
);

Then('the top bar is shown', async function (this: RidrsWorld) {
  const bar = await within(ui(this)).findByTestId('slot-main-top-bar');
  await waitFor(() => assert.equal(bar.hidden, false));
});

Then('the top bar is not shown', async function (this: RidrsWorld) {
  const bar = await within(ui(this)).findByTestId('slot-main-top-bar');
  await waitFor(() => assert.equal(bar.hidden, true));
});

Then('the top bar greets the rider for the time of day', async function (this: RidrsWorld) {
  const bar = await within(ui(this)).findByTestId('slot-main-top-bar');
  const hour = new Date().getHours();
  const expected =
    hour >= 5 && hour < 12
      ? 'Good morning'
      : hour >= 12 && hour < 18
        ? 'Good afternoon'
        : 'Good evening';
  await waitFor(() =>
    assert.equal(within(bar).getByRole('heading', { level: 1 }).textContent, expected),
  );
});

Then(
  'the menu offers {string} in this order',
  async function (this: RidrsWorld, entriesCsv: string) {
    const menu = await within(ui(this)).findByRole('navigation', { name: 'Main' });
    await waitFor(() =>
      assert.deepEqual(
        within(menu)
          .getAllByRole('button')
          .map((entry) => entry.textContent),
        splitCsv(entriesCsv),
      ),
    );
  },
);

Then(
  'the menu entry {string} is the current page',
  async function (this: RidrsWorld, name: string) {
    const menu = await within(ui(this)).findByRole('navigation', { name: 'Main' });
    await waitFor(() => {
      const current = menu.querySelectorAll('[aria-current="page"]');
      assert.deepEqual(
        [...current].map((entry) => entry.textContent),
        [name],
      );
    });
  },
);

Then(
  'the tile {string} is shown on the main screen',
  async function (this: RidrsWorld, contribution: string) {
    const grid = await within(ui(this)).findByTestId('slot-main-tile');
    await waitFor(() =>
      assert.ok(
        shownTiles(grid).some(({ tile }) => tile === contribution),
        `"${contribution}" is not shown`,
      ),
    );
  },
);
