// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The events area's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Events',
  intro: 'Gemeinsam fahren: Rennen, Gruppenfahrten, Challenges und Clubs.',
  sections: {
    race: 'Rennen',
    group: 'Gruppenfahrten',
    challenge: 'Challenges',
    club: 'Clubs und Teams',
  },
  events: {
    tempo: { name: 'Tuesday Tempo Ride', when: 'Di 18:30', about: '60 min mit 2,8 W/kg, niemand wird abgehängt' },
    crit: { name: 'Thursday Crit Series', when: 'Do 19:00', about: '25 km, Kategorien A–D' },
    'club-race': { name: 'Sunday Club Race', when: 'So 10:00', about: '42 km auf dem Alpine Loop' },
    everest: { name: 'Everest Challenge', when: 'Diesen Monat', about: '8.848 Höhenmeter' },
    distance: { name: '500 km im November', when: 'Diesen Monat', about: 'Fahre 500 km' },
    club: { name: 'ridrs Riders Club', when: 'Immer', about: 'Wöchentliche Ausfahrten und ein Team-Chat' },
  },
  join: (name: string) => `${name} beitreten`,
  joined: 'Dabei',
  joinShort: 'Beitreten',
  onToday: 'Auf Heute',
  showOnToday: 'Nächstes Event auf Heute zeigen',
  nextEvent: 'Nächstes Event',
  noneJoined: 'Noch keinem Event beigetreten',
  invitation: 'Rennen, Gruppenfahrten und Challenges',
  allEvents: 'Alle Events',
  findEvent: 'Event finden',
};
