// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type FrameDecoder,
  FramePlayer,
} from '../../plugins/ui-world-video/client/frame-player.ts';
import type { RangeReader, VideoIndex } from '../../plugins/ui-world-video/client/video-index.ts';
import { indexSource } from '../../plugins/ui-world-video/client/video-source.ts';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The frame player over a video with a broken stretch, headless: a decoder that stands in for
 * WebCodecs outputs every chunk at once, and like WebCodecs it reports an error after a chunk it
 * cannot decode and is closed from then on, taking no more chunks. The rider moves at the render clock, 60 frames per
 * second of video time, and the shown picture is what the video world keeps drawn: the last frame
 * the player gave.
 */

const FPS = 30;
const STEP = 1 / 60;

interface Frame {
  readonly timestamp: number;
  close(): void;
}

interface Scenario {
  player?: FramePlayer<Frame>;
  /** Video time and the picture shown at it (s), per render frame. */
  shown: { time: number; picture: number | undefined }[];
  picture?: number;
  skipped: number[];
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  let found = scenarios.get(world);
  if (!found) {
    found = { shown: [], skipped: [] };
    scenarios.set(world, found);
  }
  return found;
}

function player(s: Scenario): FramePlayer<Frame> {
  assert.ok(s.player, 'No video');
  return s.player;
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

async function ride(s: Scenario, from: number, to: number): Promise<void> {
  const p = player(s);
  for (let time = from; time <= to + 1e-9; time += STEP) {
    const frame = p.frameAt(time);
    if (frame) {
      s.picture = frame.timestamp / 1e6;
    }
    s.shown.push({ time, picture: s.picture });
    s.skipped.push(...p.takeSkipped());
    await settle();
  }
}

Given(
  'a {int} s video with a keyframe every second whose samples from {float} s to {float} s cannot be decoded',
  function (this: RidrsWorld, seconds: number, brokenFrom: number, brokenTo: number) {
    const frames = seconds * FPS;
    const index: VideoIndex = {
      codec: 'test',
      width: 64,
      height: 48,
      offsets: Float64Array.from({ length: frames }, (_, i) => 1000 + i * 100),
      sizes: Uint32Array.from({ length: frames }, () => 100),
      times: Float64Array.from({ length: frames }, (_, i) => i / FPS),
      keyframes: Uint8Array.from({ length: frames }, (_, i) => (i % FPS === 0 ? 1 : 0)),
    };
    const read: RangeReader = async (_offset, length) => new Uint8Array(length);
    const broken = (timestamp: number) =>
      timestamp / 1e6 >= brokenFrom - 1e-6 && timestamp / 1e6 <= brokenTo + 1e-6;
    scenario(this).player = new FramePlayer<Frame>(indexSource(index, read), (output, error) => {
      let closed = false;
      const decoder: FrameDecoder = {
        get decodeQueueSize() {
          return 0;
        },
        configure: () => {
          assert.equal(closed, false, 'A closed decoder was configured');
        },
        decode: ({ timestamp }) => {
          // As the video world's WebCodecs decoder: a closed one takes no more chunks.
          if (closed) {
            return;
          }
          if (broken(timestamp)) {
            closed = true;
            queueMicrotask(() => error(new Error('Decoding error')));
            return;
          }
          output({ timestamp, close: () => undefined });
        },
        flush: async () => undefined,
        reset: () => {
          assert.equal(closed, false, 'A closed decoder was reset');
        },
        close: () => {
          closed = true;
        },
      };
      return decoder;
    });
  },
);

When(
  'the rider rides through the video from {float} s to {float} s',
  async function (this: RidrsWorld, from: number, to: number) {
    await ride(scenario(this), from, to);
  },
);

When('the rider stays at {float} s', async function (this: RidrsWorld, time: number) {
  const s = scenario(this);
  for (let i = 0; i < 60; i += 1) {
    await ride(s, time, time);
  }
});

Then(
  'the picture followed the rider from {float} s to {float} s',
  function (this: RidrsWorld, from: number, to: number) {
    // The frame at or before the time, at most one frame and one render frame behind it.
    const wrong = scenario(this)
      .shown.filter(({ time }) => time >= from + 2 * STEP && time < to - 1e-9)
      .filter(
        ({ time, picture }) =>
          picture === undefined || picture > time + 1e-4 || picture < time - 1 / FPS - STEP - 1e-4,
      );
    assert.deepEqual(wrong.slice(0, 5), []);
  },
);

Then(
  'it held the last frame before {float} s from {float} s to {float} s',
  function (this: RidrsWorld, before: number, from: number, to: number) {
    const last = Math.round(before * FPS - 1) / FPS;
    const wrong = scenario(this)
      .shown.filter(({ time }) => time >= from && time < to - 1e-9)
      .filter(({ picture }) => picture === undefined || Math.abs(picture - last) > 1e-4);
    assert.deepEqual(wrong.slice(0, 5), []);
  },
);

Then('the picture is the last frame before {float} s', function (this: RidrsWorld, before: number) {
  const picture = scenario(this).picture;
  assert.ok(picture !== undefined, 'No frame was shown');
  assert.ok(
    Math.abs(picture - Math.round(before * FPS - 1) / FPS) < 1e-4,
    `The frame at ${picture} s was shown`,
  );
});

Then('the video did not stop', function (this: RidrsWorld) {
  assert.equal(player(scenario(this)).error, undefined);
});

Then('the video stopped', function (this: RidrsWorld) {
  assert.ok(player(scenario(this)).error instanceof Error, 'The video plays on');
});

Then(
  'the video world told that the stretch from the keyframe at {float} s was left out',
  function (this: RidrsWorld, keyframe: number) {
    assert.deepEqual(scenario(this).skipped, [keyframe]);
  },
);
