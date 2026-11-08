// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SettingsDocument } from '@ridrs/contracts';
import { z } from 'zod';

/**
 * The athlete profile kept on this device (ADR 0073): current values only, no history. `changedAt`
 * is the time of the last change, epoch ms.
 */
export const athleteDocumentSchema = z
  .object({
    ftp: z.number().int().positive().optional(),
    weight: z.number().positive().optional(),
    lthr: z.number().positive().optional(),
    maxHeartRate: z.number().positive().optional(),
    changedAt: z.number().nonnegative(),
  })
  .strict();

export type AthleteDocument = z.infer<typeof athleteDocumentSchema>;

export const ATHLETE_DOCUMENT: SettingsDocument<AthleteDocument> = {
  name: 'athlete',
  version: 1,
  schema: athleteDocumentSchema,
};
