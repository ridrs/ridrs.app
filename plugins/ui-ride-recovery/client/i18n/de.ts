// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The interrupted ride's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Unterbrochene Fahrt',
  interrupted: 'Deine letzte Fahrt wurde unterbrochen',
  facts: (minutes: number, km?: string) => (km === undefined ? `${minutes} min` : `${minutes} min · ${km} km`),
  continue: 'Fahrt fortsetzen',
  finish: 'Fahrt beenden',
};
