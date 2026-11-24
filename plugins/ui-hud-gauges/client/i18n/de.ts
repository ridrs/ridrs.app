// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The gauges' texts in German (ADR 0072). */
export const de: Messages = {
  power: 'Leistung',
  heartRate: 'Puls',
  time: 'Dauer',
  distance: 'Distanz',
  speed: 'Geschwindigkeit',
  gradient: 'Steigung',
  elevation: 'Höhe',
  cadence: 'Trittfrequenz',
  average: 'Ø',
  gear: 'Gang',
  zone: (zone: number) => `Zone ${zone}`,
  climbCategory: (category) => (category === 'HC' ? 'HC' : `Kat. ${category}`),
  secondsShort: (seconds) => `${seconds} s`,
};
