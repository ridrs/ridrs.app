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

/** A length in whole hours, minutes and seconds, for "4 min", "1 min 30 s", "1 h 5 min". */
export interface Span {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

export function spanOf(totalSeconds: number): Span {
  const total = Math.max(0, Math.round(totalSeconds));
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
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

/** How hard a step is, for its bar and its zone. */
export interface EffortLevel {
  /** In the workout's own scale: % FTP with an FTP or a target in %, else watts. */
  readonly value: number | undefined;
  readonly percentFtp: number | undefined;
  /** Max effort: as hard as the hardest step. */
  readonly max: boolean;
}

/** The level of a step: the middle of its target where it ends (a ramp counts by its end). */
export function effortLevel(effort: WorkoutEffort, ftp: number | undefined): EffortLevel {
  if (effort.kind === 'max-effort') return { value: undefined, percentFtp: undefined, max: true };
  if (effort.kind === 'free') return { value: undefined, percentFtp: undefined, max: false };
  const { unit, start, end } = effort.primary;
  const at = middle(end ?? start);
  if (unit === 'watts') {
    const percentFtp = ftp ? (at * 100) / ftp : undefined;
    return { value: percentFtp ?? at, percentFtp, max: false };
  }
  if (unit === 'percent-ftp') return { value: at, percentFtp: at, max: false };
  return { value: undefined, percentFtp: undefined, max: false };
}

/**
 * The zone ramp of the workout chart (`ui-workout-chart/client/palette.ts`, dark theme), cool to
 * hot, as the gauges keep it too. Plugins share no code, so the widget keeps its own copy; the
 * HUD lies over a video and is always dark.
 */
const ZONE_COLOURS = [
  '#0a3aff',
  '#59a6cf',
  '#0ffae3',
  '#99db94',
  '#f5ff3d',
  '#d0a771',
  '#f68c14',
  '#fe2966',
  '#ff70e0',
  '#8b49fa',
] as const;

/** The colour of a 1-based zone, spreading `count` zones over the ramp as the chart does. */
export function zoneColour(zone: number, count: number): string {
  const slots = ZONE_COLOURS.length;
  const index = Math.min(Math.max(Math.round(zone), 1), Math.max(count, 1)) - 1;
  const slot =
    count > slots
      ? Math.min(index, slots - 1)
      : count <= 1
        ? 0
        : Math.round((index * (slots - 1)) / (Math.min(count, slots) - 1));
  return ZONE_COLOURS[slot] ?? ZONE_COLOURS[0];
}

/**
 * A `#rrggbb` colour as the wide-gamut colour of the same coordinates in Display P3, at full
 * brightness, as the gauges light their scale: more vivid on a P3 or HDR screen, the nearest
 * colour on an sRGB one.
 */
export function vivid(hex: string): string {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const brightest = Math.max(...channels, 1e-6);
  const [r, g, b] = channels.map((channel) => (channel / brightest).toFixed(3));
  return `color(display-p3 ${r} ${g} ${b})`;
}

/** The ink on a chip of colour `hex`: dark on a light zone, light on a dark one (WCAG luminance). */
export function inkOn(hex: string): string {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // The ink with the better contrast: #0b1220 (L ≈ 0.006) or #f2f5fa (L ≈ 0.91).
  return (luminance + 0.05) / 0.056 >= 0.96 / (luminance + 0.05) ? '#0b1220' : '#f2f5fa';
}
