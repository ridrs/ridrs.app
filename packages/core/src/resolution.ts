// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CapabilityContract, ServiceDefinition } from '@ridrs/contracts';
import { DepGraph, DepGraphCycleError } from 'dependency-graph';
import type { DiagnosticCollector } from './diagnostics.ts';
import type { DiscoveredPlugin } from './discovery.ts';

export interface ResolutionResult {
  readonly startOrder: readonly string[];
  readonly blockedPlugins: ReadonlySet<string>;
  readonly dependencyGraph: DepGraph<string>;
}

/**
 * The capabilities a plugin starts after: what it requires and, when provided, what it may use
 * (`optionalRequires`, ADR 0053). Only the required ones block it when missing.
 */
function dependenciesOf(plugin: DiscoveredPlugin): readonly string[] {
  return [...plugin.manifest.requires, ...(plugin.manifest.optionalRequires ?? [])];
}

/** The registered app state topics and services (ADR 0068), checked like capabilities. */
export interface AppChannels {
  readonly states: ReadonlySet<string>;
  readonly services: ReadonlyMap<string, ServiceDefinition>;
}

const NO_CHANNELS: AppChannels = { states: new Set(), services: new Map() };

/**
 * App state and services a plugin names must be registered; a service without a key has one
 * provider, or both are blocked like the providers of a `single` capability. A service in
 * `calls` without a provider blocks nobody: the call rejects.
 */
function resolveAppChannels(
  plugins: readonly DiscoveredPlugin[],
  channels: AppChannels,
  diagnostics: DiagnosticCollector,
  blocked: Set<string>,
): void {
  const providers = new Map<string, string[]>();
  for (const { manifest } of plugins) {
    const topics = [
      ...(manifest.state?.owns ?? []),
      ...(manifest.state?.watches ?? []),
      ...(manifest.ui?.state ?? []),
    ];
    for (const topic of new Set(topics)) {
      if (!channels.states.has(topic)) {
        diagnostics.report({
          code: 'unknown-state',
          pluginId: manifest.id,
          message: `Plugin "${manifest.id}" references unregistered app state "${topic}"`,
          details: { topic },
        });
        blocked.add(manifest.id);
      }
    }
    const services = [
      ...(manifest.services?.provides ?? []),
      ...(manifest.services?.calls ?? []),
      ...(manifest.ui?.calls ?? []),
    ];
    for (const service of new Set(services)) {
      if (!channels.services.has(service)) {
        diagnostics.report({
          code: 'unknown-service',
          pluginId: manifest.id,
          message: `Plugin "${manifest.id}" references unregistered service "${service}"`,
          details: { service },
        });
        blocked.add(manifest.id);
      }
    }
    for (const service of manifest.services?.provides ?? []) {
      providers.set(service, [...(providers.get(service) ?? []), manifest.id]);
    }
  }
  for (const [service, ids] of providers) {
    const definition = channels.services.get(service);
    if (definition && !definition.keyedBy && ids.length > 1) {
      diagnostics.report({
        code: 'ambiguous-service',
        message: `Service "${service}" has several providers (${ids.join(', ')}) but no key to route by`,
        details: { service, plugins: ids },
      });
      for (const id of ids) {
        blocked.add(id);
      }
    }
  }
}

