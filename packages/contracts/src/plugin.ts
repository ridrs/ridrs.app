// SPDX-License-Identifier: Apache-2.0

import type { PluginCapabilitiesContext } from './capabilities.ts';
import type { Clock } from './clock.ts';
import type { DiagnosticCode } from './diagnostics.ts';
import type { PluginEventsContext } from './events.ts';
import type { PluginManifest } from './manifest.ts';
import type { UiRegistry } from './ui.ts';

export type PluginState =
  | 'discovered'
  | 'initialized'
  | 'started'
  | 'stopped'
  | 'disposed'
  | 'failed'
  | 'blocked';

export interface PluginLogFn {
  (message: string): void;
  (bindings: Readonly<Record<string, unknown>>, message?: string): void;
}

/**
 * Structured logger handed to plugins. Structural on purpose: pino satisfies it in the headless
 * app, a console adapter in the native app; no host has to fake a specific logging library.
 */
export interface PluginLogger {
  readonly debug: PluginLogFn;
  readonly info: PluginLogFn;
  readonly warn: PluginLogFn;
  readonly error: PluginLogFn;
  child(bindings: Readonly<Record<string, unknown>>): PluginLogger;
}

export interface PluginContext {
  readonly manifest: Readonly<PluginManifest>;
  readonly logger: PluginLogger;
  readonly clock: Clock;
  readonly events: PluginEventsContext;
  readonly capabilities: PluginCapabilitiesContext;
  readonly signal: AbortSignal;
  /** Read-only view of the UI registry; `core.ui-registry.changed` announces new revisions. */
  readonly ui: { registry(): UiRegistry };
  reportDiagnostic(
    code: DiagnosticCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void;
}

export interface PluginDefinition {
  initialize?(ctx: PluginContext): void | Promise<void>;
  start?(ctx: PluginContext): void | Promise<void>;
  stop?(ctx: PluginContext): void | Promise<void>;
  dispose?(ctx: PluginContext): void | Promise<void>;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
