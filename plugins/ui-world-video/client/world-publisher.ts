// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ActivityState } from '@ridrs/contracts';
import type { PresentedPhysics } from '@ridrs/presentation';
import { gradientAt, placeAt, type Track } from './track.ts';

/** As the demo landscape's (world-plugins.md, "Choosing the numbers"). */
export const TERRAIN_WINDOW = Object.freeze({ windowLength: 20, spacing: 1, republishBelow: 10 });

/** m the rider moves between two positions: at most one every second up to 18 km/h. */
export const POSITION_SPACING = 5;

export interface TerrainWindow {
  readonly revision: number;
  readonly originDistance: number;
  readonly spacing: number;
  readonly samples: readonly { readonly gradient: number }[];
}

export interface ObservedPosition {
  readonly distance: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number;
}

/** The terrain of the route from the grid point at or before `distance`, `windowLength` m ahead. */
export function terrainWindow(track: Track, distance: number): Omit<TerrainWindow, 'revision'> {
  const { windowLength, spacing } = TERRAIN_WINDOW;
  const originDistance = Math.floor(distance / spacing) * spacing;
  return {
    originDistance,
    spacing,
    samples: Array.from({ length: Math.round(windowLength / spacing) + 1 }, (_, i) => ({
      gradient: gradientAt(track, originDistance + i * spacing),
    })),
  };
}

/** Where the rider is at `distance` on the route. */
export function positionAt(track: Track, distance: number): ObservedPosition {
  const place = placeAt(track, distance);
  return { distance, latitude: place.latitude, longitude: place.longitude, altitude: place.elevation };
}

/**
 * What the video world tells the host (world-plugins.md): the terrain window from 0 m as soon as
 * the route is there, then a window from the presented position of the running ride whenever less
 * than `republishBelow` m of the last one are left ahead, and a position with the ride's first
 * state and then every `POSITION_SPACING` m. Positions lie at the presented distance, at or
 * behind the rider. At standstill nothing goes out.
 */
export class WorldPublisher {
  private revision = 0;
  private window: TerrainWindow | undefined;
  private positioned: number | undefined;
  private ride: string | undefined;

  constructor(
    private readonly track: Track,
    private readonly publish: {
      readonly terrain: (window: TerrainWindow) => void;
      readonly position: (position: ObservedPosition) => void;
    },
  ) {}

  mount(): void {
    this.sendTerrain(0);
  }

  rideState(state: ActivityState): void {
    this.ride = state.state === 'running' ? state.sessionId : undefined;
  }

  frame(shown: PresentedPhysics): void {
    if (this.ride === undefined || shown.status !== 'available' || shown.sessionId !== this.ride) {
      return;
    }
    const { distance } = shown;
    const window = this.window;
    const left = window
      ? window.originDistance + (window.samples.length - 1) * window.spacing - distance
      : Number.NEGATIVE_INFINITY;
    if (left < TERRAIN_WINDOW.republishBelow) {
      this.sendTerrain(distance);
    }
    if (this.positioned === undefined || Math.abs(distance - this.positioned) >= POSITION_SPACING) {
      this.sendPosition(distance);
    }
  }

  private sendTerrain(distance: number): void {
    this.revision += 1;
    this.window = { revision: this.revision, ...terrainWindow(this.track, distance) };
    this.publish.terrain(this.window);
  }

  private sendPosition(distance: number): void {
    this.positioned = distance;
    this.publish.position(positionAt(this.track, distance));
  }
}
