// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';

/**
 * A video's samples as the decoder needs them (ADR 0061): where each lies in the file, in decode
 * order, when it is shown and whether it is a keyframe. Typed arrays: a long route has 300 000.
 */
export interface VideoIndex {
  /** The WebCodecs codec string, e.g. `avc1.64001f` or `av01.0.05M.08`. */
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  /** The codec configuration record (`avcC`, `av1C`, …) without its box header; none for some codecs. */
  readonly description?: Uint8Array;
  /** Byte offset in the file, per sample in decode order. */
  readonly offsets: Float64Array;
  readonly sizes: Uint32Array;
  /** s from the first shown frame, per sample in decode order. */
  readonly times: Float64Array;
  /** 1 for a keyframe. */
  readonly keyframes: Uint8Array;
}

/** Fetches `length` bytes of the file from `offset`. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** Reads byte ranges of a file served over HTTP; nothing past its end. */
export function httpRangeReader(url: string): RangeReader {
  return async (offset, length) => {
    const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (response.status === 416) {
      // From the end of the file on there is nothing.
      return new Uint8Array();
    }
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

/** The file's top-level boxes, from their headers alone: the media data is never read. */
async function topLevelBoxes(read: RangeReader): Promise<{ type: string; offset: number; size: number }[]> {
  const boxes: { type: string; offset: number; size: number }[] = [];
  for (let offset = 0; ; ) {
    const header = await read(offset, 16);
    if (header.length < 8) {
      return boxes;
    }
    const view = new DataView(header.buffer, header.byteOffset, header.length);
    const type = String.fromCharCode(...header.subarray(4, 8));
    let size = view.getUint32(0);
    if (size === 1) {
      size = Number(view.getBigUint64(8));
    }
    if (size === 0) {
      // To the end of the file: nothing after it.
      boxes.push({ type, offset, size: Number.POSITIVE_INFINITY });
      return boxes;
    }
    if (size < 8) {
      throw new Error(`Broken box "${type}" at ${offset}`);
    }
    boxes.push({ type, offset, size });
    offset += size;
  }
}

/** The configuration record of a sample entry, as WebCodecs takes it: the box without its header. */
function descriptionOf(entry: Record<string, unknown>): Uint8Array | undefined {
  const box = (entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC) as
    | { write(stream: DataStream): void }
    | undefined;
  if (!box) {
    return undefined;
  }
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8);
}

/**
 * Reads the index of the first video track: only `ftyp` and `moov` are fetched, wherever `moov`
 * lies. Sample offsets are positions in the file, so the samples are then read by range.
 */
export async function readVideoIndex(read: RangeReader): Promise<VideoIndex> {
  const boxes = await topLevelBoxes(read);
  const moov = boxes.find((box) => box.type === 'moov');
  if (!moov) {
    throw new Error('The video has no sample table (moov)');
  }
  const parts = await Promise.all(
    boxes.filter((box) => box.type === 'ftyp' || box.type === 'moov').map((box) => read(box.offset, box.size)),
  );
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => {
    joined.set(part, at);
    return at + part.length;
  }, 0);

  const file = createFile();
  let ready = false;
  file.onReady = () => {
    ready = true;
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(joined.buffer, 0));
  file.flush();
  const info = file.getInfo();
  const track = info.videoTracks[0];
  if (!ready || !track) {
    throw new Error('The video has no video track');
  }
  const samples = file.getTrackById(track.id).samples ?? [];
  const firstShown = Math.min(...samples.slice(0, 64).map((sample) => sample.cts));
  const offsets = new Float64Array(samples.length);
  const sizes = new Uint32Array(samples.length);
  const times = new Float64Array(samples.length);
  const keyframes = new Uint8Array(samples.length);
  samples.forEach((sample, i) => {
    offsets[i] = sample.offset;
    sizes[i] = sample.size;
    times[i] = (sample.cts - firstShown) / sample.timescale;
    keyframes[i] = sample.is_sync ? 1 : 0;
  });
  const entry = samples[0]?.description as unknown as Record<string, unknown> | undefined;
  return {
    codec: track.codec,
    width: track.video?.width ?? track.track_width,
    height: track.video?.height ?? track.track_height,
    description: entry ? descriptionOf(entry) : undefined,
    offsets,
    sizes,
    times,
    keyframes,
  };
}
