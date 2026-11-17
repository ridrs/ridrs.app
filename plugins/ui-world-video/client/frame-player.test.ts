// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { FRAME_PLAYER, type FrameDecoder, FramePlayer } from './frame-player.ts';
import type { RangeReader, VideoIndex } from './video-index.ts';
import { indexSource, VIDEO_SOURCE, type VideoSource } from './video-source.ts';

/** 30 fps, a keyframe every 30 frames, 10 s; samples 100 bytes each, one after the other. */
function video(frames = 300, gop = 30): VideoIndex {
  return {
    codec: 'test',
    width: 64,
    height: 48,
    offsets: Float64Array.from({ length: frames }, (_, i) => 1000 + i * 100),
    sizes: Uint32Array.from({ length: frames }, () => 100),
    times: Float64Array.from({ length: frames }, (_, i) => i / 30),
    keyframes: Uint8Array.from({ length: frames }, (_, i) => (i % gop === 0 ? 1 : 0)),
  };
}

interface Frame {
  readonly timestamp: number;
  closed: boolean;
  close(): void;
}

/** A decoder that outputs every chunk at once; reads resolve on the next microtask. */
function setup(index = video()) {
  const decoded: number[] = [];
  const reads: [number, number][] = [];
  const alive = new Set<Frame>();
  let resets = 0;
  const read: RangeReader = async (offset, length) => {
    reads.push([offset, length]);
    return new Uint8Array(length);
  };
  const player = new FramePlayer<Frame>(indexSource(index, read), (output) => {
    const decoder: FrameDecoder = {
      decodeQueueSize: 0,
      configure: () => undefined,
      decode: ({ timestamp, key, data }) => {
        expect(data).toHaveLength(100);
        if (decoded.length === 0 || resets > 0) {
          // After a (re)start the first chunk is a keyframe.
        }
        decoded.push(timestamp);
        const frame: Frame = {
          timestamp,
          closed: false,
          close() {
            this.closed = true;
            alive.delete(this);
          },
        };
        alive.add(frame);
        output(frame);
        void key;
      },
      flush: async () => undefined,
      reset: () => {
        resets += 1;
      },
      close: () => undefined,
    };
    return decoder;
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return { player, decoded, reads, alive, settle, resets: () => resets };
}

const seconds = (frame: Frame | undefined) => (frame ? frame.timestamp / 1e6 : undefined);

describe('FramePlayer', () => {
  it('shows nothing until the frame is decoded, then the frame at or before the time', async () => {
    const { player, settle } = setup();
    expect(player.frameAt(0.5)).toBeUndefined();
    await settle();
    expect(seconds(player.frameAt(0.5))).toBeCloseTo(15 / 30, 5);
  });

  it('starts at the keyframe at or before the time, not at the beginning', async () => {
    const { player, decoded, settle } = setup();
    player.frameAt(2.5);
    await settle();
    expect(decoded[0]).toBe(Math.round((60 / 30) * 1e6));
    expect(seconds(player.frameAt(2.5))).toBeCloseTo(75 / 30, 5);
  });

  it('follows the time frame by frame, closing the frames left behind, without starting again', async () => {
    const { player, settle, alive, resets } = setup();
    player.frameAt(0);
    await settle();
    const shown: (number | undefined)[] = [];
    for (let t = 0; t <= 3; t += 1 / 60) {
      shown.push(seconds(player.frameAt(t)));
      await settle();
    }
    const wrong = shown.flatMap((s, i) =>
      s !== undefined && s <= i / 60 + 1e-6 && s > i / 60 - 1 / 30 - 1e-6 ? [] : [[i / 60, s]],
    );
    expect(wrong).toEqual([]);
    expect(resets()).toBe(1);
    expect(player.restarts).toBe(1);
    expect(alive.size).toBeLessThanOrEqual(FRAME_PLAYER.bufferAhead + 1);
  });

  it('holds the same frame while the time stands still', async () => {
    const { player, settle } = setup();
    player.frameAt(1);
    await settle();
    const first = player.frameAt(1);
    await settle();
    expect(player.frameAt(1)).toBe(first);
    expect(first?.closed).toBe(false);
  });

  it('never keeps more than the buffer ahead', async () => {
    const { player, settle, alive } = setup();
    player.frameAt(0);
    await settle();
    await settle();
    expect(alive.size).toBeLessThanOrEqual(FRAME_PLAYER.bufferAhead);
  });

  it('starts again at a keyframe when the time jumps back behind the buffer', async () => {
    const { player, settle, decoded } = setup();
    player.frameAt(5);
    await settle();
    player.frameAt(1.2);
    await settle();
    expect(player.restarts).toBe(2);
    expect(decoded.at(-FRAME_PLAYER.bufferAhead)).toBe(Math.round(1e6));
    expect(seconds(player.frameAt(1.2))).toBeCloseTo(1.2, 5);
  });

  it('skips to the keyframe ahead when the time passes one the decoder has not reached', async () => {
    const { player, settle, decoded } = setup();
    player.frameAt(0);
    await settle();
    // Faster than the decoder: the time is already past the keyframe at 4 s.
    player.frameAt(4.4);
    await settle();
    expect(player.restarts).toBe(2);
    expect(decoded).toContain(Math.round(4e6));
    expect(decoded).not.toContain(Math.round((61 / 30) * 1e6));
    expect(seconds(player.frameAt(4.4))).toBeCloseTo(132 / 30, 5);
  });

  it('reads samples in ranges of contiguous bytes', async () => {
    const { player, settle, reads } = setup();
    player.frameAt(0);
    await settle();
    expect(reads[0]).toEqual([1000, VIDEO_SOURCE.maxBatchSamples * 100]);
  });

  it('shows the last frame beyond the end of the video', async () => {
    const { player, settle } = setup(video(45, 15));
    player.frameAt(10);
    await settle();
    expect(seconds(player.frameAt(10))).toBeCloseTo(44 / 30, 5);
  });

  it('stops when a read fails', async () => {
    const index = video();
    const player = new FramePlayer(indexSource(index, async () => Promise.reject(new Error('gone'))), () => ({
      decodeQueueSize: 0,
      configure: () => undefined,
      decode: () => undefined,
      flush: async () => undefined,
      reset: () => undefined,
      close: () => undefined,
    }));
    player.frameAt(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(player.error).toBeInstanceOf(Error);
    expect(player.frameAt(0)).toBeUndefined();
  });
});

describe('FramePlayer with a source whose keyframes must be read (Matroska)', () => {
  /** The index source, but every keyframe lookup a read that resolves on a later task. */
  function lazy(index = video()) {
    const read: RangeReader = async (_offset, length) => new Uint8Array(length);
    const eager = indexSource(index, read);
    const lookups: number[] = [];
    const source: VideoSource = {
      ...eager,
      keyframeAt: (time) => {
        lookups.push(time);
        return new Promise((resolve) => setTimeout(() => resolve(eager.keyframeAt(time) as number), 0));
      },
    };
    return { source, lookups };
  }

  function play(source: VideoSource) {
    const decoded: number[] = [];
    const player = new FramePlayer<Frame>(source, (output) => ({
      decodeQueueSize: 0,
      configure: () => undefined,
      decode: ({ timestamp }) => {
        decoded.push(timestamp);
        output({ timestamp, closed: false, close() {} });
      },
      flush: async () => undefined,
      reset: () => {
        decoded.length = 0;
      },
      close: () => undefined,
    }));
    return { player, decoded };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('starts at the keyframe it looked up, once the lookup is answered', async () => {
    const { source } = lazy();
    const { player, decoded } = play(source);
    expect(player.frameAt(2.5)).toBeUndefined();
    await tick();
    await tick();
    expect(decoded[0]).toBe(2e6);
    expect(seconds(player.frameAt(2.5))).toBeCloseTo(75 / 30, 5);
  });

  it('looks up no keyframe while the time stays within what was fed', async () => {
    const { source, lookups } = lazy();
    const { player } = play(source);
    player.frameAt(0);
    await tick();
    await tick();
    const before = lookups.length;
    for (let t = 0; t <= 0.5; t += 1 / 60) {
      player.frameAt(t);
      await tick();
    }
    expect(lookups.length).toBe(before);
    expect(player.restarts).toBe(1);
  });

  it('skips to the keyframe ahead when the time passes what was fed', async () => {
    const { source } = lazy();
    const { player, decoded } = play(source);
    player.frameAt(0);
    await tick();
    await tick();
    player.frameAt(6.3);
    await tick();
    await tick();
    expect(player.restarts).toBe(2);
    expect(decoded[0]).toBe(6e6);
    expect(seconds(player.frameAt(6.3))).toBeCloseTo(189 / 30, 5);
  });

  it('stops when a lookup fails', async () => {
    const { source } = lazy();
    const { player } = play({ ...source, keyframeAt: () => Promise.reject(new Error('gone')) });
    player.frameAt(1);
    await tick();
    expect(player.error).toBeInstanceOf(Error);
    expect(player.frameAt(1)).toBeUndefined();
  });
});
