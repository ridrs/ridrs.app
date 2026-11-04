// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ActivityState } from '@ridrs/contracts';
import type { PresentedPhysics } from '@ridrs/presentation';
import {
  type LandscapeModel,
  remainingAhead,
  TERRAIN_WINDOW,
  type TerrainWindow,
  terrainWindow,
} from './landscape-model.ts';

export type PublishedWindow = TerrainWindow & { readonly revision: number };

/**
 * When the landscape tells what it sees ahead (ADR 0044, amended 2026-11-04): the window from
 * 0 m as soon as it is mounted, without waiting for a physics state, since every ride starts
 * there; then a window from the presented position of the running ride whenever less than
 * `republishBelow` m are left ahead of it. At standstill nothing goes out.
 */
export class TerrainPublisher {
  private revision = 0;
  private current: TerrainWindow | undefined;
  private ride: string | undefined;

  constructor(
    private readonly model: LandscapeModel,
    private readonly publish: (window: PublishedWindow) => void,
  ) {}

  mount(): void {
    this.send(terrainWindow(this.model, 0));
  }

  rideState(state: ActivityState): void {
    this.ride = state.state === 'running' ? state.sessionId : undefined;
  }

  frame(shown: PresentedPhysics): void {
    if (this.ride === undefined || shown.status !== 'available' || shown.sessionId !== this.ride) {
      return;
    }
    if (!this.current || remainingAhead(this.current, shown.distance) < TERRAIN_WINDOW.republishBelow) {
      this.send(terrainWindow(this.model, shown.distance));
    }
  }

  private send(window: TerrainWindow): void {
    this.revision += 1;
    this.current = window;
    this.publish({ revision: this.revision, ...window });
  }
}
