// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The pairing's texts in German (ADR 0072). */
export const de: Messages = {
  codeFor: (companion: string) => `Kopplungscode für ${companion}`,
  qrAlt: 'QR-Code zum Koppeln: scanne ihn mit der ridrs-Companion-App',
  scan: 'QR-Code scannen',
  or: 'oder',
  enter: 'Code eingeben',
  looking: 'Suche Handys in diesem WLAN…',
};
