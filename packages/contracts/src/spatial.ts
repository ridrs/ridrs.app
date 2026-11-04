// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityCardinality,
  type CapabilityContract,
  defineCapability,
} from './capabilities.ts';
import type { TerrainSurface } from './world.ts';

/*
 * The spatial data layer: quantities by distance along the path (the physics odometer, m), as the
 * temporal layer holds quantities by time. A writer puts windows of samples in; readers ask for
 * the value at any distance, ahead of the rider too. Terrain never goes stale.
 */

/**
 * How a value at a distance came about: a sample exactly there, a value between two samples, or
 * the last sample of the window held beyond its end.
 */
export type SpatialQuality = 'sampled' | 'interpolated' | 'held';

/** No window yet, or a distance behind the origin of the window. */
export type SpatialUnavailableReason = 'no-source' | 'outside-window';

/** How a channel goes from one sample to the next: numbers linearly, categories stepwise. */
export type SpatialInterpolation = 'linear' | 'step';

/** One value per channel; a `linear` channel must be a number. */
export type SpatialPoint = Readonly<Record<string, number | string>>;

export type SpatialChannels<TPoint extends SpatialPoint> = {
  readonly [K in keyof TPoint]: TPoint[K] extends number ? SpatialInterpolation : 'step';
};

export type SpatialValue<TPoint extends SpatialPoint> =
  | {
      readonly status: 'available';
      /** m, the distance asked for. */
      readonly distance: number;
      readonly value: TPoint;
      readonly quality: SpatialQuality;
      /** Who published the window the value comes from. */
      readonly sourceId: string;
      readonly revision: number;
    }
  | {
      readonly status: 'unavailable';
      readonly distance: number;
      readonly reason: SpatialUnavailableReason;
    };

/** Sample `i` lies at `originDistance + i · spacing`. */
export interface SpatialWindow<TPoint extends SpatialPoint> {
  readonly sourceId: string;
  /** Counts up per source; a window with a lower or equal revision than the last one is ignored. */
  readonly revision: number;
  /** m */
  readonly originDistance: number;
  /** m, > 0 */
  readonly spacing: number;
  /** At least two. */
  readonly samples: readonly TPoint[];
}

/** `outdated`: the source already wrote this or a newer revision. */
export type SpatialWriteResult = 'accepted' | 'outdated';

export interface SpatialSeriesWriter<TPoint extends SpatialPoint> {
  readonly series: string;
  /** The window replaces the range it covers; nothing outside the newest window is kept. */
  write(window: SpatialWindow<TPoint>): SpatialWriteResult;
}

export interface SpatialSeriesReader<TPoint extends SpatialPoint> {
  readonly series: string;
  valueAt(distance: number): SpatialValue<TPoint>;
}

/**
 * What a spatial series capability stands for: the series' channels and how each one
 * interpolates. The writer plugin provides it and creates the writer with the same channels.
 */
export interface SpatialSeriesCapability<TPoint extends SpatialPoint> {
  readonly channels: SpatialChannels<TPoint>;
}

/**
 * The spatial data layer as seen by one plugin. A series is identified by a capability: only the
 * plugin providing it may write (writers are created during `initialize`), readers need it in
 * `requires`. Everything obtained here is released when the plugin stops.
 */
export interface PluginSpatialContext {
  writer<TPoint extends SpatialPoint>(
    capability: CapabilityContract<SpatialSeriesCapability<TPoint>, CapabilityCardinality>,
    options: { readonly channels: SpatialChannels<TPoint> },
  ): SpatialSeriesWriter<TPoint>;
  reader<TPoint extends SpatialPoint>(
    capability: CapabilityContract<SpatialSeriesCapability<TPoint>, CapabilityCardinality>,
  ): SpatialSeriesReader<TPoint>;
}

/** The terrain at one distance. A type, not an interface: it must fit `SpatialPoint`. */
export type TerrainPoint = {
  /** Rise over run. */
  readonly gradient: number;
  readonly surface: TerrainSurface;
};

/** The terrain along the path: one writer (`spatial-terrain`), however many worlds feed it. */
export const spatialTerrainCapability = defineCapability<
  SpatialSeriesCapability<TerrainPoint>,
  'single',
  'spatial.terrain'
>('spatial.terrain', { cardinality: 'single' });
