// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The preview kit's texts in German (ADR 0072). */
export const de: Messages = {
  preview: 'Vorschau',
  back: 'Zurück',
  hide: (name: string) => `${name} ausblenden`,
};
