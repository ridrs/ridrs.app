// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The search's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Suche',
  intro: 'Eine Suche für Routen, Workouts und Events.',
  field: 'Suche',
  placeholder: 'Route, Workout oder Event',
  kinds: 'Arten',
  kindsPlural: { route: 'Routen', workout: 'Workouts', event: 'Events' },
  kindSingular: { route: 'Route', workout: 'Workout', event: 'Event' },
  later: 'Filter nach Dauer, TSS, Zone, Steigung und Land sowie Sortierung folgen später.',
  nothing: 'Nichts gefunden.',
  recent: 'Letzte Suchen',
  details: {
    'Tuesday Tempo Ride': 'Gruppenfahrt · Di 18:30',
    'Sunday Club Race': 'Rennen · So 10:00',
    'Everest Challenge': 'Challenge · diesen Monat',
  },
};
