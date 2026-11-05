// SPDX-License-Identifier: Apache-2.0

import type { z } from 'zod';

/**
 * Where a plugin's settings belong (ADR 0054). Only `machine` today: configuration of this
 * installation (devices, links), never synchronized. User settings come with their use case.
 */
export type PersistenceScope = 'machine';

/** A versioned settings document a plugin owns; its name is unique within the plugin. */
export interface SettingsDocument<T> {
  /** Lowercase words joined by `-`: the file name. */
  readonly name: string;
  /** Raised with every incompatible change of the schema. */
  readonly version: number;
  readonly schema: z.ZodType<T>;
  /** Turns a value of an older version into this version's; without it, older values are dropped. */
  migrate?(fromVersion: number, value: unknown): unknown;
}

/** One settings document, bound to the plugin that asked for it. */
export interface ScopedSettings<T> {
  /**
   * The value, or `undefined` when there is none or it cannot be used (unreadable, a newer
   * version, failing the schema: then a `settings-invalid` diagnostic). Never rejects.
   */
  read(): Promise<T | undefined>;
  /** Replaces the document atomically; committed once it resolves. Writes run in order. */
  write(value: T): Promise<void>;
}

/** `ctx.settings`: only for plugins whose manifest declares the persistence scope. */
export interface PluginSettingsContext {
  /** Throws `permission-denied` without `"persistence": ["machine"]` in the manifest. */
  machine<T>(document: SettingsDocument<T>): ScopedSettings<T>;
}
