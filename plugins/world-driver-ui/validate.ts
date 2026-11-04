// SPDX-License-Identifier: AGPL-3.0-or-later

import { TERRAIN_SURFACES, type TerrainPreview, type TerrainSurface } from '@ridrs/contracts';

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
