// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  physicsStateBatchEvent,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { validateTerrainWindow } from './validate.ts';

/**
 * The driver of the UI landscape, the world sensor: validates every window the UI observed and
 * accepts a valid one as the external input `world.terrain-preview`, recorded and injected on
 * replay. An invalid window is dropped with `terrain-preview-rejected`. The odometer comes from
 * the physics' batches of the running ride; between rides every ride's start, 0 m, counts.
 */
export default definePlugin({
  start(ctx) {
    const lastRevisions = new Map<string, number>();
    let ride: { sessionId: string; odometer: number } | undefined;

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
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
      ctx.inputs.accept(worldTerrainPreviewEvent, result.preview);
    });
  },
});
