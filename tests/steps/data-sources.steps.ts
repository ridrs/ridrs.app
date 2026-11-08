// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then } from '@cucumber/cucumber';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

const DATA_SOURCE_PLUGINS = resolve(import.meta.dirname, '../fixtures/plugins/data-source');
const ME_PREVIEW_PATH = 'config/user/ui-area-me/preview.json';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

/** The innermost screen shown, as a screen in a dialog or in the content area sits in another. */
function shownScreen(world: RidrsWorld): HTMLElement {
  const screen = [...ui(world).querySelectorAll<HTMLElement>('[data-screen]')].at(-1);
  assert.ok(screen, 'No screen is shown');
  return screen;
}

/** A row of the settings page: a group named like the data type. */
function row(world: RidrsWorld, name: string): HTMLElement {
  return within(shownScreen(world)).getByRole('group', { name });
}

Given('the test data source plugin is removed', function (this: RidrsWorld) {
  this.extraPluginDirs = this.extraPluginDirs.filter((dir) => dir !== DATA_SOURCE_PLUGINS);
});

Then('the page shows the section {string}', async function (this: RidrsWorld, section: string) {
  await waitFor(() => {
    const headings = within(shownScreen(this))
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    assert.ok(headings.includes(section), `Sections: ${headings.join(', ')}`);
  });
});

Then('the page says {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.ok(
      shownScreen(this).textContent?.includes(text),
      `The page reads "${shownScreen(this).textContent}"`,
    ),
  );
});

Then(
  'the row {string} offers {string}',
  async function (this: RidrsWorld, name: string, providersCsv: string) {
    await waitFor(() =>
      assert.deepEqual(
        within(row(this, name))
          .getAllByRole('button')
          .map((button) => button.textContent),
        splitCsv(providersCsv),
      ),
    );
  },
);

Then(
  'the row {string} has {string} chosen',
  async function (this: RidrsWorld, name: string, provider: string) {
    await waitFor(() =>
      assert.deepEqual(
        within(row(this, name))
          .getAllByRole('button', { pressed: true })
          .map((button) => button.textContent),
        [provider],
      ),
    );
  },
);

Then(
  'the row {string} shows the status {string}',
  async function (this: RidrsWorld, name: string, status: string) {
    await waitFor(() =>
      assert.equal(within(row(this, name)).getByRole('status').textContent, status),
    );
  },
);

Then(
  'the row {string} shows a status starting with {string}',
  async function (this: RidrsWorld, name: string, start: string) {
    await waitFor(() => {
      const status = within(row(this, name)).getByRole('status').textContent ?? '';
      assert.ok(status.startsWith(start), `The status reads "${status}"`);
    });
  },
);

Then('the start card notes {string}', async function (this: RidrsWorld, text: string) {
  const note = await within(ui(this)).findByTestId('athlete-note');
  await waitFor(() => assert.equal(note.textContent, text));
});

Then('the start card notes nothing', async function (this: RidrsWorld) {
  // The card is there: it names the first thing every start has.
  await within(ui(this)).findByTestId('start-ride');
  // `ok`, not `equal`: a diff against the element found would print the whole page.
  await waitFor(() =>
    assert.ok(within(ui(this)).queryByTestId('athlete-note') === null, 'The card notes a problem'),
  );
});

Then('the weight reads {string}', async function (this: RidrsWorld, value: string) {
  await waitFor(() =>
    assert.equal(within(shownScreen(this)).getByTestId('weight').textContent, value),
  );
});

Then('the button {string} is disabled', async function (this: RidrsWorld, name: string) {
  await waitFor(() =>
    assert.equal(
      (within(shownScreen(this)).getByRole('button', { name }) as HTMLButtonElement).disabled,
      true,
    ),
  );
});

Given(
  'the Me area kept an FTP of {int} W and a weight of {float} kg before the athlete profile existed',
  async function (this: RidrsWorld, ftp: number, weight: number) {
    const value = { ftp, weight, weeklyHours: 5, showOnToday: true };
    const text = `${JSON.stringify({ version: 1, value })}\n`;
    await this.settingsFiles.write(ME_PREVIEW_PATH, new TextEncoder().encode(text));
  },
);

Then(
  'the Me area keeps no FTP and no weight of its own any more',
  async function (this: RidrsWorld) {
    await waitFor(() => {
      const file = this.settingsFiles.files.get(ME_PREVIEW_PATH);
      assert.ok(file, 'The Me area keeps no preview document');
      const { value } = JSON.parse(new TextDecoder().decode(file)) as {
        value: Record<string, unknown>;
      };
      assert.deepEqual(Object.keys(value).sort(), ['showOnToday', 'weeklyHours']);
    });
  },
);
