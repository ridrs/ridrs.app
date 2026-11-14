// SPDX-License-Identifier: AGPL-3.0-or-later

type Reason = 'read-only' | 'unreachable' | 'failed';

/** The bin's texts in English (ADR 0072): the shape of every language. */
export const en = {
  bin: 'Bin',
  dateLocale: 'en-GB',
  items: (count: number) => (count === 1 ? '1 item' : `${count} items`),
  dropToRemove: 'Drop here to remove',
  dropToDeleteRide: 'Drop here to delete the ride',
  intro: 'What you dragged into the bin is hidden everywhere. It is deleted only when you delete it here.',
  empty: 'The bin is empty.',
  emptyHint: 'Drag a planned workout or a ride done onto the bin in the menu to remove it.',
  planned: 'Planned workouts',
  done: 'Rides done',
  binnedOn: (date: string) => `In the bin since ${date}`,
  restore: (title: string) => `Restore ${title}`,
  restoreLabel: 'Restore',
  deleteForGood: (title: string) => `Delete permanently: ${title}`,
  deleteLabel: 'Delete permanently',
  emptyBin: 'Empty bin',
  cancel: 'Cancel',
  and: (all: readonly string[]) =>
    all.length <= 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`,
  askOne: (title: string, where: string) => `Delete “${title}” from ${where}? This cannot be undone.`,
  askAll: (count: number) =>
    `Delete ${count === 1 ? 'the item' : `all ${count} items`} in the bin? This cannot be undone.`,
  refused: (source: string, reason: Reason) =>
    reason === 'read-only'
      ? `${source} cannot be changed here: nothing was removed.`
      : reason === 'unreachable'
        ? `${source} could not be reached: nothing was removed.`
        : `${source} did not take the change.`,
};

export type Messages = typeof en;
