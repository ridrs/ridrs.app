// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type LibraryWorkout,
  type ServiceDefinition,
  trainingLibrarySaveService,
  trainingLibraryState,
} from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

/** The fixture `ridrs` library with its calendar, and the host that opens the details and the editor. */
const EDITOR_FIXTURES = resolve(import.meta.dirname, '../fixtures/plugins/workout-editor');

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const editor = (world: RidrsWorld) => within(ui(world)).getByTestId('workout-editor');
const details = (world: RidrsWorld) => within(ui(world)).getByTestId('workout-details');
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** The `li` of every step of the editor, in the order of the list (a block before its steps). */
const items = (world: RidrsWorld) => [
  ...editor(world).querySelectorAll<HTMLElement>('[data-testid="workout-editor-step"]'),
];
const rowOf = (item: HTMLElement) => item.firstElementChild as HTMLElement;
const input = (row: Element, field: string) =>
  row.querySelector<HTMLInputElement>(`[data-field="${field}"]`);

/** The name a step goes by: a block's heading, a step's name or what its field suggests. */
function titleOf(item: HTMLElement): string {
  const row = rowOf(item);
  const block = row.querySelector('[data-field="block"]');
  if (block) return plain(block.textContent);
  const name = input(row, 'name');
  return name?.value || name?.placeholder || '';
}

function listed(world: RidrsWorld, title: string): HTMLElement {
  const found = items(world).find((item) => titleOf(item) === title);
  assert.ok(
    found,
    `The editor lists no step "${title}"; it has ${items(world).map(titleOf).join(', ')}`,
  );
  return found;
}

/** The step of that title, once the editor lists it. */
const itemTitled = (world: RidrsWorld, title: string): Promise<HTMLElement> =>
  waitFor(() => listed(world, title));

/** The target of a row: the numbers of its power fields, "50–75" for a ramp, "100" for a steady step. */
const targetOf = (row: Element) =>
  [...row.querySelectorAll<HTMLInputElement>('[data-field^="power-"]')]
    .map((each) => each.value)
    .join('–');
const durationOf = (row: Element) => input(row, 'duration')?.value ?? '';

Given(
  'the ridrs plugins {string} with the workout editor fixtures',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(
      this,
      pluginsCsv.split(',').map((id) => id.trim()),
    );
    // The world knows the services of the other areas; the save of the library is this area's.
    this.serviceDefinitions.set(
      trainingLibrarySaveService.id,
      trainingLibrarySaveService as ServiceDefinition,
    );
    this.extraPluginDirs.push(EDITOR_FIXTURES);
  },
);

When('I open the workout editor for a new workout', async function (this: RidrsWorld) {
  fireEvent.click(await within(ui(this)).findByRole('button', { name: 'New workout' }));
  await waitFor(() => editor(this));
});

When('I open the details of the workout {string}', async function (this: RidrsWorld, name: string) {
  fireEvent.click(await within(ui(this)).findByRole('button', { name }));
  await waitFor(() => details(this));
});

When(
  'I press {string} in the details of the workout',
  async function (this: RidrsWorld, name: string) {
    fireEvent.click(await within(details(this)).findByRole('button', { name }));
    await waitFor(() => editor(this));
  },
);

Then(
  'the details of the workout offer {string} and not {string}',
  async function (this: RidrsWorld, offered: string, other: string) {
    await waitFor(() => {
      const button = within(details(this)).getByTestId('workout-details-edit');
      assert.equal(plain(button.textContent), offered);
      assert.notEqual(plain(button.textContent), other);
    });
  },
);

When('I press {string} in the workout editor', async function (this: RidrsWorld, name: string) {
  fireEvent.click(await within(editor(this)).findByRole('button', { name }));
  await this.settle();
});

When(
  'I name the workout {string} in the workout editor',
  async function (this: RidrsWorld, name: string) {
    const field = await waitFor(() => {
      const found = input(editor(this), 'meta-name');
      assert.ok(found, 'The editor has no name field');
      return found;
    });
    fireEvent.change(field, { target: { value: name } });
    await this.settle();
  },
);

When(
  'I add the step {string} in the workout editor',
  async function (this: RidrsWorld, kind: string) {
    const button = within(editor(this))
      .getAllByTestId('workout-editor-add')
      .find((each) => plain(each.textContent) === kind);
    assert.ok(button, `The editor has no button to add "${kind}"`);
    fireEvent.click(button);
    await this.settle();
  },
);

When(
  'I set {string} of the step {string} to {string} in the workout editor',
  async function (this: RidrsWorld, field: string, title: string, value: string) {
    const control = input(rowOf(await itemTitled(this, title)), field);
    assert.ok(control, `The step "${title}" has no field "${field}"`);
    fireEvent.change(control, { target: { value } });
    await this.settle();
  },
);

