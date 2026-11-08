// SPDX-License-Identifier: Apache-2.0

import type { Language } from '@ridrs/contracts';
import { useEffect, useState } from 'react';
import type { UiContext } from './contract.ts';
import { type Catalogs, watchLanguage } from './language.ts';

/** The app's language (ADR 0072); the component renders again when it changes. */
export function useLanguage(ctx: UiContext): Language {
  const [language, setLanguage] = useState<Language>(() => {
    let first: Language | undefined;
    // Reads the current language at once, without keeping the watch.
    watchLanguage(ctx, (l) => {
      first ??= l;
    })();
    return first as Language;
  });
  useEffect(() => watchLanguage(ctx, setLanguage), [ctx]);
  return language;
}

/** The plugin's texts in the app's language (ADR 0072). */
export function useMessages<T>(ctx: UiContext, catalogs: Catalogs<T>): T {
  return catalogs[useLanguage(ctx)];
}
