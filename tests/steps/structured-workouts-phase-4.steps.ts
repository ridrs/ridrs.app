// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { type PlannedWorkout, trainingCalendarState } from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

Given(
  'the ridrs plugins {string} with app files and a test device plugin {string}',
  async function (this: RidrsWorld, csv: string, deviceId: string) {
    // The ridrs library keeps imported and edited workouts as app files.
    this.useMemoryStorage();
    await useRealPlugins(
      this,
      csv.split(',').map((id) => id.trim()),
    );
    await this.writeProbePluginFolder({ folder: deviceId, id: deviceId, types: ['device'] });
  },
);

When(
  'I open the details of the library workout {string}',
  async function (this: RidrsWorld, name: string) {
    // The card of the library, not the planned entry of the same name.
    const open = await waitFor(() => {
      const card = [
        ...ui(this).querySelectorAll<HTMLElement>('article[data-library-workout]'),
      ].find((each) => each.querySelector('h4')?.textContent?.trim() === name);
      const button = card?.querySelector('button');
      assert.ok(button, `No library card "${name}"`);
      return button;
    });
    fireEvent.click(open);
    await waitFor(() => within(ui(this)).getByTestId('workout-details'));
  },
);

/** The power field of one row of the editor; steps count from 1 in the order of the list. */
When(
  'I set {string} of step {int} in the workout editor to {string}',
  async function (this: RidrsWorld, field: string, number: number, value: string) {
    const control = await waitFor(() => {
      const editor = within(ui(this)).getByTestId('workout-editor');
      const items = editor.querySelectorAll('[data-testid="workout-editor-step"]');
      assert.ok(items.length >= number, `The editor lists only ${items.length} steps`);
      const found = items[number - 1]?.firstElementChild?.querySelector<HTMLInputElement>(
        `[data-field="${field}"]`,
      );
      assert.ok(found, `Step ${number} of the editor has no field "${field}"`);
      return found;
    });
    fireEvent.change(control, { target: { value } });
    await this.settle();
  },
);

/** The smallest y of the points of a path: the higher a step is drawn, the more power it asks. */
const topOf = (shape: Element): number => {
  const d = shape.querySelector('path[data-fill]')?.getAttribute('d') ?? '';
  const ys = [...d.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
  assert.ok(ys.length > 0, 'The step is drawn without a shape');
  return Math.min(...ys);
};

Then(
  'the chart of the next workout draws the step {string} higher than the step {string}',
  async function (this: RidrsWorld, higher: string, lower: string) {
    await waitFor(() => {
      const chart = within(ui(this)).getByTestId('next-workout-chart');
      const shape = (id: string) => {
        const found = chart.querySelector(`g[data-shape][data-step-id="${id}"]`);
        assert.ok(found, `The chart of the next workout draws no step "${id}"`);
        return found;
      };
      assert.ok(topOf(shape(higher)) < topOf(shape(lower)));
    });
  },
);

const detailsOf = (world: RidrsWorld) => within(ui(world)).getByTestId('workout-details');
const stepRows = (world: RidrsWorld) => [
  ...detailsOf(world).querySelectorAll<HTMLElement>('[data-testid="workout-details-step"]'),
];
const targetOfRow = (row: Element | null | undefined) =>
  (row?.querySelector('[data-field="target"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Arrows alone: Down to the list of steps, then Up until a step of the chart has the focus. */
When(
  'I move the focus to the chart in the details of the workout',
  async function (this: RidrsWorld) {
    const inChart = () => document.activeElement?.closest('[data-testid="workout-chart-step"]');
    const inList = () => document.activeElement?.closest('[data-testid="workout-details-step"]');
    for (let n = 0; n < 40 && !inChart(); n += 1) {
      const key = inList() || n > 20 ? 'ArrowUp' : 'ArrowDown';
      fireEvent.keyDown(document.activeElement ?? document.body, { key });
      await this.settle();
    }
    assert.ok(
      inChart(),
      `The arrows never reached the chart of the details: ${document.activeElement?.outerHTML.slice(0, 200)}`,
    );
  },
);

When(
  'I press the arrow key {string} {int} times',
  async function (this: RidrsWorld, direction: string, times: number) {
    for (let n = 0; n < times; n += 1) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: `Arrow${direction}` });
      await this.settle();
    }
  },
);

Then(
  'the selected step of the details of the workout has the target {string}',
  async function (this: RidrsWorld, target: string) {
    await waitFor(() => {
      const selected = stepRows(this).filter((row) => row.querySelector('[aria-current="step"]'));
      assert.deepEqual(selected.map(targetOfRow), [target]);
    });
  },
);

Then(
  'the focused step of the details of the workout has the target {string}',
  async function (this: RidrsWorld, target: string) {
    await waitFor(() =>
      assert.equal(
        targetOfRow(document.activeElement?.closest('[data-testid="workout-details-step"]')),
        target,
      ),
    );
  },
);

Then('the next workout card has no chart', async function (this: RidrsWorld) {
  await within(ui(this)).findByTestId('next-workout');
  assert.equal(within(ui(this)).queryByTestId('next-workout-chart'), null);
});

Then(
  'the planned workout {string} of ridrs comes from the library {string} workout {string}',
  async function (this: RidrsWorld, name: string, from: string, workoutId: string) {
    await waitFor(() => {
      const entry = this.ensureHost().getState(trainingCalendarState.id).get('ridrs') as
        | { data?: { workouts: PlannedWorkout[] } }
        | undefined;
      const planned = entry?.data?.workouts.find((workout) => workout.name === name);
      assert.ok(planned, `ridrs plans no "${name}"`);
      assert.deepEqual(planned.library, { from, workoutId });
      assert.ok(planned.steps.length > 0, 'The planned workout has no steps');
    });
  },
);

/** A calendar kept by an earlier version: a workout entry without a link to a library. */
Given(
  'the Training area kept a workout {string} on {word} without a link to a library',
  async function (this: RidrsWorld, title: string, day: string) {
    const document = {
      version: 1,
      value: {
        calendar: { entries: [{ id: 'entry-1', day, kind: 'workout', title }], undo: [] },
        favourites: [],
      },
    };
    await this.settingsFiles.write(
      'config/user/ui-area-training/preview.json',
      new TextEncoder().encode(`${JSON.stringify(document)}\n`),
    );
  },
);
