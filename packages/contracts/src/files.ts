// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineService } from './services.ts';

/**
 * Saves a file where the rider chooses (ADR 0085): the native app opens the system's save dialog,
 * other hosts offer a download. Answers once the dialog closed: `saved: false` when the rider
 * cancelled. Data is base64; files of this kind are small (a workout, a FIT file).
 */
export const filesSaveService = defineService('files.save', {
  request: z
    .object({
      /** The suggested file name, with its extension. */
      fileName: z.string().min(1),
      mediaType: z.string().min(1),
      data: z.string(),
    })
    .strict(),
  response: z.object({ saved: z.boolean() }).strict(),
});
