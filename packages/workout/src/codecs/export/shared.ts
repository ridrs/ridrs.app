// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutDuration,
  WorkoutInterval,
  WorkoutRange,
  WorkoutSourceFormat,
  WorkoutStep,
  WorkoutTarget,
  WorkoutTargetUnit,
} from '@ridrs/contracts';
import type { WorkoutDiagnostic } from '../../codec.ts';
import { durationOf, type TrainingZones, zoneBounds } from '../../core/index.ts';
import { defaultPowerZones } from '../../core/zones.ts';
import { record } from './common.ts';

/**
 * What the exporters of ZWO, ERG, MRC, TCX and FIT share (structured-workouts.md, section 9): the
 * options, the result, the warnings, converting power only where the target format cannot hold a
 * unit, and the steps a format cannot hold as they are. The text of intervals.icu has its own,
 * older exporters.
 */

export interface WorkoutExportOptions {
  /** W, the athlete's FTP: needed where a format cannot hold the unit a workout is in. */
  readonly ftp?: number;
  /** Power zones in % FTP; Coggan's when absent. */
  readonly powerZones?: TrainingZones;
}

/** An export is a file, with what it converted or lost as warnings; or it is refused with its reason. */
export type WorkoutExport<T> =
  | { readonly ok: true; readonly data: T; readonly diagnostics: readonly WorkoutDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly WorkoutDiagnostic[] };

export const FORMAT_NAMES: Record<WorkoutSourceFormat, string> = {
  zwo: 'ZWO',
  fit: 'FIT',
  erg: 'ERG',
  mrc: 'MRC',
  tcx: 'TCX',
  intervals: 'intervals.icu text',
};

/** Warnings, one per code: the first place and message, and how many places it touched. */
export class Notes {
  private readonly byCode = new Map<string, { message: string; at?: string; count: number }>();
  private ftpNeeded: string | undefined;

  warn(code: string, message: string, at?: string): void {
    const known = this.byCode.get(code);
    if (known) known.count += 1;
    else this.byCode.set(code, { message, ...(at === undefined ? {} : { at }), count: 1 });
  }

  /** A conversion that needs an FTP the export was not given. */
  needFtp(why: string): void {
    this.ftpNeeded ??= why;
  }

  get missingFtp(): string | undefined {
    return this.ftpNeeded;
  }

  list(): WorkoutDiagnostic[] {
    return [...this.byCode].map(([code, { message, at, count }]) => ({
      severity: 'warning' as const,
      code,
      message: count > 1 ? `${message} (${count} places)` : message,
      ...(at === undefined ? {} : { at }),
    }));
  }
}

/** Finishes an export: refused where an FTP was needed and missing, else the file and its warnings. */
export function finishExport<T>(
  format: WorkoutSourceFormat,
  notes: Notes,
  data: () => T,
): WorkoutExport<T> {
  if (notes.missingFtp !== undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'ftp-required',
          message: `${FORMAT_NAMES[format]} cannot hold ${notes.missingFtp}; converting it needs an FTP, and there is none. Set the FTP in the athlete profile.`,
        },
        ...notes.list(),
      ],
    };
  }
  return { ok: true, data: data(), diagnostics: notes.list() };
}

export const POWER_UNITS: ReadonlySet<WorkoutTargetUnit> = new Set([
  'percent-ftp',
  'watts',
  'power-zone',
]);

const roundTo = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Converts power ranges between % FTP, watts and zones, noting what needs an FTP. */
export class PowerConverter {
  private readonly zones: TrainingZones;
  constructor(
    private readonly options: WorkoutExportOptions,
    private readonly notes: Notes,
  ) {
    this.zones = options.powerZones ?? defaultPowerZones();
  }

  /** A zone range as % FTP: from the lower bound of the lowest to the upper one of the highest. */
  private zonePercent(range: WorkoutRange): WorkoutRange | undefined {
    const low = zoneBounds(range.low, this.zones);
    const high = zoneBounds(range.high, this.zones);
    return low && high ? { low: low.low, high: high.high ?? high.low } : undefined;
  }

