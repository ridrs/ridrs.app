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
  weight: 'Weight',
  weeklyGoal: 'Weekly goal',
  notUsed: (wattsPerKg: string) => `${wattsPerKg} W/kg. The ride does not use these values yet.`,
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
