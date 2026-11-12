// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Given, Then } from '@cucumber/cucumber';
import { waitFor, within } from '@testing-library/dom';
import { SimulatedOpenDialog } from '../support/simulated-open-dialog.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv, useRealPlugins } from './devices-and-metrics.steps.ts';

/** Where `storage-media-node` keeps the media (`docs/ideas/video-sources.md`). */
const MEDIA_DIR_ENV = 'RIDRS_MEDIA_DIR';

const dialogs = new WeakMap<RidrsWorld, SimulatedOpenDialog>();

function dialog(world: RidrsWorld): SimulatedOpenDialog {
  const simulation = dialogs.get(world);
  assert.ok(simulation, 'Expected the simulated open dialog');
  return simulation;
}

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

Given(
  'the ridrs plugins {string} together with the simulated open dialog',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    const media = mkdtempSync(join(tmpdir(), 'ridrs-media-'));
    process.env[MEDIA_DIR_ENV] = media;
    const simulation = new SimulatedOpenDialog(media);
    dialogs.set(this, simulation);
    this.getBehavior('simulated-open-dialog').providedImplementations.set(
      'data.pick',
      simulation.pick,
    );
    await this.writeProbePluginFolder({
      folder: 'simulated-open-dialog',
      id: 'simulated-open-dialog',
      types: ['test'],
      provides: ['data.pick'],
    });
    this.useMemoryStorage();
  },
);

Given(
  'the rider chooses the Incyclist package {string}',
  function (this: RidrsWorld, name: string) {
    dialog(this).choose(name, 'incyclist');
  },
);

Given(
  'the rider chooses a ZIP {string} without a control file',
  function (this: RidrsWorld, name: string) {
    dialog(this).choose(name, 'no-control-file');
  },
);

Given('the rider cancels the open dialog', function (this: RidrsWorld) {
  dialog(this).cancel();
});

Then(
  'the open dialog offered Incyclist packages as {string}',
  function (this: RidrsWorld, extensionsCsv: string) {
    const filter = dialog(this).filters.at(-1);
    assert.ok(filter, 'Expected the open dialog to have been opened');
    assert.deepEqual(filter.extensions, splitCsv(extensionsCsv));
  },
);

Then(
  'the section {string} lists {string} first',
  async function (this: RidrsWorld, name: string, title: string) {
    await waitFor(() => {
      const cards = within(within(ui(this)).getByRole('region', { name })).queryAllByRole(
        'article',
      );
      assert.equal(cards[0]?.getAttribute('aria-label'), title);
    });
  },
);
