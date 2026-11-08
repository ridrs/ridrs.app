// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SettingsDocument } from '@ridrs/contracts';
import { z } from 'zod';
import { type Entry, FIRST_WEEK, WEEKDAYS } from './client/calendar.ts';

export const entrySchema = z
  .object({
    id: z.string(),
    day: z.enum(WEEKDAYS),
    kind: z.enum(['workout', 'rest', 'note', 'outdoor']),
    title: z.string(),
  })
  .strict();

export interface TrainingDocument {
  calendar: { entries: Entry[]; undo: Entry[][] };
  favourites: string[];
}

/** What the rider changed in the Training area, kept at once (ADR 0059); read by both its sides. */
export const TRAINING_DOCUMENT: SettingsDocument<TrainingDocument> = {
  name: 'preview',
  version: 1,
  schema: z
    .object({
      calendar: z.object({ entries: z.array(entrySchema), undo: z.array(z.array(entrySchema)) }).strict(),
      favourites: z.array(z.string()),
    })
    .strict(),
};

/** What the area shows before the rider changed anything. */
export const INITIAL_TRAINING: TrainingDocument = {
  calendar: FIRST_WEEK as { entries: Entry[]; undo: Entry[][] },
  favourites: [],
};
