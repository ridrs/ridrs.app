// SPDX-License-Identifier: AGPL-3.0-or-later

/** The training area's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Training',
  intro:
    'The calendar is the hub: drag a workout from below onto a day to plan it, and a planned workout onto another day to move it.',
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
  previousWeek: 'Previous week',
  nextWeek: 'Next week',
  openLarge: 'Open large calendar',
  thisWeekOnly: 'The calendar of ridrs holds this week only: another calendar can be chosen in the settings.',
  back: 'Back',
  calendar: 'Calendar',
  thisWeek: 'This week',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  thisMonth: 'This month',
  asPlanned: 'as planned',
  ridAsPlanned: (plan: string) => `Ridden as planned: ${plan}`,
  dateLocale: 'en-GB',
  exportLater: 'Export to Google, Apple and Outlook calendars comes later.',
  workouts: 'Workouts',
  zones: { 'sweet-spot': 'Sweet spot', 'vo2-max': 'VO2 max', endurance: 'Endurance', recovery: 'Recovery' } as Readonly<
    Record<string, string>
  >,
  favourite: (name: string) => `Favourite ${name}`,
  library: 'Workout library',
  planRefused: (source: string, reason: 'read-only' | 'unreachable') =>
    reason === 'read-only'
      ? `${source} cannot be changed from the library.`
      : `${source} could not be reached: nothing was planned.`,
  saving: 'Saving…',
  writeFailed: (source: string) => `${source} did not take the change.`,
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
