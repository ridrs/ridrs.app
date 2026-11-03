// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { RECORDING_MEDIA_TYPE, recordingRecordSchema } from './recording.ts';

/** JSON Schema (draft 2020-12) of one line of a ridrs recording v1, generated from the zod schemas. */
export function recordingJsonSchema(): Record<string, unknown> {
  return {
    title: 'ridrs recording v1 record',
    description: `One line of a ridrs recording (${RECORDING_MEDIA_TYPE}). See ridrs-recording-v1.md.`,
    ...z.toJSONSchema(recordingRecordSchema, { io: 'input' }),
  };
}
