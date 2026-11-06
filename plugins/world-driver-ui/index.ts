// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  physicsStateBatchEvent,
  uiPositionObservedEvent,
  uiTerrainObservedEvent,
  worldPositionEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { validatePosition, validateTerrainWindow } from './validate.ts';

/**
 * The driver of the UI landscape, the world sensor: validates every window the UI observed and
 * accepts a valid one as the external input `world.terrain-preview`, recorded and injected on
 * replay. An invalid window is dropped with `terrain-preview-rejected`. A sensor's revisions
 * ascend within a ride: every ride mounts its landscape anew, counting from 1. The driver numbers
 * the windows it accepts on its own, so they ascend for the spatial layer across rides. Where the UI shows the
 * rider (`ui.position-observed`) is validated the same way and accepted as `world.position`, or
 * dropped with `position-rejected`. The odometer comes from
 * the physics' batches of the running ride; between rides every ride's start, 0 m, counts.
 */
export default definePlugin({
  start(ctx) {
    const lastRevisions = new Map<string, number>();
    let accepted = 0;
    let session: string | undefined;
    let ride: { sessionId: string; odometer: number } | undefined;

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if ('sessionId' in payload && payload.sessionId !== session) {
        session = payload.sessionId;
        lastRevisions.clear();
      }
      ride = payload.state === 'running' ? { sessionId: payload.sessionId, odometer: 0 } : undefined;
    });

    ctx.events.subscribe(physicsStateBatchEvent, ({ payload }) => {
      const distance = payload.samples.at(-1)?.distance;
      if (ride?.sessionId === payload.sessionId && distance !== undefined) {
        ride.odometer = distance;
      }
    });

    ctx.events.subscribe(uiTerrainObservedEvent, ({ payload, source }) => {
      const result = validateTerrainWindow(payload, {
        odometer: ride?.odometer ?? 0,
        lastRevision: lastRevisions.get(source),
      });
      if (!result.valid) {
        ctx.reportDiagnostic(
          'terrain-preview-rejected',
          `Dropped terrain window ${payload.revision} from "${source}": ${result.reason}`,
          { reason: result.reason, revision: payload.revision, source },
        );
        return;
      }
      lastRevisions.set(source, payload.revision);
      accepted += 1;
      ctx.inputs.accept(worldTerrainPreviewEvent, { ...result.preview, revision: accepted });
    });

    ctx.events.subscribe(uiPositionObservedEvent, ({ payload, source }) => {
      const result = validatePosition(payload, { odometer: ride?.odometer ?? 0 });
      if (!result.valid) {
        ctx.reportDiagnostic(
          'position-rejected',
          `Dropped the position at ${payload.distance} m from "${source}": ${result.reason}`,
          { reason: result.reason, distance: payload.distance, source },
        );
        return;
      }
      ctx.inputs.accept(worldPositionEvent, result.position);
    });
  },
});
