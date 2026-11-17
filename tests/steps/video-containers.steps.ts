// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type FrameDecoder,
  FramePlayer,
} from '../../plugins/ui-world-video/client/frame-player.ts';
import { isPqBt2020 } from '../../plugins/ui-world-video/client/hdr.ts';
import type { RangeReader } from '../../plugins/ui-world-video/client/video-index.ts';
import { openVideo, type VideoSource } from '../../plugins/ui-world-video/client/video-source.ts';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The video world's demuxing, headless: the file is read by range as over the media protocol and
 * the frame player feeds a decoder that stands in for WebCodecs (not available in Node). It
 * outputs every chunk at once, so what it shows is what was fed.
 */

const FIXTURES = new URL('../../plugins/ui-world-video/client/fixtures/', import.meta.url);

interface Chunk {
  readonly timestamp: number;
  readonly key: boolean;
}

interface Scenario {
  file?: Uint8Array;
  bytesRead: number;
  video?: VideoSource;
  failure?: unknown;
  decoded: Chunk[];
  shown?: number;
}

const scenarios = new WeakMap<RidrsWorld, Scenario>();

function scenario(world: RidrsWorld): Scenario {
  let found = scenarios.get(world);
  if (!found) {
    found = { bytesRead: 0, decoded: [] };
    scenarios.set(world, found);
  }
  return found;
}

function reader(s: Scenario): RangeReader {
  return async (offset, length) => {
    const file = s.file ?? new Uint8Array();
    const bytes = file.subarray(offset, Math.min(file.length, offset + length));
    s.bytesRead += bytes.length;
    return bytes;
  };
}

/** Lets the reads and the lookups of the player run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function show(s: Scenario, time: number): Promise<void> {
  const video = s.video;
  assert.ok(video, `The video did not open: ${String(s.failure)}`);
  const player = new FramePlayer(video, (output) => {
    const decoder: FrameDecoder = {
      decodeQueueSize: 0,
      configure: () => undefined,
      decode: ({ timestamp, key }) => {
        s.decoded.push({ timestamp, key });
        output({ timestamp, close: () => undefined });
      },
      flush: async () => undefined,
      reset: () => {
        s.decoded.length = 0;
      },
      close: () => undefined,
    };
    return decoder;
  });
  for (let i = 0; i < 50 && s.shown === undefined; i += 1) {
    const frame = player.frameAt(time);
    if (frame) {
      s.shown = frame.timestamp / 1e6;
    }
    await settle();
  }
  assert.equal(player.error, undefined);
  player.close();
}

Given(/^the (?:20 s )?test pattern as (\S+)$/, function (this: RidrsWorld, file: string) {
  scenario(this).file = new Uint8Array(readFileSync(new URL(file, FIXTURES)));
});

Given('a file that starts with the bytes of a PNG picture', function (this: RidrsWorld) {
  scenario(this).file = Uint8Array.from([
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

When('the video world opens the video', async function (this: RidrsWorld) {
  const s = scenario(this);
  const size = s.file?.length ?? 0;
  try {
    s.video = await openVideo(reader(s), () => size);
  } catch (error) {
    s.failure = error;
  }
});

When(
  'the video world shows the frame at {float} s',
  async function (this: RidrsWorld, time: number) {
    await show(scenario(this), time);
  },
);

Then(
  'the video is {word} of {int} × {int} pixels',
  function (this: RidrsWorld, codec: string, width: number, height: number) {
    const video = scenario(this).video;
    assert.ok(video, `The video did not open: ${String(scenario(this).failure)}`);
    assert.equal(video.codec.split('.')[0], codec);
    assert.deepEqual([video.width, video.height], [width, height]);
  },
);

Then(
  'the frame at {float} s is decoded from the keyframe at {float} s on',
  async function (this: RidrsWorld, time: number, keyframe: number) {
    const s = scenario(this);
    await show(s, time);
    const first = s.decoded[0];
    assert.ok(first, 'Nothing was decoded');
    assert.equal(first.key, true);
    assert.equal((first.timestamp / 1e6).toFixed(3), keyframe.toFixed(3));
  },
);

Then('the video world showed the frame at {float} s', function (this: RidrsWorld, time: number) {
  const shown = scenario(this).shown;
  assert.ok(shown !== undefined, 'No frame was shown');
  // The frame at or before the time: at 30 fps less than one frame earlier.
  assert.ok(shown <= time + 1e-4 && shown > time - 1 / 30, `The frame at ${shown} s was shown`);
});

Then('the video world read less than half of the file', function (this: RidrsWorld) {
  const s = scenario(this);
  assert.ok(
    s.bytesRead < (s.file?.length ?? 0) / 2,
    `${s.bytesRead} of ${s.file?.length} bytes read`,
  );
});

Then('it shows the opened video on the HDR canvas', function (this: RidrsWorld) {
  assert.equal(isPqBt2020(scenario(this).video?.colour), true);
});

Then('opening the video fails with {string}', function (this: RidrsWorld, reason: string) {
  const failure = scenario(this).failure;
  assert.ok(failure instanceof Error, 'The video opened');
  assert.match(failure.message, new RegExp(reason));
});
