// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiFrame } from '@ridrs/ui-sdk';
import FakeTimers from '@sinonjs/fake-timers';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameClock, type FrameSource, timerFrameSource } from './frame-clock.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

/** A source that fires only when the test says so. */
function manualSource() {
  let pending: (() => void) | undefined;
  let requests = 0;
  const source: FrameSource = {
    request(callback) {
      requests += 1;
      pending = callback;
      return () => {
        pending = undefined;
      };
    },
  };
  return {
    source,
    pending: () => pending !== undefined,
    requests: () => requests,
    fire() {
      const callback = pending;
      pending = undefined;
      callback?.();
    },
  };
}

function clockWith(source: FrameSource, now = () => T0) {
  const errors: Array<{ error: unknown; owner: string | undefined }> = [];
  const clock = new FrameClock({
    source,
    now,
    onError: (error, owner) => errors.push({ error, owner }),
  });
  return { clock, errors };
}

describe('FrameClock', () => {
  it('requests frames only while a handler is subscribed', () => {
    const manual = manualSource();
    const { clock } = clockWith(manual.source);
    expect(manual.requests()).toBe(0);
    const first = clock.onFrame(() => undefined);
    const second = clock.onFrame(() => undefined);
    expect(manual.requests()).toBe(1);
    manual.fire();
    expect(manual.pending()).toBe(true);
    first();
    expect(clock.running).toBe(true);
    second();
    expect(manual.pending()).toBe(false);
    expect(clock.running).toBe(false);
  });

  it('stops when the last handler unsubscribes inside a frame', () => {
    const manual = manualSource();
    const { clock } = clockWith(manual.source);
    const unsubscribe = clock.onFrame(() => unsubscribe());
    manual.fire();
    expect(manual.pending()).toBe(false);
    expect(clock.running).toBe(false);
  });

  it('gives every handler of a frame the same frame, in subscription order', () => {
    const manual = manualSource();
    let time = T0;
    const { clock } = clockWith(manual.source, () => {
      time += 7;
      return time;
    });
    const seen: string[] = [];
    const frames: UiFrame[] = [];
    clock.onFrame((frame) => {
      seen.push('a');
      frames.push(frame);
    });
    clock.onFrame((frame) => {
      seen.push('b');
      frames.push(frame);
    });
    manual.fire();
    manual.fire();
    expect(seen).toEqual(['a', 'b', 'a', 'b']);
    expect(frames.map((f) => [f.index, f.time - T0])).toEqual([
      [0, 7],
      [0, 7],
      [1, 14],
      [1, 14],
    ]);
    expect(Object.isFrozen(frames[0])).toBe(true);
  });

  it('reports a throwing handler once and keeps it and the others running', () => {
    const manual = manualSource();
    const { clock, errors } = clockWith(manual.source);
    let calls = 0;
    let others = 0;
    clock.onFrame(() => {
      calls += 1;
      throw new Error('broken frame');
    }, 'ui-broken');
    clock.onFrame(() => {
      others += 1;
    });
    manual.fire();
    manual.fire();
    manual.fire();
    expect(calls).toBe(3);
    expect(others).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.owner).toBe('ui-broken');
    expect(manual.pending()).toBe(true);
  });
});

describe('timerFrameSource', () => {
  let fake: ReturnType<typeof FakeTimers.install> | undefined;

  afterEach(() => {
    fake?.uninstall();
    fake = undefined;
  });

  it('schedules frame k at round(k · 1000 / fps) ms after it starts', () => {
    fake = FakeTimers.install({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { clock } = clockWith(timerFrameSource(60), () => Date.now());
    const times: number[] = [];
    clock.onFrame((frame) => times.push(frame.time - T0));
    fake.tick(1000);
    expect(times).toHaveLength(60);
    expect(times.slice(0, 4)).toEqual([17, 33, 50, 67]);
    expect(times.at(-1)).toBe(1000);
  });

  it('starts anew after it was stopped', () => {
    fake = FakeTimers.install({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { clock } = clockWith(timerFrameSource(30), () => Date.now());
    const times: number[] = [];
    const stop = clock.onFrame((frame) => times.push(frame.time - T0));
    fake.tick(100);
    stop();
    fake.tick(1000);
    expect(times).toEqual([33, 67, 100]);
    clock.onFrame((frame) => times.push(frame.time - T0));
    fake.tick(34);
    expect(times).toEqual([33, 67, 100, 1133]);
    expect(fake.countTimers()).toBe(1);
  });
});
