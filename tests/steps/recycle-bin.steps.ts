// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

/** The page of the bin (ADR 0096), once it is shown. */
const binPage = (world: RidrsWorld): HTMLElement => {
  const page = ui(world).querySelector<HTMLElement>('[data-bin-page]');
  assert.ok(page, 'The bin is not shown');
  return page;
};

/** The names of what the bin page lists. */
const listed = (world: RidrsWorld): string[] =>
  [...binPage(world).querySelectorAll('[data-bin-item] [data-bin-title]')].map(
    (title) => title.textContent ?? '',
  );

Then('the last entry of the menu is {string}', async function (this: RidrsWorld, name: string) {
  const menu = await within(ui(this)).findByRole('navigation', { name: 'Main' });
  await waitFor(() => {
    const entries = [...menu.querySelectorAll<HTMLElement>('[data-menu-item]')];
    assert.equal(entries.at(-1)?.querySelector('[data-menu-label]')?.textContent, name);
  });
});

/** The rules of every style sheet of the page with `selector`, as one text each. */
const rulesOf = (selector: RegExp): string[] =>
  [...document.querySelectorAll('style')]
    .map((sheet) => sheet.textContent ?? '')
    .flatMap((css) =>
      [...css.matchAll(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, 'g'))].map(
        (rule) => rule[1] ?? '',
      ),
    );

Then('the bin is at the bottom of the menu', async function (this: RidrsWorld) {
  const entry = await waitFor(() => {
    const element = ui(this).querySelector<HTMLElement>('[data-recycle-bin]');
    assert.ok(element, 'The menu has no bin');
    return element;
  });
  assert.ok(entry.closest('.mm-footer'), "The bin is not in the menu's footer");
  assertMenuFillsTheWindow();
  // Without a next ride above it, the footer takes the space left above it.
  assert.ok(
    rulesOf(/\.mm-section:empty \+ \.mm-footer/).some((rule) => /margin-top:\s*auto/.test(rule)),
    'The footer is not pushed to the bottom',
  );
});

/**
 * The headless DOM has no layout: the rules say where the window shows the menu. The main
 * screen's grid gives anything beside the menu and the page no row of its own (an empty overlay
 * slot took the height left on a short page), and the menu fills its place.
 */
export function assertMenuFillsTheWindow(): void {
  assert.ok(
    rulesOf(/\.ms-root/).some((rule) => /grid-auto-rows:\s*0/.test(rule)),
    'Something beside the menu and the page can take a row of the window',
  );
  assert.ok(
    rulesOf(/\.ms-menu > \[data-contribution\]/).some((rule) => /height:\s*100%/.test(rule)),
    'The menu does not fill the height of its place',
  );
  assert.ok(
    rulesOf(/\.mm-nav/).some((rule) => /height:\s*100%/.test(rule)),
    'The menu does not fill its contribution',
  );
}

Then(
  'the next ride and the trash are at the bottom of the menu',
  async function (this: RidrsWorld) {
    const [nextRide, trash] = await waitFor(() => {
      const found = [
        ui(this).querySelector('[data-next-ride]'),
        ui(this).querySelector('[data-recycle-bin]'),
      ];
      assert.ok(found[0] && found[1], 'The menu lacks the next ride or the trash');
      return found as [Element, Element];
    });
    const entries = [...ui(this).querySelectorAll('.mm-list [data-menu-item]')];
    assert.ok(
      entries.every(
        (entry) => entry.compareDocumentPosition(nextRide) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      'The next ride is not below the entries',
    );
    assert.ok(
      nextRide.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING,
      'The trash is not below the next ride',
    );
    assertMenuFillsTheWindow();
    assert.ok(
      rulesOf(/\.mm-section/).some((rule) => /margin-top:\s*auto/.test(rule)),
      'The next ride is not pushed to the bottom',
    );
  },
);

Then('the bin in the menu counts {int} item(s)', async function (this: RidrsWorld, count: number) {
  await waitFor(() => {
    const entry = ui(this).querySelector<HTMLElement>('[data-recycle-bin]');
    assert.ok(entry, 'The menu has no bin');
    assert.equal(entry.dataset.count, String(count));
  });
});

Then('the bin is empty', async function (this: RidrsWorld) {
  await waitFor(() => {
    assert.deepEqual(listed(this), []);
    assert.ok(binPage(this).querySelector('[data-bin-empty]'), 'The bin does not say it is empty');
  });
});

Then('the bin lists {string}', async function (this: RidrsWorld, name: string) {
  await waitFor(() =>
    assert.ok(listed(this).includes(name), `The bin lists ${listed(this).join(', ')}`),
  );
});

Then('the bin asks {string}', async function (this: RidrsWorld, question: string) {
  await waitFor(() =>
    assert.equal(
      within(binPage(this)).getByRole('alertdialog').querySelector('p')?.textContent,
      question,
    ),
  );
});

When('I delete {string} permanently from the bin', async function (this: RidrsWorld, name: string) {
  const page = await waitFor(() => binPage(this));
  fireEvent.click(await within(page).findByRole('button', { name: `Delete permanently: ${name}` }));
  await this.settle();
  const dialog = await within(page).findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
  await this.settle();
});

/** The briefing's own Start, with whatever it has chosen. */
When('I start the ride in the briefing', async function (this: RidrsWorld) {
  const shown = await within(ui(this)).findByTestId('briefing');
  fireEvent.click(await within(shown).findByTestId('briefing-start'));
  await this.settle();
});
