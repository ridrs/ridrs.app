// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MotionCapability,
  MotionResult,
  PhysicsState,
  PhysicsStateBatch,
} from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { ENGINE_DEFAULTS, RideSimulation, stepTime } from './simulation.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

function result(at: number, speed = 0): MotionResult {
  return {
    at,
    speed,
    distance: 0,
    acceleration: 0,
    mass: 85,
    riderPower: { status: 'unavailable', at, reason: 'no-source' },
    wheelPower: 0,
    driveForce: 0,
    resistance: { total: 0, contributions: [] },
    road: { gradient: 0, origin: 'default' },
  };
}

/** A motion that only records the times it is asked for. */
function recordingMotion(times: number[]): MotionCapability {
  return {
    initial: (at) => {
      times.push(at);
      return result(at);
    },
    advance: (_previous, at) => {
      times.push(at);
      return result(at);
    },
  };
}

function simulation(
  times: number[] = [],
  published: PhysicsState[] = [],
  batches: PhysicsStateBatch[] = [],
) {
  return new RideSimulation('session', T0, recordingMotion(times), {
    state: (s) => published.push(s),
    batch: (b) => batches.push(b),
  });
}

/** The steps of each batch, e.g. [[0], [1, 2, 3, 4, 5]]. */
const stepsOf = (batches: PhysicsStateBatch[]) => batches.map((b) => b.samples.map((s) => s.step));

describe('stepTime', () => {
  it('computes step times from the index', () => {
    expect(stepTime(T0, 0)).toBe(T0);
    expect(stepTime(T0, 100)).toBe(T0 + 1000);
  });
});

describe('RideSimulation', () => {
  it('starts with step 0 at the ride start and publishes it', () => {
    const published: PhysicsState[] = [];
    simulation([], published);
    expect(published.map((s) => [s.step, s.at])).toEqual([[0, T0]]);
  });

  it('computes only steps that are due, never ahead of the clock', () => {
    const times: number[] = [];
    const sim = simulation(times);
    sim.advanceUntil(T0 + 9);
    expect(times).toEqual([T0]);
    sim.advanceUntil(T0 + 10);
    expect(times).toEqual([T0, T0 + 10]);
  });

  it('does not drift after 360 000 steps (one hour)', () => {
    const times: number[] = [];
    const sim = simulation(times);
    sim.advanceUntil(T0 + 3_600_000);
    expect(times).toHaveLength(360_001);
    expect(times.every((t, n) => t === T0 + 10 * n)).toBe(true);
    expect(sim.nextDueAt()).toBe(T0 + 3_600_010);
  });

  it('catches up in chunks of at most 1000 steps', () => {
    const times: number[] = [];
    const sim = simulation(times);
    const now = T0 + 25_000;
    expect(sim.advanceUntil(now, ENGINE_DEFAULTS.maxStepsPerWake)).toBe(true);
    expect(times).toHaveLength(1 + 1000);
    expect(sim.advanceUntil(now, ENGINE_DEFAULTS.maxStepsPerWake)).toBe(true);
    expect(sim.advanceUntil(now, ENGINE_DEFAULTS.maxStepsPerWake)).toBe(false);
    expect(times).toHaveLength(1 + 2500);
  });

  it('publishes every 25th step', () => {
    const published: PhysicsState[] = [];
    simulation([], published).advanceUntil(T0 + 1000);
    expect(published.map((s) => s.step)).toEqual([0, 25, 50, 75, 100]);
  });

  it('publishes the final state at finish, once', () => {
    const published: PhysicsState[] = [];
    const sim = simulation([], published);
    sim.finish(T0 + 1013);
    expect(published.map((s) => s.step)).toEqual([0, 25, 50, 75, 100, 101]);

    const onBoundary: PhysicsState[] = [];
    simulation([], onBoundary).finish(T0 + 250);
    expect(onBoundary.map((s) => s.step)).toEqual([0, 25]);
  });

  it('fails at the start when a contributor fails in step 0', () => {
    const motion: MotionCapability = {
      initial: () => {
        throw new Error('broken');
      },
      advance: (_previous, at) => result(at),
    };
    expect(
      () => new RideSimulation('s', T0, motion, { state: () => undefined, batch: () => undefined }),
    ).toThrow('broken');
  });
});

