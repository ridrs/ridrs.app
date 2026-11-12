// SPDX-License-Identifier: AGPL-3.0-or-later

/** The workout widget's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Workout',
  now: 'NOW',
  next: 'NEXT',
  /** "at 115 % 288 W": the target. */
  at: 'at',
  freeRide: 'Free ride',
  maxEffort: 'Max effort',
  heartRate: (bpm: string) => `${bpm} bpm`,
  rpm: 'rpm',
  untilNext: 'until the next step',
  distance: (meters: number) => (meters >= 1000 ? `${Math.round(meters / 100) / 10} km` : `${Math.round(meters)} m`),
  energy: (kilocalories: number) => `${Math.round(kilocalories)} kcal`,
  left: (time: string) => `${time} left`,
  /** "3/5" read out. */
  setLabel: (at: number, of: number) => `${at} of ${of}`,
  countdown: (seconds: number) => `Next step in ${seconds}`,
  done: 'Workout done',
  starting: 'Get ready',
  barLabel: 'Time left in the step',
};

export type Messages = typeof en;
