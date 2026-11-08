// SPDX-License-Identifier: Apache-2.0

import {
  APP_LANGUAGE_KEY,
  appLanguageState,
  DEFAULT_LANGUAGE,
  type Language,
} from '@ridrs/contracts';
import type { UiContext, Unsubscribe } from './contract.ts';

/**
 * A plugin's texts in every language (ADR 0072): one module per language, the English one the
 * shape of all. Typed as `Catalogs<typeof en>`, a missing or extra German text fails the build.
 */
export type Catalogs<T> = { readonly [L in Language]: T };

/**
 * The language the app spoke last. A new screen's watch gets its snapshot only after a
 * microtask: starting in this language instead of the default, it does not flash English.
 */
let lastKnown: Language = DEFAULT_LANGUAGE;

/**
 * Calls `listener` with the app's language at once and with every change: the default while no
 * plugin owns it. Needs `app.language` in the plugin's `ui.state`.
 */
export function watchLanguage(ctx: UiContext, listener: (language: Language) => void): Unsubscribe {
  let current: Language | undefined;
  const deliver = (language: Language) => {
    if (language !== current) {
      current = language;
      listener(language);
    }
  };
  const stop = ctx.state.watch(appLanguageState, (view) => {
    lastKnown = view.entries.get(APP_LANGUAGE_KEY) ?? DEFAULT_LANGUAGE;
    deliver(lastKnown);
  });
  // The snapshot comes after a microtask: speak the last known language until then.
  deliver(current ?? lastKnown);
  return stop;
}

/** The decimal mark of the language: a number reads "46.2" in English and "46,2" in German. */
export function localizeNumber(text: string, language: Language): string {
  return language === 'de' ? text.replace(/(\d)\.(\d)/g, '$1,$2') : text;
}