  /** The range in % FTP, or `undefined` (an FTP is missing, noted). */
  percent(range: WorkoutRange, unit: WorkoutTargetUnit, at: string): WorkoutRange | undefined {
    switch (unit) {
      case 'percent-ftp':
        return range;
      case 'power-zone':
        this.notes.warn(
          'zone-converted',
          `${at}: a power zone is written as the % FTP range of the zone.`,
          at,
        );
        return this.zonePercent(range);
      case 'watts': {
        const { ftp } = this.options;
        if (!ftp) {
          this.notes.needFtp('targets in watts');
          return undefined;
        }
        this.notes.warn(
          'watts-to-percent',
          `${at}: watts are converted to % FTP with an FTP of ${ftp} W.`,
          at,
        );
        return {
          low: roundTo((range.low / ftp) * 100, 2),
          high: roundTo((range.high / ftp) * 100, 2),
        };
      }
      default:
        return undefined;
    }
  }

  /** The range in watts, or `undefined` (an FTP is missing, noted). */
  watts(range: WorkoutRange, unit: WorkoutTargetUnit, at: string): WorkoutRange | undefined {
    if (unit === 'watts') return range;
    const percent = unit === 'power-zone' ? this.zonePercent(range) : range;
    if (unit !== 'percent-ftp' && unit !== 'power-zone') return undefined;
    const { ftp } = this.options;
    if (!ftp) {
      this.notes.needFtp('targets in % FTP or zones');
      return undefined;
    }
    if (!percent) return undefined;
    this.notes.warn(
      unit === 'power-zone' ? 'zone-converted' : 'percent-to-watts',
      `${at}: ${unit === 'power-zone' ? 'a power zone' : '% FTP'} is converted to watts with an FTP of ${ftp} W.`,
      at,
    );
    return {
      low: Math.round((percent.low * ftp) / 100),
      high: Math.round((percent.high * ftp) / 100),
    };
  }
}

export const middle = (range: WorkoutRange): number => (range.low + range.high) / 2;

/** One primary power target of an interval, if it has one. */
export function primaryOf(step: WorkoutInterval): WorkoutTarget | undefined {
  return step.effort.kind === 'target' ? step.effort.primary : undefined;
}

export function secondaryOf(step: WorkoutInterval): readonly WorkoutTarget[] {
  return step.effort.kind === 'max-effort' ? [] : (step.effort.secondary ?? []);
}

/** The name of a step for a warning: its name or its id. */
export const placeOf = (step: { id: string; name?: string }): string =>
  `step ${step.name ? `"${step.name}"` : step.id}`;

/** Repeats of a count as the steps they stand for, once per round, with fresh ids. */
export function unroll(
  steps: readonly WorkoutStep[],
  notes: Notes,
  format: WorkoutSourceFormat,
): WorkoutInterval[] {
  const out: WorkoutInterval[] = [];
  const walk = (list: readonly WorkoutStep[], prefix: string) => {
    for (const step of list) {
      if (step.kind === 'interval') {
        out.push({ ...step, id: prefix + step.id });
        continue;
      }
      const reps = step.until.kind === 'count' ? step.until.reps : 1;
      if (step.until.kind !== 'count') {
        notes.warn(
          'repeat-until-once',
          `A repeat that ends by ${step.until.kind} is written once; ${FORMAT_NAMES[format]} repeats by count only.`,
          `step ${step.id}`,
        );
      }
      for (let round = 1; round <= reps; round += 1)
        walk(step.steps, `${prefix}${step.id}.${round}.`);
    }
  };
  walk(steps, '');
  return out;
}

/** Seconds a step lasts when written as a time step; non-time durations are estimated and warned. */
export function secondsOf(
  step: WorkoutInterval,
  notes: Notes,
  format: WorkoutSourceFormat,
): number {
  const { duration } = step;
  if (duration.kind === 'time') return duration.seconds;
  const { seconds } = durationOf(duration);
  notes.warn(
    'duration-estimated',
    `${placeOf(step)}: a step by ${durationName(duration)} becomes a time step of ${Math.round(seconds)} s, estimated; ${FORMAT_NAMES[format]} cannot hold it.`,
    step.id,
  );
  return seconds;
}

