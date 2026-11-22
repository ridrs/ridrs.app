// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then } from '@cucumber/cucumber';
import type {
  RouteDownload,
  RouteDownloader,
  RouteDownloadOption,
  RouteOffer,
} from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

type Availability = RouteOffer['availability'];

/** What a test downloader was asked for: the route and the quality, in order. */
const asked = new WeakMap<RidrsWorld, { id: string; option?: string }[]>();
/** The routes a source handed the test downloader last. */
const handed = new WeakMap<RidrsWorld, readonly RouteDownload[]>();

/**
 * A downloader of the downloads of `kind` that offers `qualities` (`1080p (recommended)` marks the
 * recommended one) and starts every download without ever finishing it.
 */
function testDownloader(
  world: RidrsWorld,
  qualities: readonly string[],
  kind: string,
): RouteDownloader {
  const options: RouteDownloadOption[] = qualities.map((quality) => {
    const label = quality.replace(/\s*\(recommended\)$/, '');
    return { id: label, label, ...(label === quality ? {} : { recommended: true }) };
  });
  const calls: { id: string; option?: string }[] = [];
  asked.set(world, calls);
  return {
    kinds: [kind],
    open(changed) {
      let routes: readonly RouteDownload[] = [];
      const states = new Map<string, Availability>();
      return {
        async setRoutes(next) {
          routes = next;
          handed.set(world, next);
        },
        availability: (id) =>
          states.get(id) ?? {
            state: 'fetchable',
            size: routes.find((route) => route.id === id)?.size ?? 1,
          },
        pictures: () => ({}),
        refusal: () => undefined,
        options: async () => options,
        async fetch(id, option) {
          calls.push({ id, ...(option ? { option } : {}) });
          states.set(id, {
            state: 'fetching',
            received: 0,
            size: routes.find((route) => route.id === id)?.size ?? 1,
          });
          changed(id);
        },
        cancel: () => undefined,
        remove: async () => undefined,
      };
    },
  };
}

for (const [kinds, kind] of [
  ['ride packages', 'ride-package'],
  ['YouTube videos', 'youtube'],
] as const) {
  Given(
    `a test downloader offers the qualities {string} for ${kinds}`,
    async function (this: RidrsWorld, qualities: string) {
      this.getBehavior('test-downloader').providedImplementations.set(
        'route.downloader',
        testDownloader(this, splitCsv(qualities), kind),
      );
      await this.writeProbePluginFolder({
        folder: 'test-downloader',
        id: 'test-downloader',
        types: ['test'],
        provides: ['route.downloader'],
      });
    },
  );
}

Then(
  'the test downloader was handed the route {string} with the details {string}',
  async function (this: RidrsWorld, id: string, json: string) {
    await this.waitForIo(
      () => (handed.get(this) ?? []).some((route) => route.id === id),
      `the test downloader to be handed "${id}"`,
    );
    const route = handed.get(this)?.find((each) => each.id === id);
    assert.deepEqual(route?.details, JSON.parse(json));
  },
);

Then(
  'the test downloader was asked for the route {string} in {string}',
  async function (this: RidrsWorld, id: string, option: string) {
    await this.waitForIo(
      () => (asked.get(this) ?? []).some((call) => call.id === id && call.option === option),
      `the test downloader to be asked for "${id}" in "${option}"`,
    );
    assert.deepEqual(asked.get(this), [{ id, option }]);
  },
);

Then('the test downloader was asked for no route', async function (this: RidrsWorld) {
  await this.settle();
  assert.deepEqual(asked.get(this), []);
});

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

/** The names of the qualities a choice offers, in order. */
function qualitiesIn(container: HTMLElement): string[] {
  const group = within(container).getByRole('group', { name: (name) => /quality/i.test(name) });
  return within(group)
    .getAllByRole('button')
    .map((button) => button.textContent?.trim() ?? '');
}

Then(
  'the route details offer the qualities {string}',
  async function (this: RidrsWorld, list: string) {
    await waitFor(() => {
      const details = within(ui(this)).getByRole('region', {
        name: (name) => name.endsWith(' details'),
      });
      assert.deepEqual(qualitiesIn(details), splitCsv(list));
    });
  },
);

Then('the briefing offers the qualities {string}', async function (this: RidrsWorld, list: string) {
  await waitFor(() =>
    assert.deepEqual(qualitiesIn(within(ui(this)).getByTestId('briefing')), splitCsv(list)),
  );
});

Then(
  'the route offer {string} is downloading {int} bytes',
  async function (this: RidrsWorld, key: string, size: number) {
    await this.waitForIo(() => {
      const availability = (
        this.ensureHost().getState('route.offer').get(key) as RouteOffer | undefined
      )?.availability;
      return availability?.state === 'fetching' && availability.size === size;
    }, `"${key}" to be downloading ${size} bytes`);
  },
);
