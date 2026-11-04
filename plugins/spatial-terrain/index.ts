// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type PluginContext,
  type SpatialChannels,
  type SpatialSeriesWriter,
  spatialTerrainCapability,
  type TerrainPoint,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';

/** The gradient changes continuously between samples; a surface holds until the next one. */
const TERRAIN_CHANNELS: SpatialChannels<TerrainPoint> = Object.freeze({
  gradient: 'linear',
  surface: 'step',
});

const writers = new WeakMap<PluginContext, SpatialSeriesWriter<TerrainPoint>>();

/**
 * The one writer of the terrain series: every `world.terrain-preview` a driver accepted goes into
 * the spatial layer, however many worlds feed it. A sample without a surface is asphalt.
 */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(spatialTerrainCapability, { channels: TERRAIN_CHANNELS });
    const writer: SpatialSeriesWriter<TerrainPoint> = ctx.spatial.writer(
      spatialTerrainCapability,
      { channels: TERRAIN_CHANNELS },
    );
    writers.set(ctx, writer);
  },

  start(ctx) {
    const writer = writers.get(ctx);
    ctx.events.subscribe(worldTerrainPreviewEvent, ({ payload, source }) => {
      writer?.write({
        sourceId: source,
        revision: payload.revision,
        originDistance: payload.originDistance,
        spacing: payload.spacing,
        samples: payload.samples.map(({ gradient, surface }) => ({
          gradient,
          surface: surface ?? 'asphalt',
        })),
      });
    });
  },
});
