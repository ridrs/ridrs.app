// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout } from '@ridrs/contracts';

/** The length classes of the duration filter, by minutes: up to 30, up to 60, up to 90, longer. */
export const DURATION_CLASSES = ['short', 'medium', 'long', 'extra-long'] as const;
export type DurationClass = (typeof DURATION_CLASSES)[number];

const LIMITS: readonly (readonly [DurationClass, number])[] = [
  ['short', 30],
  ['medium', 60],
  ['long', 90],
];

/** The class of a length; none for a workout whose length is not known. */
export function durationClassOf(seconds: number | undefined): DurationClass | undefined {
  if (seconds === undefined) return undefined;
  const minutes = seconds / 60;
  return LIMITS.find(([, upTo]) => minutes <= upTo)?.[0] ?? 'extra-long';
}

/** What the rider narrowed the catalogue to; an absent field lets everything through. */
export interface CatalogueFilter {
  readonly focus?: string;
  readonly duration?: DurationClass;
  readonly provider?: string;
}

/** One workout of the catalogue with the provider whose library holds it. */
export interface CatalogueItem {
  readonly provider: string;
  readonly workout: LibraryWorkout;
}

export const focusOf = (workout: LibraryWorkout): string | undefined => workout.workout?.focus;

/** Whether the workout passes the filter: a workout of unknown focus or length passes only that filter left open. */
export function passes(item: CatalogueItem, filter: CatalogueFilter): boolean {
  return (
    (filter.provider === undefined || item.provider === filter.provider) &&
    (filter.focus === undefined || focusOf(item.workout) === filter.focus) &&
    (filter.duration === undefined || durationClassOf(item.workout.durationSeconds) === filter.duration)
  );
}

/** The focuses that occur in the catalogue, in the order of the focus list of the format. */
export function focusesIn(items: readonly CatalogueItem[], order: readonly string[]): string[] {
  const present = new Set(items.map((item) => focusOf(item.workout)));
  return order.filter((focus) => present.has(focus));
}

/** The duration classes that occur in the catalogue. */
export function durationClassesIn(items: readonly CatalogueItem[]): DurationClass[] {
  const present = new Set(items.map((item) => durationClassOf(item.workout.durationSeconds)));
  return DURATION_CLASSES.filter((each) => present.has(each));
}
