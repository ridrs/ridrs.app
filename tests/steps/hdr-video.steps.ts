// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  isPqBt2020,
  pqToNits,
  REFERENCE_WHITE_NITS,
  yuvToRgb,
} from '../../plugins/ui-world-video/client/hdr.ts';
import {
  readVideoIndex,
  type VideoIndex,
} from '../../plugins/ui-world-video/client/video-index.ts';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The HDR path of the video world, headless: the colour read from the container and the colour
 * maths the HDR canvas runs. The canvas itself (WebGPU) is not available in Node.
 */

const FIXTURES = new URL('../../plugins/ui-world-video/client/fixtures/', import.meta.url);

interface Scenario {
  file?: Buffer;
  video?: VideoIndex;
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  let found = scenarios.get(world);
  if (!found) {
    found = {};
    scenarios.set(world, found);
  }
  return found;
}

/** The inverse of the PQ curve, by bisection: the signal of a luminance. */
function pqSignal(nits: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 60; i += 1) {
    const middle = (low + high) / 2;
    if (pqToNits(middle) < nits) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

Given('the test video tagged as PQ with BT.2020 primaries and matrix', function (this: RidrsWorld) {
  scenario(this).file = readFileSync(new URL('pq-test-pattern.mp4', FIXTURES));
});

Given('the test video without colour information', function (this: RidrsWorld) {
  scenario(this).file = readFileSync(new URL('test-pattern.mp4', FIXTURES));
});

When('the video world reads its index', async function (this: RidrsWorld) {
  const s = scenario(this);
  const file = s.file;
  assert.ok(file, 'Expected a test video');
  s.video = await readVideoIndex(
    async (offset, length) => new Uint8Array(file.subarray(offset, offset + length)),
  );
});

Then('it shows the video on the HDR canvas', function (this: RidrsWorld) {
  assert.equal(isPqBt2020(scenario(this).video?.colour), true);
});

Then('it shows the video on the SDR canvas', function (this: RidrsWorld) {
  assert.equal(isPqBt2020(scenario(this).video?.colour), false);
});

Then(
  'a PQ signal of {int} cd\\/m² is shown at {float} times SDR white',
  (nits: number, times: number) => {
    const shown = pqToNits(pqSignal(nits)) / REFERENCE_WHITE_NITS;
    assert.equal(shown.toFixed(2), times.toFixed(2));
  },
);

Then(
  'a PQ signal of {int} cd\\/m² is shown at more than {float} times SDR white',
  (nits: number, times: number) => {
    const shown = pqToNits(pqSignal(nits)) / REFERENCE_WHITE_NITS;
    assert.ok(shown > times, `${shown} times SDR white`);
  },
);

Then(
  "the limited-range code values {int}, {int}, {int} give R'G'B' {float}, {float}, {float}",
  (y: number, cb: number, cr: number, r: number, g: number, b: number) => {
    const m = yuvToRgb(false);
    const sample = [y / 255, cb / 255, cr / 255, 1];
    const row = (i: number) =>
      sample.reduce((sum, v, j) => sum + v * (m[4 * i + j] ?? Number.NaN), 0);
    assert.deepEqual(
      [row(0), row(1), row(2)].map((v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3)),
      [r, g, b].map((v) => v.toFixed(3)),
    );
  },
);
