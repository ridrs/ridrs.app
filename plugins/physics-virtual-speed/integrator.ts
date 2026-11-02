// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Below `minimumDriveSpeed` the drive force is bounded: 200 W at standstill push with 200 N.
 * A road sample is valid while its gradient is finite and within ±`maximumGradient` (±30 %).
 */
export const VIRTUAL_SPEED_DEFAULTS = Object.freeze({ minimumDriveSpeed: 1, maximumGradient: 0.3 });

export function isValidGradient(gradient: number): boolean {
  return Number.isFinite(gradient) && Math.abs(gradient) <= VIRTUAL_SPEED_DEFAULTS.maximumGradient;
}

export interface IntegratorStep {
  /** Speed of the previous state, m/s. */
  readonly speed: number;
  /** Distance of the previous state, m. */
  readonly distance: number;
  /** kg */
  readonly mass: number;
  /** W, at the new state's time. */
  readonly wheelPower: number;
  /** Signed resistance at the previous speed, N. */
  readonly resistance: number;
  /** s */
  readonly dt: number;
}

export interface IntegratorResult {
  readonly speed: number;
  readonly distance: number;
  readonly acceleration: number;
  readonly driveForce: number;
}

/** F = P / v, bounded at standstill so that there is no division by zero or infinite start force. */
export function driveForce(wheelPower: number, speed: number): number {
  return wheelPower / Math.max(speed, VIRTUAL_SPEED_DEFAULTS.minimumDriveSpeed);
}

/**
 * One semi-implicit Euler step: forces from the previous speed, distance from the new one. Speed
 * never becomes negative, so a coasting rider comes to rest and stays there - also on a climb,
 * where gravity would pull backwards ("brakes held"; there is no reverse motion).
 */
export function integrate(step: IntegratorStep): IntegratorResult {
  const force = driveForce(step.wheelPower, step.speed);
  const acceleration = (force - step.resistance) / step.mass;
  const speed = Math.max(0, step.speed + acceleration * step.dt);
  return {
    speed,
    distance: step.distance + speed * step.dt,
    // The effective acceleration, after the clamp.
    acceleration: (speed - step.speed) / step.dt,
    driveForce: force,
  };
}
