// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { fireEvent, waitFor, within } from '@testing-library/dom';
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

When(
  'I press the chip {string} of the row {string}',
  async function (this: RidrsWorld, chip: string, name: string) {
    const button = await waitFor(() => within(row(this, name)).getByRole('button', { name: chip }));
    fireEvent.click(button);
    await this.settle();
  },
);

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
  'the row {string} lists {string}',
  async function (this: RidrsWorld, name: string, providersCsv: string) {
    await waitFor(() =>
      assert.deepEqual(
        splitCsv(within(row(this, name)).getByTestId('library-providers').textContent ?? ''),
        splitCsv(providersCsv),
      ),
    );
  },
);

/** The library section of the Training area: a block per provider. */
function libraryOf(world: RidrsWorld, provider: string): HTMLElement | null {
  return shownScreen(world).querySelector<HTMLElement>(
    `[data-testid="library"] [data-provider="${provider}"]`,
  );
}

Then(
  'the library lists the workout {string} of {string}',
  async function (this: RidrsWorld, name: string, provider: string) {
    await waitFor(() => {
      const block = libraryOf(this, provider);
      assert.ok(block, `The library shows nothing of ${provider}`);
      const names = [...block.querySelectorAll('article h4')].map((card) => card.textContent);
      assert.ok(names.includes(name), `The library of ${provider} lists ${names.join(', ')}`);
    });
  },
);

Then(
  'the library lists these workouts of {string}:',
  async function (this: RidrsWorld, provider: string, table: DataTable) {
    await waitFor(() => {
      const block = libraryOf(this, provider);
      assert.ok(block, `The library shows nothing of ${provider}`);
      const listed = [...block.querySelectorAll('article')].map((card) => ({
        name: card.querySelector('h4')?.textContent ?? '',
        details: card.querySelector('span')?.textContent ?? '',
      }));
      assert.deepEqual(listed, table.hashes());
    });
  },
);

Then(
  'the library lists no workouts of {string}',
  async function (this: RidrsWorld, provider: string) {
    // The library is there: its heading names the section.
    await within(shownScreen(this)).findByRole('heading', {
      level: 2,
      name: /library|Bibliothek/i,
    });
    await waitFor(() => assert.equal(libraryOf(this, provider), null));
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

Then(
  'the Training area offers the button {string}',
  async function (this: RidrsWorld, name: string) {
    await within(shownScreen(this)).findByRole('button', { name });
  },
);

Then('the button {string} is enabled', async function (this: RidrsWorld, name: string) {
  await waitFor(() =>
    assert.equal(
      (within(shownScreen(this)).getByRole('button', { name }) as HTMLButtonElement).disabled,
      false,
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
