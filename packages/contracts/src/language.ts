// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { defineService } from './services.ts';

/** The languages of the user interface (ADR 0072): English first, the default. */
export const LANGUAGES = ['en', 'de'] as const;

export const languageSchema = z.enum(LANGUAGES);

export type Language = z.infer<typeof languageSchema>;

export const DEFAULT_LANGUAGE: Language = 'en';

/** The one key of `app.language`: the app's language, not one per screen. */
export const APP_LANGUAGE_KEY = 'app';

/**
 * The language the user interface speaks (ADR 0072), under `APP_LANGUAGE_KEY`. Owned by the
 * settings plugin, which keeps it; every UI plugin with text watches it. Without an owner it is
 * empty, and the UI speaks `DEFAULT_LANGUAGE`.
 */
export const appLanguageState = defineState('app.language', languageSchema);

/** Changes the language at once; answered once it is kept, or could not be. */
export const appLanguageSetService = defineService('app.set-language', {
  request: z.object({ language: languageSchema }).strict(),
  response: z.object({}).strict(),
});