describe('RideSimulation batches', () => {
  it('starts with a batch of step 0, right after its state', () => {
    const order: string[] = [];
    new RideSimulation('session', T0, recordingMotion([]), {
      state: (s) => order.push(`state ${s.step}`),
      batch: (b) => order.push(`batch ${b.samples.map((s) => s.step).join(',')}`),
    });
    expect(order).toEqual(['state 0', 'batch 0']);
  });

  it('publishes every five steps the steps since the previous batch', () => {
    const batches: PhysicsStateBatch[] = [];
    const sim = simulation([], [], batches);
    sim.advanceUntil(T0 + 40);
    expect(stepsOf(batches)).toEqual([[0]]);
    sim.advanceUntil(T0 + 100);
    expect(stepsOf(batches)).toEqual([[0], [1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
    expect(batches.every((b) => b.sessionId === 'session')).toBe(true);
  });

  it('publishes the state of a 25th step before the batch that contains it', () => {
    const order: string[] = [];
    const sim = new RideSimulation('session', T0, recordingMotion([]), {
      state: (s) => order.push(`state ${s.step}`),
      batch: (b) => order.push(`batch ${b.samples.at(-1)?.step}`),
    });
    sim.advanceUntil(T0 + 250);
    expect(order.slice(-2)).toEqual(['state 25', 'batch 25']);
  });

  it('projects samples from the states, copying values', () => {
    const motion: MotionCapability = {
      initial: (at) => result(at),
      advance: (_previous, at) => ({
        ...result(at, (at - T0) / 100),
        distance: (at - T0) / 1000,
        acceleration: 0.5,
        road: { gradient: 0.05, origin: 'default' },
      }),
    };
    const batches: PhysicsStateBatch[] = [];
    new RideSimulation('session', T0, motion, {
      state: () => undefined,
      batch: (b) => batches.push(b),
    }).advanceUntil(T0 + 50);
    expect(batches[1]?.samples[4]).toEqual({
      step: 5,
      at: T0 + 50,
      speed: 0.5,
      distance: 0.05,
      acceleration: 0.5,
      gradient: 0.05,
    });
  });

  it('sends the remaining steps at finish, once', () => {
    const batches: PhysicsStateBatch[] = [];
    simulation([], [], batches).finish(T0 + 1020);
    expect(stepsOf(batches).at(-1)).toEqual([101, 102]);

    const onBoundary: PhysicsStateBatch[] = [];
    simulation([], [], onBoundary).finish(T0 + 1000);
    expect(stepsOf(onBoundary).at(-1)).toEqual([96, 97, 98, 99, 100]);
  });

  it.each([
    ENGINE_DEFAULTS.maxStepsPerWake,
    997,
  ])('keeps the batch boundaries across catch-up chunks of %i steps', (chunk) => {
    const batches: PhysicsStateBatch[] = [];
    const sim = simulation([], [], batches);
    const now = T0 + 25_030;
    // A chunk that is no multiple of 5 ends mid-batch; the batch boundaries must not move.
    let more = true;
    while (more) {
      more = sim.advanceUntil(now, chunk);
    }
    const steps = stepsOf(batches);
    expect(steps.flat()).toEqual(Array.from({ length: 2501 }, (_, n) => n));
    expect(steps.slice(1).every((b) => b.length === 5 && (b[4] ?? 0) % 5 === 0)).toBe(true);
    // 2501…2503 are computed but not yet due for a batch.
    expect(steps.at(-1)).toEqual([2496, 2497, 2498, 2499, 2500]);
  });

  it('discards unbatched steps when a step fails', () => {
    let calls = 0;
    const motion: MotionCapability = {
      initial: (at) => result(at),
      advance: (_previous, at) => {
        calls += 1;
        if (calls === 8) {
          throw new Error('broken');
        }
        return result(at);
      },
    };
    const batches: PhysicsStateBatch[] = [];
    const sim = new RideSimulation('session', T0, motion, {
      state: () => undefined,
      batch: (b) => batches.push(b),
    });
    expect(() => sim.advanceUntil(T0 + 100)).toThrow('broken');
    expect(stepsOf(batches)).toEqual([[0], [1, 2, 3, 4, 5]]);
  });
});
