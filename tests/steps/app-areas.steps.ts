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
  'the calendar day {string} shows {string} as done',
  async function (this: RidrsWorld, day: string, ride: string) {
    await waitFor(() =>
      assert.ok(
        [...calendarDay(this, day).querySelectorAll('li[data-done]')].some((li) =>
          li.textContent?.includes(ride),
        ),
      ),
    );
  },
);

Then(
  'the calendar day {string} shows {int} done ride(s)',
  async function (this: RidrsWorld, day: string, count: number) {
    await waitFor(() =>
      assert.equal(calendarDay(this, day).querySelectorAll('li[data-done]').length, count),
    );
  },
);

Then(
  'the calendar day {string} lists no {string}',
  async function (this: RidrsWorld, day: string, entry: string) {
    await waitFor(() => assert.ok(!calendarDay(this, day).textContent?.includes(entry)));
  },
);

Then(
  'the calendar day {string} shows {string} as done as planned',
  async function (this: RidrsWorld, day: string, name: string) {
    await waitFor(() =>
      assert.ok(
        [...calendarDay(this, day).querySelectorAll('li[data-done][data-as-planned]')].some((li) =>
          li.textContent?.includes(name),
        ),
        `No ride "${name}" done as planned on ${day}`,
      ),
    );
  },
);

Then(
  'the calendar day {string} lists {int} planned workout(s)',
  async function (this: RidrsWorld, day: string, count: number) {
    await waitFor(() =>
      assert.equal(
        calendarDay(this, day).querySelectorAll('li[data-state="planned"]').length,
        count,
      ),
    );
  },
);

Then(
  "the calendar's heading {string} links {string}",
  async function (this: RidrsWorld, title: string, link: string) {
    await waitFor(() => {
      const heading = within(shownScreen(this)).getByRole('heading', { name: new RegExp(title) });
      within(heading).getByRole('button', { name: link });
    });
    assert.equal(within(shownScreen(this)).getAllByRole('button', { name: link }).length, 1);
  },
);

/** A day of the large calendar, by its date. */
function calendarDate(world: RidrsWorld, date: string): HTMLElement {
  const element = shownScreen(world).querySelector<HTMLElement>(`[data-calendar-date="${date}"]`);
  assert.ok(element, `No calendar date ${date}`);
  return element;
}

Then(
  'the calendar date {string} lists {string}',
  async function (this: RidrsWorld, date: string, entry: string) {
    await waitFor(() => assert.ok(calendarDate(this, date).textContent?.includes(entry)));
  },
);

Then(
  'the calendar date {string} shows {string} as done',
  async function (this: RidrsWorld, date: string, ride: string) {
    await waitFor(() =>
      assert.ok(
        [...calendarDate(this, date).querySelectorAll('li[data-done]')].some((li) =>
          li.textContent?.includes(ride),
        ),
        `No ride "${ride}" done on ${date}`,
      ),
    );
  },
);

Then('the calendar date {string} is shown', async function (this: RidrsWorld, date: string) {
  await waitFor(() => calendarDate(this, date));
});

Then(
  'the large calendar shows the month {string}',
  async function (this: RidrsWorld, month: string) {
    await waitFor(() =>
      assert.equal(
        shownScreen(this).querySelector('[data-month]')?.getAttribute('data-month'),
        month,
      ),
    );
  },
);

/** Drags `source` onto the calendar day `day`, as the pointer does: start, over, drop, end. */
async function dragOnto(world: RidrsWorld, source: HTMLElement, day: string): Promise<void> {
  const target = calendarDay(world, day);
  fireEvent.dragStart(source);
  await world.settle();
  fireEvent.dragOver(target);
  await world.settle();
  fireEvent.drop(target);
  fireEvent.dragEnd(source);
  await world.settle();
}

/** The element to drag, once the screen has it. */
const draggable = (world: RidrsWorld, selector: string, name: string): Promise<HTMLElement> =>
  waitFor(() => {
    const element = [...shownScreen(world).querySelectorAll<HTMLElement>(selector)].find(
      (candidate) => candidate.textContent?.includes(name),
    );
    assert.ok(element, `Nothing to drag named "${name}"`);
    return element;
  });

When(
  'I drag the workout {string} onto {string}',
  async function (this: RidrsWorld, name: string, day: string) {
    await dragOnto(this, await draggable(this, 'article[draggable="true"]', name), day);
  },
);

When(
  'I drag the planned workout {string} onto {string}',
  async function (this: RidrsWorld, name: string, day: string) {
    await dragOnto(this, await draggable(this, 'li[draggable="true"]', name), day);
  },
);

/** The bin a dragged entry of the calendar is dropped into, while the screen shows it. */
const bin = (world: RidrsWorld): HTMLElement | null =>
  shownScreen(world).querySelector<HTMLElement>('[data-calendar-bin]');

/** The element a drag was started on, ended by `I end the drag`. */
const dragged = new WeakMap<RidrsWorld, HTMLElement>();

async function startDragging(world: RidrsWorld, source: HTMLElement): Promise<void> {
  dragged.set(world, source);
  fireEvent.dragStart(source);
  await world.settle();
}

When(
  'I start dragging the planned workout {string}',
  async function (this: RidrsWorld, name: string) {
    await startDragging(this, await draggable(this, 'li[draggable="true"]', name));
  },
);

When('I start dragging the workout {string}', async function (this: RidrsWorld, name: string) {
  await startDragging(this, await draggable(this, 'article[draggable="true"]', name));
});

When('I end the drag', async function (this: RidrsWorld) {
  const source = dragged.get(this);
  assert.ok(source, 'Nothing is being dragged');
  fireEvent.dragEnd(source);
  await this.settle();
});

When(
  'I drag the planned workout {string} into the bin',
  async function (this: RidrsWorld, name: string) {
    const source = await draggable(this, 'li[draggable="true"]', name);
    await startDragging(this, source);
    const target = await waitFor(() => {
      const element = bin(this);
      assert.ok(element, 'No bin is shown');
      return element;
    });
    fireEvent.dragOver(target);
    await this.settle();
    fireEvent.drop(target);
    fireEvent.dragEnd(source);
    await this.settle();
  },
);

Then('the page shows the bin {string}', async function (this: RidrsWorld, label: string) {
  await waitFor(() => assert.equal(bin(this)?.textContent?.trim(), label));
});

Then('the page shows no bin', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(bin(this), null));
});

Then('the planned workout {string} cannot be dragged', function (this: RidrsWorld, name: string) {
  const entry = [...shownScreen(this).querySelectorAll<HTMLElement>('li.tr-entry')].find((e) =>
    e.textContent?.includes(name),
  );
  assert.ok(entry, `No planned workout "${name}"`);
  assert.notEqual(entry.getAttribute('draggable'), 'true');
});

Then('the Training area has no button {string}', function (this: RidrsWorld, name: string) {
  assert.equal(within(shownScreen(this)).queryByRole('button', { name }), null);
});

Then('the Training area has the button {string}', async function (this: RidrsWorld, name: string) {
  await waitFor(() => within(shownScreen(this)).getByRole('button', { name }));
});

Then('the large calendar is shown', async function (this: RidrsWorld) {
  await waitFor(() => assert.ok(shownScreen(this).querySelector('[data-testid="large-calendar"]')));
});

Then(
  'the calendar shows the week starting {string}',
  async function (this: RidrsWorld, date: string) {
    await waitFor(() =>
      assert.equal(
        shownScreen(this).querySelector('[data-week-start]')?.getAttribute('data-week-start'),
        date,
      ),
    );
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
