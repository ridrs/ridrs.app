// SPDX-License-Identifier: AGPL-3.0-or-later

export { type BundledPluginSet, createBundledPluginSource } from './bundled-source.ts';
export { CapabilityRegistry } from './capability-registry.ts';
export {
  createSystemTimeSource,
  LiveClock,
  type LiveClockOptions,
  ReplayClock,
  type TimerPort,
  TurnClock,
} from './clock.ts';
export { DiagnosticCollector } from './diagnostics.ts';
export {
  type DiscoveredPlugin,
  discoverPlugins,
  type PluginCandidate,
  type PluginSource,
} from './discovery.ts';
export { EventBus } from './event-bus.ts';
export { createConsoleLogger, createSilentLogger } from './logger.ts';
export { PluginHost, type PluginHostOptions } from './plugin-host.ts';
export { type AppChannels, type ResolutionResult, resolveCapabilities } from './resolution.ts';
export {
  type ServiceCallObserver,
  type ServiceCallRecord,
  ServiceRegistry,
} from './service-registry.ts';
export { type StateObserver, StateStore } from './state-store.ts';
export { computeUiRegistry, type UiRegistryInput, type UiRegistryResult } from './ui-registry.ts';
