// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RangeReader, VideoIndex } from './video-index.ts';

/** What the player needs of a WebCodecs `VideoDecoder`; tests pass a fake. */
export interface FrameDecoder {
  readonly decodeQueueSize: number;
  configure(): void;
  decode(chunk: { readonly data: Uint8Array; readonly timestamp: number; readonly key: boolean }): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

/** A decoded frame: its presentation time (µs, as the chunk carried it) and how to release it. */
export interface DecodedFrame {
  readonly timestamp: number;
  close(): void;
}

export const FRAME_PLAYER = Object.freeze({
  /** Decoded frames kept ahead of the shown one, plus those in the decoder: about 1 s at 30 fps. */
  bufferAhead: 30,
  /** Bytes per range request at most; samples of a request are contiguous in the file. */
  maxBatchBytes: 4 * 1024 * 1024,
  /** Samples per range request at most. */
  maxBatchSamples: 30,
  /** s a frame may lie after the shown time and still count as at it: rounding of µs timestamps. */
  tolerance: 1e-4,
});

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
 * The sample in decode order with the latest time at or before `time`. Decode order and
 * presentation order differ only within a few frames, so it searches the presentation times by
 * bisection on decode order and then looks around.
 */
function sampleAt(video: VideoIndex, time: number): number {
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
  let best = low;
  for (let i = Math.max(0, low - 8); i < Math.min(times.length, low + 8); i += 1) {
    const t = times[i] ?? 0;
    if (t <= time + FRAME_PLAYER.tolerance && t > (times[best] ?? 0)) {
      best = i;
    }
  }
  return best;
}

/**
 * Shows a video frame by frame for the render clock (ADR 0061): `frameAt(time)` returns the
 * decoded frame with the latest time at or before `time`, or undefined while it is not decoded
 * yet (the last picture stays). It decodes ahead from where the times go, a short buffer at most;
 * when the time leaves what the decoder can reach in time (behind the buffer, or past a keyframe
 * that was not fed yet), it starts again at the last keyframe at or before the time.
 */
export class FramePlayer<F extends DecodedFrame> {
  private readonly decoder: FrameDecoder;
  private buffer: F[] = [];
  /** The next sample to feed, in decode order; undefined before the first frame is asked for. */
  private next: number | undefined;
  /** The first time the decoder can give since it started again. */
  private from = 0;
  private generation = 0;
  private fetching = false;
  private flushed = false;
  private failure: unknown;
  /** How often the decoder started again at a keyframe: a measure of how far it fell behind. */
  restarts = 0;

  constructor(
    private readonly video: VideoIndex,
    private readonly read: RangeReader,
    createDecoder: (output: (frame: F) => void, error: (error: unknown) => void) => FrameDecoder,
  ) {
    this.decoder = createDecoder(
      (frame) => this.receive(frame, this.generation),
      (error) => {
        this.failure = error;
      },
    );
    this.decoder.configure();
  }

  /** Why the player stopped, if it did. */
  get error(): unknown {
    return this.failure;
  }

  frameAt(time: number): F | undefined {
    if (this.failure !== undefined) {
      return undefined;
    }
    const target = sampleAt(this.video, time);
    const keyframe = keyframeAtOrBefore(this.video, target);
    if (this.next === undefined || time < this.from - FRAME_PLAYER.tolerance || keyframe >= this.next) {
      this.restart(keyframe);
    }
    // Drop every frame before the one shown: they are behind the rider.
    let shown = -1;
    while ((this.buffer[shown + 1]?.timestamp ?? Number.POSITIVE_INFINITY) / 1e6 <= time + FRAME_PLAYER.tolerance) {
      shown += 1;
    }
    for (const frame of this.buffer.splice(0, Math.max(0, shown))) {
      frame.close();
    }
    this.pump();
    return shown >= 0 ? this.buffer[0] : undefined;
  }

  close(): void {
    this.generation += 1;
    for (const frame of this.buffer.splice(0)) {
      frame.close();
    }
    this.decoder.close();
  }

  private restart(keyframe: number): void {
    this.restarts += 1;
    this.generation += 1;
    for (const frame of this.buffer.splice(0)) {
      frame.close();
    }
    this.decoder.reset();
    this.decoder.configure();
    this.next = keyframe;
    this.from = this.video.times[keyframe] ?? 0;
    this.fetching = false;
    this.flushed = false;
  }

  private receive(frame: F, generation: number): void {
    if (generation !== this.generation) {
      frame.close();
      return;
    }
    // Frames come out in presentation order; inserting sorted keeps it so whatever the decoder does.
    let at = this.buffer.length;
    while (at > 0 && (this.buffer[at - 1]?.timestamp ?? 0) > frame.timestamp) {
      at -= 1;
    }
    this.buffer.splice(at, 0, frame);
  }

  /** Reads and feeds the next samples while the buffer has room; one range request at a time. */
  private pump(): void {
    const { video } = this;
    const count = video.offsets.length;
    if (this.fetching || this.next === undefined) {
      return;
    }
    if (this.buffer.length + this.decoder.decodeQueueSize >= FRAME_PLAYER.bufferAhead) {
      return;
    }
    const first = this.next;
    if (first >= count) {
      if (!this.flushed) {
        // The decoder holds back the last frames until it knows no more come.
        this.flushed = true;
        this.decoder.flush().catch(() => undefined);
      }
      return;
    }
    let end = first + 1;
    let bytes = video.sizes[first] ?? 0;
    while (
      end < count &&
      end - first < FRAME_PLAYER.maxBatchSamples &&
      (video.offsets[end] ?? 0) >= (video.offsets[end - 1] ?? 0) &&
      (video.offsets[end] ?? 0) + (video.sizes[end] ?? 0) - (video.offsets[first] ?? 0) <= FRAME_PLAYER.maxBatchBytes
    ) {
      bytes = (video.offsets[end] ?? 0) + (video.sizes[end] ?? 0) - (video.offsets[first] ?? 0);
      end += 1;
    }
    const generation = this.generation;
    const start = video.offsets[first] ?? 0;
    this.fetching = true;
    this.next = end;
    this.read(start, bytes).then(
      (data) => {
        if (generation !== this.generation) {
          return;
        }
        this.fetching = false;
        for (let i = first; i < end; i += 1) {
          const at = (video.offsets[i] ?? 0) - start;
          this.decoder.decode({
            data: data.subarray(at, at + (video.sizes[i] ?? 0)),
            timestamp: Math.round((video.times[i] ?? 0) * 1e6),
            key: video.keyframes[i] === 1,
          });
        }
        this.pump();
      },
      (error: unknown) => {
        if (generation === this.generation) {
          this.failure = error;
        }
      },
    );
  }
}
