// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Language } from '@ridrs/contracts';
import { de } from './de.ts';
import { en, type Messages } from './en.ts';

export type { Messages };

export const messages: { readonly [L in Language]: Messages } = { en, de };

/**
 * The companion has no settings: it speaks the phone's first language it knows, else English
 * (ADR 0072).
 */
export function phoneLanguage(languages: readonly string[]): Language {
  const known = languages
    .map((tag) => tag.toLowerCase().split('-')[0])
    .find((l) => l === 'de' || l === 'en');
  return known === 'de' ? 'de' : 'en';
}
