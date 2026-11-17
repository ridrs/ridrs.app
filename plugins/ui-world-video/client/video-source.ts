// SPDX-License-Identifier: AGPL-3.0-or-later

import { type EncodedPacket, EncodedPacketSink, Input, MATROSKA, StreamSource, WEBM } from 'mediabunny';
import { type RangeReader, readVideoIndex, type VideoColour, type VideoIndex } from './video-index.ts';

/** An encoded sample as the decoder takes it: s from the first shown frame. */
export interface VideoSample {
  readonly data: Uint8Array;
  readonly time: number;
  readonly key: boolean;
}

/** The next samples in decode order, a batch per call; none at the end of the video. */
export type SampleReader = () => Promise<readonly VideoSample[]>;

/**
 * A video as the frame player needs it, whatever its container (ADR 0101): the decoder
 * configuration, where its keyframes are and its samples from a keyframe on.
 */
export interface VideoSource {
  /** The WebCodecs codec string, e.g. `avc1.64001f`, `vp09.02.10.10` or `av01.0.05M.08`. */
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  /** The codec configuration record (`avcC`, `av1C`, …); none for some codecs. */
  readonly description?: Uint8Array;
  /** The colour the container declares; none when it declares none (ADR 0091). */
  readonly colour?: VideoColour;
  /**
   * The time of the last keyframe at or before `time` (the first one before it); a promise when
   * the container must be read for it.
   */
  keyframeAt(time: number): number | Promise<number>;
  /** The samples in decode order from the keyframe at `keyframe` (a time `keyframeAt` gave) on. */
  samplesFrom(keyframe: number): SampleReader;
}

export const VIDEO_SOURCE = Object.freeze({
  /** Bytes per batch at most; for an MP4 the samples of a batch are one range request. */
  maxBatchBytes: 4 * 1024 * 1024,
  /** Samples per batch at most. */
  maxBatchSamples: 30,
});

/** The EBML header every Matroska and WebM file starts with. */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** s a sample may lie after a time and still count as at it: rounding of µs timestamps. */
const TOLERANCE = 1e-4;

/**
 * Opens a video read by range: an MP4, M4V or QuickTime file by its sample table (mp4box.js, ADR
 * 0061), a Matroska or WebM file by its cues (mediabunny, ADR 0101). `size` is the file's size in
 * bytes, known once the first read was answered.
 */
export async function openVideo(read: RangeReader, size: () => number): Promise<VideoSource> {
  const head = await read(0, 12);
  if (EBML_MAGIC.every((byte, i) => head[i] === byte)) {
    return openMatroska(read, size);
  }
  // ISO BMFF (MP4, M4V, QuickTime) starts with a box: a size and a type of four printable letters.
  const type = String.fromCharCode(...head.subarray(4, 8));
  if (head.length < 8 || !/^[a-z0-9 ]{4}$/i.test(type)) {
    throw new Error('The video is neither MP4 nor Matroska (or WebM)');
  }
  const index = await readVideoIndex(read);
  return indexSource(index, read);
}

/** The sample in decode order with the latest time at or before `time` (ADR 0061). */
export function sampleAt(video: VideoIndex, time: number): number {
  const { times } = video;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((times[middle] ?? 0) <= time) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  // Decode order and presentation order differ only within a few frames: look around.
  let best = low;
  for (let i = Math.max(0, low - 8); i < Math.min(times.length, low + 8); i += 1) {
    const t = times[i] ?? 0;
    if (t <= time + TOLERANCE && t > (times[best] ?? 0)) {
      best = i;
    }
  }
  return best;
}

/** The last sample in decode order at or before `index` that is a keyframe. */
function keyframeAtOrBefore(video: VideoIndex, index: number): number {
  for (let i = index; i > 0; i -= 1) {
    if (video.keyframes[i]) {
      return i;
    }
  }
  return 0;
}

/**
 * A video whose every sample is in its index (an MP4): keyframes are found at once, and the
 * samples of a batch are contiguous bytes, read with one range request.
 */
