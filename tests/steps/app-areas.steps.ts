// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import {
  type Bicycle,
  equipmentBicycleChangedEvent,
  type LibraryWorkout,
  type PlannedWorkout,
  trainingCalendarState,
  trainingLibraryState,
} from '@ridrs/contracts';
import { createEvent, fireEvent, waitFor, within } from '@testing-library/dom';
import { type DragTransfer, dragTransfer } from '../support/drag-transfer.ts';
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
  'the calendar date {string} lists no {string}',
  async function (this: RidrsWorld, date: string, entry: string) {
    await waitFor(() => assert.ok(!calendarDate(this, date).textContent?.includes(entry)));
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

/** The `dataTransfer` of the drag on its way: every event of one drag gets the same. */
const transfers = new WeakMap<RidrsWorld, DragTransfer>();

type DragEventName = 'dragStart' | 'dragOver' | 'drop' | 'dragEnd';

/** Fires one event of the drag on its way at `element`, with the drag's data; `true` when it was taken. */
function fireDrag(world: RidrsWorld, name: DragEventName, element: HTMLElement): boolean {
  let transfer = transfers.get(world);
  if (!transfer || name === 'dragStart') {
    transfer = dragTransfer();
    transfers.set(world, transfer);
  }
  const event = createEvent[name](element);
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return !fireEvent(element, event);
}

/** Drags `source` onto `target`, as the pointer does: start, over, drop where it was taken, end. */
async function dragOntoElement(
  world: RidrsWorld,
  source: HTMLElement,
  target: () => HTMLElement,
): Promise<void> {
  fireDrag(world, 'dragStart', source);
  await world.settle();
  const over = target();
  const taken = fireDrag(world, 'dragOver', over);
  await world.settle();
  // The web view drops only where the drag over was taken.
  if (taken) fireDrag(world, 'drop', over);
  fireDrag(world, 'dragEnd', source);
  await world.settle();
}

/** Drags `source` onto the calendar day `day`. */
const dragOnto = (world: RidrsWorld, source: HTMLElement, day: string): Promise<void> =>
  dragOntoElement(world, source, () => calendarDay(world, day));

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

/** The bin of the menu (ADR 0096), a drop target while something it takes is dragged. */
const bin = (world: RidrsWorld): HTMLElement => {
  const element = ui(world).querySelector<HTMLElement>('[data-recycle-bin]');
  assert.ok(element, 'The menu has no bin');
  return element;
};

/** The element a drag was started on, ended by `I end the drag`. */
const dragged = new WeakMap<RidrsWorld, HTMLElement>();

async function startDragging(world: RidrsWorld, source: HTMLElement): Promise<void> {
  dragged.set(world, source);
  fireDrag(world, 'dragStart', source);
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
  fireDrag(this, 'dragEnd', source);
  await this.settle();
});

/** Drags `source` into the bin of the menu. */
const dragIntoBin = (world: RidrsWorld, source: HTMLElement): Promise<void> =>
  dragOntoElement(world, source, () => bin(world));

/** A ride done, as the calendar lists it: draggable, but only into the bin. */
const RIDE = 'li[data-done][draggable="true"]';

When(
  'I drag the planned workout {string} into the bin',
  async function (this: RidrsWorld, name: string) {
    await dragIntoBin(this, await draggable(this, 'li[draggable="true"]', name));
  },
);

When('I start dragging the ride {string}', async function (this: RidrsWorld, name: string) {
  await startDragging(this, await draggable(this, RIDE, name));
});

When('I drag the ride {string} into the bin', async function (this: RidrsWorld, name: string) {
  await dragIntoBin(this, await draggable(this, RIDE, name));
});

When(
  'I drag the ride {string} onto {string}',
  async function (this: RidrsWorld, name: string, day: string) {
    await dragOnto(this, await draggable(this, RIDE, name), day);
  },
);

Then('the bin in the menu takes it with {string}', async function (this: RidrsWorld, hint: string) {
  await waitFor(() => {
    const element = bin(this);
    assert.equal(element.dataset.armed, 'true', 'The bin takes nothing');
    assert.equal(element.querySelector('[data-bin-hint]')?.textContent?.trim(), hint);
  });
});

Then('the bin in the menu takes nothing', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(bin(this).dataset.armed, undefined, 'The bin takes a drag'));
});

