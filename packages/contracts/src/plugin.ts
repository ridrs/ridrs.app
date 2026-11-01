// SPDX-License-Identifier: Apache-2.0

import type { Logger } from 'pino';
import type { PluginCapabilitiesContext } from './capabilities.ts';
import type { Clock } from './clock.ts';
import type { PluginEventsContext } from './events.ts';
import type { PluginManifest } from './manifest.ts';

export type PluginState =
  | 'discovered'
  | 'initialized'
  | 'started'
  | 'stopped'
  | 'disposed'
  | 'failed'
  | 'blocked';

export type PluginLogger = Logger;

export interface PluginContext {
  readonly manifest: Readonly<PluginManifest>;
  readonly logger: PluginLogger;
  readonly clock: Clock;
  readonly events: PluginEventsContext;
  readonly capabilities: PluginCapabilitiesContext;
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
