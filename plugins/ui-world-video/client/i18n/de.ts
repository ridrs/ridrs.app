// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The video world's texts in German (ADR 0072). */
export const de: Messages = {
  km: (km: string) => `${km} km`,
  complete: 'Route geschafft',
  loading: 'Video wird geladen…',
  cannotShow: (reason: string) => `Das Video kann nicht gezeigt werden: ${reason}`,
};
