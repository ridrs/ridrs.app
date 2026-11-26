// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DecodedFrame, FramePlayer } from './frame-player.ts';
import type { SampleReader, VideoSource } from './video-source.ts';

/**
 * A refined stretch's video on the video's time (ADR 0109): the stretch's file starts at its time
 * 0, which is `from` s of the video. Keyframes and samples are moved by `from`, so its frame player
 * works on the video's time and its frames carry it.
 */
export function shiftedSource(video: VideoSource, from: number): VideoSource {
  return {
    ...video,
    keyframeAt: (time) => {
      const keyframe = video.keyframeAt(Math.max(0, time - from));
      return typeof keyframe === 'number' ? keyframe + from : keyframe.then((found) => found + from);
    },
    samplesFrom: (keyframe): SampleReader => {
      const samples = video.samplesFrom(keyframe - from);
      return async () => (await samples()).map((sample) => ({ ...sample, time: sample.time + from }));
    },
  };
}

/** A refined stretch for the player: from `from` s to `to` s of the video, its frame player once opened. */
export interface RefinedStretchPlayer<F extends DecodedFrame> {
  readonly from: number;
  readonly to: number;
  /** Opens the stretch's file; a stretch that cannot be opened is left out. */
  open(): Promise<FramePlayer<F>>;
}

export const REFINED_PLAYER = Object.freeze({
  /** s before a stretch that it is opened and decoded, and before its end that the video is. */
  lookahead: 2,
  /** s a stretch is kept open after the rider left it, either way. */
  keep: 2,
});

type State<F extends DecodedFrame> =
  | { readonly status: 'closed' }
  | { readonly status: 'opening' }
  | { readonly status: 'open'; readonly player: FramePlayer<F> }
  | { readonly status: 'failed'; readonly reason: unknown };

/**
 * Shows a route's video with its refined stretches (ADR 0109): the frame at `time` from the
 * stretch that covers it, and from the video everywhere else, each by its own frame player (ADR
 * 0061). A stretch is opened and decoded `lookahead` s before the rider reaches it; within it, the
 * video is decoded from the stretch's end `lookahead` s before the rider gets there. Until a
 * stretch has its frame, the video's stands in. A stretch whose file fails is left out for the ride.
 */
export class RefinedFramePlayer<F extends DecodedFrame> {
  private readonly states: State<F>[];
  /** Why stretches were left out, by their index; read once each by `takeFailures`. */
  private readonly failures: { index: number; reason: unknown }[] = [];

  constructor(
    private readonly video: FramePlayer<F>,
    private readonly stretches: readonly RefinedStretchPlayer<F>[],
  ) {
    this.states = stretches.map(() => ({ status: 'closed' }));
  }

  get error(): unknown {
    return this.video.error;
  }

  get restarts(): number {
    return this.video.restarts;
  }

  /** The video's keyframes (s) whose runs were left out since the last call (broken-video.feature). */
  takeSkipped(): number[] {
    return this.video.takeSkipped();
  }

  frameAt(time: number): F | undefined {
    const current = this.stretches.findIndex(
      (stretch, i) => time >= stretch.from && time < stretch.to && this.states[i]?.status !== 'failed',
    );
    const next = this.stretches.findIndex(
      (stretch, i) =>
        stretch.from > time && stretch.from - time <= REFINED_PLAYER.lookahead && this.states[i]?.status !== 'failed',
    );
    this.release(time);
    if (next >= 0) {
      this.prime(next, this.stretches[next]?.from ?? time);
    }
    if (current >= 0) {
      const stretch = this.stretches[current] as RefinedStretchPlayer<F>;
      const frame = this.frameOf(current, time);
      if (frame) {
        // The video from the stretch's end, unless another stretch begins there. Only while the
        // stretch shows: where the video stands in, it is decoded at `time`, not at the end.
        if (stretch.to - time <= REFINED_PLAYER.lookahead && !this.stretches.some((s) => s.from === stretch.to)) {
          this.video.frameAt(stretch.to);
        }
        return frame;
      }
    }
    return this.video.frameAt(time);
  }

  /** The stretches left out since the last call, with why. */
  takeFailures(): { index: number; reason: unknown }[] {
    return this.failures.splice(0);
  }

  close(): void {
    this.states.forEach((state, i) => {
      if (state.status === 'open') {
        state.player.close();
      }
      this.states[i] = { status: 'closed' };
    });
    this.video.close();
  }

  /** Opens stretch `i` if it is not, and decodes it towards `time`. */
  private prime(i: number, time: number): void {
    this.frameOf(i, time);
  }

  /** The frame of stretch `i` at `time`, opening it first; undefined until it has one. */
  private frameOf(i: number, time: number): F | undefined {
    const state = this.states[i];
    if (state?.status === 'closed') {
      this.states[i] = { status: 'opening' };
      (this.stretches[i] as RefinedStretchPlayer<F>).open().then(
        (player) => {
          if (this.states[i]?.status === 'opening') {
            this.states[i] = { status: 'open', player };
          } else {
            player.close();
          }
        },
        (reason: unknown) => this.fail(i, reason),
      );
      return undefined;
    }
    if (state?.status !== 'open') {
      return undefined;
    }
    const frame = state.player.frameAt(time);
    if (state.player.error !== undefined) {
      this.fail(i, state.player.error);
      return undefined;
    }
    return frame;
  }

  private fail(i: number, reason: unknown): void {
    const state = this.states[i];
    if (state?.status === 'open') {
      state.player.close();
    }
    this.states[i] = { status: 'failed', reason };
    this.failures.push({ index: i, reason });
  }

  /** Closes the stretches the rider is far from: behind them, or well before them. */
  private release(time: number): void {
    this.states.forEach((state, i) => {
      const stretch = this.stretches[i] as RefinedStretchPlayer<F>;
      const far =
        time > stretch.to + REFINED_PLAYER.keep || time < stretch.from - REFINED_PLAYER.lookahead - REFINED_PLAYER.keep;
      if (far && state.status === 'open') {
        state.player.close();
        this.states[i] = { status: 'closed' };
      } else if (far && state.status === 'opening') {
        this.states[i] = { status: 'closed' };
      }
    });
  }
}
