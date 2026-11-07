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
