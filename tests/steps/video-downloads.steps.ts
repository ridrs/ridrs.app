// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { activityStartRequestedEvent, type RideWorld } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import { SimulatedDownloads } from '../support/simulated-downloads.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv, useRealPlugins } from './devices-and-metrics.steps.ts';

/** Where `storage-media-node` keeps the media (`docs/ideas/video-sources.md`). */
const MEDIA_DIR_ENV = 'RIDRS_MEDIA_DIR';

const simulations = new WeakMap<RidrsWorld, SimulatedDownloads>();

function downloads(world: RidrsWorld): SimulatedDownloads {
  const simulation = simulations.get(world);
  assert.ok(simulation, 'Expected the simulated downloads');
  return simulation;
}

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const details = (world: RidrsWorld) =>
  within(ui(world)).getByRole('region', { name: (name) => name.endsWith(' details') });

/** Every file below `directory`, relative to it. */
function filesBelow(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
}

const routeFolder = (id: string) =>
  join(process.env[MEDIA_DIR_ENV] ?? '', 'videos', ...id.split('/'));

Given(
  'the ridrs plugins {string} together with the simulated downloads',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    const media = mkdtempSync(join(tmpdir(), 'ridrs-media-'));
    process.env[MEDIA_DIR_ENV] = media;
    const simulation = new SimulatedDownloads(media);
    simulations.set(this, simulation);
    this.getBehavior('simulated-downloads').providedImplementations.set(
      'data.fetch',
      simulation.fetch,
    );
    await this.writeProbePluginFolder({
      folder: 'simulated-downloads',
      id: 'simulated-downloads',
      types: ['test'],
      provides: ['data.fetch'],
    });
    this.useMemoryStorage();
  },
);

Given('the simulated downloads stop halfway', function (this: RidrsWorld) {
  downloads(this).stopHalfway = true;
});

Given('the simulated downloads fail with {string}', function (this: RidrsWorld, reason: string) {
  downloads(this).failure = reason;
});

Given('the simulated downloads work again', function (this: RidrsWorld) {
  downloads(this).failure = undefined;
});

When('the simulated download goes on', async function (this: RidrsWorld) {
  downloads(this).goOn();
  await this.settle();
});

Then('the route details offer a {string} button', async function (this: RidrsWorld, name: string) {
  await waitFor(() => within(details(this)).getByRole('button', { name }), { timeout: 5000 });
});

Then(
  'the media storage holds the route {string} titled {string}',
  function (this: RidrsWorld, id: string, title: string) {
    const folder = routeFolder(id);
    const route = JSON.parse(readFileSync(join(folder, 'route.json'), 'utf8'));
    assert.equal(route.title, title);
    assert.deepEqual(filesBelow(folder).sort(), ['route.json', 'track.gpx', 'video.mp4']);
  },
);

Then('the media storage holds no downloaded package', function (this: RidrsWorld) {
  const leftovers = filesBelow(process.env[MEDIA_DIR_ENV] ?? '').filter((file) =>
    /\.(zip|part)$/.test(file),
  );
  assert.deepEqual(leftovers, []);
});

Then('the media storage holds no route {string}', async function (this: RidrsWorld, id: string) {
  // Without a DOM too (headless scenarios): the media folder is real I/O.
  await this.waitForIo(() => !existsSync(routeFolder(id)), `no route "${id}"`);
});

Then(
  'the ride was requested in the world {string} on the route {string}',
  function (this: RidrsWorld, landscape: string, route: string) {
    const requests = this.tapped
      .filter((envelope) => envelope.type === activityStartRequestedEvent.id)
      .map((envelope) => (envelope.payload as { world?: RideWorld }).world);
    assert.deepEqual(requests.at(-1), { landscape, route });
  },
);

Then(
  /^after the start only "([^"]*)" of the "([^"]*)" state changed, in at least (\d+) steps$/,
  function (this: RidrsWorld, key: string, topic: string, steps: string) {
    // The first write of every key is its offer at start; every later one is a change.
    const seen = new Set<string>();
    const changes = this.stateOf(topic).filter((write) => {
      const later = seen.has(write.key);
      seen.add(write.key);
      return later;
    });
    assert.deepEqual([...new Set(changes.map((write) => write.key))], [key]);
    assert.ok(changes.length >= Number(steps), `${changes.length} changes`);
  },
);

Then(
  'the route offer {string} is {string}',
  async function (this: RidrsWorld, key: string, state: string) {
    await this.waitForIo(
      () =>
        (this.ensureHost().getState('route.offer').get(key) as { availability?: { state: string } })
          ?.availability?.state === state,
      `"${key}" to be ${state}`,
    );
  },
);
