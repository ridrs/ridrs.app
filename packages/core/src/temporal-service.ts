// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type CapabilityCardinality,
  type CapabilityContract,
  type Clock,
  type EstimationStrategy,
  type Freshness,
  type PluginManifest,
  type PluginTemporalContext,
  RidrsError,
  type TemporalMeasurement,
  type TemporalRecordResult,
  type TemporalSeriesReader,
  type TemporalSeriesWriter,
  type TemporalSnapshot,
} from '@ridrs/contracts';
import { buildSnapshot, type FreshnessTransition, TemporalSeries } from '@ridrs/temporal';
import { queueScheduler, type Subscription, timer } from 'rxjs';
import type { DiagnosticCollector } from './diagnostics.ts';

/** A late measurement is reported at most once per series in this period. */
const LATE_REPORT_EVERY_MS = 10_000;

interface FreshnessHandler {
  readonly pluginId: string;
  readonly handle: (freshness: Freshness, at: number) => void;
}

interface ManagedSeries {
  readonly id: string;
  readonly owner: string;
  readonly series: TemporalSeries;
  freshness: Freshness;
  /** The one deadline of this series: its next freshness transition. */
  deadline?: Subscription;
  readonly handlers: Set<FreshnessHandler>;
  lastLateReportAt?: number;
}

interface Combination {
  readonly pluginId: string;
  readonly seriesIds: readonly string[];
  readonly handle: (snapshot: TemporalSnapshot) => void;
  active: boolean;
}

export interface TemporalServiceOptions {
  readonly clock: Clock;
  readonly diagnostics: DiagnosticCollector;
  /** Whether a plugin is started: only started writers record. */
  readonly isPluginActive: (pluginId: string) => boolean;
}

/**
 * The core part of the temporal data layer: which plugin owns which series, the one freshness
 * deadline per series, and run-to-completion delivery of snapshots and freshness changes. The
 * math lives in `@ridrs/temporal`.
 */
export class TemporalService {
  private readonly clock: Clock;
  private readonly diagnostics: DiagnosticCollector;
  private readonly isPluginActive: (pluginId: string) => boolean;
  private readonly series = new Map<string, ManagedSeries>();
  private readonly combinations: Combination[] = [];

  constructor(options: TemporalServiceOptions) {
    this.clock = options.clock;
    this.diagnostics = options.diagnostics;
    this.isPluginActive = options.isPluginActive;
  }

