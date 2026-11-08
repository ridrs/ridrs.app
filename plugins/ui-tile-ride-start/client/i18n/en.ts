// SPDX-License-Identifier: AGPL-3.0-or-later

/** The ride start tile's texts in English (ADR 0072): the shape of every language. */
export const en = {
  ride: 'Ride',
  freeRide: 'Free ride',
  ready: 'Ready to ride?',
  about: 'Ride at your own pace. Your devices join as they connect.',
  riding: (bicycle: string, kg: string) => `Riding ${bicycle} · ${kg} kg`,
  profileUnavailable: 'Your athlete profile is not available: the next ride uses default values.',
  start: 'Start ride',
  notSaved: 'Ride could not be saved',
  saved: 'Ride saved',
  kmIn: 'km in',
};

export type Messages = typeof en;
