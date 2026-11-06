// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  TERRAIN_SURFACES,
  type TerrainPreview,
  type TerrainSurface,
  type WorldPosition,
} from '@ridrs/contracts';

/** The steepest gradient a window may carry, either way: rise over run. */
export const MAX_GRADIENT = 0.3;

export type TerrainRejection =
  | 'invalid-origin'
  | 'origin-ahead-of-rider'
  | 'invalid-spacing'
  | 'too-few-samples'
  | 'invalid-gradient'
  | 'unknown-surface'
  | 'revision-not-ascending';

/** The raw window as a sensor published it: shape-checked only. */
export interface ObservedTerrain {
  readonly revision: number;
  readonly originDistance: number;
  readonly spacing: number;
  readonly samples: readonly { readonly gradient: number; readonly surface?: string }[];
}

export type TerrainValidation =
  | { readonly valid: true; readonly preview: TerrainPreview }
  | { readonly valid: false; readonly reason: TerrainRejection };

const isSurface = (surface: string): surface is TerrainSurface =>
  (TERRAIN_SURFACES as readonly string[]).includes(surface);

/**
 * Whether an observed window can become terrain: it starts at or behind the rider (`odometer`,
 * 0 between rides), on a positive grid, with at least two samples of a finite gradient within
 * ±30 % and a known surface, and a revision above the source's last one.
 */
export function validateTerrainWindow(
  window: ObservedTerrain,
  { odometer, lastRevision }: { readonly odometer: number; readonly lastRevision?: number },
): TerrainValidation {
  const reject = (reason: TerrainRejection) => ({ valid: false, reason }) as const;
  const { revision, originDistance, spacing, samples } = window;
  if (!(Number.isFinite(originDistance) && originDistance >= 0)) {
    return reject('invalid-origin');
  }
  if (originDistance > odometer) {
    return reject('origin-ahead-of-rider');
  }
  if (!(Number.isFinite(spacing) && spacing > 0)) {
    return reject('invalid-spacing');
  }
  if (samples.length < 2) {
    return reject('too-few-samples');
  }
  if (!samples.every(({ gradient }) => Number.isFinite(gradient) && Math.abs(gradient) <= MAX_GRADIENT)) {
    return reject('invalid-gradient');
  }
  if (!samples.every(({ surface }) => surface === undefined || isSurface(surface))) {
    return reject('unknown-surface');
  }
  if (!(Number.isInteger(revision) && revision > (lastRevision ?? 0))) {
    return reject('revision-not-ascending');
  }
  return { valid: true, preview: window as TerrainPreview };
}

export type PositionRejection =
  | 'invalid-distance'
  | 'distance-ahead-of-rider'
  | 'invalid-latitude'
  | 'invalid-longitude'
  | 'invalid-altitude';

/** The raw position as a sensor published it: shape-checked only. */
export interface ObservedPosition {
  readonly distance: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude?: number;
}

export type PositionValidation =
  | { readonly valid: true; readonly position: WorldPosition }
  | { readonly valid: false; readonly reason: PositionRejection };

/**
 * Whether an observed position can become the rider's: at or behind the rider (`odometer`, 0
 * between rides) like a terrain window, on the earth, and with a finite altitude if it has one.
 */
export function validatePosition(
  position: ObservedPosition,
  { odometer }: { readonly odometer: number },
): PositionValidation {
  const reject = (reason: PositionRejection) => ({ valid: false, reason }) as const;
  const { distance, latitude, longitude, altitude } = position;
  if (!(Number.isFinite(distance) && distance >= 0)) {
    return reject('invalid-distance');
  }
  if (distance > odometer) {
    return reject('distance-ahead-of-rider');
  }
  if (!(Number.isFinite(latitude) && Math.abs(latitude) <= 90)) {
    return reject('invalid-latitude');
  }
  if (!(Number.isFinite(longitude) && Math.abs(longitude) <= 180)) {
    return reject('invalid-longitude');
  }
  if (altitude !== undefined && !Number.isFinite(altitude)) {
    return reject('invalid-altitude');
  }
  return { valid: true, position: position as WorldPosition };
}
