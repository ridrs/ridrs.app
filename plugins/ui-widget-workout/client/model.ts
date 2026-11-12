// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutCue, WorkoutDuration, WorkoutEffort, WorkoutRange } from '@ridrs/contracts';
import type { TimelineSegment } from '@ridrs/workout';

/** How long a cue without a duration of its own stays up. */
export const CUE_SECONDS = 10;
/** The countdown before a step changes: 3, 2, 1. */
export const COUNTDOWN_SECONDS = 3;

const round = (value: number) => Math.round(value);

/** "4:00", "1:47", "1:02:03": the clock of a step. */
export function clock(totalSeconds: number): string {
  const total = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** "288", "95–105": a range as the rider reads it; one number for an exact value. */
export function rangeText(range: WorkoutRange): string {
  return round(range.low) === round(range.high) ? `${round(range.low)}` : `${round(range.low)}–${round(range.high)}`;
}

/** What a step asks, in the units the HUD shows. `percent` only with an FTP. */
export type EffortView =
  | {
      readonly kind: 'power';
      /** A ramp reads "125 → 188", a steady step or a range "288" or "270–290". */
      readonly watts: string | undefined;
      readonly percent: string | undefined;
    }
  | { readonly kind: 'heart-rate'; readonly bpm: string }
  | { readonly kind: 'free' }
  | { readonly kind: 'max-effort' }
  | { readonly kind: 'none' };

const middle = (range: WorkoutRange) => (range.low + range.high) / 2;

/** The span of a ramp or a range: from where it starts to where it ends. */
function spanText(start: WorkoutRange, end: WorkoutRange | undefined, convert: (value: number) => number) {
  const scaled = (range: WorkoutRange): WorkoutRange => ({ low: convert(range.low), high: convert(range.high) });
  if (!end || (end.low === start.low && end.high === start.high)) return rangeText(scaled(start));
  const from = convert(middle(start));
  const to = convert(middle(end));
  return `${round(from)} → ${round(to)}`;
}

/** The ride's workout holds watts; % FTP is shown beside them, and kept when a target still is in %. */
export function effortOf(effort: WorkoutEffort, ftp: number | undefined): EffortView {
  if (effort.kind === 'free') return { kind: 'free' };
  if (effort.kind === 'max-effort') return { kind: 'max-effort' };
  const { unit, start, end } = effort.primary;
  if (unit === 'watts') {
    return {
      kind: 'power',
      watts: spanText(start, end, (watts) => watts),
      percent: ftp ? spanText(start, end, (watts) => (watts * 100) / ftp) : undefined,
    };
  }
  if (unit === 'percent-ftp') {
    return {
      kind: 'power',
      watts: ftp ? spanText(start, end, (percent) => (percent * ftp) / 100) : undefined,
      percent: spanText(start, end, (percent) => percent),
    };
  }
  if (unit === 'bpm') return { kind: 'heart-rate', bpm: spanText(start, end, (bpm) => bpm) };
  return { kind: 'none' };
}

/** The cadence target ("95–105"), from the targets beside the power. */
export function cadenceOf(effort: WorkoutEffort): string | undefined {
  const targets = effort.kind === 'max-effort' ? [] : (effort.secondary ?? []);
  const cadence = targets.find((target) => target.unit === 'rpm');
  return cadence ? spanText(cadence.start, cadence.end, (rpm) => rpm) : undefined;
}

/** The length of a step as the HUD says it: a clock for a timed one, else what ends it. */
export type DurationView =
  | { readonly kind: 'time'; readonly seconds: number }
  | { readonly kind: 'distance'; readonly meters: number }
  | { readonly kind: 'energy'; readonly kilocalories: number }
  | { readonly kind: 'open' };

export function durationOf(duration: WorkoutDuration): DurationView {
  switch (duration.kind) {
    case 'time':
      return { kind: 'time', seconds: duration.seconds };
    case 'distance':
      return { kind: 'distance', meters: duration.meters };
    case 'energy':
      return { kind: 'energy', kilocalories: duration.kilocalories };
    default:
      // The lap button, or a condition: until the player moves on.
      return { kind: 'open' };
  }
}

/** One step of the workout as the widget shows it. */
export interface StepView {
  readonly index: number;
  readonly duration: DurationView;
  readonly effort: EffortView;
  readonly cadence: string | undefined;
}

export function stepView(segment: TimelineSegment, ftp: number | undefined): StepView {
  return {
    index: segment.index,
    duration: durationOf(segment.duration),
    effort: effortOf(segment.effort, ftp),
    cadence: cadenceOf(segment.effort),
  };
}

/** "3/5": the round of the innermost counted repeat, else the place among all the steps. */
export function setOf(segment: TimelineSegment, count: number): { readonly of: number; readonly at: number } {
  const repeat = segment.repeats.at(-1);
  if (repeat?.count !== undefined) return { at: repeat.iteration, of: repeat.count };
  return { at: segment.index + 1, of: count };
}

/** The cue that is up at `seconds` into the step, if any: the first of those that overlap. */
export function cueAt(cues: readonly WorkoutCue[], seconds: number): WorkoutCue | undefined {
  return cues.find((cue) => {
    const length = cue.durationSeconds && cue.durationSeconds > 0 ? cue.durationSeconds : CUE_SECONDS;
    return seconds >= cue.offsetSeconds && seconds < cue.offsetSeconds + length;
  });
}

/** 3, 2, 1 in the last seconds of a timed step that another step follows; else nothing. */
export function countdownAt(remainingSeconds: number | undefined, hasNext: boolean): number | undefined {
  if (remainingSeconds === undefined || !hasNext) return undefined;
  return remainingSeconds >= 1 && remainingSeconds <= COUNTDOWN_SECONDS ? Math.ceil(remainingSeconds) : undefined;
}

/**
 * Whole seconds ridden in the step: the ride's clock from its start, without the time it stood
 * still. While paused the clock stands at the pause.
 */
export function elapsedSeconds(input: {
  readonly now: number;
  readonly stepStartedAt: number;
  readonly pausedAt: number | undefined;
  readonly pausedMs: number;
}): number {
  const at = input.pausedAt ?? input.now;
  return Math.max(0, Math.floor((at - input.stepStartedAt - input.pausedMs) / 1000));
}
