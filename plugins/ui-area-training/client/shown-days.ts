// SPDX-License-Identifier: AGPL-3.0-or-later

import { trainingCalendarState, trainingHistoryState, trainingRangeLoadService } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect } from 'react';

/**
 * Asks every remote provider of planned workouts or done rides for the days `oldest` to `newest`
 * (ADR 0088), once each time the days shown change. A provider that read them in the last 15
 * minutes answers without a request; the data follows in `training.calendar` and
 * `training.history`. Providers on this device hold every day already and are not asked.
 */
export function useShownDays(ctx: UiContext, oldest: string | undefined, newest: string | undefined): void {
  const remote = (sources: ReadonlyMap<string, { readonly remote?: boolean }>) =>
    [...sources].filter(([, source]) => source.remote === true).map(([key]) => key);
  const providers = [
    ...new Set([
      ...remote(useStateEntries(ctx, trainingCalendarState)),
      ...remote(useStateEntries(ctx, trainingHistoryState)),
    ]),
  ]
    .sort()
    .join(',');
  useEffect(() => {
    if (oldest === undefined || newest === undefined) return;
    for (const key of providers.split(',').filter((provider) => provider !== '')) {
      ctx
        .call(trainingRangeLoadService, { key, oldest, newest })
        .catch((error: unknown) =>
          ctx.logger.warn(`The days ${oldest} to ${newest} of "${key}" could not be asked for: ${String(error)}`),
        );
    }
  }, [ctx, providers, oldest, newest]);
}
