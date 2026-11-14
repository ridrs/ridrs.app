// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import type { DataSource } from './data-sources.ts';
import { type Removable, removableSchema } from './drag.ts';
import { defineService } from './services.ts';

/**
 * The recycle bin (ADR 0096): what the rider dragged into it is hidden everywhere and deleted
 * only when they delete it in the bin. App state, kept across a restart.
 */
export const trashItemSchema = z
  .object({
    item: removableSchema,
    /** When it went into the bin, epoch ms. */
    binnedAt: z.number(),
  })
  .strict();

export type TrashItem = z.infer<typeof trashItemSchema>;

/** What the bin holds, by `keyOfRemovable`; owner `ui-recycle-bin`. */
export const trashItemState = defineState('trash.item', trashItemSchema);

/** Puts an item into the bin; one that is there already stays as it is. Answers its key. */
export const trashPutService = defineService('trash.put', {
  request: z.object({ item: removableSchema }).strict(),
  response: z.object({ key: z.string().min(1) }).strict(),
});

/** Takes an item out of the bin: it is shown again where it was. */
export const trashRestoreService = defineService('trash.restore', {
  request: z.object({ key: z.string().min(1) }).strict(),
  response: z.object({}).strict(),
});

/**
 * Why an item could not be deleted at a provider: it cannot be changed there (`read-only`), the
 * provider could not be reached, or the call failed.
 */
export const TRASH_PURGE_REASONS = ['read-only', 'unreachable', 'failed'] as const;

/** An item a provider did not delete. */
export const trashPurgeFailureSchema = z
  .object({
    key: z.string().min(1),
    /** The provider that did not delete it. */
    provider: z.string().min(1),
    reason: z.enum(TRASH_PURGE_REASONS),
  })
  .strict();

/**
 * Deletes an item for good at every provider that has it, or with no `key` everything in the bin.
 * Answers the items that could not be deleted, which stay in the bin.
 */
export const trashPurgeService = defineService('trash.purge', {
  request: z.object({ key: z.string().min(1).optional() }).strict(),
  response: z.object({ failed: z.array(trashPurgeFailureSchema) }).strict(),
});

/** The key of an item in the bin: `calendar-entry:<provider>:<id>`, `done-ride:<provider>:<id>`. */
export function keyOfRemovable(item: Removable): string {
  if (item.kind === 'calendar-entry') return `calendar-entry:${item.provider}:${item.id}`;
  const [first] = item.removals;
  return `done-ride:${first?.provider}:${first?.id}`;
}

type Bin = ReadonlyMap<string, TrashItem | undefined>;

/** Whether the planned entry `id` of `provider`'s calendar is in the bin. */
export const isEntryBinned = (bin: Bin, provider: string, id: string): boolean =>
  bin.get(`calendar-entry:${provider}:${id}`) !== undefined;

/** Whether the ride done `id` of `provider` is in the bin, under any of the providers that have it. */
export function isRideBinned(bin: Bin, provider: string, id: string): boolean {
  for (const entry of bin.values()) {
    if (
      entry?.item.kind === 'done-ride' &&
      entry.item.removals.some((each) => each.provider === provider && each.id === id)
    ) {
      return true;
    }
  }
  return false;
}

/** The calendars with their entries that are in the bin left out. */
export function withoutBinned<C extends { readonly workouts: readonly { readonly id: string }[] }>(
  calendars: ReadonlyMap<string, DataSource<C>>,
  bin: Bin,
): ReadonlyMap<string, DataSource<C>> {
  if (bin.size === 0) return calendars;
  return new Map(
    [...calendars].map(([provider, source]) => [
      provider,
      source.data
        ? {
            ...source,
            data: {
              ...source.data,
              workouts: source.data.workouts.filter(
                (entry) => !isEntryBinned(bin, provider, entry.id),
              ),
            },
          }
        : source,
    ]),
  );
}
