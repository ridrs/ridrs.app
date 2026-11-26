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
  /** Decoder errors in a row without a frame in between after which the video stops for the ride. */
  maxDecodeFailures: 3,
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
 *
 * A sample the decoder cannot decode (a damaged stretch of a download) closes a WebCodecs decoder.
 * The player then leaves out the samples from that sample's keyframe to the next one for the rest
 * of the ride and goes on with a new decoder: the last picture holds only over the broken stretch
 * (broken-video.feature). A decoder that fails `maxDecodeFailures` times in a row without a frame in
 * between stops the player, as a failed read does.
 */
export class FramePlayer<F extends DecodedFrame> {
  private decoder: FrameDecoder;
  private buffer: F[] = [];
  /** Fed samples not decoded yet: their time (µs) and their keyframe's (s), in decode order. */
  private pending: { timestamp: number; keyframe: number }[] = [];
  /** The keyframe (s) of the run the last fed sample belongs to. */
  private feeding = Number.NEGATIVE_INFINITY;
  /** Keyframes (s) whose run the decoder could not decode: left out for the ride. */
  private readonly broken = new Set<number>();
  private readonly newlyBroken: number[] = [];
  /** The error of the current decoder, until a new one replaces it. */
  private decodeError: unknown;
  private decodeFailures = 0;
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
    private readonly createDecoder: (output: (frame: F) => void, error: (error: unknown) => void) => FrameDecoder,
  ) {
    this.decoder = this.newDecoder();
  }

  /** A configured decoder whose errors count only while it is the player's. */
  private newDecoder(): FrameDecoder {
    let decoder: FrameDecoder | undefined;
    decoder = this.createDecoder(
      (frame) => this.receive(frame, this.generation),
      (error) => {
        if (decoder === undefined || decoder === this.decoder) {
          this.decodeError ??= error;
        }
      },
    );
    decoder.configure();
    return decoder;
  }

  /** The keyframes (s) whose runs were left out since the last call, as the decoder could not decode them. */
  takeSkipped(): number[] {
    return this.newlyBroken.splice(0);
  }

  /** Why the player stopped, if it did. */
  get error(): unknown {
    return this.failure;
  }

  frameAt(time: number): F | undefined {
    if (this.decodeError !== undefined && this.failure === undefined) {
      this.recover();
    }
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

  /**
   * After a decoder error: leaves out the run of the sample that was not decoded and goes on with a
   * new decoder from the keyframe of the next shown time; stops after too many errors in a row.
   */
  private recover(): void {
    const error = this.decodeError;
    this.decodeError = undefined;
    this.decodeFailures += 1;
    if (this.decodeFailures >= FRAME_PLAYER.maxDecodeFailures) {
      this.failure = error;
      return;
    }
    const keyframe = this.pending[0]?.keyframe ?? this.feeding;
    if (Number.isFinite(keyframe) && !this.broken.has(keyframe)) {
      this.broken.add(keyframe);
      this.newlyBroken.push(keyframe);
    }
    this.generation += 1;
    for (const frame of this.buffer.splice(0)) {
      frame.close();
    }
    this.pending = [];
    this.decoder.close();
    this.decoder = this.newDecoder();
    // `locate` starts again at the keyframe of the time; the broken run is left out as it is fed.
    this.samples = undefined;
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
    this.pending = [];
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
    this.decodeFailures = 0;
    while ((this.pending[0]?.timestamp ?? Number.POSITIVE_INFINITY) <= frame.timestamp) {
      this.pending.shift();
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
    if (this.fetching || this.flushed || samples === undefined || this.decodeError !== undefined) {
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
          if (sample.key) {
            this.feeding = sample.time;
            this.fedKeyframe = Math.max(this.fedKeyframe, sample.time);
          }
          this.fedUntil = Math.max(this.fedUntil, sample.time);
          // A run the decoder could not decode is passed over up to the next keyframe.
          if (this.broken.has(this.feeding) || this.decodeError !== undefined) {
            continue;
          }
          const timestamp = Math.round(sample.time * 1e6);
          this.pending.push({ timestamp, keyframe: this.feeding });
          this.decoder.decode({ data: sample.data, timestamp, key: sample.key });
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
