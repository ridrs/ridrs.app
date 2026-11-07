// SPDX-License-Identifier: Apache-2.0

import type { z } from 'zod';
import type { EventSubscription } from './events.ts';
import { eventIdSchema } from './manifest-ids.ts';

/**
 * A topic of app state (ADR 0068): values under string keys, one owner per key, beside the
 * simulation bus. Never recorded, never replayed; owners rebuild it from their storage at start.
 */
export interface StateDefinition<T = unknown, TId extends string = string> {
  /** A lowercase dotted id, like an event's. */
  readonly id: TId;
  readonly schema: z.ZodType<T>;
}

export function defineState<T, TId extends string>(
  id: TId,
  schema: z.ZodType<T>,
): StateDefinition<T, TId> {
  return Object.freeze({ id: eventIdSchema.parse(id) as TId, schema });
}

/** What a watcher gets: every entry of the topic, and the keys changed since its last delivery. */
export interface StateView<T> {
  readonly entries: ReadonlyMap<string, T>;
  /** Every key on the first delivery; a removed key is listed and absent from `entries`. */
  readonly changed: readonly string[];
}

/**
 * `ctx.state`: only for plugins of the input-side types whose manifest declares the topic
 * (`state.owns`, `state.watches`). Deliveries to watchers are coalesced per microtask: the first
 * one is the snapshot, then the keys changed since, each with its last value.
 */
export interface PluginStateContext {
  /** Validates; the first writer of a key owns it. Throws `state-key-owned`, `undeclared-state`, `invalid-state-value`. */
  set<T>(topic: StateDefinition<T>, key: string, value: T): void;
  /** Only the owner; a missing key is not an error. */
  remove(topic: StateDefinition, key: string): void;
  get<T>(topic: StateDefinition<T>, key: string): T | undefined;
  entries<T>(topic: StateDefinition<T>): ReadonlyMap<string, T>;
  /** Only topics in `state.watches`. Ends when the plugin stops. */
  watch<T>(topic: StateDefinition<T>, listener: (view: StateView<T>) => void): EventSubscription;
}
