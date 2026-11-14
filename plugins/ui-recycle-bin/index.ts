// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  keyOfRemovable,
  type SettingsDocument,
  type TrashItem,
  trainingCalendarRemoveService,
  trainingHistoryRemoveService,
  trashItemSchema,
  trashItemState,
  trashPurgeService,
  trashPutService,
  trashRestoreService,
} from '@ridrs/contracts';
import { z } from 'zod';

/** What the bin holds, kept beside the app (ADR 0059): it is still there after a restart. */
const KEPT: SettingsDocument<TrashItem[]> = {
  name: 'recycle-bin',
  version: 1,
  schema: z.array(trashItemSchema),
};

type Failure = { readonly provider: string; readonly reason: 'read-only' | 'unreachable' | 'failed' };

/**
 * The host side of the bin (ADR 0096) owns the app state `trash.item`: the bin deletes nothing
 * when something is dropped into it, the views hide what it holds. Only `trash.purge` deletes, and
 * through the contract services of the item's providers alone, so the bin knows no provider.
 */
export default definePlugin({
  async start(ctx) {
    const kept = ctx.settings.user(KEPT);
    const items = () =>
      [...ctx.state.entries(trashItemState).values()].filter((item): item is TrashItem => item !== undefined);
    const keep = () => kept.write(items());

    /** Deletes one item at every provider that has it; the providers that did not delete it. */
    const purge = async ({ item }: TrashItem): Promise<Failure[]> => {
      const removals =
        item.kind === 'calendar-entry'
          ? [
              {
                provider: item.provider,
                remove: () =>
                  ctx.services.call(trainingCalendarRemoveService, { key: item.provider, id: item.id }),
              },
            ]
          : item.removals.map(({ provider, id }) => ({
              provider,
              remove: () => ctx.services.call(trainingHistoryRemoveService, { key: provider, id }),
            }));
      const failures: Failure[] = [];
      for (const { provider, remove } of removals) {
        try {
          const result = await remove();
          if (!result.ok) failures.push({ provider, reason: result.reason });
        } catch (error) {
          ctx.logger.warn(`Could not delete at ${provider}: ${String(error)}`);
          failures.push({ provider, reason: 'failed' });
        }
      }
      return failures;
    };

    ctx.services.provide(trashPutService, async ({ item }) => {
      const key = keyOfRemovable(item);
      if (ctx.state.get(trashItemState, key) === undefined) {
        ctx.state.set(trashItemState, key, { item, binnedAt: ctx.clock.now() });
        await keep();
      }
      return { key };
    });

    ctx.services.provide(trashRestoreService, async ({ key }) => {
      if (ctx.state.get(trashItemState, key) !== undefined) {
        ctx.state.remove(trashItemState, key);
        await keep();
      }
      return {};
    });

    ctx.services.provide(trashPurgeService, async ({ key }) => {
      const keys = key === undefined ? [...ctx.state.entries(trashItemState).keys()] : [key];
      const failed: { key: string; provider: string; reason: Failure['reason'] }[] = [];
      for (const each of keys) {
        const item = ctx.state.get(trashItemState, each);
        if (item === undefined) continue;
        const failures = await purge(item);
        if (failures.length === 0) ctx.state.remove(trashItemState, each);
        else failed.push(...failures.map((failure) => ({ key: each, ...failure })));
      }
      await keep();
      return { failed };
    });

    const stored = await kept.read();
    for (const item of stored ?? []) {
      const key = keyOfRemovable(item.item);
      // An item put into the bin while the document was read is newer.
      if (ctx.state.get(trashItemState, key) === undefined) ctx.state.set(trashItemState, key, item);
    }
  },
});
