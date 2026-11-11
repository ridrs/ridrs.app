// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, filesSaveService } from '@ridrs/contracts';

/** What the fixture has been asked to save, for the scenarios; `answer` is the rider's choice. */
export interface FixtureFilesSave {
  requests: { fileName: string; mediaType: string; data: string }[];
  /** `false`: the rider cancels the dialog. */
  answer: boolean;
}

const KEY = '__ridrsFixtureFilesSave';

/** The fixture's record: shared with the scenarios' steps through the global scope. */
export function fixtureFilesSave(): FixtureFilesSave {
  const scope = globalThis as unknown as Record<string, FixtureFilesSave | undefined>;
  scope[KEY] ??= { requests: [], answer: true };
  return scope[KEY];
}

/**
 * Stands in for `files-save-tauri`: no dialog, no file; it keeps the request and answers as the
 * scenario says (saved, or the rider cancelled).
 */
export default definePlugin({
  initialize(ctx) {
    ctx.services.provide(filesSaveService, async (request) => {
      const record = fixtureFilesSave();
      record.requests.push(request);
      return { saved: record.answer };
    });
  },
});
