// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The gear widget's texts in German (ADR 0072). */
export const de: Messages = {
  gear: 'Gang',
  chainring: 'Kettenblatt',
  sprocket: 'Ritzel',
  of: (count: number) => `/ ${count}`,
  keys: '↑ ↓ schalten',
};
