// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Then, When } from '@cucumber/cucumber';
import { controllerButtonSchema, controllerButtonsChangedEvent } from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { untilQuiet } from '../support/dom-quiet.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

async function hold(world: RidrsWorld, buttons: readonly string[]): Promise<void> {
  const ctx = world.ensureHost().getPluginContext('test-device');
  assert.ok(ctx, 'Expected the test device plugin');
  ctx.inputs.accept(controllerButtonsChangedEvent, {
    deviceId: 'controller-1',
    buttons: buttons.map((b) => controllerButtonSchema.parse(b)),
  });
  await world.settle();
}

/** A press is a button held down and let go again. */
When('the controller presses {string}', async function (this: RidrsWorld, button: string) {
  // A rider presses buttons on the screen they see, not on one still being assembled.
  await untilQuiet(ui(this));
  await hold(this, [button]);
  await hold(this, []);
});

When('I open the tab {string}', async function (this: RidrsWorld, name: string) {
  fireEvent.click(await within(ui(this)).findByRole('tab', { name }));
  await this.settle();
});

Then('the settings offer the tabs {string}', async function (this: RidrsWorld, names: string) {
  await waitFor(() => {
    const tabs = within(ui(this))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    assert.deepEqual(tabs, splitCsv(names));
  });
});

Then('the screen shows no heading {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    const headings = [...ui(this).querySelectorAll('h1')].map((h) => h.textContent);
    assert.ok(!headings.includes(text), `Headings: ${headings.join(', ')}`);
  });
});

/** The rows of the bindings table, by the name of their command. */
function bindingRow(world: RidrsWorld, command: string): HTMLElement {
  const table = within(ui(world)).getAllByRole('table')[0];
  assert.ok(table, 'No bindings table');
  const row = within(table)
    .getAllByRole('row')
    .find((r) => within(r).queryByRole('rowheader')?.textContent === command);
  assert.ok(row, `No binding of "${command}"`);
  return row;
}

function boundButton(row: HTMLElement): string | undefined {
  return row.querySelector('[data-button]')?.getAttribute('aria-label') ?? undefined;
}

Then('the controller bindings are:', async function (this: RidrsWorld, table: DataTable) {
  await waitFor(() => {
    for (const { command, button } of table.hashes()) {
      assert.equal(
        boundButton(bindingRow(this, command ?? '')),
        button,
        `The button of "${command}"`,
      );
    }
  });
});

Then(
  'the fixed controller buttons are {string}',
  async function (this: RidrsWorld, functions: string) {
    await waitFor(() => {
      const table = within(ui(this)).getAllByRole('table')[1];
      assert.ok(table, 'No table of the fixed buttons');
      const names = within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent);
      assert.deepEqual(names, functions.split(/, (?=[A-Z])/));
    });
  },
);

When('I choose the binding of {string}', async function (this: RidrsWorld, command: string) {
  const row = await waitFor(() => bindingRow(this, command));
  fireEvent.click(within(row).getByRole('button'));
  await this.settle();
});

Then(
  'the binding of {string} waits for a button',
  async function (this: RidrsWorld, command: string) {
    await waitFor(() => {
      const button = within(bindingRow(this, command)).getByRole('button');
      assert.equal(button.getAttribute('aria-pressed'), 'true');
    });
  },
);

Then(
  'the binding of {string} is {string}',
  async function (this: RidrsWorld, command: string, button: string) {
    await waitFor(() => {
      const row = bindingRow(this, command);
      assert.equal(within(row).getByRole('button').getAttribute('aria-pressed'), 'false');
      assert.equal(boundButton(row), button);
    });
  },
);

Then('the settings say {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    assert.equal(within(ui(this)).getByTestId('controller-notice').textContent, text);
  });
});
