// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiFrame, Unsubscribe } from '@ridrs/ui-sdk';

/** Port to whatever paces frames: requestAnimationFrame in the shell, timers in tests. */
export interface FrameSource {
  /** Calls `callback` once at the next frame; returns a function that cancels that call. */
  request(callback: () => void): () => void;
}

export interface FrameClockOptions {
  readonly source: FrameSource;
  /** The host clock (epoch ms), read once per frame. */
  readonly now: () => number;
  /** A handler's first failure; `owner` is what it subscribed with (the shell: its plugin id). */
  readonly onError: (error: unknown, owner: string | undefined) => void;
}

interface Subscriber {
  readonly handler: (frame: UiFrame) => void;
  readonly owner: string | undefined;
  failed: boolean;
}

/**
 * One render loop. Runs its source only while a handler is subscribed; every handler of a frame
 * gets the same frame, in subscription order. A throwing handler is reported once and stays
 * subscribed; it never stops other handlers or later frames.
 */
export class FrameClock {
  private readonly subscribers: Subscriber[] = [];
  private cancel: (() => void) | undefined;
  private index = 0;

  constructor(private readonly options: FrameClockOptions) {}

  onFrame(handler: (frame: UiFrame) => void, owner?: string): Unsubscribe {
    const subscriber: Subscriber = { handler, owner, failed: false };
    this.subscribers.push(subscriber);
    this.cancel ??= this.options.source.request(() => this.tick());
    return () => {
      const at = this.subscribers.indexOf(subscriber);
      if (at < 0) {
        return;
      }
      this.subscribers.splice(at, 1);
      if (this.subscribers.length === 0) {
        this.cancel?.();
        this.cancel = undefined;
      }
    };
  }

  /** Whether a frame is requested from the source. */
  get running(): boolean {
    return this.cancel !== undefined;
  }

  private tick(): void {
    this.cancel = undefined;
    const frame: UiFrame = Object.freeze({ index: this.index, time: this.options.now() });
    this.index += 1;
    for (const subscriber of [...this.subscribers]) {
      if (!this.subscribers.includes(subscriber)) {
        continue;
      }
      try {
        subscriber.handler(frame);
      } catch (error) {
        if (!subscriber.failed) {
          subscriber.failed = true;
          this.options.onError(error, subscriber.owner);
        }
      }
    }
    if (this.subscribers.length > 0 && !this.cancel) {
      this.cancel = this.options.source.request(() => this.tick());
    }
  }
}

/**
 * A frame source on timers (fake or real), for tests and headless runs: frame k (k = 1, 2, …)
 * comes `round(k · 1000 / fps)` ms after the source starts, so frames never drift. A request
 * from outside a frame callback starts it anew.
 */
export function timerFrameSource(fps: number): FrameSource {
  let startedAt = 0;
  let frame = 0;
  let inCallback = false;
  return {
    request(callback) {
      if (!inCallback) {
        startedAt = Date.now();
        frame = 0;
      }
      frame += 1;
      const delay = Math.max(0, startedAt + Math.round((frame * 1000) / fps) - Date.now());
      const timer = setTimeout(() => {
        inCallback = true;
        try {
          callback();
        } finally {
          inCallback = false;
        }
      }, delay);
      return () => clearTimeout(timer);
    },
  };
}
