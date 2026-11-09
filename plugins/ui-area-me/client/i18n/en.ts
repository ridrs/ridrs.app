// SPDX-License-Identifier: AGPL-3.0-or-later

/** The Me area's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Me',
  intro: 'Your rides, your progress and your account.',
  profile: 'Profile',
  lower: (name: string) => `Lower ${name}`,
  raise: (name: string) => `Raise ${name}`,
  progress: 'Progress and FTP',
  ftp: 'FTP',
  save: 'Save',
  discard: 'Discard',
  unsaved: 'Not saved yet.',
  weight: 'Weight',
  weeklyGoal: 'Weekly goal',
  thisDevice: 'ridrs (this device)',
  wattsPerKg: (ratio: string) => `${ratio} W/kg.`,
  fromSource: (source: string) => `From ${source}.`,
  readOnly: (source: string) => `${source} cannot be changed here.`,
  refused: (source: string, reason: 'read-only' | 'unreachable') =>
    reason === 'read-only'
      ? `${source} cannot be changed here.`
      : `${source} could not be reached: the value stays as it was.`,
  rideUses: 'The next ride uses your weight; FTP is not used yet.',
  activities: 'Activities',
  activitiesSoon: 'Your recorded rides with their FIT files will be listed here.',
  achievements: 'Achievements',
  first100: 'First 100 km',
  first100About: 'Ride 100 km in total',
  climber: 'Climber',
  climberAbout: 'Climb 1,000 m in one ride',
  account: 'Account and subscription',
  accountSoon: 'Sign-in, profile and subscription come with the athlete profile.',
  connected: 'Connected services',
  onToday: 'On Today',
  showOnToday: 'Show Weekly goal on Today',
  hoursOf: (ridden: string, goal: string) => `${ridden} of ${goal} h`,
  shareOfGoal: (percent: number) => `${percent} % of this week's goal`,
  changeGoal: 'Change the goal',
};

export type Messages = typeof en;