  createPluginTemporalContext(
    manifest: Readonly<PluginManifest>,
    isInitializing: () => boolean,
  ): PluginTemporalContext {
    const pluginId = manifest.id;
    const issuedReaders = new WeakSet<TemporalSeriesReader>();
    const seriesIdsOf = (readers: readonly TemporalSeriesReader[]): string[] =>
      readers.map((reader) => {
        if (!issuedReaders.has(reader)) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" combined a series reader it did not obtain itself`,
            { pluginId },
          );
        }
        return reader.series;
      });

    return Object.freeze({
      writer: (
        capability: CapabilityContract<unknown, CapabilityCardinality>,
        options: { readonly strategy: EstimationStrategy; readonly min?: number },
      ): TemporalSeriesWriter => {
        if (!manifest.provides.includes(capability.id) || !isInitializing()) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" may write the series "${capability.id}" only for a capability it provides, during initialize`,
            { pluginId },
          );
        }
        if (this.series.has(capability.id)) {
          throw new RidrsError(
            'undeclared-capability',
            `The series "${capability.id}" already has a writer`,
            { pluginId },
          );
        }
        const managed: ManagedSeries = {
          id: capability.id,
          owner: pluginId,
          series: new TemporalSeries(options),
          freshness: 'none',
          handlers: new Set(),
        };
        this.series.set(capability.id, managed);
        return this.createWriter(managed);
      },

      reader: (capability: CapabilityContract<unknown, CapabilityCardinality>) => {
        if (
          !manifest.requires.includes(capability.id) &&
          !manifest.provides.includes(capability.id)
        ) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" may read the series "${capability.id}" only for a capability it requires or provides`,
            { pluginId },
          );
        }
        const reader = this.createReader(capability.id, pluginId);
        issuedReaders.add(reader);
        return reader;
      },

      combine: (
        readers: readonly TemporalSeriesReader[],
        handle: (snapshot: TemporalSnapshot) => void,
      ): (() => void) => {
        const combination: Combination = {
          pluginId,
          seriesIds: seriesIdsOf(readers),
          handle,
          active: true,
        };
        this.combinations.push(combination);
        return () => this.removeCombination(combination);
      },

      snapshot: (readers: readonly TemporalSeriesReader[], at: number): TemporalSnapshot =>
        this.snapshotAt(seriesIdsOf(readers), at),
    });
  }

  /** Releases everything a plugin obtained; a stopped writer's series has no source any more. */
  releasePlugin(pluginId: string): void {
    for (const combination of [...this.combinations]) {
      if (combination.pluginId === pluginId) {
        this.removeCombination(combination);
      }
    }
    for (const managed of this.series.values()) {
      for (const handler of [...managed.handlers]) {
        if (handler.pluginId === pluginId) {
          managed.handlers.delete(handler);
        }
      }
      if (managed.owner === pluginId) {
        managed.deadline?.unsubscribe();
        managed.deadline = undefined;
        managed.series.reset();
        managed.freshness = 'none';
        managed.lastLateReportAt = undefined;
      }
    }
  }

  private createWriter(managed: ManagedSeries): TemporalSeriesWriter {
    const ensureActive = (action: string): void => {
      if (!this.isPluginActive(managed.owner)) {
        throw new RidrsError(
          'plugin-not-active',
          `Plugin "${managed.owner}" cannot ${action} the series "${managed.id}" because it is not started`,
          { pluginId: managed.owner },
        );
      }
    };
    return Object.freeze({
      series: managed.id,
      record: (measurement: TemporalMeasurement): TemporalRecordResult => {
        ensureActive('record into');
        const result = managed.series.record(measurement);
        if (result === 'late') {
          this.reportLate(managed, measurement);
        }
        if (result !== 'accepted') {
          return result;
        }
        this.updateFreshness(managed);
        this.deliverSnapshots(managed.id, measurement.measuredAt);
        return result;
      },
      markUnavailable: (_reason: 'disconnected', at: number): void => {
        ensureActive('mark');
        managed.series.markDisconnected(at);
        this.updateFreshness(managed);
      },
      reset: (): void => {
        ensureActive('reset');
        managed.series.reset();
        this.updateFreshness(managed);
      },
    });
  }

  private createReader(seriesId: string, pluginId: string): TemporalSeriesReader {
    const series = () => this.series.get(seriesId)?.series;
    return Object.freeze({
      series: seriesId,
      valueAt: (t: number) =>
        series()?.valueAt(t, this.clock.now()) ?? {
          status: 'unavailable' as const,
          at: t,
          reason: 'no-source' as const,
        },
      average: ({ window, at }: { readonly window: number; readonly at: number }) =>
        series()?.average(window, at, this.clock.now()) ?? { at, window, coverage: 0 },
      freshness: () => series()?.freshnessAt(this.clock.now()) ?? 'none',
      samplingInterval: () => series()?.samplingInterval,
      nextExpectedAt: () => series()?.nextExpectedAt,
      historySize: () => series()?.historySize ?? 0,
      onFreshnessChange: (handle: (freshness: Freshness, at: number) => void) => {
        const managed = this.series.get(seriesId);
        if (!managed) {
          return () => undefined;
        }
        const handler: FreshnessHandler = { pluginId, handle };
        managed.handlers.add(handler);
        return () => {
          managed.handlers.delete(handler);
        };
      },
    });
  }

  private snapshotAt(
    seriesIds: readonly string[],
    at: number,
    trigger?: { readonly series: string; readonly measuredAt: number },
  ): TemporalSnapshot {
    const series = new Map(seriesIds.map((id) => [id, this.series.get(id)?.series]));
    return buildSnapshot(series, at, this.clock.now(), trigger);
  }

  /** One snapshot per combination containing the series, built now, delivered run-to-completion. */
  private deliverSnapshots(seriesId: string, measuredAt: number): void {
    for (const combination of this.combinations) {
      if (!combination.seriesIds.includes(seriesId)) {
        continue;
      }
      const snapshot = this.snapshotAt(combination.seriesIds, measuredAt, {
        series: seriesId,
        measuredAt,
      });
      this.schedule(combination.pluginId, 'snapshot', () => {
        if (combination.active) {
          combination.handle(snapshot);
        }
      });
    }
  }

  /** Notifies a change (if any) and arms the one deadline for the next transition. */
  private updateFreshness(managed: ManagedSeries): void {
    const now = this.clock.now();
    this.transition(managed, managed.series.freshnessAt(now), now);
    this.armDeadline(managed, now);
  }

  private armDeadline(managed: ManagedSeries, from: number): void {
    managed.deadline?.unsubscribe();
    managed.deadline = undefined;
    const next = managed.series.nextTransition(from);
    if (!next) {
      return;
    }
    managed.deadline = timer(Math.max(0, next.at - this.clock.now())).subscribe(() =>
      this.onDeadline(managed, next),
    );
  }

  private onDeadline(managed: ManagedSeries, due: FreshnessTransition): void {
    managed.deadline = undefined;
    this.transition(managed, due.freshness, due.at);
    // A late timer may have skipped a transition: catch up in order, each exactly once.
    const next = managed.series.nextTransition(due.at);
    if (next && next.at <= this.clock.now()) {
      this.onDeadline(managed, next);
    } else {
      this.armDeadline(managed, due.at);
    }
  }

  private transition(managed: ManagedSeries, freshness: Freshness, at: number): void {
    if (freshness === managed.freshness) {
      return;
    }
    managed.freshness = freshness;
    for (const handler of [...managed.handlers]) {
      this.schedule(handler.pluginId, 'freshness change', () => {
        if (managed.handlers.has(handler)) {
          handler.handle(freshness, at);
        }
      });
    }
  }

  private reportLate(managed: ManagedSeries, measurement: TemporalMeasurement): void {
    const now = this.clock.now();
    if (
      managed.lastLateReportAt !== undefined &&
      now - managed.lastLateReportAt < LATE_REPORT_EVERY_MS
    ) {
      return;
    }
    managed.lastLateReportAt = now;
    this.diagnostics.report({
      code: 'late-measurement',
      pluginId: managed.owner,
      message: `Rejected a late measurement for the series "${managed.id}": measured at ${measurement.measuredAt}, not after the last accepted one`,
      details: { series: managed.id, measuredAt: measurement.measuredAt },
    });
  }

  /** Same delivery rule as the event bus: after the current handler, in order, never re-entrant. */
  private schedule(pluginId: string, what: string, deliver: () => void): void {
    queueScheduler.schedule(() => {
      try {
        deliver();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnostics.report({
          code: 'event-handler-failure',
          pluginId,
          message: `Plugin "${pluginId}" failed while handling a temporal ${what}: ${reason}`,
          details: { temporal: what },
        });
      }
    });
  }

  private removeCombination(combination: Combination): void {
    combination.active = false;
    const index = this.combinations.indexOf(combination);
    if (index >= 0) {
      this.combinations.splice(index, 1);
    }
  }
}
