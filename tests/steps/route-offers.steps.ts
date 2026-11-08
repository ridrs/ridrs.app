// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then } from '@cucumber/cucumber';
import { activityStartRequestedEvent, type RideWorld } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const section = (world: RidrsWorld, name: string) =>
  within(ui(world)).getByRole('region', { name });

/** The titles of the route cards in a section of the ride page, in their order. */
const routesIn = (world: RidrsWorld, name: string) =>
  within(section(world, name))
    .queryAllByRole('article')
    .map((card) => card.getAttribute('aria-label'));

const card = (world: RidrsWorld, title: string) =>
  within(ui(world)).getByRole('article', { name: title });

/** What a route card says, without the style sheet a card carries. */
function textOf(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const style of copy.querySelectorAll('style')) style.remove();
  return copy.textContent ?? '';
}

Given(
  'ridrs restarted without the plugin {string}',
  async function (this: RidrsWorld, pluginId: string) {
    this.realPluginIds = this.realPluginIds.filter((id) => id !== pluginId);
    await this.disposeHost();
    await this.ensureHost().start();
    await this.settle();
  },
);

Then(
  'the section {string} lists {string}',
  async function (this: RidrsWorld, name: string, title: string) {
    await waitFor(() =>
      assert.ok(routesIn(this, name).includes(title), `Listed: ${routesIn(this, name)}`),
    );
  },
);

Then(
  'the section {string} does not list {string}',
  async function (this: RidrsWorld, name: string, title: string) {
    await waitFor(() =>
      assert.ok(!routesIn(this, name).includes(title), `Listed: ${routesIn(this, name)}`),
    );
  },
);

Then(
  'the section {string} lists {int} routes',
  async function (this: RidrsWorld, name: string, count: number) {
    await waitFor(() => assert.equal(routesIn(this, name).length, count));
  },
);

Then(
  'the route {string} reads {string}',
  async function (this: RidrsWorld, title: string, text: string) {
    await waitFor(() =>
      assert.ok(textOf(card(this, title)).includes(text), textOf(card(this, title))),
    );
  },
);

Then(
  'the route {string} does not read {string}',
  async function (this: RidrsWorld, title: string, text: string) {
    await waitFor(() =>
      assert.ok(!textOf(card(this, title)).includes(text), textOf(card(this, title))),
    );
  },
);

Then(
  'the route {string} shows a picture and an elevation profile',
  async function (this: RidrsWorld, title: string) {
    await waitFor(() => {
      const picture = card(this, title).querySelector('img');
      assert.ok(
        picture?.getAttribute('src')?.endsWith('col-de-pennes/thumbnail.jpg'),
        picture?.getAttribute('src') ?? 'no picture',
      );
      within(card(this, title)).getByRole('img', { name: `Elevation profile of ${title}` });
    });
  },
);

/** The share of a card's height its profile area takes: `.pv-teaser-backdrop` in ui-preview. */
const BACKDROP_SHARE = 0.42;

Then(
  'the profile on the route card {string} rises {float} % of the card',
  async function (this: RidrsWorld, title: string, share: number) {
    await waitFor(() => {
      const profile = within(card(this, title)).getByRole('img', {
        name: `Elevation profile of ${title}`,
      });
      const height = profile.getAttribute('viewBox')?.split(' ').map(Number)[3] ?? 0;
      const ys = (profile.querySelector('polyline')?.getAttribute('points') ?? '')
        .split(' ')
        .map((point) => Number(point.split(',')[1]));
      const rise = ((Math.max(...ys) - Math.min(...ys)) / height) * BACKDROP_SHARE * 100;
      assert.ok(Math.abs(rise - share) < 0.06, `rises ${rise.toFixed(2)} %`);
    });
  },
);

const details = (world: RidrsWorld) =>
  within(ui(world)).getByRole('region', { name: (name) => name.endsWith(' details') });

Then('the route details read {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.ok(details(this).textContent?.includes(text), details(this).textContent ?? ''),
  );
});

Then('the route details offer no {string} button', async function (this: RidrsWorld, name: string) {
  await waitFor(() => assert.equal(within(details(this)).queryByRole('button', { name }), null));
});