When(
  'I press {string} on the step {string} in the workout editor',
  async function (this: RidrsWorld, label: string, title: string) {
    const row = rowOf(await itemTitled(this, title));
    const button = [...row.querySelectorAll('button')].find(
      (each) =>
        plain(each.textContent) === label ||
        (each.getAttribute('aria-label') ?? '').startsWith(`${label}:`),
    );
    assert.ok(button, `The step "${title}" has no button "${label}"`);
    fireEvent.click(button);
    await this.settle();
  },
);

function press(world: RidrsWorld, init: { shiftKey: boolean }) {
  fireEvent.keyDown(editor(world), { key: 'z', ctrlKey: true, ...init });
}
When('I press Ctrl+Z in the workout editor', async function (this: RidrsWorld) {
  press(this, { shiftKey: false });
  await this.settle();
});
When('I press Ctrl+Shift+Z in the workout editor', async function (this: RidrsWorld) {
  press(this, { shiftKey: true });
  await this.settle();
});

When('I save the workout in the workout editor', async function (this: RidrsWorld) {
  const save = within(editor(this)).getByTestId('workout-editor-save');
  await waitFor(() =>
    assert.equal((save as HTMLButtonElement).disabled, false, 'Save is disabled'),
  );
  fireEvent.click(save);
  await this.settle();
});

const dataTransfer = () => ({
  setData() {},
  getData: () => '',
  effectAllowed: 'move',
  dropEffect: 'move',
});

async function dragTo(
  world: RidrsWorld,
  title: string,
  target: (grip: HTMLElement) => HTMLElement,
) {
  const grip = within(rowOf(await itemTitled(world, title))).getByTestId('workout-editor-grip');
  const transfer = dataTransfer();
  fireEvent.dragStart(grip, { dataTransfer: transfer });
  await world.settle();
  const to = target(grip);
  fireEvent.dragOver(to, { dataTransfer: transfer });
  fireEvent.drop(to, { dataTransfer: transfer });
  fireEvent.dragEnd(grip, { dataTransfer: transfer });
  await world.settle();
}

When(
  'I drag the step {string} before the step {string} in the workout editor',
  async function (this: RidrsWorld, title: string, before: string) {
    const target = await itemTitled(this, before);
    await dragTo(this, title, () => target);
  },
);

When(
  'I drag the step {string} to the end of the block in the workout editor',
  async function (this: RidrsWorld, title: string) {
    await dragTo(this, title, () => {
      const end = editor(this).querySelector<HTMLElement>(
        '[data-testid="workout-editor-drop-end"][data-parent]',
      );
      assert.ok(end, 'The editor shows no block to drop into');
      return end;
    });
  },
);

const chart = (world: RidrsWorld) => within(editor(world)).getByTestId('workout-editor-chart');

When(
  'I select the step {string} in the workout editor chart',
  async function (this: RidrsWorld, stepId: string) {
    const shape = await waitFor(() => {
      const found = chart(this).querySelector<HTMLElement>(
        `[data-testid="workout-chart-step"][data-step-id="${stepId}"]`,
      );
      assert.ok(found, `The chart draws no step "${stepId}"`);
      return found;
    });
    fireEvent.click(shape);
    await this.settle();
  },
);

When(
  'I drag the {string} handle of the step {string} in the workout editor chart by {int} across and {int} down',
  async function (this: RidrsWorld, kind: string, stepId: string, across: number, down: number) {
    const handle = await waitFor(() => {
      const found = chart(this).querySelector<SVGElement>(
        `[data-testid="workout-chart-handle"][data-handle="${kind}"][data-step-id="${stepId}"]`,
      );
      assert.ok(found, `The chart shows no ${kind} handle on "${stepId}"`);
      return found;
    });
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, button: 0 });
    fireEvent(
      window,
      new PointerEvent('pointermove', { clientX: 100 + across, clientY: 100 + down }),
    );
    await this.settle();
    fireEvent(
      window,
      new PointerEvent('pointerup', { clientX: 100 + across, clientY: 100 + down }),
    );
    await this.settle();
  },
);

Then('the workout editor shows the numbers:', async function (this: RidrsWorld, table: DataTable) {
  await waitFor(() => {
    const list = within(editor(this)).getByTestId('workout-editor-numbers');
    const shown = [...list.querySelectorAll('dt')].map((term) => [
      plain(term.textContent),
      plain(term.nextElementSibling?.textContent),
    ]);
    assert.deepEqual(shown, table.raw());
  });
});

