// SPDX-License-Identifier: AGPL-3.0-or-later

/** The training area's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Training',
  intro:
    'The calendar is the hub: add, move and remove entries here, schedule workouts from the library. Every change is kept at once; Undo takes it back.',
  pictureCredits: 'Photo: Munbaik Cycling Clothing, Unsplash',
  weekdays: {
    Monday: 'Monday',
    Tuesday: 'Tuesday',
    Wednesday: 'Wednesday',
    Thursday: 'Thursday',
    Friday: 'Friday',
    Saturday: 'Saturday',
    Sunday: 'Sunday',
  },
  short: (day: string) => day.slice(0, 3),
  today: 'today',
  /** The entries that are not a workout, by kind; a workout shows its name. */
  kinds: { rest: 'Rest day', note: 'Note', outdoor: 'Outdoor ride' },
  move: (entry: string, from: string, to: string) => `Move ${entry} from ${from} to ${to}`,
  later: 'Later',
  removeFrom: (entry: string, day: string) => `Remove ${entry} from ${day}`,
  remove: 'Remove',
  thisWeek: 'This week',
  addRest: (day: string) => `Add a rest day on ${day}`,
  addNote: (day: string) => `Add a note on ${day}`,
  addOutdoor: (day: string) => `Add an outdoor ride on ${day}`,
  undo: 'Undo',
  exportLater: 'Export to Google, Apple and Outlook calendars comes later.',
  workouts: 'Workouts',
  zones: { 'sweet-spot': 'Sweet spot', 'vo2-max': 'VO2 max', endurance: 'Endurance', recovery: 'Recovery' } as Readonly<
    Record<string, string>
  >,
  favourite: (name: string) => `Favourite ${name}`,
  schedule: (name: string, day: string) => `Schedule ${name} on ${day}`,
  library: 'Workout library',
  planFromLibrary: (name: string, day: string) => `Plan ${name} on ${day}`,
  planRefused: (source: string, reason: 'read-only' | 'unreachable') =>
    reason === 'read-only'
      ? `${source} cannot be changed from the library.`
      : `${source} could not be reached: nothing was planned.`,
  libraryEmpty: 'Your sources have no workouts yet.',
  thisDevice: 'ridrs (this device)',
  plans: 'Training plans',
  baseBuilder: '8 weeks · 6 h a week · builds endurance',
  ftpBuilder: '6 weeks · 5 h a week · raises the threshold',
  suggestion: 'Suggestion',
  suggestionLater:
    'A suggestion for today from your week and your form comes later. Until then: Endurance 90 suits a day without other training.',
};

export type Messages = typeof en;
