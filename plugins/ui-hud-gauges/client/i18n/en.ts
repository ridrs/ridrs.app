// SPDX-License-Identifier: AGPL-3.0-or-later

/** The gauges' texts in English (ADR 0072): the shape of every language. */
export const en = {
  power: 'Power',
  heartRate: 'Heart rate',
  time: 'Time',
  distance: 'Distance',
  speed: 'Speed',
  gradient: 'Gradient',
  elevation: 'Elev',
  climb: 'Climb',
  route: 'Route',
  step: 'Step',
  target: 'Target',
  cadence: 'Cadence',
  /** Before the average of the ride. */
  average: 'avg',
  /** The virtual gear, in the cadence gauge. */
  gear: 'Gear',
  /** The name of a zone the profile leaves unnamed. */
  zone: (zone: number) => `Zone ${zone}`,
  /** Climb category badge in the summit segment. */
  climbCategory: (category: 'HC' | '1' | '2' | '3' | '4') =>
    category === 'HC' ? 'HC' : `Cat ${category}`,
  /** Countdown to summit, e.g. `7 s`. */
  secondsShort: (seconds: number) => `${seconds} s`,
};

export type Messages = typeof en;
