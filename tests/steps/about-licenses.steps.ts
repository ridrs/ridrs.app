// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Then, When } from '@cucumber/cucumber';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { parseNotice } from '../../scripts/licenses.ts';
import { untilQuiet } from '../support/dom-quiet.ts';
import type { RidrsWorld } from '../support/world.ts';

const ROOT = join(import.meta.dirname, '../..');

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

function entryButtons(world: RidrsWorld): HTMLElement[] {
  return [...shownScreen(world).querySelectorAll<HTMLElement>('[data-license-entry]')];
}

async function entry(world: RidrsWorld, name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = entryButtons(world).find((button) => button.dataset.licenseEntry === name);
    assert.ok(found, `No license entry "${name}"`);
  });
  return found as HTMLElement;
}

Then('the screen shows the section {string}', async function (this: RidrsWorld, name: string) {
  await waitFor(() => {
    const sections = within(shownScreen(this))
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    assert.ok(sections.includes(name), `Sections: ${sections.join(', ')}`);
  });
});

Then('the screen shows the text {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => assert.ok(shownScreen(this).textContent?.includes(text)));
});

Then('the screen shows the app version', async function (this: RidrsWorld) {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  await waitFor(() => assert.ok(shownScreen(this).textContent?.includes(version)));
});

Then(
  'the screen links {string} to {string}',
  async function (this: RidrsWorld, name: string, href: string) {
    await waitFor(() =>
      assert.equal(
        within(shownScreen(this)).getByRole('link', { name }).getAttribute('href'),
        href,
      ),
    );
  },
);

When('I press the license entry {string}', async function (this: RidrsWorld, name: string) {
  fireEvent.click(await entry(this, name));
  await this.settle();
});

/** The arrows alone, as `I move the focus to` has them, for an entry named by its data. */
When(
  'I move the focus to the license entry {string}',
  async function (this: RidrsWorld, name: string) {
    const target = await entry(this, name);
    for (let step = 0; step < 400 && document.activeElement !== target; step += 1) {
      await untilQuiet(ui(this));
      const focused = document.activeElement;
      const before =
        focused &&
        focused !== document.body &&
        focused.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING;
      fireEvent.keyDown(focused ?? document.body, { key: before ? 'ArrowLeft' : 'ArrowRight' });
      await this.settle();
    }
    assert.ok(document.activeElement === target, `The arrows never reached the entry "${name}"`);
  },
);

Then(
  'the licenses list every entry of the NOTICE file with its version, license and purpose',
  async function (this: RidrsWorld) {
    const rows = parseNotice(readFileSync(join(ROOT, 'NOTICE'), 'utf8')).filter(
      (row) => row.kind === 'dependency',
    );
    assert.ok(rows.length > 40, `Only ${rows.length} rows in NOTICE`);
    await waitFor(() => {
      const shown = new Map(entryButtons(this).map((b) => [b.dataset.licenseEntry, b.textContent]));
      for (const row of rows) {
        const text = shown.get(row.name);
        assert.ok(text !== undefined, `Not listed: ${row.name}`);
        assert.ok(
          text.includes(row.version),
          `${row.name}: no version ${row.version} in "${text}"`,
        );
        assert.ok(
          text.includes(row.license),
          `${row.name}: no license ${row.license} in "${text}"`,
        );
        assert.ok(text.includes(row.purpose.slice(0, 20)), `${row.name}: no purpose in "${text}"`);
      }
    });
  },
);

Then('the license text contains {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    const shown = shownScreen(this).querySelector('[data-license-text]');
    assert.ok(shown, 'No license text is shown');
    assert.ok(
      shown.textContent?.includes(text),
      `The text reads "${shown.textContent?.slice(0, 200)}"`,
    );
  });
});

Then('every license entry has a license text', async function (this: RidrsWorld) {
  await waitFor(() => assert.ok(entryButtons(this).length > 40));
  const names = entryButtons(this).map((button) => button.dataset.licenseEntry as string);
  for (const name of names) {
    fireEvent.click(await entry(this, name));
    await this.settle();
    await waitFor(() => {
      const shown = shownScreen(this).querySelector('[data-license-text]');
      assert.ok(shown?.textContent?.trim(), `No license text for ${name}`);
    });
    await untilQuiet(ui(this));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await this.settle();
    await waitFor(() =>
      assert.ok(entryButtons(this).length > 40, 'Back did not return to the list'),
    );
  }
});

Then(
  'the credits name {string} and the license {string}',
  async function (this: RidrsWorld, author: string, license: string) {
    await waitFor(() => {
      const credits = shownScreen(this).querySelector('[data-credits]');
      assert.ok(credits, 'No credits');
      assert.ok(credits.textContent?.includes(author));
      assert.ok(credits.textContent?.includes(license));
    });
  },
);
