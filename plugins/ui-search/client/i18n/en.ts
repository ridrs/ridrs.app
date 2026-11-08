// SPDX-License-Identifier: AGPL-3.0-or-later

/** The search's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Search',
  intro: 'One search for routes, workouts and events.',
  field: 'Search',
  placeholder: 'Route, workout or event',
  kinds: 'Kinds',
  kindsPlural: { route: 'Routes', workout: 'Workouts', event: 'Events' },
  kindSingular: { route: 'Route', workout: 'Workout', event: 'Event' },
  later: 'Filters by duration, TSS, zone, gradient and country, and sorting, come later.',
  nothing: 'Nothing found.',
  recent: 'Recent searches',
  /** The details of the placeholder results that are words, by the result's name. */
  details: {
    'Tuesday Tempo Ride': 'Group ride · Tue 18:30',
    'Sunday Club Race': 'Race · Sun 10:00',
    'Everest Challenge': 'Challenge · this month',
  } as Readonly<Record<string, string>>,
};

export type Messages = typeof en;
