// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, rideScreenshotService } from '@ridrs/contracts';

/** What the fixture has been asked for, for the scenarios; `fails`: no screenshot can be taken. */
export interface FixtureRideScreenshot {
  requests: { startedAt: number }[];
  fails: boolean;
}

const KEY = '__ridrsFixtureRideScreenshot';

/** The fixture's record: shared with the scenarios' steps through the global scope. */
export function fixtureRideScreenshot(): FixtureRideScreenshot {
  const scope = globalThis as unknown as Record<string, FixtureRideScreenshot | undefined>;
  scope[KEY] ??= { requests: [], fails: false };
  return scope[KEY];
}

/** Stands in for `screenshot-tauri`: no picture, no file; it keeps the request and answers. */
export default definePlugin({
  initialize(ctx) {
    ctx.services.provide(rideScreenshotService, async (request) => {
      const record = fixtureRideScreenshot();
      record.requests.push(request);
      if (record.fails) throw new Error('No screenshot in this scenario');
      return { file: `recordings/screenshot-${record.requests.length}.jpg` };
    });
  },
});
