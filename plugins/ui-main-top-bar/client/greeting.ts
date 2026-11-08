// SPDX-License-Identifier: AGPL-3.0-or-later

export type PartOfDay = 'morning' | 'afternoon' | 'evening';

/** The part of the day to greet in: morning from 5 to 11 h, afternoon from 12 to 17 h, evening otherwise. */
export function greetingAt(hour: number): PartOfDay {
  if (hour >= 5 && hour < 12) {
    return 'morning';
  }
  return hour >= 12 && hour < 18 ? 'afternoon' : 'evening';
}

/** The greeting can change only on the hour. */
export function msUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0);
  return next.getTime() - now.getTime();
}
