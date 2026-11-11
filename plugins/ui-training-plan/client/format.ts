// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  TrainingAccount,
  WorkoutInterval,
  WorkoutRange,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import type { Messages } from './i18n/index.ts';

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` as the rider's local midnight. */
function localMidnight(date: string): Date {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Today", "Tomorrow", else "Fri 6 Nov", in the rider's language. */
export function dayLabel(date: string, now: number, text: Messages): string {
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = localMidnight(date);
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((day.getTime() - startOfToday) / DAY_MS);
  if (days === 0) {
    return text.today;
  }
  if (days === 1) {
    return text.tomorrow;
  }
  const weekday = new Intl.DateTimeFormat(text.dateLocale, { weekday: 'short', day: 'numeric', month: 'short' });
  return weekday.format(day).replace(',', '');
}

/** "1 h 15 min", "2 h", "12 min", "45 s", "1 min 30 s". */
export function durationLabel(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  if (m > 0) {
    return s > 0 ? `${m} min ${s} s` : `${m} min`;
  }
  return `${s} s`;
}

const range = (low: number, high: number, unit: string) =>
  low === high ? `${low} ${unit}` : `${low}–${high} ${unit}`;

const mid = (range: WorkoutRange) => (range.low + range.high) / 2;

/** A ramp from start to end, else the range of the start. */
const span = (target: WorkoutTarget): [number, number] =>
  target.end ? [mid(target.start), mid(target.end)] : [target.start.low, target.start.high];

/**
 * "90 % FTP · 225 W", "50–75 % FTP · 125–188 W", "200–220 W", "Z2": the target in its own unit,
 * watts beside % only with an FTP. Units the tile does not show yet give "".
 */
export function targetLabel(target: WorkoutTarget, ftp: number | undefined): string {
  const [from, to] = span(target);
  switch (target.unit) {
    case 'percent-ftp': {
      const percent = range(Math.round(from), Math.round(to), '% FTP');
      if (ftp === undefined) {
        return percent;
      }
      const watts = (value: number) => Math.round((value * ftp) / 100);
      return `${percent} · ${range(watts(from), watts(to), 'W')}`;
    }
    case 'watts':
      return range(Math.round(from), Math.round(to), 'W');
    case 'power-zone':
      return from === to ? `Z${from}` : `Z${from}–Z${to}`;
    default:
      return '';
  }
}

/** The power target of an interval, if it has one. */
export function powerTarget(step: WorkoutInterval): WorkoutTarget | undefined {
  const primary = step.effort.kind === 'target' ? step.effort.primary : undefined;
  return primary && ['percent-ftp', 'watts', 'power-zone'].includes(primary.unit) ? primary : undefined;
}

/** The mean power of an interval in % FTP, for the bars; 0 without one ridrs can place. */
export function meanPercent(step: WorkoutInterval, ftp: number | undefined): number {
  const target = powerTarget(step);
  if (!target) {
    return 0;
  }
  const [from, to] = span(target);
  const mean = (from + to) / 2;
  if (target.unit === 'percent-ftp') {
    return mean;
  }
  return target.unit === 'watts' && ftp !== undefined ? (mean / ftp) * 100 : 0;
}

/** The seconds of a step with a time; 0 for distance, lap button and the like. */
export function stepSeconds(step: WorkoutInterval): number {
  return step.duration.kind === 'time' ? step.duration.seconds : 0;
}

export function stepName(step: WorkoutInterval, text: Messages): string {
  if (step.intensity === 'warm-up') {
    return text.warmUp;
  }
  if (step.intensity === 'cool-down') {
    return text.coolDown;
  }
  return step.name ?? '';
}

/** The number of times a repeat runs: its count, else once. */
export const repeatCount = (step: Extract<WorkoutStep, { kind: 'repeat' }>): number =>
  step.until.kind === 'count' ? step.until.reps : 1;

/** The intervals in riding order, repeats unrolled: one bar each in the power profile. */
export function unrolled(steps: readonly WorkoutStep[]): WorkoutInterval[] {
  return steps.flatMap((step) =>
    step.kind === 'repeat'
      ? Array.from({ length: repeatCount(step) }, () => unrolled(step.steps)).flat()
      : [step],
  );
}

/** What the panel says about the account, if anything. */
export function accountMessage(account: TrainingAccount, text: Messages): string | undefined {
  return account.reason === undefined ? undefined : text.accountReasons[account.reason];
}
