// SPDX-License-Identifier: AGPL-3.0-or-later

import { pathToFileURL } from 'node:url';
import {
  type CapabilityContract,
  type Clock,
  type Diagnostic,
  hostStartedEvent,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
  type PluginState,
  RidrsError,
} from '@ridrs/contracts';
import type { DepGraph } from 'dependency-graph';
import pino, { type Logger } from 'pino';
import { CapabilityRegistry } from './capability-registry.ts';
import { createSystemClock } from './clock.ts';
import { DiagnosticCollector } from './diagnostics.ts';
import { type DiscoveredPlugin, discoverPlugins } from './discovery.ts';
import { EventBus } from './event-bus.ts';
import { resolveCapabilities } from './resolution.ts';

export interface PluginHostOptions {
  readonly pluginsDir: string;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly capabilities?: Iterable<CapabilityContract>;
}

interface ManagedPlugin {
  readonly discovered: DiscoveredPlugin;
  state: PluginState;
  context?: PluginContext;
  definition?: PluginDefinition;
  publishingAllowed: boolean;
}

export class PluginHost {
  private readonly pluginsDir: string;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly diagnostics: DiagnosticCollector;
  private readonly capabilityRegistry: CapabilityRegistry;
  private readonly eventBus: EventBus;
  private readonly plugins = new Map<string, ManagedPlugin>();
  private dependencyGraph?: DepGraph<string>;
  private startOrder: string[] = [];
  private initializedOrder: string[] = [];
  private discoveredOnce = false;
  private running = false;

  constructor(options: PluginHostOptions) {
    this.pluginsDir = options.pluginsDir;
    this.clock = options.clock ?? createSystemClock();
    this.logger = options.logger ?? pino({ level: 'silent' });
    this.diagnostics = new DiagnosticCollector(this.logger);
    this.capabilityRegistry = new CapabilityRegistry();
    if (options.capabilities) {
      this.capabilityRegistry.registerContracts(options.capabilities);
    }
    this.eventBus = new EventBus({
      clock: this.clock,
      diagnostics: this.diagnostics,
      canPluginPublish: (pluginId) => {
        const managed = this.plugins.get(pluginId);
        return Boolean(managed?.publishingAllowed && managed.state === 'started');
      },
    });
  }

  registerCapability(contract: CapabilityContract): void {
    this.capabilityRegistry.registerContract(contract);
  }

  registerCapabilities(contracts: Iterable<CapabilityContract>): void {
    this.capabilityRegistry.registerContracts(contracts);
  }

  async discover(): Promise<readonly PluginManifest[]> {
    const discoveredList = await discoverPlugins(this.pluginsDir, this.diagnostics);
    this.plugins.clear();
    for (const item of discoveredList) {
      this.plugins.set(item.manifest.id, {
        discovered: item,
        state: 'discovered',
        publishingAllowed: false,
      });
    }
    this.discoveredOnce = true;
    return discoveredList.map((d) => d.manifest);
  }

  async start(): Promise<void> {
    if (!this.discoveredOnce) {
      await this.discover();
    }

    const discoveredList = [...this.plugins.values()].map((p) => p.discovered);
    const resolution = resolveCapabilities(
      discoveredList,
      this.capabilityRegistry.getContracts(),
      this.diagnostics,
    );

    this.dependencyGraph = resolution.dependencyGraph;
    this.startOrder = [...resolution.startOrder];
    this.initializedOrder = [];

    for (const blockedId of resolution.blockedPlugins) {
      const managed = this.plugins.get(blockedId);
      if (managed) {
        managed.state = 'blocked';
      }
    }

    // Load entry modules and initialize in dependency order.
    for (const pluginId of this.startOrder) {
      const managed = this.plugins.get(pluginId);
      if (managed?.state !== 'discovered') {
        continue;
      }

      const definition = await this.loadPluginEntry(managed);
      if (!definition) {
        this.failPluginAndBlockDependents(pluginId);
        continue;
      }

      managed.definition = definition;
      managed.context = this.createPluginContext(managed.discovered.manifest);

      try {
        await definition.initialize?.(managed.context);
      } catch (error) {
        if (error instanceof RidrsError && error.code === 'undeclared-capability') {
          this.diagnostics.report({
            code: 'undeclared-capability',
            pluginId,
            message: error.message,
          });
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          this.diagnostics.report({
            code: 'lifecycle-failure',
            pluginId,
            message: `Plugin "${pluginId}" failed in "initialize" hook: ${reason}`,
            details: { hook: 'initialize' },
          });
        }
        this.capabilityRegistry.removeProvidersForPlugin(pluginId);
        this.eventBus.removeSubscriptionsForPlugin(pluginId);
        this.failPluginAndBlockDependents(pluginId);
        continue;
      }

      // Verify all declared capabilities were provided during initialize.
      const missingProvided = managed.discovered.manifest.provides.find(
        (capId) => !this.capabilityRegistry.hasProvided(pluginId, capId),
      );
      if (missingProvided) {
        this.diagnostics.report({
          code: 'capability-not-provided',
          pluginId,
          message: `Plugin "${pluginId}" did not provide declared capability "${missingProvided}" during initialize`,
          details: { capability: missingProvided },
        });
        this.capabilityRegistry.removeProvidersForPlugin(pluginId);
        this.eventBus.removeSubscriptionsForPlugin(pluginId);
        this.failPluginAndBlockDependents(pluginId);
        continue;
      }

      managed.state = 'initialized';
      this.initializedOrder.push(pluginId);
    }

    // Start all initialized plugins in dependency order.
    const startedPlugins: string[] = [];
    for (const pluginId of this.startOrder) {
      const managed = this.plugins.get(pluginId);
      if (managed?.state !== 'initialized' || !managed.context) {
        continue;
      }

      managed.state = 'started';
      managed.publishingAllowed = true;

      try {
        await managed.definition?.start?.(managed.context);
        startedPlugins.push(pluginId);
      } catch (error) {
        managed.publishingAllowed = false;
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnostics.report({
          code: 'lifecycle-failure',
          pluginId,
          message: `Plugin "${pluginId}" failed in "start" hook: ${reason}`,
          details: { hook: 'start' },
        });
        this.eventBus.removeSubscriptionsForPlugin(pluginId);
        this.failPluginAndBlockDependents(pluginId);
      }
    }

    this.running = true;
    this.eventBus.publishSystemEvent('core.host', hostStartedEvent, {
      startedPlugins,
    });
  }

