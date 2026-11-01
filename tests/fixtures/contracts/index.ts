// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineEvent } from '@ridrs/contracts';
import { z } from 'zod';

export const pingEvent = defineEvent(
  'example.ping',
  z.object({
    sequence: z.number().int().nonnegative(),
  }),
);

export const pongEvent = defineEvent(
  'example.pong',
  z.object({
    sequence: z.number().int().nonnegative(),
  }),
);
