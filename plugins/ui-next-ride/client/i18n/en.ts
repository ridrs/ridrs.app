// SPDX-License-Identifier: AGPL-3.0-or-later

/** The next ride's texts in English (ADR 0072): the shape of every language. */
export const en = {
  nextRide: 'Next ride',
  workout: 'Workout',
  route: 'Route',
  dropWorkout: 'Drop a workout here',
  dropRoute: 'Drop a route here',
  start: 'Start next ride',
  gone: 'No longer available',
  removeWorkout: 'Remove the workout from the next ride',
  removeRoute: 'Remove the route from the next ride',
  minutes: (minutes: number) => `${minutes} min`,
  kilometres: (km: string) => `${km} km`,
  numberLocale: 'en-GB',
};

export type Messages = typeof en;
