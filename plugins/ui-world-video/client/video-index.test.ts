// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type RangeReader, readVideoIndex } from './video-index.ts';

// 2 s of a 64 × 48 test pattern at 30 fps, H.264 with B-frames, a keyframe every 15 frames and
// the sample table (moov) after the media data, like the library's videos.
const FILE = readFileSync(new URL('./fixtures/test-pattern.mp4', import.meta.url));

function reader() {
  const reads: [number, number][] = [];
  const read: RangeReader = async (offset, length) => {
    reads.push([offset, length]);
    return new Uint8Array(FILE.subarray(offset, Math.min(FILE.length, offset + length)));
  };
  return { read, reads };
}

describe('readVideoIndex', () => {
  it('reads codec, size and every sample in decode order', async () => {
    const video = await readVideoIndex(reader().read);
    expect(video.codec).toMatch(/^avc1\./);
    expect([video.width, video.height]).toEqual([64, 48]);
    expect(video.offsets).toHaveLength(60);
    expect([...video.keyframes.keys()].filter((i) => video.keyframes[i])).toEqual([0, 15, 30, 45]);
    expect(video.description?.[0]).toBe(1); // avcC configurationVersion
  });

  it('gives presentation times from 0, which differ from decode order with B-frames', async () => {
    const video = await readVideoIndex(reader().read);
    const times = [...video.times];
    expect(Math.min(...times)).toBe(0);
    expect([...times].sort((a, b) => a - b).map((t) => Math.round(t * 30))).toEqual(
      Array.from({ length: 60 }, (_, i) => i),
    );
    expect(times).not.toEqual([...times].sort((a, b) => a - b));
  });

  it('points at the samples in the file', async () => {
    const video = await readVideoIndex(reader().read);
    // An H.264 sample in an MP4 starts with the 4-byte length of its first NAL unit.
    const first = video.offsets[0] ?? 0;
    expect(FILE.readUInt32BE(first)).toBeLessThan(video.sizes[0] ?? 0);
  });

  it('reads only the box headers, ftyp and moov, never the media data', async () => {
    const { read, reads } = reader();
    await readVideoIndex(read);
    expect(Math.max(...reads.map(([, length]) => length))).toBeLessThan(2000);
  });
});

describe('httpRangeReader', () => {
  it('reads nothing past the end of the file, where the server answers 416', async () => {
    const { httpRangeReader } = await import('./video-index.ts');
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 416 })) as typeof fetch;
    try {
      expect(await httpRangeReader('/videos/x.mp4')(6741, 16)).toHaveLength(0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it('fails on any other error', async () => {
    const { httpRangeReader } = await import('./video-index.ts');
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    try {
      await expect(httpRangeReader('/videos/x.mp4')(0, 16)).rejects.toThrow(/404/);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });
});
