// SPDX-License-Identifier: AGPL-3.0-or-later

/** The gauges' texts in English (ADR 0072): the shape of every language. */
export const en = {
  power: 'Power',
  heartRate: 'Heart rate',
  time: 'Time',
  distance: 'Distance',
  speed: 'Speed',
  gradient: 'Gradient',
  cadence: 'Cadence',
  /** Before the average of the ride. */
  average: 'avg',
  /** The virtual gear, in the cadence gauge. */
  gear: 'Gear',
  /** The name of a zone the profile leaves unnamed. */
  zone: (zone: number) => `Zone ${zone}`,
};

export type Messages = typeof en;
