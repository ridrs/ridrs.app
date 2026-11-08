// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Catalogs } from '@ridrs/ui-sdk';
import { createContext, useContext } from 'react';
import { de } from './de.ts';
import { en, type Messages } from './en.ts';

export type { Messages };

export const messages: Catalogs<Messages> = { en, de };

/** The texts in the app's language for the setup's parts, set by the views that have `ctx`. */
export const TextContext = createContext<Messages>(en);

export const useText = (): Messages => useContext(TextContext);
