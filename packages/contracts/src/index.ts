// SPDX-License-Identifier: Apache-2.0

export {
  type CapabilityCardinality,
  type CapabilityContract,
  type CapabilityOptions,
  defineCapability,
  type PluginCapabilitiesContext,
} from './capabilities.ts';
export type { Clock } from './clock.ts';
export {
  type Diagnostic,
  type DiagnosticCode,
  RidrsError,
  type RidrsErrorCode,
} from './diagnostics.ts';
export {
  defineEvent,
  type EventDefinition,
  type EventEnvelope,
  type EventHandler,
  type EventSubscription,
  type HostStartedPayload,
  hostStartedEvent,
  type PluginEventsContext,
} from './events.ts';
export {
  capabilityIdSchema,
  dottedIdPattern,
  eventIdSchema,
  type ManifestValidationResult,
  manifestSchema,
  type PluginManifest,
  parseManifestJson,
  pluginIdPattern,
  pluginIdSchema,
} from './manifest.ts';
export {
  definePlugin,
  type PluginContext,
  type PluginDefinition,
  type PluginLogger,
  type PluginState,
} from './plugin.ts';