  async stopPlugin(pluginId: string): Promise<void> {
    const managed = this.plugins.get(pluginId);
    if (!managed) {
      return;
    }

    const dependents = this.getTransitiveDependents(pluginId);
    const toStopOrder = [...this.startOrder]
      .reverse()
      .filter((id) => id === pluginId || dependents.has(id));

    for (const id of toStopOrder) {
      await this.stopSinglePlugin(id);
    }
  }

  async stop(): Promise<void> {
    const reverseOrder = [...this.startOrder].reverse();
    for (const pluginId of reverseOrder) {
      await this.stopSinglePlugin(pluginId);
    }
    this.eventBus.removeAllSubscriptions();
    this.running = false;
  }

  async dispose(): Promise<void> {
    if (this.running || [...this.plugins.values()].some((p) => p.state === 'started')) {
      await this.stop();
    }

    const reverseInitialized = [...this.initializedOrder].reverse();
    for (const pluginId of reverseInitialized) {
      const managed = this.plugins.get(pluginId);
      if (!managed?.context) {
        continue;
      }

      try {
        await managed.definition?.dispose?.(managed.context);
        if (managed.state !== 'failed') {
          managed.state = 'disposed';
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnostics.report({
          code: 'lifecycle-failure',
          pluginId,
          message: `Plugin "${pluginId}" failed in "dispose" hook: ${reason}`,
          details: { hook: 'dispose' },
        });
        managed.state = 'failed';
      } finally {
        this.capabilityRegistry.removeProvidersForPlugin(pluginId);
        this.eventBus.removeSubscriptionsForPlugin(pluginId);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getKnownPlugins(): readonly PluginManifest[] {
    return [...this.plugins.values()].map((p) => p.discovered.manifest);
  }

  getPluginManifest(pluginId: string): Readonly<PluginManifest> | undefined {
    return this.plugins.get(pluginId)?.discovered.manifest;
  }

  getPluginState(pluginId: string): PluginState | undefined {
    return this.plugins.get(pluginId)?.state;
  }

  getPluginContext(pluginId: string): PluginContext | undefined {
    return this.plugins.get(pluginId)?.context;
  }

  getDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics.getAll();
  }

  getSubscriptionCount(pluginId?: string): number {
    return this.eventBus.getSubscriptionCount(pluginId);
  }

  private async stopSinglePlugin(pluginId: string): Promise<void> {
    const managed = this.plugins.get(pluginId);
    if (managed?.state !== 'started' || !managed.context) {
      return;
    }

    managed.publishingAllowed = false;
    try {
      await managed.definition?.stop?.(managed.context);
      managed.state = 'stopped';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.diagnostics.report({
        code: 'lifecycle-failure',
        pluginId,
        message: `Plugin "${pluginId}" failed in "stop" hook: ${reason}`,
        details: { hook: 'stop' },
      });
      managed.state = 'failed';
    } finally {
      this.eventBus.removeSubscriptionsForPlugin(pluginId);
    }
  }

  private createPluginContext(manifest: Readonly<PluginManifest>): PluginContext {
    return Object.freeze({
      manifest,
      logger: this.logger.child({ pluginId: manifest.id }),
      clock: this.clock,
      events: this.eventBus.createPluginEventsContext(manifest.id),
      capabilities: this.capabilityRegistry.createPluginCapabilitiesContext(manifest),
    });
  }

  private async loadPluginEntry(managed: ManagedPlugin): Promise<PluginDefinition | undefined> {
    const pluginId = managed.discovered.manifest.id;
    try {
      const fileUrl = pathToFileURL(managed.discovered.entryPath).href;
      const imported = (await import(fileUrl)) as { default?: unknown };
      if (!imported || typeof imported.default !== 'object' || imported.default === null) {
        this.diagnostics.report({
          code: 'entry-load-failure',
          pluginId,
          message: `Entry module for plugin "${pluginId}" does not have a valid default export`,
        });
        return undefined;
      }
      return imported.default as PluginDefinition;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.diagnostics.report({
        code: 'entry-load-failure',
        pluginId,
        message: `Failed to load entry module for plugin "${pluginId}": ${reason}`,
      });
      return undefined;
    }
  }

  private failPluginAndBlockDependents(pluginId: string): void {
    const managed = this.plugins.get(pluginId);
    if (managed) {
      managed.state = 'failed';
      managed.publishingAllowed = false;
    }

    const dependents = this.getTransitiveDependents(pluginId);
    for (const depId of dependents) {
      const depManaged = this.plugins.get(depId);
      if (depManaged && depManaged.state !== 'failed') {
        depManaged.state = 'blocked';
        depManaged.publishingAllowed = false;
        this.eventBus.removeSubscriptionsForPlugin(depId);
      }
    }
  }

  private getTransitiveDependents(pluginId: string): Set<string> {
    if (!this.dependencyGraph?.hasNode(pluginId)) {
      return new Set<string>();
    }
    return new Set(this.dependencyGraph.dependantsOf(pluginId));
  }
}
