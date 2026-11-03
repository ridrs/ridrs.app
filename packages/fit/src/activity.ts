// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type MetricReading,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerEvent,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
  type RecordingEvent,
  type RecordingFooter,
  type RecordingHeader,
} from '@ridrs/contracts';

/** What an activity is built from: the parts of a ridrs recording it needs. */
export interface ActivitySource {
  readonly header: RecordingHeader;
  readonly events: readonly RecordingEvent[];
  readonly footer?: RecordingFooter;
}

/** One record per whole second. Absent values are invalid in FIT, never 0. */
export interface ActivityRecord {
  /** epoch ms, a whole second */
  readonly at: number;
  /** W */
  readonly power?: number;
  /** rpm */
  readonly cadence?: number;
  /** bpm */
  readonly heartRate?: number;
  /** m/s */
  readonly speed?: number;
  /** m */
  readonly distance?: number;
}

export interface ActivitySummary {
  readonly totalElapsedMs: number;
  readonly totalTimerMs: number;
  readonly totalDistance?: number;
  readonly avgSpeed?: number;
  readonly maxSpeed?: number;
  readonly avgPower?: number;
  readonly maxPower?: number;
  readonly avgCadence?: number;
  readonly maxCadence?: number;
  readonly avgHeartRate?: number;
  readonly maxHeartRate?: number;
}

/** A ride as a FIT activity sees it: pure data, so the same model always gives the same file. */
export interface ActivityModel {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly timeZoneOffsetMinutes: number;
  /** e.g. "0.1.0" */
  readonly softwareVersion: string;
  readonly records: readonly ActivityRecord[];
  readonly summary: ActivitySummary;
}

export const FIT_DEFAULTS = Object.freeze({
  /** Records at whole seconds. */
  recordIntervalMs: 1000,
});

interface Timed<T> {
  readonly at: number;
  readonly value: T;
}

/** The latest value at or before `at` of a series sorted by time, walking forward. */
class Cursor<T> {
  private index = -1;

  constructor(private readonly series: readonly Timed<T>[]) {}

  at(at: number): T | undefined {
    while ((this.series[this.index + 1]?.at ?? Number.POSITIVE_INFINITY) <= at) {
      this.index += 1;
    }
    return this.series[this.index]?.value;
  }
}

function metricSeries(
  events: readonly RecordingEvent[],
  type: string,
): Timed<number | undefined>[] {
  return events
    .filter((e) => e.envelope.type === type)
    .map((e) => {
      const reading = e.envelope.payload as MetricReading;
      return {
        at: e.envelope.timestamp,
        value: reading.status === 'available' ? reading.value : undefined,
      };
    });
}

function sampleSeries(
  events: readonly RecordingEvent[],
): Timed<{ speed: number; distance: number }>[] {
  return events
    .filter((e) => e.envelope.type === physicsStateBatchEvent.id)
    .flatMap((e) => (e.envelope.payload as PhysicsStateBatch).samples)
    .map((s) => ({ at: s.at, value: { speed: s.speed, distance: s.distance } }))
    .sort((a, b) => a.at - b.at);
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

function max(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

function defined<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((v): v is T => v !== undefined);
}

/**
 * The activity of a recorded ride, from its events (the pre-roll excluded): a record at every whole
 * second `t_k ≤ endedAt` with the latest power, cadence and heart rate published at or before
 * `t_k` and the speed and distance of the latest physics sample at or before `t_k`.
 */
export function buildActivity(recording: ActivitySource): ActivityModel {
  const { startedAt } = recording.header;
  const endedAt = recording.footer?.endedAt ?? startedAt;
  const ride = recording.events.filter((e) => !e.preroll);

  const power = new Cursor(metricSeries(ride, metricPowerEvent.id));
  const cadence = new Cursor(metricSeries(ride, metricCadenceEvent.id));
  const heartRate = new Cursor(metricSeries(ride, metricHeartRateEvent.id));
  const samples = new Cursor(sampleSeries(ride));

  const records: ActivityRecord[] = [];
  const interval = FIT_DEFAULTS.recordIntervalMs;
  for (let at = Math.ceil(startedAt / interval) * interval; at <= endedAt; at += interval) {
    const sample = samples.at(at);
    records.push({
      at,
      power: power.at(at),
      cadence: cadence.at(at),
      heartRate: heartRate.at(at),
      speed: sample?.speed,
      distance: sample?.distance,
    });
  }

  const durationMs = endedAt - startedAt;
  const totalDistance = defined(records.map((r) => r.distance)).at(-1);
  const powers = defined(records.map((r) => r.power));
  const cadences = defined(records.map((r) => r.cadence));
  const heartRates = defined(records.map((r) => r.heartRate));
  return {
    startedAt,
    endedAt,
    timeZoneOffsetMinutes: recording.header.timeZoneOffsetMinutes,
    softwareVersion: recording.header.ridrsVersion,
    records,
    summary: {
      // ridrs has no pause yet: the timer runs for the whole ride.
      totalElapsedMs: durationMs,
      totalTimerMs: durationMs,
      totalDistance,
      avgSpeed:
        totalDistance !== undefined && durationMs > 0
          ? totalDistance / (durationMs / 1000)
          : undefined,
      maxSpeed: max(defined(records.map((r) => r.speed))),
      avgPower: mean(powers),
      maxPower: max(powers),
      avgCadence: mean(cadences),
      maxCadence: max(cadences),
      avgHeartRate: mean(heartRates),
      maxHeartRate: max(heartRates),
    },
  };
}
