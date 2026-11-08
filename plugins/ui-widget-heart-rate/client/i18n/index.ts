// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Catalogs } from '@ridrs/ui-sdk';
import { de } from './de.ts';
import { en, type Messages } from './en.ts';

export const messages: Catalogs<Messages> = { en, de };
