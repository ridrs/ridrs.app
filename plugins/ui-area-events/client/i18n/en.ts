// SPDX-License-Identifier: AGPL-3.0-or-later

/** The events area's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Events',
  intro: 'Ride together: races, group rides, challenges and clubs.',
  sections: {
    race: 'Races',
    group: 'Group rides',
    challenge: 'Challenges',
    club: 'Clubs and teams',
  },
  /** The placeholder events of the early alpha, by id. */
  events: {
    tempo: { name: 'Tuesday Tempo Ride', when: 'Tue 18:30', about: '60 min at 2.8 W/kg, no drop' },
    crit: { name: 'Thursday Crit Series', when: 'Thu 19:00', about: '25 km, categories A–D' },
    'club-race': { name: 'Sunday Club Race', when: 'Sun 10:00', about: '42 km on the Alpine Loop' },
    everest: { name: 'Everest Challenge', when: 'This month', about: '8,848 m of climbing' },
    distance: { name: '500 km in November', when: 'This month', about: 'Ride 500 km' },
    club: { name: 'ridrs Riders Club', when: 'Always', about: 'Weekly rides and a team chat' },
  },
  join: (name: string) => `Join ${name}`,
  joined: 'Joined',
  joinShort: 'Join',
  onToday: 'On Today',
  showOnToday: 'Show Next event on Today',
  nextEvent: 'Next event',
  noneJoined: 'No event joined yet',
  invitation: 'Races, group rides and challenges',
  allEvents: 'All events',
  findEvent: 'Find an event',
};

export type Messages = typeof en;
