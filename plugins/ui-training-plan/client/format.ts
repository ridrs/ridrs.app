// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TrainingAccount, WorkoutInterval, WorkoutPower, WorkoutStep } from '@ridrs/contracts';

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` as the rider's local midnight. */
function localMidnight(date: string): Date {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** "Today", "Tomorrow", else "Fri 6 Nov". */
export function dayLabel(date: string, now: number): string {
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = localMidnight(date);
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((day.getTime() - startOfToday) / DAY_MS);
  if (days === 0) {
    return 'Today';
  }
  if (days === 1) {
    return 'Tomorrow';
  }
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

/** "90 % FTP · 225 W", "50–75 % FTP · 125–188 W"; watts only with an FTP. */
export function powerLabel(power: WorkoutPower): string {
  const percent = range(Math.round(power.low), Math.round(power.high), '% FTP');
  if (power.lowWatts === undefined || power.highWatts === undefined) {
    return percent;
  }
  return `${percent} · ${range(power.lowWatts, power.highWatts, 'W')}`;
}

export function stepName(step: WorkoutInterval): string {
  if (step.phase === 'warm-up') {
    return 'Warm-up';
  }
  if (step.phase === 'cool-down') {
    return 'Cool-down';
  }
  return step.text ?? '';
}

/** The intervals in riding order, repeats unrolled: one bar each in the power profile. */
export function unrolled(steps: readonly WorkoutStep[]): WorkoutInterval[] {
  return steps.flatMap((step) =>
    step.kind === 'repeat'
      ? Array.from({ length: step.reps }, () => unrolled(step.steps)).flat()
      : [step],
  );
}

/** What the panel says about the account, if anything. */
export function accountMessage(account: TrainingAccount): string | undefined {
  switch (account.reason) {
    case 'sign-in-cancelled':
      return 'Sign-in cancelled';
    case 'sign-in-rejected':
      return 'Sign-in failed. Please try again.';
    case 'token-rejected':
      return 'intervals.icu no longer accepts this connection.';
    case 'unreachable':
      return 'intervals.icu could not be reached.';
    default:
      return undefined;
  }
}
