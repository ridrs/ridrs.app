// SPDX-License-Identifier: AGPL-3.0-or-later

/** "Good morning" from 5 to 11 h, "Good afternoon" from 12 to 17 h, "Good evening" otherwise. */
export function greetingAt(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return 'Good morning';
  }
  return hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** The greeting can change only on the hour. */
export function msUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0);
  return next.getTime() - now.getTime();
}
