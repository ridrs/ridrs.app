// SPDX-License-Identifier: AGPL-3.0-or-later

/** The briefing's texts in English (ADR 0072): the shape of every language. */
export const en = {
  locale: 'en',
  title: 'Before you ride',
  back: 'Back',
  loading: 'Getting ready…',
  route: 'Route',
  freeRide: 'Free ride',
  noRoutes: 'No route is on offer yet.',
  routeMissing: 'This route is not on offer any more. Choose another.',
  workout: 'Workout',
  noWorkout: 'No workout',
  planned: 'Planned',
  library: 'Library',
  noWorkouts: 'No workout is on offer yet.',
  workoutMissing: 'This workout is no longer in your library or calendar. Choose another.',
  bicycle: 'Bicycle',
  riding: (name: string, kg: string) => `${name} · ${kg} kg`,
  changeRoute: 'Change route',
  changeWorkout: 'Change workout',
  changeBicycle: 'Change bicycle',
  chosen: 'Chosen',
  preview: 'Preview',
  routeProfile: 'Route profile',
  workoutChart: 'Workout chart',
  chartFallback: (duration: string, load: string | undefined) =>
    load === undefined ? duration : `${duration} · TSS ${load}`,
  summary: 'Summary',
  duration: 'Duration',
  distance: 'Distance',
  trainingLoad: 'TSS',
  timeInZones: 'Time per zone',
  zonesNeedFtp: 'With an FTP in your profile, the time per zone shows here.',
  ready: 'Ready?',
  trainer: 'Trainer',
  heartRate: 'Heart rate',
  connected: (name: string) => (name ? `${name} connected` : 'Connected'),
  notConnected: 'Not connected',
  pair: 'Pair',
  pairTrainer: 'Pair trainer',
  pairHeartRate: 'Pair heart rate',
  routeReady: 'The route is on this device',
  routeNotReady: 'The route is not on this device yet',
  download: 'Download',
  downloadRoute: 'Download route',
  /** The workout outlasts the route. */
  workoutLonger: (workout: string, route: string) =>
    `Workout ${workout}, route about ${route}: the picture then stands still and the workout goes on.`,
  /** The route outlasts the workout. */
  routeLonger: (workout: string, route: string) =>
    `Workout ${workout}, route about ${route}: the workout ends first, then you ride on along the route in resistance mode.`,
  minutes: (seconds: number) => `${Math.round(seconds / 60)} min`,
  start: 'Start',
  refusal: {
    'no-ftp': 'This workout is set in % of your FTP, and your profile has no FTP yet. Set your FTP in your profile, then start again.',
    'no-power-zones':
      'This workout is set in power zones, and your profile has none yet. Set your zones in your profile, then start again.',
  },
};

export type Messages = typeof en;
