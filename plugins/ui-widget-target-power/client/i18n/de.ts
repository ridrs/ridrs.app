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
  /** The workout halted itself (ADR 0113): the trainer rides the route. */
  halted: 'Angehalten',
  goingOn: (seconds: number) => `Weiter in ${seconds}`,
  /** The target after a repeated halt, as a share of the step's. */
  ceiling: (percent: number) => `Ziel ${percent} %`,
};
