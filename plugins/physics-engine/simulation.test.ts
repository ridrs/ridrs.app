// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MotionCapability, MotionResult, PhysicsState } from '@ridrs/contracts';
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

function simulation(times: number[] = [], published: PhysicsState[] = []) {
  return new RideSimulation('session', T0, recordingMotion(times), (s) => published.push(s));
}

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
    expect(() => new RideSimulation('s', T0, motion, () => undefined)).toThrow('broken');
  });
});
