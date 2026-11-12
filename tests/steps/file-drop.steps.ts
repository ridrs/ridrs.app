// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { waitFor, within } from '@testing-library/dom';
import { SimulatedDrop } from '../support/simulated-drop.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv, useRealPlugins } from './devices-and-metrics.steps.ts';

/** Where `storage-media-node` keeps the media (`docs/ideas/video-sources.md`). */
const MEDIA_DIR_ENV = 'RIDRS_MEDIA_DIR';

/** The workout files of the import scenarios. */
const WORKOUT_FILES = resolve(import.meta.dirname, '../fixtures/workout-import/files');

/** The start of a PNG picture: a file ridrs cannot import. */
const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const drops = new WeakMap<RidrsWorld, SimulatedDrop>();

/** The layer over the main screen while files are dragged, if the UI shows it. */
function layer(world: RidrsWorld): HTMLElement | null {
  return (
    world.uiViews[0]?.root.querySelector<HTMLElement>('[data-testid="file-drop-layer"]') ?? null
  );
}

async function shownLayer(world: RidrsWorld): Promise<HTMLElement> {
  return waitFor(() => {
    const shown = layer(world);
    assert.ok(shown, 'Expected the drop layer to be shown');
    return shown;
  });
}

function drop(world: RidrsWorld): SimulatedDrop {
  const simulation = drops.get(world);
  assert.ok(simulation, 'Expected the simulated drop');
  return simulation;
}

Given(
  'the ridrs plugins {string} together with the simulated drop',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    const media = mkdtempSync(join(tmpdir(), 'ridrs-media-'));
    process.env[MEDIA_DIR_ENV] = media;
    const simulation = new SimulatedDrop(media);
    drops.set(this, simulation);
    this.getBehavior('simulated-drop').providedImplementations.set(
      'data.drop',
      simulation.provider,
    );
    await this.writeProbePluginFolder({
      folder: 'simulated-drop',
      id: 'simulated-drop',
      types: ['test'],
      provides: ['data.drop'],
    });
    this.useMemoryStorage();
  },
);

Given(
  'the rider drags the Incyclist package {string} onto the window',
  async function (this: RidrsWorld, name: string) {
    await drop(this).drag(name, 'incyclist');
  },
);

Given(
  'the rider drags the video2gpx package {string} onto the window',
  async function (this: RidrsWorld, name: string) {
    await drop(this).drag(name, 'video2gpx');
  },
);

Given(
  'the rider drags a ZIP {string} without a control file onto the window',
  async function (this: RidrsWorld, name: string) {
    await drop(this).drag(name, 'no-control-file');
  },
);

Given(
  'the rider drags the workout file {string} onto the window',
  function (this: RidrsWorld, name: string) {
    drop(this).dragBytes(name, new Uint8Array(readFileSync(resolve(WORKOUT_FILES, name))));
  },
);

Given(
  'the rider drags the file {string} onto the window',
  function (this: RidrsWorld, name: string) {
    drop(this).dragBytes(name, PICTURE);
  },
);

/** Waits until `file-drop` has read every dragged file: no verdict is `reading` any more. */
async function filesRead(world: RidrsWorld): Promise<void> {
  await world.waitForIo(() => {
    const drag = world.ensureHost().getState('file.drop').get('window') as
      | { files: { verdict: { kind: string } }[] }
      | undefined;
    return drag?.files.every((file) => file.verdict.kind !== 'reading') === true;
  }, 'the dragged files to be read');
}

When('the dragged files are read', async function (this: RidrsWorld) {
  await filesRead(this);
});

When('the rider lets go of it', async function (this: RidrsWorld) {
  drop(this).drop();
  // Where the UI is shown, the files are let go over the layer that shows them, if it shows them.
  if (this.uiViews[0]) {
    await filesRead(this);
    // Files ridrs cannot import have no layer; anything else is shown on it.
    const drag = this.ensureHost().getState('file.drop').get('window') as
      | { files: { verdict: { kind: string } }[] }
      | undefined;
    if (
      !drag?.files.some((file) => file.verdict.kind === 'workouts' || file.verdict.kind === 'route')
    ) {
      await this.settle();
      return;
    }
    const target = await shownLayer(this);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], dropEffect: 'copy' },
    });
    const takes = target.dataset.takes !== undefined;
    target.dispatchEvent(event);
    // What the layer takes is added once its import is done; the layer then says what it did.
    if (takes) {
      await waitFor(
        () => assert.ok(layer(this)?.dataset.phase === 'done', 'The files are still being added'),
        {
          timeout: 5000,
        },
      );
    }
  }
  await this.settle();
});

