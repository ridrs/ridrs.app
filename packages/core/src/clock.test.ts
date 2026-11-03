// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  defineEvent,
  definePlugin,
  type EventEnvelope,
  type PluginContext,
} from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createBundledPluginSource,
  LiveClock,
  PluginHost,
  ReplayClock,
  type TimerPort,
} from './index.ts';

const T0 = 1_000_000;

/** A hand-driven monotonic time source and timer port: wakes happen only when a test says so. */
function manualTime(start = T0) {
  let now = start;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  const port: TimerPort = {
    setTimeout: (callback, delay) => {
      const id = next;
      next += 1;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    source: { now: () => now },
    port,
    /** Moves the time source without waking anything: a busy or blocked event loop. */
    set: (time: number) => {
      now = time;
    },
    /** Fires the wake-ups that are due now, as the event loop would once it is free. */
    fire: () => {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    armed: () => timers.size,
  };
}

describe('LiveClock', () => {
  it('keeps the logical time of a turn while computing takes time', () => {
    const time = manualTime();
    const clock = new LiveClock({ timeSource: time.source, timers: time.port });
    const seen: number[] = [];
    clock.enqueueInput(() => {
      seen.push(clock.now());
      time.set(T0 + 7); // the turn computes for 7 ms
      seen.push(clock.now());
    });
    expect(seen).toEqual([T0, T0]);
  });

  it('runs a late task at its planned time, and a periodic one on its plan', () => {
    const time = manualTime();
    const clock = new LiveClock({ timeSource: time.source, timers: time.port });
    const once: number[] = [];
    const every: number[] = [];
    clock.scheduleAt(T0 + 10, () => once.push(clock.now()));
    clock.scheduleEvery(25, () => every.push(clock.now()));
    time.set(T0 + 63); // the wake comes 53 ms late
    time.fire();
    expect(once).toEqual([T0 + 10]);
    expect(every).toEqual([T0 + 25, T0 + 50]);
  });

  it('runs tasks due at an input’s time before the input, whether it woke already or not', async () => {
    for (const wokeFirst of [true, false]) {
      const time = manualTime();
      const clock = new LiveClock({ timeSource: time.source, timers: time.port });
      const order: string[] = [];
      clock.scheduleAt(T0 + 10, () => order.push(`task@${clock.now()}`));
      time.set(T0 + 10);
      if (wokeFirst) {
        time.fire();
      }
      // The input arrives in a later event-loop task than the scheduling.
      await Promise.resolve();
      clock.enqueueInput(() => order.push(`input@${clock.now()}`));
      time.fire();
      expect(order, `woke first: ${wokeFirst}`).toEqual([`task@${T0 + 10}`, `input@${T0 + 10}`]);
    }
  });

  it('keeps inputs with the same time in their order of arrival, and never moves them', () => {
    const time = manualTime();
    const clock = new LiveClock({ timeSource: time.source, timers: time.port });
    const order: string[] = [];
    clock.enqueueInput(() => {
      order.push(`a@${clock.now()}`);
      // An input that arrives during a turn waits for it, with its own (same) time.
      clock.enqueueInput(() => order.push(`c@${clock.now()}`));
    });
    clock.enqueueInput(() => order.push(`b@${clock.now()}`));
    expect(order).toEqual([`a@${T0}`, `c@${T0}`, `b@${T0}`]);
  });

  it('catches up in chunks: an input that arrives meanwhile waits for the tasks due before it', async () => {
    const time = manualTime();
    const clock = new LiveClock({ timeSource: time.source, timers: time.port, turnsPerChunk: 3 });
    const log: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      clock.scheduleAt(T0 + 10 * i, () => log.push(`step@${clock.now() - T0}`));
    }
    time.set(T0 + 100);
    time.fire(); // three steps, then a yield
    expect(log).toEqual(['step@10', 'step@20', 'step@30']);
    await Promise.resolve();
    clock.enqueueInput(() => log.push(`input@${clock.now() - T0}`));
    time.fire();
    expect(log).toEqual(['step@10', 'step@20', 'step@30', 'step@40', 'step@50', 'input@100']);
  });

  it('places work for a past time at the current time, never in the past', () => {
    const time = manualTime();
    const clock = new LiveClock({ timeSource: time.source, timers: time.port });
    const seen: number[] = [];
    clock.enqueueInput(() => clock.scheduleAt(T0 - 500, () => seen.push(clock.now())));
    time.fire();
    expect(seen).toEqual([T0]);
  });

  it('arms no timer without tasks', () => {
    const time = manualTime();
    const clock = new LiveClock({ timeSource: time.source, timers: time.port });
    const id = clock.scheduleAt(T0 + 10, () => undefined);
    expect(time.armed()).toBe(1);
    clock.cancel(id);
    expect(time.armed()).toBe(0);
  });
});

describe('ReplayClock', () => {
  it('runs recorded inputs at their times, after the tasks due by then, in the live order', () => {
    const clock = new ReplayClock(T0);
    const order: string[] = [];
    clock.scheduleEvery(10, () => order.push(`task@${clock.now() - T0}`));
    clock.enqueueInput(() => order.push(`input@${clock.now() - T0}`), T0 + 20);
    clock.enqueueInput(() => order.push(`input@${clock.now() - T0}`), T0 + 25);
    expect(order).toEqual([]);
    clock.advanceTo(T0 + 30);
    expect(order).toEqual(['task@10', 'task@20', 'input@20', 'input@25', 'task@30']);
  });
});

const ping = defineEvent('demo.ping', z.object({ n: z.number() }));

async function hostWith(definition: ReturnType<typeof definePlugin>, types = ['test']) {
  const time = manualTime();
  const host = new PluginHost({
    sources: [
      createBundledPluginSource({
        manifests: {
          'plugins/probe/manifest.json': JSON.stringify({
            id: 'probe',
            name: 'probe',
            version: '1.0.0',
            types,
            provides: [],
            requires: [],
            entry: 'index.ts',
          }),
        },
        modules: { 'plugins/probe/index.ts': async () => ({ default: definition }) },
      }),
    ],
    timeSource: time.source,
  });
  const seen: EventEnvelope[] = [];
  host.observe('test', { onEvent: (e) => seen.push(e) });
  await host.start();
  const ctx = host.getPluginContext('probe') as PluginContext;
  return { host, ctx, seen, time };
}

describe('turns in the host', () => {
  it('refuses a publish from asynchronous work, and accepts it as an input', async () => {
    const { ctx, seen, host } = await hostWith(definePlugin({}));
    await Promise.resolve();
    expect(() => ctx.events.publish(ping, { n: 1 })).toThrowError(
      expect.objectContaining({ code: 'outside-turn' }),
    );
    ctx.inputs.accept(ping, { n: 2 });
    const published = seen.filter((e) => e.type === ping.id);
    expect(published).toMatchObject([{ payload: { n: 2 }, input: true }]);
    await host.dispose();
  });

  it('accepts publications of input-side plugins outside a turn as inputs', async () => {
    const { ctx, seen, host } = await hostWith(definePlugin({}), ['transport']);
    ctx.events.publish(ping, { n: 1 });
    expect(seen.filter((e) => e.type === ping.id)).toMatchObject([{ input: true }]);
    await host.dispose();
  });

  it('gives a cascade one timestamp, numbers envelopes and derives ids from the run', async () => {
    const pong = defineEvent('demo.pong', z.object({ n: z.number() }));
    let advance: (() => void) | undefined;
    const { ctx, seen, host, time } = await hostWith(
      definePlugin({
        start(c) {
          c.events.subscribe(ping, ({ payload }) => {
            advance?.();
            c.events.publish(pong, { n: payload.n });
          });
        },
      }),
    );
    advance = () => time.set(T0 + 5);
    ctx.inputs.accept(ping, { n: 1 });
    const cascade = seen.filter((e) => e.type === ping.id || e.type === pong.id);
    expect(cascade.map((e) => e.timestamp)).toEqual([T0, T0]);
    expect(cascade[1]?.seq).toBe((cascade[0]?.seq ?? 0) + 1);
    const runId = host.describe().runId;
    expect(cascade[0]?.id).toBe(`${runId}:in:1`);
    expect(cascade[1]?.id).toBe(`${runId}:probe:${T0}:0`);
    await host.dispose();
  });

  it('cancels the tasks of a plugin when it stops', async () => {
    const ran: number[] = [];
    const { host, time } = await hostWith(
      definePlugin({
        start(c) {
          c.clock.scheduleEvery(10, () => ran.push(c.clock.now()));
        },
      }),
    );
    time.set(T0 + 20);
    host.input(() => undefined);
    expect(ran).toEqual([T0 + 10, T0 + 20]);
    await host.stopPlugin('probe');
    expect(host.pendingTasks()).toBe(0);
    await host.dispose();
  });
});
