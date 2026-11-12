// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { SimulatedDrop } from '../support/simulated-drop.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv, useRealPlugins } from './devices-and-metrics.steps.ts';

/** Where `storage-media-node` keeps the media (`docs/ideas/video-sources.md`). */
const MEDIA_DIR_ENV = 'RIDRS_MEDIA_DIR';

const drops = new WeakMap<RidrsWorld, SimulatedDrop>();

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

When('the rider lets go of it', function (this: RidrsWorld) {
  drop(this).drop();
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
