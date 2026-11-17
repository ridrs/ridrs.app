// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RangeReader } from './video-index.ts';
import { openVideo, type VideoSample } from './video-source.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function reader(file: Uint8Array) {
  const reads: [number, number][] = [];
  const read: RangeReader = async (offset, length) => {
    reads.push([offset, length]);
    return file.subarray(offset, Math.min(file.length, offset + length));
  };
  return { read, reads, size: () => file.length };
}

async function open(name: string) {
  const file = fixture(name);
  const { read, reads, size } = reader(file);
  return { video: await openVideo(read, size), reads, file };
}

/** Every sample the reader gives, to the end. */
async function all(next: () => Promise<readonly VideoSample[]>): Promise<VideoSample[]> {
  const samples: VideoSample[] = [];
  for (let batch = await next(); batch.length > 0; batch = await next()) {
    samples.push(...batch);
  }
  return samples;
}

describe('openVideo', () => {
  it('opens an MP4 and a QuickTime file by their sample table, keyframes at once', async () => {
    for (const name of ['test-pattern.mp4', 'test-pattern.mov']) {
      const { video } = await open(name);
      expect(video.codec).toMatch(/^avc1\./);
      expect([video.width, video.height]).toEqual([64, 48]);
      expect(video.keyframeAt(1.2)).toBeCloseTo(1, 5);
      expect(video.description?.[0]).toBe(1); // avcC configurationVersion
    }
  });

  it('opens a Matroska and a WebM file, keyframes from the cues', async () => {
    const mkv = (await open('test-pattern.mkv')).video;
    expect(mkv.codec).toMatch(/^avc1\./);
    expect(mkv.description?.[0]).toBe(1);
    expect(await mkv.keyframeAt(1.2)).toBeCloseTo(1, 5);
    const webm = (await open('test-pattern.webm')).video;
    expect(webm.codec).toMatch(/^vp09\./);
    expect([webm.width, webm.height]).toEqual([64, 48]);
    expect(await webm.keyframeAt(0.9)).toBeCloseTo(0.5, 5);
    expect(await webm.keyframeAt(-1)).toBe(0);
  });

  it('gives a Matroska file’s samples in decode order from the keyframe on, in batches', async () => {
    const { video } = await open('test-pattern.mkv');
    const samples = await all(video.samplesFrom(1));
    expect(samples).toHaveLength(30);
    expect(samples[0]).toMatchObject({ time: 1, key: true });
    expect(samples.filter((sample) => sample.key).map((sample) => sample.time)).toEqual([1, 1.5]);
    // B-frames: presentation times are not in decode order, but cover every frame once.
    const times = samples.map((sample) => Math.round(sample.time * 30));
    expect(times).not.toEqual([...times].sort((a, b) => a - b));
    expect([...times].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => 30 + i));
    // An H.264 sample in Matroska is length-prefixed like in an MP4.
    const first = samples[0]?.data ?? new Uint8Array();
    expect(new DataView(first.buffer, first.byteOffset).getUint32(0)).toBeLessThan(first.length);
  });

  it('reads the colour a WebM declares, none when it declares none', async () => {
    expect((await open('pq-test-pattern.webm')).video.colour).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: false });
    expect((await open('test-pattern.webm')).video.colour).toBeUndefined();
  });

  it('refuses a file in no known container', async () => {
    const { read, size } = reader(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    await expect(openVideo(read, size)).rejects.toThrow(/neither MP4 nor Matroska/);
  });
});
