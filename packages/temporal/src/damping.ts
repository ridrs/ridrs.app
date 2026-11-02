// SPDX-License-Identifier: AGPL-3.0-or-later

import { TEMPORAL_DEFAULTS } from './defaults.ts';

// Damped trend after the last measurement: the rate of change is constant for T, then decays
// exponentially with τ = T, and is zero from 3 T. The estimate is x + v · D(Δ), where D is the
// integral of that rate profile (in units of "full-rate milliseconds").

/** D(Δ): how far the trend has carried the value Δ ms after the last measurement. */
export function dampedDistance(delta: number, interval: number): number {
  const tau = interval;
  const holdAt = TEMPORAL_DEFAULTS.holdAfterIntervals * interval;
  const d = Math.min(Math.max(delta, 0), holdAt);
  if (d <= interval) {
    return d;
  }
  return interval + tau * (1 - Math.exp(-(d - interval) / tau));
}

/** ∫₀^Δ D(s) ds in closed form; D is constant after 3 T. */
export function dampedDistanceIntegral(delta: number, interval: number): number {
  const tau = interval;
  const holdAt = TEMPORAL_DEFAULTS.holdAfterIntervals * interval;
  const d = Math.max(delta, 0);
  if (d <= interval) {
    return (d * d) / 2;
  }
  const u = Math.min(d, holdAt) - interval;
  const decaying =
    (interval * interval) / 2 + (interval + tau) * u + tau * tau * (Math.exp(-u / tau) - 1);
  if (d <= holdAt) {
    return decaying;
  }
  return decaying + dampedDistance(holdAt, interval) * (d - holdAt);
}

/**
 * The Δ at which D(Δ) reaches `distance`, or undefined if D never gets there (D stops at D(3 T)).
 * Used to split averages where an estimate hits the series minimum.
 */
export function dampedDistanceInverse(distance: number, interval: number): number | undefined {
  const tau = interval;
  if (distance < 0) {
    return undefined;
  }
  if (distance <= interval) {
    return distance;
  }
  const holdAt = TEMPORAL_DEFAULTS.holdAfterIntervals * interval;
  if (distance > dampedDistance(holdAt, interval)) {
    return undefined;
  }
  return interval - tau * Math.log(1 - (distance - interval) / tau);
}