export function resolveCapabilities(
  plugins: readonly DiscoveredPlugin[],
  contracts: ReadonlyMap<string, CapabilityContract>,
  diagnostics: DiagnosticCollector,
  channels: AppChannels = NO_CHANNELS,
): ResolutionResult {
  const sortedPlugins = [...plugins].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  const blocked = new Set<string>();
  resolveAppChannels(sortedPlugins, channels, diagnostics, blocked);

  // 1. Validate that all referenced capabilities have registered contracts.
  for (const plugin of sortedPlugins) {
    const referenced = [
      ...plugin.manifest.provides,
      ...plugin.manifest.requires,
      ...(plugin.manifest.optionalRequires ?? []),
    ];
    for (const capId of referenced) {
      if (!contracts.has(capId)) {
        diagnostics.report({
          code: 'unknown-capability',
          pluginId: plugin.manifest.id,
          message: `Plugin "${plugin.manifest.id}" references unregistered capability "${capId}"`,
          details: { capability: capId },
        });
        blocked.add(plugin.manifest.id);
      }
    }
  }

  // 2. Map capabilities to their providers and check for single-capability ambiguity.
  const providersByCap = new Map<string, string[]>();
  for (const plugin of sortedPlugins) {
    for (const capId of plugin.manifest.provides) {
      if (!contracts.has(capId)) {
        continue;
      }
      const list = providersByCap.get(capId);
      if (list) {
        list.push(plugin.manifest.id);
      } else {
        providersByCap.set(capId, [plugin.manifest.id]);
      }
    }
  }

  const ambiguousCapabilities = new Set<string>();
  for (const [capId, providerIds] of providersByCap.entries()) {
    const contract = contracts.get(capId);
    if (contract && contract.cardinality === 'single' && providerIds.length > 1) {
      const sortedProviders = [...providerIds].sort((a, b) => a.localeCompare(b));
      ambiguousCapabilities.add(capId);
      diagnostics.report({
        code: 'ambiguous-provider',
        message: `Capability "${capId}" has multiple providers (${sortedProviders.join(', ')}) but cardinality is single`,
        details: { capability: capId, plugins: sortedProviders },
      });
      for (const providerId of sortedProviders) {
        blocked.add(providerId);
      }
    }
  }

  // 3. Check for missing required capabilities.
  for (const plugin of sortedPlugins) {
    for (const reqCap of plugin.manifest.requires) {
      if (!contracts.has(reqCap) || ambiguousCapabilities.has(reqCap)) {
        continue;
      }
      const providers = providersByCap.get(reqCap) ?? [];
      if (providers.length === 0) {
        diagnostics.report({
          code: 'missing-capability',
          pluginId: plugin.manifest.id,
          message: `Plugin "${plugin.manifest.id}" requires missing capability "${reqCap}"`,
          details: { capability: reqCap },
        });
        blocked.add(plugin.manifest.id);
      }
    }
  }

  // 4. Build full dependency graph across all discovered plugins.
  const fullGraph = new DepGraph<string>();
  for (const plugin of sortedPlugins) {
    fullGraph.addNode(plugin.manifest.id);
  }
  for (const plugin of sortedPlugins) {
    for (const reqCap of dependenciesOf(plugin)) {
      const providers = providersByCap.get(reqCap) ?? [];
      for (const providerId of providers) {
        fullGraph.addDependency(plugin.manifest.id, providerId);
      }
    }
  }

  // 5. Detect dependency cycles using dependency-graph and block cyclic components.
  const buildActiveGraph = (): DepGraph<string> => {
    const graph = new DepGraph<string>();
    for (const plugin of sortedPlugins) {
      if (!blocked.has(plugin.manifest.id)) {
        graph.addNode(plugin.manifest.id);
      }
    }
    for (const plugin of sortedPlugins) {
      const pluginId = plugin.manifest.id;
      if (blocked.has(pluginId)) {
        continue;
      }
      for (const reqCap of dependenciesOf(plugin)) {
        const providers = providersByCap.get(reqCap) ?? [];
        for (const providerId of providers) {
          if (!blocked.has(providerId)) {
            graph.addDependency(pluginId, providerId);
          }
        }
      }
    }
    return graph;
  };

  while (true) {
    const candidateGraph = buildActiveGraph();
    try {
      candidateGraph.overallOrder();
      break;
    } catch (error) {
      if (error instanceof DepGraphCycleError) {
        const cyclePlugins = [...new Set(error.cyclePath)].sort((a, b) => a.localeCompare(b));
        diagnostics.report({
          code: 'dependency-cycle',
          message: `Dependency cycle detected involving plugins: ${cyclePlugins.join(', ')}`,
          details: { plugins: cyclePlugins, cyclePath: error.cyclePath },
        });
        for (const cyclePluginId of cyclePlugins) {
          blocked.add(cyclePluginId);
        }
      } else {
        throw error;
      }
    }
  }

  // 6. Propagate blocking transitively to any plugin that depends on a blocked plugin.
  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of sortedPlugins) {
      const pluginId = plugin.manifest.id;
      if (blocked.has(pluginId)) {
        continue;
      }
      for (const reqCap of plugin.manifest.requires) {
        if (!contracts.has(reqCap) || ambiguousCapabilities.has(reqCap)) {
          blocked.add(pluginId);
          changed = true;
          break;
        }
        const providers = providersByCap.get(reqCap) ?? [];
        const activeProviders = providers.filter((p) => !blocked.has(p));
        if (activeProviders.length === 0) {
          blocked.add(pluginId);
          changed = true;
          break;
        }
      }
    }
  }

  const finalActiveGraph = buildActiveGraph();
  const startOrder = finalActiveGraph.overallOrder();

  return {
    startOrder,
    blockedPlugins: blocked,
    dependencyGraph: finalActiveGraph,
  };
}
