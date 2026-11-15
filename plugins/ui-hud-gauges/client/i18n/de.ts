// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The gauges' texts in German (ADR 0072). */
export const de: Messages = {
  power: 'Leistung',
  heartRate: 'Puls',
  time: 'Zeit',
  distance: 'Distanz',
  speed: 'Tempo',
  cadence: 'Trittfrequenz',
  average: 'Ø',
  zone: (zone: number) => `Zone ${zone}`,
};
