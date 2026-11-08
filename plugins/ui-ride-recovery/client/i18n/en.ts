// SPDX-License-Identifier: AGPL-3.0-or-later

/** The interrupted ride's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Interrupted ride',
  interrupted: 'Your last ride was interrupted',
  facts: (minutes: number, km?: string) => (km === undefined ? `${minutes} min` : `${minutes} min · ${km} km`),
  continue: 'Continue ride',
  finish: 'Finish ride',
};

export type Messages = typeof en;
