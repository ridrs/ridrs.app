// SPDX-License-Identifier: Apache-2.0

import type { Diagnostic } from './diagnostics.ts';
import type { EventEnvelope, EventSubscription } from './events.ts';
import type { PluginState } from './plugin.ts';

/**
 * Sees every envelope and diagnostic of the host. `onEvent` runs synchronously at publish time,
 * in global publish order, before queued delivery to subscribers. Observers are read-only:
 * publishing from one throws.
 */
export interface HostObserver {
  onEvent?(envelope: EventEnvelope): void;
  onDiagnostic?(diagnostic: Diagnostic): void;
}

/** Who runs the host: given by the composition root. */
export interface HostPlatform {
  readonly ridrsVersion: string;
  readonly runtime: 'node' | 'tauri';
  readonly os: string;
  readonly appVersion: string;
}

export interface HostPluginDescription {
  readonly id: string;
  readonly version: string;
  readonly types: readonly string[];
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly state: PluginState;
}

/** The host as it runs now: plugins, their resolution and the core defaults that shape results. */
export interface HostDescription {
  /** Identifies the host run; the root of every id (recorded, reused on replay). */
  readonly runId: string;
  readonly platform: HostPlatform;
  /** Sorted by id. */
  readonly plugins: readonly HostPluginDescription[];
  readonly disabledPlugins: readonly string[];
  /** Capability id -> the ids of the plugins that provide it, sorted. */
  readonly resolution: Readonly<Record<string, readonly string[]>>;
  readonly coreDefaults: { readonly temporal: Readonly<Record<string, number>> };
  /** A host that continues an interrupted ride: the journal it goes on with (ADR 0057). */
  readonly continuing?: { readonly file: string };
}

/** `ctx.host`: only for plugins whose manifest declares the permission `observe-host`. */
export interface PluginHostAccess {
  /** Released when the plugin stops. Throws `permission-denied` without the permission. */
  observe(observer: HostObserver): EventSubscription;
  /** Throws `permission-denied` without the permission. */
  describe(): HostDescription;
}
