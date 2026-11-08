// SPDX-License-Identifier: AGPL-3.0-or-later

/** The gear widget's texts in English (ADR 0072): the shape of every language. */
export const en = {
  gear: 'Gear',
  chainring: 'Chainring',
  sprocket: 'Sprocket',
  of: (count: number) => `/ ${count}`,
  keys: '↑ ↓ shift',
};

export type Messages = typeof en;
