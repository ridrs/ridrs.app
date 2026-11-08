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
};

export type Messages = typeof en;
