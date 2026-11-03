// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineCapability } from './capabilities.ts';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.json();

/**
 * One plugin's effective parameters and defaults, as JSON. A recording stores every section, so
 * a replay can tell which parameters differ from the ones the ride was recorded with.
 */
export interface ConfigSnapshotProvider {
  /** The providing plugin's id. */
  readonly section: string;
  snapshot(): JsonValue;
}

export const configSnapshotCapability = defineCapability<
  ConfigSnapshotProvider,
  'multiple',
  'config.snapshot'
>('config.snapshot', { cardinality: 'multiple' });