export function indexSource(video: VideoIndex, read: RangeReader): VideoSource {
  const count = video.offsets.length;
  return {
    codec: video.codec,
    width: video.width,
    height: video.height,
    ...(video.description ? { description: video.description } : {}),
    ...(video.colour ? { colour: video.colour } : {}),
    keyframeAt: (time) => video.times[keyframeAtOrBefore(video, sampleAt(video, time))] ?? 0,
    samplesFrom: (keyframe) => {
      let next = keyframeAtOrBefore(video, sampleAt(video, keyframe));
      return async () => {
        const first = next;
        if (first >= count) {
          return [];
        }
        let end = first + 1;
        let bytes = video.sizes[first] ?? 0;
        while (
          end < count &&
          end - first < VIDEO_SOURCE.maxBatchSamples &&
          (video.offsets[end] ?? 0) >= (video.offsets[end - 1] ?? 0) &&
          (video.offsets[end] ?? 0) + (video.sizes[end] ?? 0) - (video.offsets[first] ?? 0) <= VIDEO_SOURCE.maxBatchBytes
        ) {
          bytes = (video.offsets[end] ?? 0) + (video.sizes[end] ?? 0) - (video.offsets[first] ?? 0);
          end += 1;
        }
        next = end;
        const start = video.offsets[first] ?? 0;
        const data = await read(start, bytes);
        const samples: VideoSample[] = [];
        for (let i = first; i < end; i += 1) {
          const at = (video.offsets[i] ?? 0) - start;
          samples.push({
            data: data.subarray(at, at + (video.sizes[i] ?? 0)),
            time: video.times[i] ?? 0,
            key: video.keyframes[i] === 1,
          });
        }
        return samples;
      };
    },
  };
}

/** ISO/IEC 23091-2 (H.273) code points of the WebCodecs colour names. */
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const TRANSFER: Record<string, number> = {
  bt709: 1,
  smpte170m: 6,
  linear: 8,
  'iec61966-2-1': 13,
  pq: 16,
  hlg: 18,
};
const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };

/** The colour a Matroska track declares (its `Colour` element or the codec's), as code points. */
function colourOf(space: VideoColorSpaceInit): VideoColour | undefined {
  const transfer = space.transfer ? TRANSFER[space.transfer] : undefined;
  if (transfer === undefined) {
    return undefined;
  }
  return {
    primaries: (space.primaries ? PRIMARIES[space.primaries] : undefined) ?? 2,
    transfer,
    matrix: (space.matrix ? MATRIX[space.matrix] : undefined) ?? 2,
    fullRange: space.fullRange === true,
  };
}

/** The bytes of a `BufferSource`, without copying. */
function bytesOf(source: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!source) {
    return undefined;
  }
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

/**
 * A Matroska or WebM video: it has no sample table, so keyframes are looked up in its cues and
 * the samples read cluster by cluster as the player goes (ADR 0101). Nothing reads the file in
 * full: a 9 GB WebM costs two reads per keyframe lookup.
 */
async function openMatroska(read: RangeReader, size: () => number): Promise<VideoSource> {
  const source = new StreamSource({
    getSize: size,
    read: (start, end) => read(start, end - start),
  });
  const input = new Input({ source, formats: [MATROSKA, WEBM] });
  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    throw new Error('The video has no video track');
  }
  const config = await track.getDecoderConfig();
  if (!config) {
    throw new Error(`This system cannot decode ${track.codec ?? 'unknown'} video`);
  }
  const first = await track.getFirstTimestamp();
  const sink = new EncodedPacketSink(track);
  const keyPacket = async (time: number, metadataOnly: boolean) =>
    (await sink.getKeyPacket(first + time + TOLERANCE, { metadataOnly })) ?? sink.getFirstKeyPacket({ metadataOnly });
  const sample = (packet: EncodedPacket): VideoSample => ({
    data: packet.data,
    time: packet.timestamp - first,
    key: packet.type === 'key',
  });
  const description = bytesOf(config.description);
  const colour = colourOf(await track.getColorSpace());
  return {
    codec: config.codec,
    width: config.codedWidth ?? track.codedWidth,
    height: config.codedHeight ?? track.codedHeight,
    ...(description ? { description } : {}),
    ...(colour ? { colour } : {}),
    keyframeAt: async (time) => {
      const packet = await keyPacket(time, true);
      return packet ? packet.timestamp - first : 0;
    },
    samplesFrom: (keyframe) => {
      /** The last packet given; undefined before the first batch, null at the end. */
      let last: EncodedPacket | null | undefined;
      return async () => {
        const samples: VideoSample[] = [];
        let bytes = 0;
        while (last !== null && samples.length < VIDEO_SOURCE.maxBatchSamples && bytes < VIDEO_SOURCE.maxBatchBytes) {
          last = last === undefined ? await keyPacket(keyframe, false) : await sink.getNextPacket(last);
          if (last) {
            samples.push(sample(last));
            bytes += last.byteLength;
          }
        }
        return samples;
      };
    },
  };
}
