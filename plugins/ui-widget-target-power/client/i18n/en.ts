// SPDX-License-Identifier: AGPL-3.0-or-later

/** The ERG widgets' texts in English (ADR 0072): the shape of every language. */
export const en = {
  erg: 'ERG',
  on: 'On',
  off: 'Off',
  targetPower: 'Target power',
  target: 'Target',
  watts: (watts: number) => `${watts} W`,
  keys: '↑ ↓ target',
  /** The workout halted itself (ADR 0113): the trainer rides the route. */
  halted: 'Halted',
  goingOn: (seconds: number) => `Going on in ${seconds}`,
  /** The target after a repeated halt, as a share of the step's. */
  ceiling: (percent: number) => `Target ${percent} %`,
};

export type Messages = typeof en;