Then('the workout editor lists the steps:', async function (this: RidrsWorld, table: DataTable) {
  await waitFor(() => {
    const shown = items(this).map((item) => ({
      step: titleOf(item),
      duration: durationOf(rowOf(item)),
      target: targetOf(rowOf(item)),
    }));
    assert.deepEqual(shown, table.hashes());
  });
});

Then(
  'the workout editor lists the step {string} with the duration {string} and the target {string}',
  async function (this: RidrsWorld, title: string, duration: string, target: string) {
    await waitFor(() => {
      const row = rowOf(listed(this, title));
      assert.deepEqual({ duration: durationOf(row), target: targetOf(row) }, { duration, target });
    });
  },
);

Then(
  'the workout editor lists the step {string} as kept as imported with {string}',
  async function (this: RidrsWorld, title: string, said: string) {
    await waitFor(() => {
      const row = rowOf(listed(this, title));
      assert.ok(
        row.querySelector('[data-field="foreign"]'),
        `The step "${title}" is not kept as imported`,
      );
      assert.ok(
        plain(row.textContent).includes(said),
        `The step "${title}" does not say "${said}"`,
      );
      assert.equal(row.querySelector('[data-field="duration"]'), null);
    });
  },
);

Then(
  'the workout editor chart draws {int} steps',
  async function (this: RidrsWorld, count: number) {
    await waitFor(() =>
      assert.equal(
        chart(this).querySelectorAll('[data-testid="workout-chart-step"]').length,
        count,
      ),
    );
  },
);

Then(
  'the workout editor shows the error {string} at the step {string}',
  async function (this: RidrsWorld, message: string, title: string) {
    await waitFor(() => {
      const errors = [
        ...listed(this, title).querySelectorAll('[data-testid="workout-editor-step-error"]'),
      ].map((each) => plain(each.textContent));
      assert.ok(errors.includes(message), `The step shows ${JSON.stringify(errors)}`);
    });
  },
);

Then(
  'the workout editor shows the problem {string}',
  async function (this: RidrsWorld, message: string) {
    await waitFor(() => {
      const list = within(editor(this)).getByTestId('workout-editor-problems');
      assert.ok(
        plain(list.textContent).includes(message),
        `The problems read "${plain(list.textContent)}"`,
      );
    });
  },
);

Then('the workout editor cannot be saved', async function (this: RidrsWorld) {
  await waitFor(() =>
    assert.equal(
      (within(editor(this)).getByTestId('workout-editor-save') as HTMLButtonElement).disabled,
      true,
    ),
  );
});

Then(
  'the workout editor shows the notice {string}',
  async function (this: RidrsWorld, notice: string) {
    await waitFor(() =>
      assert.equal(
        plain(within(editor(this)).getByTestId('workout-editor-notice').textContent),
        notice,
      ),
    );
  },
);

Then('the workout editor shows no notice about planned days', async function (this: RidrsWorld) {
  await waitFor(() =>
    assert.equal(within(editor(this)).queryByTestId('workout-editor-notice'), null),
  );
});

Then('the workout editor shows the name {string}', async function (this: RidrsWorld, name: string) {
  await waitFor(() => assert.equal(input(editor(this), 'meta-name')?.value, name));
});

Then(
  'the workout editor shows the heading {string}',
  async function (this: RidrsWorld, heading: string) {
    await waitFor(() => within(editor(this)).getByRole('heading', { level: 1, name: heading }));
  },
);

Then(
  'the workout editor has the buttons {string}',
  async function (this: RidrsWorld, names: string) {
    await waitFor(() => {
      for (const name of names.split(',').map((each) => each.trim()))
        within(editor(this)).getByRole('button', { name });
    });
  },
);

const library = (world: RidrsWorld) =>
  (
    world.ensureHost().getState(trainingLibraryState.id).get('ridrs') as
      | { data?: { workouts: LibraryWorkout[] } }
      | undefined
  )?.data?.workouts ?? [];

Then('the library holds the workouts {string}', async function (this: RidrsWorld, ids: string) {
  await waitFor(() =>
    assert.deepEqual(
      library(this).map((each) => each.id),
      ids.split(',').map((each) => each.trim()),
    ),
  );
});

Then(
  "the library workout {string} is the rider's own, by {string} under {string}",
  async function (this: RidrsWorld, id: string, author: string, license: string) {
    const saved = library(this).find((each) => each.id === id)?.workout;
    assert.ok(saved, `The library has no workout "${id}"`);
    assert.equal(saved.source.kind, 'user');
    assert.equal(saved.author, author);
    assert.equal(saved.license, license);
  },
);

Then(
  'the library workout {string} is named {string}',
  async function (this: RidrsWorld, id: string, name: string) {
    await waitFor(() =>
      assert.equal(library(this).find((each) => each.id === id)?.workout?.name, name),
    );
  },
);
