// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type FrameDecoder,
  FramePlayer,
} from '../../plugins/ui-world-video/client/frame-player.ts';
import { type RefinedPart, refinedParts } from '../../plugins/ui-world-video/client/library.ts';
import {
  RefinedFramePlayer,
  shiftedSource,
} from '../../plugins/ui-world-video/client/refined-player.ts';
import { openVideo } from '../../plugins/ui-world-video/client/video-source.ts';
import type { RidrsWorld } from '../support/world.ts';

/*
 * A route's refined stretches (ADR 0109), headless: the fixtures are read by range as over the
 * media protocol, and each frame player feeds a decoder that stands in for WebCodecs and outputs
 * every chunk at once, so what it shows is what was fed (as in video-containers.steps.ts).
 */

const FIXTURES = new URL('../../plugins/ui-world-video/client/fixtures/', import.meta.url);

interface Frame {
  readonly timestamp: number;
  close(): void;
}

interface Stretch {
  readonly from: number;
  readonly to: number;
  bytes: Uint8Array;
}

interface Scenario {
  video?: Uint8Array;
  stretch?: Stretch;
  player?: RefinedFramePlayer<Frame>;
  /** The frame (s) shown for each time asked, in the order asked. */
  shown: { time: number; frame: number | undefined }[];
  /** A route's refinement, its files and what the video world made of it. */
  refinement?: { text: string; files: Record<string, string> };
  read?: { refined: readonly RefinedPart[]; problem?: string };
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  let found = scenarios.get(world);
  if (!found) {
    found = { shown: [] };
    scenarios.set(world, found);
  }
  return found;
}

const fixture = (file: string) => new Uint8Array(readFileSync(new URL(file, FIXTURES)));

/** Reads `bytes` by range, as the media protocol serves a file. */
const rangeOf = (bytes: Uint8Array) => async (offset: number, length: number) =>
  bytes.subarray(offset, Math.min(bytes.length, offset + length));

/** A frame player of `bytes` whose decoder outputs every chunk at once. */
async function playerOf(bytes: Uint8Array, from?: number): Promise<FramePlayer<Frame>> {
  const opened = await openVideo(rangeOf(bytes), () => bytes.length);
  const video = from === undefined ? opened : shiftedSource(opened, from);
  return new FramePlayer<Frame>(video, (output) => {
    const decoder: FrameDecoder = {
      decodeQueueSize: 0,
      configure: () => undefined,
      decode: ({ timestamp }) => output({ timestamp, close: () => undefined }),
      flush: async () => undefined,
      reset: () => undefined,
      close: () => undefined,
    };
    return decoder;
  });
}

/** Lets the reads, the openings and the lookups of the players run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function player(s: Scenario): Promise<RefinedFramePlayer<Frame>> {
  if (!s.player) {
    const video = await playerOf(s.video ?? new Uint8Array());
    const stretch = s.stretch;
    s.player = new RefinedFramePlayer(
      video,
      stretch
        ? [
            {
              from: stretch.from,
              to: stretch.to,
              open: () => playerOf(stretch.bytes, stretch.from),
            },
          ]
        : [],
    );
  }
  return s.player;
}

const seconds = (frame: Frame | undefined) => (frame ? frame.timestamp / 1e6 : undefined);

/** Asks for `time` until the frame stays the same, as render frames do while the rider is there. */
async function show(s: Scenario, time: number): Promise<void> {
  const shown = await player(s);
  let frame: number | undefined;
  for (let i = 0, same = 0; i < 50 && same < 3; i += 1) {
    const next = seconds(shown.frameAt(time));
    same = next !== undefined && next === frame ? same + 1 : 0;
    frame = next;
    await settle();
  }
  s.shown.push({ time, frame });
}

Given(
  'the test pattern as {word}, {int} frames per second',
  function (this: RidrsWorld, file: string, _frameRate: number) {
    scenario(this).video = fixture(file);
  },
);

Given(
  'a refined stretch from {float} s to {float} s with {int} frames per frame in {word}',
  function (this: RidrsWorld, from: number, to: number, _factor: number, file: string) {
    scenario(this).stretch = { from, to, bytes: fixture(file) };
  },
);

Given("the refined stretch's file is not a video", function (this: RidrsWorld) {
  const stretch = scenario(this).stretch;
  assert.ok(stretch, 'Expected a refined stretch');
  stretch.bytes = Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new Array(64).fill(0),
  ]);
});

