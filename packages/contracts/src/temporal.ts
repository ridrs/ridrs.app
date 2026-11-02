// SPDX-License-Identifier: Apache-2.0

import type { CapabilityCardinality, CapabilityContract } from './capabilities.ts';

/**
 * How a value at a given time came about. Ordered from most to least certain:
 * an actual measurement, a value between two measurements, the last value held, a trend estimate.
 */
export type TemporalQuality = 'measured' | 'interpolated' | 'held' | 'extrapolated';

export type TemporalUnavailableReason = 'no-source' | 'disconnected' | 'stale' | 'out-of-range';

export type Freshness = 'none' | 'fresh' | 'delayed' | 'stale' | 'disconnected';

/** How a series estimates values after its last measurement. Chosen by the writer, never by readers. */
export type EstimationStrategy = 'hold' | 'damped-trend';

export type TemporalValue =
  | {
      readonly status: 'available';
      readonly value: number;
      readonly at: number;
      readonly quality: TemporalQuality;
      readonly sourceId: string;
      /** Measurement time of the last actual measurement the value is based on. */
      readonly sourceMeasuredAt: number;
    }
  | {
      readonly status: 'unavailable';
      readonly at: number;
      readonly reason: TemporalUnavailableReason;
    };

/** Time-weighted average over `[at - window, at]`; unavailable time is excluded. */
export interface TemporalAverage {
  readonly at: number;
  readonly window: number;
  /** Undefined when the coverage is 0. */
  readonly value?: number;
  /** Available duration divided by the window, 0..1. */
  readonly coverage: number;
  /** The least certain quality used. */
  readonly quality?: TemporalQuality;
}

/** All combined series evaluated at the same time `at`, keyed by series id (= capability id). */
export interface TemporalSnapshot {
  readonly at: number;
  /** The measurement that caused the snapshot; absent for snapshots requested at an arbitrary time. */
  readonly trigger?: { readonly series: string; readonly measuredAt: number };
  readonly values: Readonly<Record<string, TemporalValue>>;
}

export interface TemporalMeasurement {
  readonly value: number;
  /** Places the value on the time axis (values, interpolation, averages). */
  readonly measuredAt: number;
  /** Places the packet on the time axis (sampling interval, freshness). */
  readonly receivedAt: number;
  readonly sourceId: string;
}

export type TemporalRecordResult = 'accepted' | 'late' | 'duplicate';

export interface TemporalSeriesWriter {
  readonly series: string;
  record(measurement: TemporalMeasurement): TemporalRecordResult;
  /** Inserts a break: nothing is estimated across it, the series is `disconnected` until the next measurement. */
  markUnavailable(reason: 'disconnected', at: number): void;
  /** The source changed: clears the history and the learned timing. */
  reset(): void;
}

export interface TemporalSeriesReader {
  readonly series: string;
  valueAt(t: number): TemporalValue;
  average(options: { readonly window: number; readonly at: number }): TemporalAverage;
  freshness(): Freshness;
  /** The learned sampling interval in ms; undefined until learned. */
  samplingInterval(): number | undefined;
  /** When the next packet is expected (an expectation, not a deadline); undefined until learned. */
  nextExpectedAt(): number | undefined;
  /** Number of measurements the series currently keeps. */
  historySize(): number;
  /** Called exactly once per freshness transition, with the time of the transition. */
  onFreshnessChange(handler: (freshness: Freshness, at: number) => void): () => void;
}

/**
 * The temporal data layer as seen by one plugin. A series is identified by a capability: only
 * the plugin providing it may write (during `initialize`), readers need it in `requires`.
 * Everything obtained here belongs to the plugin and is released when it stops.
 */
export interface PluginTemporalContext {
  writer(
    capability: CapabilityContract<unknown, CapabilityCardinality>,
    options: { readonly strategy: EstimationStrategy; readonly min?: number },
  ): TemporalSeriesWriter;
  reader(capability: CapabilityContract<unknown, CapabilityCardinality>): TemporalSeriesReader;
  /** One snapshot per accepted measurement of any of the series, at that measurement's time. */
  combine(
    readers: readonly TemporalSeriesReader[],
    handler: (snapshot: TemporalSnapshot) => void,
  ): () => void;
  /** A snapshot at any `at <= now`, without a trigger and without side effects. */
  snapshot(readers: readonly TemporalSeriesReader[], at: number): TemporalSnapshot;
}
