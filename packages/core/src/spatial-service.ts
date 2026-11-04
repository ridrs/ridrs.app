// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type CapabilityCardinality,
  type CapabilityContract,
  type PluginManifest,
  type PluginSpatialContext,
  RidrsError,
  type SpatialChannels,
  type SpatialPoint,
  type SpatialSeriesCapability,
  type SpatialSeriesReader,
  type SpatialSeriesWriter,
  type SpatialValue,
  type SpatialWindow,
} from '@ridrs/contracts';
import { SpatialSeries } from '@ridrs/spatial';

interface ManagedSeries {
  readonly id: string;
  readonly owner: string;
  readonly series: SpatialSeries<SpatialPoint>;
}

export interface SpatialServiceOptions {
  /** Whether a plugin is started: only started writers write. */
  readonly isPluginActive: (pluginId: string) => boolean;
  /** Writes are simulation state: only inside a turn (or a lifecycle hook). */
  readonly mayWrite: () => boolean;
}

/**
 * The core part of the spatial data layer: which plugin owns which series, and that writes happen
 * inside turns. The sampling lives in `@ridrs/spatial`. No clock: terrain does not age.
 */
export class SpatialService {
  private readonly isPluginActive: (pluginId: string) => boolean;
  private readonly mayWrite: () => boolean;
  private readonly series = new Map<string, ManagedSeries>();

  constructor(options: SpatialServiceOptions) {
    this.isPluginActive = options.isPluginActive;
    this.mayWrite = options.mayWrite;
  }

  createPluginSpatialContext(
    manifest: Readonly<PluginManifest>,
    isInitializing: () => boolean,
  ): PluginSpatialContext {
    const pluginId = manifest.id;
    return Object.freeze({
      writer: <TPoint extends SpatialPoint>(
        capability: CapabilityContract<SpatialSeriesCapability<TPoint>, CapabilityCardinality>,
        options: { readonly channels: SpatialChannels<TPoint> },
      ): SpatialSeriesWriter<TPoint> => {
        if (!manifest.provides.includes(capability.id) || !isInitializing()) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" may write the spatial series "${capability.id}" only for a capability it provides, during initialize`,
            { pluginId },
          );
        }
        if (this.series.has(capability.id)) {
          throw new RidrsError(
            'undeclared-capability',
            `The spatial series "${capability.id}" already has a writer`,
            { pluginId },
          );
        }
        const managed: ManagedSeries = {
          id: capability.id,
          owner: pluginId,
          series: new SpatialSeries(
            options as { readonly channels: SpatialChannels<SpatialPoint> },
          ),
        };
        this.series.set(capability.id, managed);
        return this.createWriter(managed) as SpatialSeriesWriter<TPoint>;
      },

      reader: <TPoint extends SpatialPoint>(
        capability: CapabilityContract<SpatialSeriesCapability<TPoint>, CapabilityCardinality>,
      ): SpatialSeriesReader<TPoint> => {
        if (
          !manifest.requires.includes(capability.id) &&
          !manifest.provides.includes(capability.id)
        ) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" may read the spatial series "${capability.id}" only for a capability it requires or provides`,
            { pluginId },
          );
        }
        const seriesId = capability.id;
        return Object.freeze({
          series: seriesId,
          valueAt: (distance: number): SpatialValue<TPoint> =>
            (this.series.get(seriesId)?.series.valueAt(distance) as SpatialValue<TPoint>) ?? {
              status: 'unavailable',
              distance,
              reason: 'no-source',
            },
        });
      },
    });
  }

  /** A stopped writer's series has no source any more. */
  releasePlugin(pluginId: string): void {
    for (const managed of this.series.values()) {
      if (managed.owner === pluginId) {
        managed.series.reset();
      }
    }
  }

  private createWriter(managed: ManagedSeries): SpatialSeriesWriter<SpatialPoint> {
    return Object.freeze({
      series: managed.id,
      write: (window: SpatialWindow<SpatialPoint>) => {
        if (!this.mayWrite()) {
          throw new RidrsError(
            'outside-turn',
            `Plugin "${managed.owner}" cannot write the spatial series "${managed.id}" outside a turn: results of asynchronous work enter through ctx.inputs`,
            { pluginId: managed.owner },
          );
        }
        if (!this.isPluginActive(managed.owner)) {
          throw new RidrsError(
            'plugin-not-active',
            `Plugin "${managed.owner}" cannot write the spatial series "${managed.id}" because it is not started`,
            { pluginId: managed.owner },
          );
        }
        return managed.series.write(window);
      },
    });
  }
}