function durationName(duration: WorkoutDuration): string {
  switch (duration.kind) {
    case 'distance':
      return 'distance';
    case 'energy':
      return 'energy';
    case 'open':
      return 'the lap button';
    case 'until':
      return 'a bound';
    default:
      return 'time';
  }
}

/** `extensions.<format>` of a step or workout, as an object. */
export function extensionOf(
  owner: { readonly extensions?: Record<string, unknown> },
  format: WorkoutSourceFormat,
): Record<string, unknown> | undefined {
  return record(owner.extensions?.[format]);
}

export const workoutExtension = (workout: Workout, format: WorkoutSourceFormat) =>
  extensionOf(workout, format);

const roundedUnit = (value: number, unit: WorkoutTargetUnit): number =>
  unit === 'power-zone' || unit === 'hr-zone'
    ? Math.max(1, Math.round(value))
    : Math.round(value * 100) / 100;

/**
 * Formats without ramps (TCX, FIT) hold a ramp as a run of small steps, each at the middle of its
 * stretch of the ramp: a range between two values means "stay in it", never "rise". A ramp whose
 * length is not a time, a distance or energy cannot be cut and is written as a range, warned.
 */
export function stepRamps(
  steps: readonly WorkoutStep[],
  notes: Notes,
  format: WorkoutSourceFormat,
): WorkoutStep[] {
  const cut = (step: WorkoutInterval): WorkoutStep[] => {
    const primary = primaryOf(step);
    if (!primary?.end || step.effort.kind !== 'target') return [step];
    const { start, end } = primary;
    const { duration, effort } = step;
    const parts =
      duration.kind === 'time'
        ? Math.min(20, Math.max(2, Math.round(duration.seconds / 30)))
        : duration.kind === 'distance' || duration.kind === 'energy'
          ? 10
          : 1;
    if (parts === 1) {
      notes.warn(
        'ramp-as-range',
        `${placeOf(step)}: a ramp over an open length cannot be cut into steps; ${FORMAT_NAMES[format]} gets the range between its ends.`,
        step.id,
      );
      const { end: _end, ...rest } = primary;
      return [
        {
          ...step,
          effort: {
            ...step.effort,
            primary: { ...rest, start: { low: start.low, high: end.high } },
          },
        },
      ];
    }
    notes.warn(
      'ramp-stepped',
      `${placeOf(step)}: ${FORMAT_NAMES[format]} has no ramps; a ramp is written as ${parts} small steps.`,
      step.id,
    );
    return Array.from({ length: parts }, (_, i): WorkoutInterval => {
      const t = (i + 0.5) / parts;
      const at = (from: number, to: number) => roundedUnit(from + (to - from) * t, primary.unit);
      const { end: _end, ...rest } = primary;
      const share: WorkoutDuration =
        duration.kind === 'time'
          ? { kind: 'time', seconds: duration.seconds / parts }
          : duration.kind === 'distance'
            ? { kind: 'distance', meters: duration.meters / parts }
            : {
                kind: 'energy',
                kilocalories: (duration as { kilocalories: number }).kilocalories / parts,
              };
      return {
        kind: 'interval',
        id: `${step.id}.r${i + 1}`,
        ...(step.name === undefined ? {} : { name: step.name }),
        ...(step.notes === undefined ? {} : { notes: step.notes }),
        ...(step.intensity === undefined ? {} : { intensity: step.intensity }),
        duration: share,
        effort: {
          ...effort,
          primary: {
            ...rest,
            start: { low: at(start.low, end.low), high: at(start.high, end.high) },
          },
        },
        ...(i === 0 && step.cues ? { cues: step.cues } : {}),
      };
    });
  };
  const walk = (list: readonly WorkoutStep[]): WorkoutStep[] =>
    list.flatMap((step) =>
      step.kind === 'repeat' ? [{ ...step, steps: walk(step.steps) }] : cut(step),
    );
  return walk(steps);
}
