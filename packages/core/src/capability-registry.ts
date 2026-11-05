// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type CapabilityCardinality,
  type CapabilityContract,
  type PluginCapabilitiesContext,
  type PluginManifest,
  RidrsError,
} from '@ridrs/contracts';

interface ProvidedEntry {
  readonly providerPluginId: string;
  readonly implementation: unknown;
}

export class CapabilityRegistry {
  private readonly contracts = new Map<string, CapabilityContract>();
  private readonly providers = new Map<string, ProvidedEntry[]>();

  registerContract(contract: CapabilityContract): void {
    this.contracts.set(contract.id, contract);
  }

  registerContracts(contracts: Iterable<CapabilityContract>): void {
    for (const contract of contracts) {
      this.registerContract(contract);
    }
  }

  getContracts(): ReadonlyMap<string, CapabilityContract> {
    return this.contracts;
  }

  createPluginCapabilitiesContext(manifest: Readonly<PluginManifest>): PluginCapabilitiesContext {
    const pluginId = manifest.id;
    const declaredProvides = new Set(manifest.provides);
    const declaredRequires = new Set([...manifest.requires, ...(manifest.optionalRequires ?? [])]);

    return {
      provide: <TImpl>(
        contract: CapabilityContract<TImpl, CapabilityCardinality>,
        implementation: TImpl,
      ): void => {
        if (!declaredProvides.has(contract.id)) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" tried to provide undeclared capability "${contract.id}"`,
            { pluginId },
          );
        }

        const list = this.providers.get(contract.id) ?? [];
        const filtered = list.filter((entry) => entry.providerPluginId !== pluginId);
        filtered.push({
          providerPluginId: pluginId,
          implementation,
        });
        filtered.sort((a, b) => a.providerPluginId.localeCompare(b.providerPluginId));
        this.providers.set(contract.id, filtered);
      },

      get: <TImpl>(contract: CapabilityContract<TImpl, 'single'>): TImpl => {
        if (!declaredRequires.has(contract.id)) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" tried to access undeclared capability "${contract.id}"`,
            { pluginId },
          );
        }

        const entries = this.providers.get(contract.id) ?? [];
        const first = entries[0];
        if (!first) {
          throw new RidrsError(
            'missing-capability',
            `Capability "${contract.id}" required by "${pluginId}" has no active provider`,
            { pluginId },
          );
        }
        return first.implementation as TImpl;
      },

      find: <TImpl>(contract: CapabilityContract<TImpl, 'single'>): TImpl | undefined => {
        if (!declaredRequires.has(contract.id)) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" tried to access undeclared capability "${contract.id}"`,
            { pluginId },
          );
        }
        return this.providers.get(contract.id)?.[0]?.implementation as TImpl | undefined;
      },

      getAll: <TImpl>(contract: CapabilityContract<TImpl, 'multiple'>): readonly TImpl[] => {
        if (!declaredRequires.has(contract.id)) {
          throw new RidrsError(
            'undeclared-capability',
            `Plugin "${pluginId}" tried to access undeclared capability "${contract.id}"`,
            { pluginId },
          );
        }

        const entries = this.providers.get(contract.id) ?? [];
        return entries.map((entry) => entry.implementation as TImpl);
      },
    };
  }

  /** The providers of a capability with their plugin ids, sorted by plugin id. */
  providersOf(
    capabilityId: string,
  ): readonly { readonly pluginId: string; readonly implementation: unknown }[] {
    return (this.providers.get(capabilityId) ?? []).map((entry) => ({
      pluginId: entry.providerPluginId,
      implementation: entry.implementation,
    }));
  }

  /** Capability id -> provider plugin ids, both sorted. */
  resolution(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const capabilityId of [...this.providers.keys()].sort()) {
      result[capabilityId] = this.providersOf(capabilityId).map((entry) => entry.pluginId);
    }
    return result;
  }

  hasProvided(pluginId: string, capabilityId: string): boolean {
    const entries = this.providers.get(capabilityId) ?? [];
    return entries.some((entry) => entry.providerPluginId === pluginId);
  }

  removeProvidersForPlugin(pluginId: string): void {
    for (const [capId, entries] of this.providers.entries()) {
      const remaining = entries.filter((entry) => entry.providerPluginId !== pluginId);
      if (remaining.length === 0) {
        this.providers.delete(capId);
      } else {
        this.providers.set(capId, remaining);
      }
    }
  }
}