/** The next ride of the menu (ADR 0096). */
const nextRide = (world: RidrsWorld): HTMLElement => {
  const element = ui(world).querySelector<HTMLElement>('[data-next-ride]');
  assert.ok(element, 'The menu has no next ride');
  return element;
};

/** Drags `source` onto the next ride of the menu. */
const dragOntoNextRide = (world: RidrsWorld, source: HTMLElement): Promise<void> =>
  dragOntoElement(world, source, () => nextRide(world));

When(
  'I drag the workout {string} onto the next ride',
  async function (this: RidrsWorld, name: string) {
    await dragOntoNextRide(this, await draggable(this, 'article[draggable="true"]', name));
  },
);

When(
  'I drag the planned workout {string} onto the next ride',
  async function (this: RidrsWorld, name: string) {
    await dragOntoNextRide(this, await draggable(this, 'li[draggable="true"]', name));
  },
);

When(
  'I drag the route {string} onto the next ride',
  async function (this: RidrsWorld, title: string) {
    await dragOntoNextRide(this, await draggable(this, 'article[draggable="true"]', title));
  },
);

Then(
  'the next ride holds the {word} {string}',
  async function (this: RidrsWorld, slot: string, name: string) {
    await waitFor(() =>
      assert.equal(
        nextRide(this).querySelector(`[data-next-ride-${slot}] [data-next-ride-name]`)?.textContent,
        name,
      ),
    );
  },
);

Then('the next ride holds no {word}', async function (this: RidrsWorld, slot: string) {
  await waitFor(() => {
    const zone = nextRide(this).querySelector(`[data-next-ride-${slot}]`);
    assert.ok(zone, `The next ride has no place for a ${slot}`);
    // A boolean, not the element: a failure must not print the whole headless DOM.
    assert.ok(zone.querySelector('[data-next-ride-name]') === null, `It holds ${zone.textContent}`);
  });
});

Then('the next ride reads {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.ok(nextRide(this).textContent?.includes(text), nextRide(this).textContent ?? ''),
  );
});

When(
  'I drag the {word} of the next ride onto the bin',
  async function (this: RidrsWorld, slot: string) {
    const part = await waitFor(() => {
      const element = nextRide(this).querySelector<HTMLElement>(
        `[data-next-ride-${slot}][draggable="true"]`,
      );
      assert.ok(element, `The next ride has no ${slot} to drag`);
      return element;
    });
    await dragIntoBin(this, part);
  },
);

Then('the next ride cannot be started yet', async function (this: RidrsWorld) {
  await waitFor(() => {
    const start =
      within(nextRide(this)).queryByRole('button', { name: 'Start next ride' }) ?? nextRide(this);
    assert.equal(start.getAttribute('aria-disabled'), 'true', 'The next ride can be started');
  });
});

