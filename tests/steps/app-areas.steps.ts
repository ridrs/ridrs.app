// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { type Bicycle, equipmentBicycleChangedEvent } from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

/** The screen shown: the innermost one, as a screen in the content area sits in the main one. */
function shownScreen(world: RidrsWorld): HTMLElement {
  const screen = [...ui(world).querySelectorAll<HTMLElement>('[data-screen]')].at(-1);
  assert.ok(screen, 'No screen is shown');
  return screen;
}

Then('the screen is marked as a preview', async function (this: RidrsWorld) {
  await waitFor(() => {
    const marker = shownScreen(this).querySelector('[data-preview]');
    assert.equal(marker?.textContent, 'Preview');
  });
});

/** The picture across the top of the shown screen: the first thing in its page. */
function heroOf(world: RidrsWorld): HTMLElement {
  const page = shownScreen(world).querySelector('.pv-page');
  const hero = [...(page?.children ?? [])].find((child) => child.tagName !== 'STYLE');
  assert.ok(hero?.matches('[data-hero]'), hero?.outerHTML.slice(0, 200) ?? 'empty page');
  return hero as HTMLElement;
}

Then(
  'the screen shows the picture {string} across the top',
  async function (this: RidrsWorld, path: string) {
    await waitFor(() => {
      const picture = heroOf(this).querySelector('img');
      assert.ok(
        picture?.getAttribute('src')?.endsWith(path),
        picture?.getAttribute('src') ?? 'no picture',
      );
    });
  },
);

Then(
  'the screen shows the heading {string} over the picture',
  async function (this: RidrsWorld, text: string) {
    await waitFor(() =>
      assert.equal(within(heroOf(this)).getByRole('heading', { level: 1 }).textContent, text),
    );
  },
);

Then("the picture's credits read {string}", async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.equal(heroOf(this).querySelector('[data-credits]')?.textContent, text),
  );
});

Then(
  'the top bar offers {string} in this order',
  async function (this: RidrsWorld, actionsCsv: string) {
    const actions = await within(ui(this)).findByTestId('slot-main-action');
    await waitFor(() => {
      assert.equal(actions.closest('[hidden]'), null, 'The global actions are hidden');
      assert.deepEqual(
        within(actions)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        splitCsv(actionsCsv),
      );
    });
  },
);

Then('the screen shows the heading {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    const headings = within(shownScreen(this))
      .getAllByRole('heading', { level: 1 })
      .map((heading) => heading.textContent);
    assert.ok(headings.includes(text), `Headings: ${headings.join(', ')}`);
  });
});

Then('the button {string} is on', async function (this: RidrsWorld, name: string) {
  await waitFor(() =>
    assert.equal(
      within(ui(this)).getByRole('button', { name }).getAttribute('aria-pressed'),
      'true',
    ),
  );
});

Then('the button {string} is off', async function (this: RidrsWorld, name: string) {
  await waitFor(() =>
    assert.equal(
      within(ui(this)).getByRole('button', { name }).getAttribute('aria-pressed'),
      'false',
    ),
  );
});

Then('the user settings hold the file {string}', function (this: RidrsWorld, path: string) {
  assert.ok(this.settingsFiles.files.has(path), `Files: ${[...this.settingsFiles.files.keys()]}`);
});

Then(
  'the tile {string} names {string}',
  async function (this: RidrsWorld, tile: string, text: string) {
    await waitFor(() => {
      const cell = ui(this).querySelector<HTMLElement>(`[data-tile="${tile}"]`);
      assert.ok(cell, `No cell for "${tile}"`);
      assert.equal(cell.hidden, false, `"${tile}" is hidden`);
      assert.ok(cell.textContent?.includes(text), `"${tile}" reads "${cell.textContent}"`);
    });
  },
);

function calendarDay(world: RidrsWorld, day: string): HTMLElement {
  const element = shownScreen(world).querySelector<HTMLElement>(`[data-calendar-day="${day}"]`);
  assert.ok(element, `No calendar day ${day}`);
  return element;
}

Then(
  'the calendar day {string} lists {string}',
  async function (this: RidrsWorld, day: string, entry: string) {
    await waitFor(() => assert.ok(calendarDay(this, day).textContent?.includes(entry)));
  },
);

Then(
  'the calendar day {string} lists no {string}',
  async function (this: RidrsWorld, day: string, entry: string) {
    await waitFor(() => assert.ok(!calendarDay(this, day).textContent?.includes(entry)));
  },
);

Then('the FTP reads {string}', async function (this: RidrsWorld, value: string) {
  await waitFor(() =>
    assert.equal(within(shownScreen(this)).getByTestId('ftp').textContent, value),
  );
});

When(
  'I type {string} into {string}',
  async function (this: RidrsWorld, text: string, name: string) {
    const field = await within(ui(this)).findByRole('searchbox', { name });
    fireEvent.change(field, { target: { value: text } });
    await this.settle();
  },
);

Then('the search finds {string}', async function (this: RidrsWorld, namesCsv: string) {
  const results = await within(ui(this)).findByTestId('search-results');
  await waitFor(() =>
    assert.deepEqual(
      within(results)
        .queryAllByRole('button')
        .map((result) => result.getAttribute('aria-label')),
      splitCsv(namesCsv),
    ),
  );
});

Then(
  'the page shows the section {string} and no section {string}',
  async function (this: RidrsWorld, shown: string, absent: string) {
    await waitFor(() => {
      const headings = within(shownScreen(this))
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);
      assert.ok(headings.includes(shown), `Sections: ${headings.join(', ')}`);
      assert.ok(!headings.includes(absent), `Sections: ${headings.join(', ')}`);
    });
  },
);

Then('the screen is not marked as a preview', async function (this: RidrsWorld) {
  await waitFor(() => assert.ok(shownScreen(this).childElementCount > 0));
  assert.equal(shownScreen(this).querySelector('[data-preview]'), null);
});

Then('the garage shows the weight {string}', async function (this: RidrsWorld, weight: string) {
  await waitFor(() =>
    assert.equal(
      within(shownScreen(this)).getByRole('status', { name: 'Weight' }).textContent,
      weight,
    ),
  );
});

Then('the start card says {string}', async function (this: RidrsWorld, text: string) {
  const riding = await within(ui(this)).findByTestId('riding');
  await waitFor(() => assert.equal(riding.textContent, text));
});

Then(
  'the latest bicycle handed to the next ride weighs {float} kg in {string} mode',
  async function (this: RidrsWorld, mass: number, mode: string) {
    await waitFor(() => {
      const bicycle = this.tapped
        .filter((e) => e.type === equipmentBicycleChangedEvent.id)
        .map((e) => e.payload as Bicycle)
        .at(-1);
      assert.ok(bicycle, 'Expected an "equipment.bicycle-changed" event');
      assert.equal(bicycle.mass, mass);
      assert.equal(bicycle.drivetrain.shifting.mode, mode);
    });
  },
);
