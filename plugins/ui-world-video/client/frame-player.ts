// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SampleReader, VideoSource } from './video-source.ts';

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
  /** s a frame may lie after the shown time and still count as at it: rounding of µs timestamps. */
  tolerance: 1e-4,
});

/**
 * Shows a video frame by frame for the render clock (ADR 0061): `frameAt(time)` returns the
 * decoded frame with the latest time at or before `time`, or undefined while it is not decoded
 * yet (the last picture stays). It decodes ahead from where the times go, a short buffer at most;
 * when the time leaves what the decoder can reach in time (behind the buffer, or past a keyframe
 * that was not fed yet), it starts again at the last keyframe at or before the time.
 *
 * Where the keyframes are, the video source says (ADR 0101): an MP4's index at once, a Matroska
 * file's cues after a read. It is asked only when the time leaves what was fed.
 */
export class FramePlayer<F extends DecodedFrame> {
  private readonly decoder: FrameDecoder;
  private buffer: F[] = [];
  /** The samples to feed from the keyframe of the last start; undefined before the first start. */
  private samples: SampleReader | undefined;
  /** The first time the decoder can give since it started again. */
  private from = 0;
  /** The latest frame time (s) closed as left behind since the last start: before it, nothing is left. */
  private behind = Number.NEGATIVE_INFINITY;
  /** The latest keyframe fed since the last start, and the latest presentation time fed. */
  private fedKeyframe = Number.NEGATIVE_INFINITY;
  private fedUntil = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private fetching = false;
  private locating = false;
  private flushed = false;
  private failure: unknown;
  /** How often the decoder started again at a keyframe: a measure of how far it fell behind. */
  restarts = 0;

  constructor(
    private readonly video: VideoSource,
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
    if (this.samples === undefined || time < this.from - FRAME_PLAYER.tolerance || time > this.fedUntil) {
      this.locate(time);
    } else if (time < this.behind - FRAME_PLAYER.tolerance) {
      // Back within the keyframe's run, behind the frames already closed: from the keyframe again.
      this.samples = undefined;
      this.locate(time);
    }
    // Drop every frame before the one shown: they are behind the rider.
    let shown = -1;
    while ((this.buffer[shown + 1]?.timestamp ?? Number.POSITIVE_INFINITY) / 1e6 <= time + FRAME_PLAYER.tolerance) {
      shown += 1;
    }
    for (const frame of this.buffer.splice(0, Math.max(0, shown))) {
      this.behind = Math.max(this.behind, frame.timestamp / 1e6);
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

  /** Finds the keyframe of `time` and starts again there if the decoder cannot reach it in time. */
  private locate(time: number): void {
    const keyframe = this.video.keyframeAt(time);
    if (typeof keyframe === 'number') {
      this.decide(time, keyframe);
      return;
    }
    if (this.locating) {
      return;
    }
    this.locating = true;
    keyframe.then(
      (found) => {
        this.locating = false;
        if (this.failure === undefined) {
          this.decide(time, found);
          this.pump();
        }
      },
      (error: unknown) => {
        this.locating = false;
        this.failure = error;
      },
    );
  }

  private decide(time: number, keyframe: number): void {
    if (this.samples === undefined || time < this.from - FRAME_PLAYER.tolerance || keyframe > this.fedKeyframe) {
      this.restart(keyframe);
    }
  }

  private restart(keyframe: number): void {
    this.restarts += 1;
    this.generation += 1;
    for (const frame of this.buffer.splice(0)) {
      frame.close();
    }
    this.decoder.reset();
    this.decoder.configure();
    this.samples = this.video.samplesFrom(keyframe);
    this.from = keyframe;
    this.behind = Number.NEGATIVE_INFINITY;
    this.fedKeyframe = keyframe;
    this.fedUntil = Number.NEGATIVE_INFINITY;
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

  /** Reads and feeds the next samples while the buffer has room; one batch at a time. */
  private pump(): void {
    const { samples } = this;
    if (this.fetching || this.flushed || samples === undefined) {
      return;
    }
    if (this.buffer.length + this.decoder.decodeQueueSize >= FRAME_PLAYER.bufferAhead) {
      return;
    }
    const generation = this.generation;
    this.fetching = true;
    samples().then(
      (batch) => {
        if (generation !== this.generation) {
          return;
        }
        this.fetching = false;
        if (batch.length === 0) {
          // The decoder holds back the last frames until it knows no more come.
          this.flushed = true;
          this.decoder.flush().catch(() => undefined);
          return;
        }
        for (const sample of batch) {
          this.decoder.decode({ data: sample.data, timestamp: Math.round(sample.time * 1e6), key: sample.key });
          if (sample.key) {
            this.fedKeyframe = Math.max(this.fedKeyframe, sample.time);
          }
          this.fedUntil = Math.max(this.fedUntil, sample.time);
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
