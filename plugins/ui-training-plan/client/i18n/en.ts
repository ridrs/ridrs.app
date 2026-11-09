// SPDX-License-Identifier: AGPL-3.0-or-later

/** The training plan's texts in English (ADR 0072): the shape of every language. */
export const en = {
  /** The locale of dates: "Fri 6 Nov". */
  dateLocale: 'en-GB',
  today: 'Today',
  tomorrow: 'Tomorrow',
  warmUp: 'Warm-up',
  coolDown: 'Cool-down',
  /** Why the account is not connected, by the planner's reason. */
  accountReasons: {
    'sign-in-cancelled': 'Sign-in cancelled',
    'sign-in-rejected': 'Sign-in failed. Please try again.',
    'token-rejected': 'intervals.icu no longer accepts this connection.',
    unreachable: 'intervals.icu could not be reached.',
    'rate-limited': 'intervals.icu asks for a pause: too many requests.',
  } as Readonly<Record<string, string>>,
  reconnect: 'Reconnect intervals.icu',
  connect: 'Connect intervals.icu',
  connecting: 'Connecting to intervals.icu…',
  finishSignIn: 'Finish the sign-in in your browser.',
  onMainScreen: 'Your planned workouts on the main screen.',
  connectedAs: (athlete?: string) => (athlete ? `Connected as ${athlete}` : 'Connected'),
  notConnected: 'Not connected',
  offline: 'Offline',
  thisDevice: 'ridrs (this device)',
  nextWorkoutOn: (name: string, day: string) => `Next workout: ${name}, ${day}`,
  nonePlanned: 'No workout planned',
  loading: 'Loading your plan',
  loadingDots: 'Loading your plan…',
  nextWorkout: 'Next workout',
  load: (load: number) => `Load ${load}`,
  nothingSoon: 'Nothing planned for the next 14 days.',
  ftp: 'FTP',
  weight: 'Weight',
  refresh: 'Refresh',
  comesFromHere: 'Your planned workouts come from here.',
  disconnect: 'Disconnect intervals.icu',
};

export type Messages = typeof en;
