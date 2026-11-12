// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/plugins/briefing');

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const briefing = (world: RidrsWorld) => within(ui(world)).getByTestId('briefing');
const plain = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

Given('the briefing fixture routes are installed', function (this: RidrsWorld) {
  this.extraPluginDirs.push(resolve(FIXTURES, 'routes'));
});

Given('the briefing fixture devices are installed', function (this: RidrsWorld) {
  this.extraPluginDirs.push(resolve(FIXTURES, 'devices'));
});

Then('the briefing asks for the {word}', async function (this: RidrsWorld, what: string) {
  await waitFor(() =>
    assert.ok(briefing(this).querySelector(`[data-picker="${what}"]`), `No ${what} to choose`),
  );
});

Then('the briefing does not ask for the {word}', async function (this: RidrsWorld, what: string) {
  await waitFor(() => {
    assert.ok(briefing(this));
    assert.equal(briefing(this).querySelector(`[data-picker="${what}"]`), null);
  });
});

Then(
  'the briefing shows the {word} {string}',
  async function (this: RidrsWorld, what: string, value: string) {
    await waitFor(() =>
      assert.equal(
        plain(within(briefing(this)).getByTestId(`briefing-${what}-chosen`).textContent),
        value,
      ),
    );
  },
);

Then('the briefing marks the {word} as fixed', async function (this: RidrsWorld, what: string) {
  await waitFor(() =>
    assert.equal(
      within(briefing(this)).getByTestId(`briefing-${what}-chosen`).dataset.fixed,
      'true',
    ),
  );
});

Then('the briefing says {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.ok(plain(briefing(this).textContent).includes(text), plain(briefing(this).textContent)),
  );
});

Then('the briefing shows the numbers:', async function (this: RidrsWorld, table: DataTable) {
  await waitFor(() => {
    const list = within(briefing(this)).getByTestId('briefing-summary');
    const pairs = [...list.querySelectorAll('dt')].map((t) => [
      plain(t.textContent),
      plain(t.nextElementSibling?.textContent),
    ]);
    assert.deepEqual(pairs, table.raw());
  });
});

Then('the briefing shows the time per zone:', async function (this: RidrsWorld, table: DataTable) {
  await waitFor(() => {
    const list = within(briefing(this)).getByTestId('briefing-zones');
    const pairs = [...list.querySelectorAll('dt')].map((t) => [
      plain(t.textContent),
      plain(t.nextElementSibling?.textContent),
    ]);
    assert.deepEqual(pairs, table.raw());
  });
});

Then(
  'the briefing shows the {word} as {string}',
  async function (this: RidrsWorld, kind: string, state: string) {
    await waitFor(() =>
      assert.equal(
        within(briefing(this)).getByTestId(`briefing-${kind}`).dataset.connected,
        String(state === 'connected'),
      ),
    );
  },
);

Then(
  'the briefing draws the route profile above the workout chart',
  async function (this: RidrsWorld) {
    await waitFor(() => {
      const route = within(briefing(this)).getByTestId('briefing-route-profile');
      const chart = within(briefing(this)).getByTestId('briefing-workout-chart');
      assert.ok(route.querySelector('svg[role="img"]'), 'No route profile drawn');
      assert.ok(
        chart.querySelector('[role="img"], svg'),
        `No workout chart drawn: ${chart.parentElement?.outerHTML.slice(0, 600)}`,
      );
      assert.ok(
        route.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING,
        'The chart is not below',
      );
    });
  },
);

Then('the start button of the briefing is disabled', async function (this: RidrsWorld) {
  await waitFor(() =>
    assert.ok((within(briefing(this)).getByTestId('briefing-start') as HTMLButtonElement).disabled),
  );
});

/** The ride requests the UI published. */
function requests(world: RidrsWorld) {
  return world.tapped
    .filter((e) => e.type === 'activity.start-requested')
    .map(
      (e) =>
        e.payload as {
          world?: { route?: string };
          workout?: {
            workout: { name: string; steps: unknown[] };
            planned?: { provider: string; id: string };
          };
        },
    );
}

Then('{int} ride(s) was/were requested', async function (this: RidrsWorld, count: number) {
  await waitFor(() => assert.equal(requests(this).length, count));
});

Then(
  'the latest ride request names the route {string}',
  async function (this: RidrsWorld, route: string) {
    await waitFor(() => assert.equal(requests(this).at(-1)?.world?.route, route));
  },
);

Then('the latest ride request names no route', async function (this: RidrsWorld) {
  await waitFor(() => {
    const latest = requests(this).at(-1);
    assert.ok(latest, 'No ride requested');
    assert.equal(latest.world, undefined);
  });
});

Then(
  'the latest ride request carries the workout {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() => assert.equal(requests(this).at(-1)?.workout?.workout.name, name));
  },
);

Then('the latest ride request carries no workout', async function (this: RidrsWorld) {
  await waitFor(() => {
    const latest = requests(this).at(-1);
    assert.ok(latest, 'No ride requested');
    assert.equal(latest.workout, undefined);
  });
});

Then(
  'the latest ride request names the planned entry of {string}',
  async function (this: RidrsWorld, provider: string) {
    await waitFor(() => {
      const planned = requests(this).at(-1)?.workout?.planned;
      assert.equal(planned?.provider, provider);
      assert.ok(planned?.id);
    });
  },
);

Then('the latest ride request names no planned entry', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(requests(this).at(-1)?.workout?.planned, undefined));
});

Then(
  'the latest ride request has a step of {int} W',
  async function (this: RidrsWorld, watts: number) {
    await waitFor(() => {
      const text = JSON.stringify(requests(this).at(-1)?.workout?.workout.steps);
      assert.ok(text.includes(`"unit":"watts","start":{"low":${watts},"high":${watts}}`), text);
    });
  },
);

Then('the two ride requests ask for the same ride', async function (this: RidrsWorld) {
  await waitFor(() => {
    const [first, second] = requests(this);
    assert.ok(first && second);
    assert.deepEqual(second, first);
  });
});

const routeCard = (world: RidrsWorld, title: string) =>
  within(ui(world)).getByRole('button', { name: title }).closest('.pv-teaser') as HTMLElement;

Then(
  'the route card {string} has a profile of its own',
  async function (this: RidrsWorld, title: string) {
    await waitFor(() =>
      assert.ok(
        within(routeCard(this, title)).getByRole('img', { name: `Elevation profile of ${title}` }),
      ),
    );
  },
);

Then('the route card {string} has no profile', async function (this: RidrsWorld, title: string) {
  await waitFor(() => assert.equal(routeCard(this, title).querySelector('svg[role="img"]'), null));
});

/**
 * Every ride starts through the briefing (structured-workouts.md, section 11): from Today's "Start
 * ride" it asks for the route and the workout. A free ride without a workout is what "Start ride"
 * started at once before the briefing.
 */
When('I start a free ride in the briefing', async function (this: RidrsWorld) {
  const shown = await within(ui(this)).findByTestId('briefing');
  for (const choice of ['Free ride', 'No workout']) {
    const option = within(shown).queryByRole('button', { name: choice });
    if (option) {
      fireEvent.click(option);
      await this.settle();
    }
  }
  fireEvent.click(await within(shown).findByRole('button', { name: 'Start' }));
  await this.settle();
});
