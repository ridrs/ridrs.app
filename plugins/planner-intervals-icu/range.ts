// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The days the plugin holds (ADR 0088): the default window a start reads (the planned workouts of
 * the next two weeks, the rides of the last two) and the spans the large calendar asked for. Each
 * span has the time it was read; what lies outside every span held is dropped, so the cache stays
 * small however far the rider pages.
 */

/** A span of the rider's local dates, both ends included, and when it was read. */
export interface ReadSpan {
  readonly oldest: string;
  readonly newest: string;
  readonly at: number;
}

/** How many spans are kept besides the default window: a year of months paged through. */
export const KEPT_SPANS = 12;

const inside = (date: string, span: { readonly oldest: string; readonly newest: string }) =>
  date >= span.oldest && date <= span.newest;

/** Whether `oldest`–`newest` lies in one span read less than `validMs` before `now`. */
export function isSpanFresh(
  spans: readonly ReadSpan[],
  oldest: string,
  newest: string,
  now: number,
  validMs: number,
): boolean {
  return spans.some(
    (span) => span.oldest <= oldest && span.newest >= newest && now >= span.at && now - span.at < validMs,
  );
}

/** The spans after `read` was read: it replaces the spans it covers, the oldest beyond `KEPT_SPANS` go. */
export function withSpan(spans: readonly ReadSpan[], read: ReadSpan): ReadSpan[] {
  return [...spans.filter((span) => !(span.oldest >= read.oldest && span.newest <= read.newest)), read]
    .sort((a, b) => a.at - b.at)
    .slice(-KEPT_SPANS);
}

/**
 * `held` with the days of `read` replaced by `incoming` (what the provider has for them now), in
 * date order. Days outside `read` keep what they had, as long as `keeps` holds them.
 */
export function mergeDays<T extends { readonly date: string }>(
  held: readonly T[],
  read: { readonly oldest: string; readonly newest: string },
  incoming: readonly T[],
  keeps: (date: string) => boolean,
): T[] {
  return [...held.filter((item) => !inside(item.date, read) && keeps(item.date)), ...incoming]
    .filter((item) => keeps(item.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Whether `date` lies in the default window `window` or in one of `spans`. */
export const holds =
  (window: { readonly oldest: string; readonly newest: string }, spans: readonly ReadSpan[]) =>
  (date: string): boolean =>
    inside(date, window) || spans.some((span) => inside(date, span));

/** The days from `oldest` to `newest`, both included; 0 when `newest` is before `oldest`. */
export function spanDays(oldest: string, newest: string): number {
  const day = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.max(0, Math.round((day(newest) - day(oldest)) / 86_400_000) + 1);
}