When('the rider drags it out of the window again', function (this: RidrsWorld) {
  drop(this).leave();
});

Then('the call resolved with the preview {string}', function (this: RidrsWorld, expected: string) {
  const call = this.lastCall;
  assert.ok(call, 'No call was made');
  assert.ok(call.resolved, `The call was rejected: ${String(!call.resolved && call.error)}`);
  const answer = call.value as
    | {
        ok: true;
        preview: {
          kind: string;
          title: string;
          distance: number;
          ascent: number;
          sparkline?: number[];
        };
      }
    | { ok: false; reason: string };
  assert.ok(answer.ok, `No preview: ${answer.ok ? '' : answer.reason}`);
  const { kind, title, distance, ascent, sparkline } = answer.preview;
  assert.ok((sparkline?.length ?? 0) >= 2, 'The preview has no profile');
  assert.equal(
    `${title}: ${kind}, ${(distance / 1000).toFixed(1)} km, ${Math.round(ascent)} m`,
    expected,
  );
});

Then('the drop layer shows the tile {string}', async function (this: RidrsWorld, title: string) {
  const shown = await shownLayer(this);
  await waitFor(() => within(shown).getByRole('article', { name: title }));
});

Then('the drop layer shows {int} tiles', async function (this: RidrsWorld, count: number) {
  const shown = await shownLayer(this);
  await waitFor(() => assert.equal(within(shown).queryAllByRole('article').length, count));
});

Then('the drop layer says {string}', async function (this: RidrsWorld, text: string) {
  const shown = await shownLayer(this);
  await waitFor(() => assert.equal(within(shown).getByRole('status').textContent?.trim(), text));
});

Then(
  'the drop layer marks {string} as {string}',
  async function (this: RidrsWorld, title: string, mark: string) {
    const shown = await shownLayer(this);
    await waitFor(() => {
      const tile = within(shown).getByRole('article', { name: title });
      assert.ok(tile.textContent?.includes(mark), `"${title}" reads "${tile.textContent}"`);
    });
  },
);

Then(
  'the tile {string} reads {string}',
  async function (this: RidrsWorld, title: string, text: string) {
    const shown = await shownLayer(this);
    await waitFor(() => {
      const tile = within(shown).getByRole('article', { name: title });
      assert.ok(tile.textContent?.includes(text), `"${title}" reads "${tile.textContent}"`);
    });
  },
);

Then('the drop layer is not shown', async function (this: RidrsWorld) {
  // Not the element into the message: inspecting a DOM node costs gigabytes.
  const hidden = () =>
    assert.ok(layer(this) === null, `The drop layer is shown: ${layer(this)?.textContent}`);
  await waitFor(hidden);
  // And it stays away once the UI caught up with the state.
  await this.settle();
  await new Promise((resolve) => setTimeout(resolve, 150));
  hidden();
});

Given('copying the dropped file waits', function (this: RidrsWorld) {
  drop(this).holdCopies();
});

When('copying the dropped file goes on', function (this: RidrsWorld) {
  drop(this).goOn();
});

Then(
  'the route offer {string} reads {string}',
  async function (this: RidrsWorld, key: string, distance: string) {
    await this.waitForIo(() => {
      const offer = this.ensureHost().getState('route.offer').get(key) as
        | { distance?: number }
        | undefined;
      return (
        offer?.distance !== undefined && `${(offer.distance / 1000).toFixed(1)} km` === distance
      );
    }, `"${key}" to read ${distance}`);
  },
);

/** What the layer tells the pointer while the files hover over it: `copy` (a plus) or `none`. */
async function pointerOver(world: RidrsWorld): Promise<string> {
  const target = await shownLayer(world);
  const transfer = { types: ['Files'], dropEffect: 'none' };
  const event = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  target.dispatchEvent(event);
  return transfer.dropEffect;
}

Then('the pointer shows that letting go adds them', async function (this: RidrsWorld) {
  await waitFor(async () => assert.equal(await pointerOver(this), 'copy'));
});

Then('the pointer shows that letting go adds nothing', async function (this: RidrsWorld) {
  await waitFor(async () => assert.equal(await pointerOver(this), 'none'));
});