Then('the menu shows no next ride', async function (this: RidrsWorld) {
  const element = await waitFor(() => nextRide(this));
  await waitFor(() =>
    assert.ok(element.closest('[data-breakpoint="compact"]'), 'The menu is not narrow'),
  );
  // The headless DOM has no layout: the next ride's own rule hides it on the narrow menu.
  const rules = [...document.querySelectorAll('style')]
    .map((sheet) => sheet.textContent ?? '')
    .join('\n');
  assert.match(rules, /\[data-breakpoint="compact"\] \[data-next-ride\]\s*\{[^}]*display:\s*none/);
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

/** The rider's workouts below the calendar: where a planned workout is dropped to keep it as one. */
const workoutsDrop = (world: RidrsWorld): Promise<HTMLElement> =>
  waitFor(() => {
    const element = shownScreen(world).querySelector<HTMLElement>('[data-workouts-drop]');
    assert.ok(element, 'The page shows no workouts to drop onto');
    return element;
  });

/** What the pointer showed over the workouts at the last drag: `none` when the drop was not taken. */
const dropEffects = new WeakMap<RidrsWorld, string>();

/** The handlers set the effect on the very object they are handed (the DOM here has no `DataTransfer`). */
const dataTransfers = new WeakMap<RidrsWorld, { dropEffect: string }>();

function withData(world: RidrsWorld, event: Event): Event {
  let dataTransfer = dataTransfers.get(world);
  if (!dataTransfer) {
    dataTransfer = { dropEffect: 'none' };
    dataTransfers.set(world, dataTransfer);
  }
  Object.defineProperty(event, 'dataTransfer', {
    value: Object.assign(dataTransfer, { effectAllowed: 'all', setData: () => undefined }),
  });
  return event;
}

/** Drags `source` over the workouts and keeps it there: what the pointer shows is kept for the checks. */
async function dragOverWorkouts(world: RidrsWorld, source: HTMLElement): Promise<boolean> {
  const target = await workoutsDrop(world);
  dataTransfers.delete(world);
  await startDragging(world, source);
  // A drag over that nothing takes leaves the default unprevented: the web view refuses the drop.
  const taken = !fireEvent(target, withData(world, createEvent.dragOver(target)));
  const effect = taken ? (dataTransfers.get(world)?.dropEffect ?? 'none') : 'none';
  dropEffects.set(world, effect);
  await world.settle();
  return effect !== 'none';
}

When(
  'I drag the planned workout {string} over the workouts',
  async function (this: RidrsWorld, name: string) {
    await dragOverWorkouts(this, await draggable(this, 'li[draggable="true"]', name));
  },
);

When(
  'I drag the workout {string} over the workouts',
  async function (this: RidrsWorld, name: string) {
    await dragOverWorkouts(this, await draggable(this, 'article[draggable="true"]', name));
  },
);

When(
  'I drag the planned workout {string} onto the workouts',
  async function (this: RidrsWorld, name: string) {
    const source = await draggable(this, 'li[draggable="true"]', name);
    const taken = await dragOverWorkouts(this, source);
    const target = await workoutsDrop(this);
    // The web view drops only where the drag over was taken.
    if (taken) fireEvent(target, withData(this, createEvent.drop(target)));
    fireEvent.dragEnd(source);
    await this.settle();
  },
);

Then('the workouts took the drop as a copy', function (this: RidrsWorld) {
  assert.equal(dropEffects.get(this), 'copy');
});

Then('the workouts refused the drop', function (this: RidrsWorld) {
  assert.equal(dropEffects.get(this), 'none');
});

Then(
  "the workouts to drop onto are the box of the workouts' tiles",
  async function (this: RidrsWorld) {
    const zone = await workoutsDrop(this);
    assert.ok(
      zone.matches('[data-testid="own-workouts"]'),
      'The drop area is not the box of the tiles',
    );
  },
);

Then('the workouts say {string}', async function (this: RidrsWorld, text: string) {
  const zone = await workoutsDrop(this);
  await waitFor(() =>
    assert.equal(zone.querySelector('[data-workouts-drop-hint]')?.textContent?.trim(), text),
  );
});

Then('the workouts say nothing about a drop', async function (this: RidrsWorld) {
  const zone = await workoutsDrop(this);
  await waitFor(() => assert.equal(zone.querySelector('[data-workouts-drop-hint]'), null));
});

/** The names on the tiles of the section "Workouts", the library of ridrs on this device. */
const ownWorkouts = (world: RidrsWorld): string[] =>
  [...shownScreen(world).querySelectorAll('[data-testid="own-workouts"] article h4')].map(
    (title) => title.textContent ?? '',
  );

Then(
  'the section "Workouts" shows the workout {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() =>
      assert.ok(ownWorkouts(this).includes(name), `Workouts: ${ownWorkouts(this).join(', ')}`),
    );
  },
);

Then(
  'the section "Workouts" shows no workout {string}',
  async function (this: RidrsWorld, name: string) {
    await this.settle();
    assert.ok(!ownWorkouts(this).includes(name), `Workouts: ${ownWorkouts(this).join(', ')}`);
  },
);

Then(
  'the ridrs library holds {string} with the steps planned in intervals.icu',
  async function (this: RidrsWorld, name: string) {
    const host = this.ensureHost();
    const planned = (
      host.getState(trainingCalendarState.id).get('intervals.icu') as
        | { data?: { workouts: PlannedWorkout[] } }
        | undefined
    )?.data?.workouts.find((workout) => workout.name === name);
    assert.ok(planned && planned.steps.length > 0, `intervals.icu plans no "${name}" with steps`);
    await waitFor(() => {
      const source = host.getState(trainingLibraryState.id).get('ridrs') as
        | { data?: { workouts: LibraryWorkout[] } }
        | undefined;
      const saved = source?.data?.workouts.find((workout) => workout.name === name);
      assert.ok(saved, `The ridrs library has no workout "${name}"`);
      assert.notEqual(saved.id, planned.id);
      assert.deepEqual(saved.workout?.steps, planned.steps);
    });
  },
);
