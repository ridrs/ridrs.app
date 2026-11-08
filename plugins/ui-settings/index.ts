// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  APP_LANGUAGE_KEY,
  appLanguageSetService,
  appLanguageState,
  DEFAULT_LANGUAGE,
  definePlugin,
  languageSchema,
} from '@ridrs/contracts';
import { z } from 'zod';

/** The language the rider chose (ADR 0072), kept apart from the preview's settings. */
const languageDocument = {
  name: 'language',
  version: 1,
  schema: z.object({ language: languageSchema }).strict(),
};

// The rest of this plugin lives in its client module (see `ui` in the manifest). The host side
// owns the app's language: every UI plugin watches it, so it must be there before they render.
export default definePlugin({
  async start(ctx) {
    const kept = ctx.settings.user(languageDocument);
    const stored = await kept.read();
    ctx.state.set(appLanguageState, APP_LANGUAGE_KEY, stored?.language ?? DEFAULT_LANGUAGE);
    // The change takes effect at once, like every setting; keeping it follows. A language that
    // could not be kept still holds until ridrs restarts.
    ctx.services.provide(appLanguageSetService, async ({ language }) => {
      ctx.state.set(appLanguageState, APP_LANGUAGE_KEY, language);
      await kept
        .write({ language })
        .catch((error: unknown) => ctx.logger.warn(`Could not keep the language: ${String(error)}`));
      return {};
    });
  },
});
