// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { driveForce, integrate, isValidGradient } from './integrator.ts';

const dt = 0.01;

describe('driveForce', () => {
  it('is P / v above the minimum drive speed', () => {
    expect(driveForce(200, 4)).toBe(50);
  });

  it('is bounded below v_min = 1 m/s: 200 W push with 200 N at standstill', () => {
    expect(driveForce(200, 0)).toBe(200);
    expect(driveForce(200, 0.5)).toBe(200);
    expect(driveForce(200, 1)).toBe(200);
  });
});

describe('integrate (semi-implicit Euler)', () => {
  it('accelerates 85 kg from standstill with 200 W at 200/85 m/s²', () => {
    const next = integrate({ speed: 0, distance: 0, mass: 85, wheelPower: 200, resistance: 0, dt });
    expect(next.acceleration).toBeCloseTo(2.3529, 4);
    expect(next.speed).toBeCloseTo(0.023529, 6);
    // Distance from the new speed.
    expect(next.distance).toBeCloseTo(next.speed * dt, 12);
    expect(next.driveForce).toBe(200);
  });

  it('uses the previous speed for the forces', () => {
    const next = integrate({ speed: 10, distance: 0, mass: 85, wheelPower: 200, resistance: 20, dt });
    expect(next.driveForce).toBe(20);
    expect(next.acceleration).toBeCloseTo(0, 12);
  });

  it('clamps at 0 instead of rolling backwards, and reports the effective acceleration', () => {
    const next = integrate({
      speed: 0.001,
      distance: 100,
      mass: 85,
      wheelPower: 0,
      resistance: 34,
      dt,
    });
    expect(next.speed).toBe(0);
    expect(next.distance).toBe(100);
    expect(next.acceleration).toBeCloseTo(-0.1, 12);
  });

  it('stays at rest without power: no creeping distance', () => {
    let state = { speed: 0, distance: 0 };
    for (let i = 0; i < 1000; i += 1) {
      const next = integrate({ ...state, mass: 85, wheelPower: 0, resistance: 0, dt });
      state = { speed: next.speed, distance: next.distance };
    }
    expect(state).toEqual({ speed: 0, distance: 0 });
  });
});

describe('isValidGradient', () => {
  it('accepts finite gradients within ±30 %', () => {
    for (const gradient of [0, 0.05, -0.05, 0.3, -0.3]) {
      expect(isValidGradient(gradient)).toBe(true);
    }
  });

  it('rejects steeper and non-finite gradients', () => {
    for (const gradient of [0.30001, -0.30001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidGradient(gradient)).toBe(false);
    }
  });
});

describe('integrate on a climb', () => {
  it('keeps a rider without power at rest on 5 % for 10 000 steps ("brakes held")', () => {
    // Gravity of 85 kg on 5 %; rolling resistance is 0 at standstill.
    const gravity = 85 * 9.81 * Math.sin(Math.atan(0.05));
    let state = { speed: 0, distance: 0 };
    for (let i = 0; i < 10_000; i += 1) {
      const next = integrate({ ...state, mass: 85, wheelPower: 0, resistance: gravity, dt });
      state = { speed: next.speed, distance: next.distance };
    }
    expect(state).toEqual({ speed: 0, distance: 0 });
  });

  it('lets a rider without power start rolling downhill', () => {
    const gravity = 85 * 9.81 * Math.sin(Math.atan(-0.05));
    const next = integrate({ speed: 0, distance: 0, mass: 85, wheelPower: 0, resistance: gravity, dt });
    expect(next.speed).toBeGreaterThan(0);
  });
});