When(
  'the video world shows the times from {float} s to {float} s in steps of {float} s',
  async function (this: RidrsWorld, from: number, to: number, step: number) {
    const s = scenario(this);
    const count = Math.round((to - from) / step);
    for (let i = 0; i <= count; i += 1) {
      await show(s, Math.round((from + i * step) * 1e6) / 1e6);
    }
  },
);

const close = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-3;

Then(
  'it showed the frame at {float} s for the time {float} s',
  function (this: RidrsWorld, frame: number, time: number) {
    const found = scenario(this)
      .shown.filter((shown) => Math.abs(shown.time - time) < 1e-9)
      .at(-1);
    assert.ok(found, `The time ${time} s was not shown`);
    assert.ok(close(found.frame, frame), `For ${time} s it showed the frame at ${found.frame} s`);
  },
);

Then('it showed {int} different frames', function (this: RidrsWorld, count: number) {
  const frames = new Set(scenario(this).shown.map((shown) => shown.frame?.toFixed(4)));
  assert.equal(frames.size, count, [...frames].join(', '));
});

Then(
  'the next frame at {float} s is shown at once, the frame at {float} s',
  async function (this: RidrsWorld, time: number, frame: number) {
    const shown = seconds((await player(scenario(this))).frameAt(time));
    assert.ok(close(shown, frame), `At once it showed the frame at ${shown} s`);
  },
);

Then('the video plays without a failure', async function (this: RidrsWorld) {
  const shown = await player(scenario(this));
  assert.equal(shown.error, undefined);
  assert.equal(shown.takeFailures().length, 1, 'Expected the refined stretch to be left out');
});

/** The files of a route with a control file, its video and two stretches' files, as URLs by path. */
const ROUTE_FILES = {
  'route.xml': 'media://route/route.xml',
  'test-pattern.mp4': 'media://route/test-pattern.mp4',
  'refine/refine.json': 'media://route/refine/refine.json',
  'refine/a.mp4': 'media://route/refine/a.mp4',
  'refine/b.mp4': 'media://route/refine/b.mp4',
};

const refinement = (video: string, segments: unknown[]) =>
  JSON.stringify({ version: 1, video, segments });
const stretchOf = (from: number, to: number, file: string) => ({ from, to, factor: 4, file });

Given(/^a route whose refinement (.+)$/, function (this: RidrsWorld, problem: string) {
  const texts: Record<string, string> = {
    'names another video': refinement('other.mp4', [stretchOf(0.5, 1.5, 'a.mp4')]),
    'does not parse': '{',
    'names a file the route lacks': refinement('test-pattern.mp4', [
      stretchOf(0.5, 1.5, 'missing.mp4'),
    ]),
    'has overlapping stretches': refinement('test-pattern.mp4', [
      stretchOf(0.5, 1.5, 'a.mp4'),
      stretchOf(1, 2, 'b.mp4'),
    ]),
    'names its video with one stretch from 0.5 s to 1.5 s': refinement('test-pattern.mp4', [
      stretchOf(0.5, 1.5, 'a.mp4'),
    ]),
  };
  const text = texts[problem];
  assert.ok(text !== undefined, `No route whose refinement ${problem}`);
  scenario(this).refinement = { text, files: ROUTE_FILES };
});

When('the video world reads the route', function (this: RidrsWorld) {
  const s = scenario(this);
  assert.ok(s.refinement, 'Expected a route');
  s.read = refinedParts(s.refinement.text, 'test-pattern.mp4', s.refinement.files);
});

Then('the route has no refined stretches', function (this: RidrsWorld) {
  assert.deepEqual(scenario(this).read?.refined, []);
});

Then(/^the reason "(.*)" is logged$/, function (this: RidrsWorld, reason: string) {
  const problem = scenario(this).read?.problem ?? '';
  assert.ok(problem.includes(reason), `The reason was "${problem}"`);
});

Then(
  'the route has {int} refined stretch, from {float} s to {float} s with {int} frames per frame',
  function (this: RidrsWorld, count: number, from: number, to: number, factor: number) {
    const read = scenario(this).read;
    assert.equal(read?.refined.length, count, read?.problem ?? '');
    assert.deepEqual(read?.refined[0], { from, to, factor, url: 'media://route/refine/a.mp4' });
  },
);
