// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ActivityState,
  activityStateChangedEvent,
  type MetricReading,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerEvent,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
  type RecordingEvent,
  type RecordingFooter,
  type RecordingHeader,
  type WorldPosition,
  worldPositionEvent,
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
  /** Degrees north, where the world put the rider. */
  readonly latitude?: number;
  /** Degrees east. */
  readonly longitude?: number;
  /** m above sea level. */
  readonly altitude?: number;
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
  /** When the ride stood still (ADR 0056): the timer stops at `from` and starts at `to`. */
  readonly pauses: readonly Pause[];
  readonly summary: ActivitySummary;
}

export interface Pause {
  readonly from: number;
  readonly to: number;
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

function positionSeries(events: readonly RecordingEvent[]): Timed<WorldPosition>[] {
  return events
    .filter((e) => e.envelope.type === worldPositionEvent.id)
    .map((e) => ({ at: e.envelope.timestamp, value: e.envelope.payload as WorldPosition }));
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

function max(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

/** The pauses of the ride, from its activity states; one still open at the end lasts until then. */
function pausesOf(events: readonly RecordingEvent[], endedAt: number): Pause[] {
  const pauses: Pause[] = [];
  let from: number | undefined;
  for (const { envelope } of events) {
    if (envelope.type !== activityStateChangedEvent.id) {
      continue;
    }
    const state = envelope.payload as ActivityState;
    if (state.state === 'paused' && from === undefined) {
      from = state.pausedAt;
    } else if (state.state !== 'paused' && from !== undefined) {
      pauses.push({ from, to: state.state === 'running' ? (state.resumedAt ?? from) : endedAt });
      from = undefined;
    }
  }
  if (from !== undefined) {
    pauses.push({ from, to: endedAt });
  }
  return pauses;
}

function defined<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((v): v is T => v !== undefined);
}

/**
 * The activity of a recorded ride, from its events (the pre-roll excluded): a record at every whole
 * second `t_k ≤ endedAt` with the latest power, cadence and heart rate published at or before
 * `t_k`, the speed and distance of the latest physics sample at or before `t_k` and the latest
 * position a world gave (`world.position`) at or before `t_k`; a ride without a world has none.
 */
export function buildActivity(recording: ActivitySource): ActivityModel {
  const { startedAt } = recording.header;
  const endedAt = recording.footer?.endedAt ?? startedAt;
  const ride = recording.events.filter((e) => !e.preroll);

  const power = new Cursor(metricSeries(ride, metricPowerEvent.id));
  const cadence = new Cursor(metricSeries(ride, metricCadenceEvent.id));
  const heartRate = new Cursor(metricSeries(ride, metricHeartRateEvent.id));
  const samples = new Cursor(sampleSeries(ride));
  const positions = new Cursor(positionSeries(ride));

  const pauses = pausesOf(ride, endedAt);
  const paused = (at: number) => pauses.some((p) => at > p.from && at < p.to);
  const records: ActivityRecord[] = [];
  const interval = FIT_DEFAULTS.recordIntervalMs;
  for (let at = Math.ceil(startedAt / interval) * interval; at <= endedAt; at += interval) {
    if (paused(at)) {
      // The timer stands still: FIT has no records then.
      continue;
    }
    const sample = samples.at(at);
    const place = positions.at(at);
    records.push({
      at,
      power: power.at(at),
      cadence: cadence.at(at),
      heartRate: heartRate.at(at),
      speed: sample?.speed,
      distance: sample?.distance,
      latitude: place?.latitude,
      longitude: place?.longitude,
      altitude: place?.altitude,
    });
  }

  const durationMs = endedAt - startedAt;
  const timerMs = durationMs - pauses.reduce((sum, p) => sum + (p.to - p.from), 0);
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
    pauses,
    summary: {
      totalElapsedMs: durationMs,
      totalTimerMs: timerMs,
      totalDistance,
      avgSpeed:
        totalDistance !== undefined && timerMs > 0 ? totalDistance / (timerMs / 1000) : undefined,
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
