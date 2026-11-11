// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/plugins');
/** The fixture library, its calendar and the host that opens the details. */
const DETAILS_FIXTURES = resolve(FIXTURES, 'workout-details');
/** The stand-in for `ui-workout-chart`. */
const CHART_FIXTURE = resolve(FIXTURES, 'workout-chart');
const LANGUAGE_PATH = 'config/user/ui-settings/language.json';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const details = (world: RidrsWorld) => within(ui(world)).getByTestId('workout-details');
const chart = (world: RidrsWorld) => within(details(world)).getByTestId('fixture-workout-chart');
const field = (row: Element, name: string) =>
  (row.querySelector(`[data-field="${name}"]`)?.textContent ?? '').trim();
const rows = (world: RidrsWorld) => [
  ...details(world).querySelectorAll<HTMLElement>('[data-testid="workout-details-step"]'),
];

/** Text with every run of white space as one space, as a reader sees it. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

Given(
  'the ridrs plugins {string} with the workout details fixtures',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(
      this,
      pluginsCsv.split(',').map((id) => id.trim()),
    );
    this.extraPluginDirs.push(DETAILS_FIXTURES);
  },
);

Given('the fixture chart of workouts is installed', function (this: RidrsWorld) {
  this.extraPluginDirs.push(CHART_FIXTURE);
});

Given('the rider speaks German', async function (this: RidrsWorld) {
  const text = `${JSON.stringify({ version: 1, value: { language: 'de' } })}\n`;
  await this.settingsFiles.write(LANGUAGE_PATH, new TextEncoder().encode(text));
});

Then(
  'the details of the workout show the name {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() =>
      assert.equal(within(details(this)).getByRole('heading', { level: 1 }).textContent, name),
    );
  },
);

Then('the details of the workout show {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    const shown = plain(details(this).textContent);
    assert.ok(shown.includes(text), `The details do not show "${text}"`);
  });
});

Then(
  'the details of the workout show the heading {string}',
  async function (this: RidrsWorld, heading: string) {
    await waitFor(() => within(details(this)).getByRole('heading', { name: heading }));
  },
);

/** The pairs of a `<dl>` of the details, by its test id. */
function pairs(world: RidrsWorld, testId: string): string[][] {
  const list = within(details(world)).getByTestId(testId);
  return [...list.querySelectorAll('dt')].map((term) => [
    plain(term.textContent),
    plain(term.nextElementSibling?.textContent),
  ]);
}

Then(
  'the details of the workout show the numbers:',
  async function (this: RidrsWorld, table: DataTable) {
    await waitFor(() => assert.deepEqual(pairs(this, 'workout-details-numbers'), table.raw()));
  },
);

Then(
  'the details of the workout show the time per zone:',
  async function (this: RidrsWorld, table: DataTable) {
    await waitFor(() => assert.deepEqual(pairs(this, 'workout-details-zones'), table.raw()));
  },
);

Then(
  'the details of the workout list the steps:',
  async function (this: RidrsWorld, table: DataTable) {
    await waitFor(() => {
      const shown = rows(this).map((row) => ({
        step: field(row, 'step'),
        duration: field(row, 'duration'),
        target: field(row, 'target'),
        mark: field(row, 'mark'),
      }));
      const expected = table.hashes().map((row) => ({ mark: '', ...row }));
      assert.deepEqual(shown, expected);
    });
  },
);

Then(
  'the details of the workout list {int} steps to focus',
  async function (this: RidrsWorld, count: number) {
    await waitFor(() =>
      assert.equal(rows(this).filter((row) => row.querySelector('button')).length, count),
    );
  },
);

/** The step row the focus is in, if any. */
const focusedRow = () =>
  document.activeElement?.closest<HTMLElement>('[data-testid="workout-details-step"]') ?? null;

When(
  'I move the focus to the first step of the details of the workout',
  async function (this: RidrsWorld) {
    await waitFor(() => assert.ok(rows(this).length > 0, 'The details list no steps'));
    // Arrows alone, as a controller has them: on until a step has the focus.
    for (let step = 0; step < 30 && !focusedRow(); step += 1) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' });
      await this.settle();
    }
    assert.ok(focusedRow(), 'The arrows never reached a step of the details');
  },
);

Then(
  'the focused step of the details of the workout is {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() => {
      const row = focusedRow();
      assert.ok(row, 'No step of the details has the focus');
      assert.equal(field(row, 'step'), name);
    });
  },
);

Then(
  'the selected step of the details of the workout is {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() => {
      const selected = rows(this).filter((row) => row.querySelector('[aria-current="step"]'));
      assert.deepEqual(
        selected.map((row) => field(row, 'step')),
        [name],
      );
    });
  },
);

Then(
  'the workout chart shows the step {string} as selected',
  async function (this: RidrsWorld, stepId: string) {
    await waitFor(() => assert.equal(chart(this).dataset.selected, stepId));
  },
);

Then(
  'the workout chart draws {string} in the variant {string} with an FTP of {int} W',
  async function (this: RidrsWorld, name: string, variant: string, ftp: number) {
    await waitFor(() => {
      const drawn = chart(this);
      assert.equal(drawn.dataset.workout, name);
      assert.equal(drawn.dataset.variant, variant);
      assert.equal(drawn.dataset.ftp, String(ftp));
    });
  },
);

When('the workout chart focuses the step {string}', async function (this: RidrsWorld, id: string) {
  const step = await within(ui(this)).findByRole('button', { name: `Chart step ${id}` });
  step.focus();
  await this.settle();
});

Then(
  'the details of the workout show the chart fallback {string}',
  async function (this: RidrsWorld, text: string) {
    await waitFor(() => {
      const place = within(details(this)).getByTestId('workout-details-chart');
      assert.equal(place.dataset.available, 'false');
      assert.equal(
        plain(within(details(this)).getByTestId('workout-details-fallback').textContent),
        text,
      );
    });
  },
);

Then('no details of a workout are shown', async function (this: RidrsWorld) {
  await waitFor(() =>
    assert.ok(within(ui(this)).queryByTestId('workout-details') === null, 'Details are shown'),
  );
});
