// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/plugins/workout-chart-consumer');

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const text = (element: Element | null | undefined) =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

// ---- The chart on its own (the fixture consumer draws the `full` variant) ----------------------

Given(
  'the ridrs plugins {string} together with the workout chart fixture',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(
      this,
      pluginsCsv.split(',').map((id) => id.trim()),
    );
    this.extraPluginDirs.push(FIXTURE);
  },
);

const chart = (world: RidrsWorld): HTMLElement | null =>
  ui(world).querySelector<HTMLElement>('[data-testid="workout-chart"]');

async function shownChart(world: RidrsWorld): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = chart(world);
    assert.ok(found, 'The workout chart is not drawn');
  });
  return found as unknown as HTMLElement;
}

const steps = (world: RidrsWorld): HTMLElement[] => [
  ...ui(world).querySelectorAll<HTMLElement>('[data-testid="workout-chart-step"]'),
];

Then('the workout chart draws {int} steps', async function (this: RidrsWorld, count: number) {
  await shownChart(this);
  await waitFor(() => assert.equal(steps(this).length, count));
});

Then(
  'the workout chart has the bracket {string}',
  async function (this: RidrsWorld, label: string) {
    const drawn = await shownChart(this);
    assert.ok(
      [...drawn.querySelectorAll('[data-testid="workout-chart-bracket"]')].some(
        (each) => text(each) === label,
      ),
      `No bracket "${label}"`,
    );
  },
);

Then('the workout chart has a zone bar and an FTP line', async function (this: RidrsWorld) {
  const drawn = await shownChart(this);
  assert.ok(drawn.querySelector('[data-testid="workout-chart-zone-bar"]'));
  assert.ok(drawn.querySelector('[data-testid="workout-chart-ftp-line"]'));
});

When('the focus is put on the first step of the workout chart', async function (this: RidrsWorld) {
  await shownChart(this);
  const first = steps(this)[0];
  assert.ok(first, 'The chart has no steps');
  first.focus();
  await this.settle();
  assert.equal(document.activeElement, first, 'The first step did not take the focus');
});

When(
  'I press the arrow key {string} {int} times in the workout chart',
  async function (this: RidrsWorld, direction: string, times: number) {
    for (let i = 0; i < times; i++) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: `Arrow${direction}` });
      await this.settle();
    }
  },
);

When(
  'the pointer is over step {int} of the workout chart',
  async function (this: RidrsWorld, number: number) {
    await shownChart(this);
    const step = steps(this)[number - 1];
    assert.ok(step, `The chart has no step ${number}`);
    fireEvent.mouseOver(step);
    await this.settle();
  },
);

Then('the workout chart tooltip shows:', async function (this: RidrsWorld, table: DataTable) {
  for (const [field, expected] of table.raw()) {
    await waitFor(() => {
      const tooltip = ui(this).querySelector('[data-testid="workout-chart-tooltip"]');
      assert.ok(tooltip, 'No tooltip is shown');
      const value =
        field === 'title'
          ? tooltip.querySelector('b')
          : tooltip.querySelector(`[data-field="${field}"]`);
      assert.equal(text(value), expected);
    });
  }
});

Then('the consumer says {string}', async function (this: RidrsWorld, expected: string) {
  await waitFor(() => assert.equal(text(within(ui(this)).getByTestId('chart-focused')), expected));
});

Then(
  'Enter and Back pressed on the focused step reach the app unhandled',
  function (this: RidrsWorld) {
    const seen: Record<string, boolean> = {};
    const listen = (event: Event) => {
      seen[(event as KeyboardEvent).key] = !event.defaultPrevented;
    };
    document.addEventListener('keydown', listen, true);
    const step = document.activeElement ?? document.body;
    for (const key of ['Enter', 'Escape']) {
      // The capture listener sees the key before any handler: the chart had no say yet.
      fireEvent.keyDown(step, { key });
    }
    document.removeEventListener('keydown', listen, true);
    assert.deepEqual(seen, { Enter: true, Escape: true });
  },
);

Then('the workout chart is neutral', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(chart(this)?.dataset.zoned, 'false'));
  assert.ok(!(chart(this)?.innerHTML ?? '').includes('--wc-z'), 'A zone colour is drawn');
});

Then('the workout chart is coloured by zone', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(chart(this)?.dataset.zoned, 'true'));
  assert.ok((chart(this)?.innerHTML ?? '').includes('--wc-z'));
});

Then('the workout chart hint says {string}', async function (this: RidrsWorld, hint: string) {
  await waitFor(() =>
    assert.equal(text(chart(this)?.querySelector('[data-testid="workout-chart-hint"]')), hint),
  );
});

Then('the workout chart has no hint', async function (this: RidrsWorld) {
  await waitFor(() =>
    assert.equal(chart(this)?.querySelector('[data-testid="workout-chart-hint"]'), null),
  );
});

Then('the workout chart has no zone bar', async function (this: RidrsWorld) {
  await waitFor(() =>
    assert.equal(chart(this)?.querySelector('[data-testid="workout-chart-zone-bar"]'), null),
  );
});

Then(
  'the workout chart is described as {string}',
  async function (this: RidrsWorld, description: string) {
    await waitFor(() =>
      assert.equal(chart(this)?.querySelector('svg')?.getAttribute('aria-label'), description),
    );
  },
);

