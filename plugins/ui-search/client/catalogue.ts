// SPDX-License-Identifier: AGPL-3.0-or-later

export type ResultKind = 'route' | 'workout' | 'event';

/** One thing to find, and the screen that shows it. */
export interface Result {
  readonly name: string;
  readonly kind: ResultKind;
  readonly screen: string;
  /** In English; the details that are words come from the language files instead. */
  readonly detail: string;
}

/**
 * The search's own placeholder catalogue of the early alpha: the areas do not offer their content
 * to other plugins yet, so the names repeat theirs.
 */
export const CATALOGUE: readonly Result[] = [
  { name: 'Alpine Loop', kind: 'route', screen: 'ride', detail: '32 km · 840 m' },
  { name: 'Coastal Flats', kind: 'route', screen: 'ride', detail: '24 km · 60 m' },
  { name: 'Volcano Climb', kind: 'route', screen: 'ride', detail: '18 km · 1120 m' },
  { name: 'City Criterium', kind: 'route', screen: 'ride', detail: '12 km · 40 m' },
  { name: 'Sweet Spot 3×12', kind: 'workout', screen: 'training', detail: '60 min · TSS 75' },
  { name: 'VO2 Max 5×4', kind: 'workout', screen: 'training', detail: '55 min · TSS 70' },
  { name: 'Endurance 90', kind: 'workout', screen: 'training', detail: '90 min · TSS 65' },
  { name: 'Recovery Spin', kind: 'workout', screen: 'training', detail: '40 min · TSS 20' },
  { name: 'Tuesday Tempo Ride', kind: 'event', screen: 'events', detail: 'Group ride · Tue 18:30' },
  { name: 'Sunday Club Race', kind: 'event', screen: 'events', detail: 'Race · Sun 10:00' },
  { name: 'Everest Challenge', kind: 'event', screen: 'events', detail: 'Challenge · this month' },
];

/** The entries whose name contains the query (ignoring case and the space around it). */
export function search(
  catalogue: readonly Result[],
  query: string,
  kinds: readonly ResultKind[],
): Result[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return catalogue.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) && (kinds.length === 0 || kinds.includes(entry.kind)),
  );
}
