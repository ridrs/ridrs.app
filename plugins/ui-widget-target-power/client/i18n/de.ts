// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The ERG widgets' texts in German (ADR 0072). */
export const de: Messages = {
  erg: 'ERG',
  on: 'An',
  off: 'Aus',
  targetPower: 'Zielleistung',
  target: 'Ziel',
  watts: (watts: number) => `${watts} W`,
  keys: '↑ ↓ Ziel',
};