Then(
  'the ride was requested in the world {string}',
  function (this: RidrsWorld, landscape: string) {
    const requests = this.tapped
      .filter((envelope) => envelope.type === activityStartRequestedEvent.id)
      .map((envelope) => (envelope.payload as { world?: RideWorld }).world);
    assert.deepEqual(requests.at(-1), { landscape });
  },
);

Then(
  'the route card {string} offers no download',
  async function (this: RidrsWorld, title: string) {
    await waitFor(() =>
      assert.deepEqual(
        within(card(this, title))
          .queryAllByRole('button', { name: (name) => /^(Cancel download|Download) /.test(name) })
          .map((button) => button.getAttribute('aria-label')),
        [],
      ),
    );
  },
);

Then(
  'the route {string} shows the status {string}',
  async function (this: RidrsWorld, title: string, status: string) {
    await waitFor(() => within(card(this, title)).getByRole('img', { name: status }));
  },
);

Then(
  'the route {string} shows no status {string}',
  async function (this: RidrsWorld, title: string, status: string) {
    await waitFor(() =>
      assert.equal(within(card(this, title)).queryByRole('img', { name: status }), null),
    );
  },
);

Then(
  'the route details draw the elevation profile of {string}',
  async function (this: RidrsWorld, title: string) {
    await waitFor(() => {
      // Drawn by the app from the offer's elevations, not a picture file.
      const profile = within(details(this)).getByRole('img', {
        name: `Elevation profile of ${title}`,
      });
      assert.equal(profile.tagName.toLowerCase(), 'svg');
    });
  },
);

Then('the route details list the climb {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    const climbs = within(details(this))
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    assert.ok(
      climbs.some((climb) => climb.includes(text)),
      JSON.stringify(climbs),
    );
  });
});

Then(
  'the route details show the picture {string} across the top',
  async function (this: RidrsWorld, path: string) {
    await waitFor(() => {
      // The hero comes first in the details, before their title and everything else.
      const hero = details(this).firstElementChild;
      assert.ok(hero?.matches('[data-hero]'), hero?.outerHTML.slice(0, 200) ?? 'empty details');
      assert.ok(hero);
      const picture = hero.querySelector('img');
      assert.ok(
        picture?.getAttribute('src')?.endsWith(path),
        picture?.getAttribute('src') ?? 'no picture',
      );
    });
  },
);

/** The profile the route details draw, by its label. */
const detailsProfile = (world: RidrsWorld) =>
  within(details(world)).getByRole('img', {
    name: (name) => name.startsWith('Elevation profile of '),
  });

Then(
  "the route's profile marks a {string} summit {string} at km {float}",
  async function (this: RidrsWorld, category: string, label: string, at: number) {
    await waitFor(() => {
      const summits = [...detailsProfile(this).querySelectorAll('.summit')];
      const texts = summits.map((summit) => summit.textContent?.replace(/\s+/g, ' ').trim());
      assert.ok(
        summits.some(
          (summit) =>
            summit.querySelector('.badge')?.textContent?.trim() === category &&
            summit.textContent?.includes(label) &&
            summit.textContent?.includes(`km ${at.toFixed(1)}`),
        ),
        `Summits: ${JSON.stringify(texts)}`,
      );
    });
  },
);

Then("the route's profile colours each stretch by its gradient", async function (this: RidrsWorld) {
  await waitFor(() => {
    const profile = detailsProfile(this);
    const legend = new Map(
      [...details(this).querySelectorAll('.legend [data-grade]')].map((entry) => [
        entry.getAttribute('data-grade'),
        entry.getAttribute('data-colour'),
      ]),
    );
    const stretches = [...profile.querySelectorAll('.stretch')];
    assert.ok(stretches.length > 10, `${stretches.length} stretches`);
    for (const stretch of stretches) {
      assert.equal(
        stretch.getAttribute('fill'),
        legend.get(stretch.getAttribute('data-grade')),
        stretch.outerHTML,
      );
    }
    const grades = new Set(stretches.map((stretch) => stretch.getAttribute('data-grade')));
    assert.ok(grades.size >= 3, `Grades: ${[...grades]}`);
  });
});