Then(
  'the consumer shows the fallback {string}',
  async function (this: RidrsWorld, fallback: string) {
    await waitFor(() => {
      const shown = within(ui(this)).getByTestId('chart-fallback');
      assert.equal(shown.hidden, false);
      assert.equal(text(shown), fallback);
    });
  },
);

Then('the workout chart is not drawn', async function (this: RidrsWorld) {
  await this.settle();
  assert.equal(chart(this), null);
});

// ---- The charts in the Training area ----------------------------------------------------------

/** The cards of the workout library of the other providers (those of this device are "Workouts"). */
function card(world: RidrsWorld, name: string): HTMLElement | undefined {
  return [
    ...ui(world).querySelectorAll<HTMLElement>(
      '[data-testid="library"] article[data-library-workout]',
    ),
  ].find((each) => text(each.querySelector('h4')) === name);
}

async function shownCard(world: RidrsWorld, name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = card(world, name);
    assert.ok(found, `No library card "${name}"`);
  });
  return found as unknown as HTMLElement;
}

Then(
  'the library card {string} shows a mini chart saying {string}',
  async function (this: RidrsWorld, name: string, facts: string) {
    const found = await shownCard(this, name);
    await waitFor(() => {
      const mini = found.querySelector('[data-testid="workout-chart"][data-variant="mini"]');
      assert.ok(mini, 'No mini chart');
      assert.equal(text(mini.querySelector('[data-testid="workout-chart-facts"]')), facts);
    });
  },
);

Then(
  'the mini chart of {string} is described as {string}',
  async function (this: RidrsWorld, name: string, description: string) {
    const found = await shownCard(this, name);
    await waitFor(() =>
      assert.equal(
        found.querySelector('[data-testid="workout-chart"] svg')?.getAttribute('aria-label'),
        description,
      ),
    );
  },
);

Then(
  'the library card {string} shows the facts {string}',
  async function (this: RidrsWorld, name: string, facts: string) {
    const found = await shownCard(this, name);
    await waitFor(() => assert.equal(text(found.querySelector('span')), facts));
  },
);

Then('the library card {string} shows no chart', async function (this: RidrsWorld, name: string) {
  const found = await shownCard(this, name);
  await this.settle();
  await waitFor(() => assert.equal(found.querySelector('[data-testid="workout-chart"]'), null));
});

Then(
  'the calendar day {string} shows a micro chart for {string}',
  async function (this: RidrsWorld, day: string, name: string) {
    await waitFor(() => {
      const entry = [
        ...ui(this).querySelectorAll<HTMLElement>(`[data-calendar-day="${day}"] li.tr-entry`),
      ].find((each) => text(each.querySelector('.tw-entry-name')) === name);
      assert.ok(entry, `The day lists no "${name}"`);
      assert.ok(
        entry.querySelector('[data-testid="workout-chart"][data-variant="micro"]'),
        'No micro chart',
      );
    });
  },
);

Then('the catalogue shows exactly {string}', async function (this: RidrsWorld, names: string) {
  const expected = names.split(',').map((name) => name.trim());
  await waitFor(() =>
    assert.deepEqual(
      [
        ...ui(this).querySelectorAll('[data-testid="library"] article[data-library-workout] h4'),
      ].map(text),
      expected,
    ),
  );
});

// ---- The chart on the Today tile ---------------------------------------------------------------

async function tileChart(world: RidrsWorld): Promise<HTMLElement> {
  return within(ui(world)).findByTestId('next-workout-chart');
}

Then(
  'the next workout card shows a workout chart of {int} steps',
  async function (this: RidrsWorld, count: number) {
    const drawn = await tileChart(this);
    await waitFor(() =>
      assert.equal(
        drawn.querySelectorAll('[data-testid="workout-chart"][data-variant="mini"] g[data-shape]')
          .length,
        count,
      ),
    );
  },
);

Then(
  'the next workout card shows a workout chart saying {string}',
  async function (this: RidrsWorld, facts: string) {
    const drawn = await tileChart(this);
    await waitFor(() =>
      assert.equal(text(drawn.querySelector('[data-testid="workout-chart-facts"]')), facts),
    );
  },
);

Then('the next workout card shows no workout chart', async function (this: RidrsWorld) {
  await within(ui(this)).findByTestId('next-workout');
  await this.settle();
  await waitFor(() => assert.equal(ui(this).querySelector('[data-testid="workout-chart"]'), null));
});

// ---- One focus stop ---------------------------------------------------------------------------

Then(
  'exactly {int} step of the workout chart is tabbable',
  async function (this: RidrsWorld, count: number) {
    await shownChart(this);
    assert.equal(steps(this).filter((each) => each.getAttribute('tabindex') === '0').length, count);
  },
);

Then(
  'the tabbable step of the workout chart is step {int}',
  function (this: RidrsWorld, number: number) {
    assert.equal(
      steps(this).findIndex((each) => each.getAttribute('tabindex') === '0'),
      number - 1,
    );
  },
);

Then('Down leaves the workout chart for the next control', async function (this: RidrsWorld) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' });
  await this.settle();
  const focused = document.activeElement;
  assert.ok(focused && !steps(this).includes(focused as HTMLElement), 'The focus stayed on a step');
  assert.ok(ui(this).contains(focused), 'The focus left the UI');
});
