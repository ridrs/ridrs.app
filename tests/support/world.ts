// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setWorldConstructor, World } from '@cucumber/cucumber';
import {
  type CapabilityCardinality,
  type CapabilityContract,
  type Clock,
  defineCapability,
  defineEvent,
  type EventDefinition,
  type EventEnvelope,
  type EventSubscription,
} from '@ridrs/contracts';
import { PluginHost } from '@ridrs/core';
import type { ResultPromise } from 'execa';
import { z } from 'zod';

export type LifecycleHookName = 'initialize' | 'start' | 'stop' | 'dispose';

export interface ProbeBehavior {
  readonly asyncHooks: Set<LifecycleHookName>;
  readonly throwInHook: Map<LifecycleHookName, string>;
  readonly providedImplementations: Map<string, unknown>;
  readonly skipProvideCapabilities: Set<string>;
  readonly extraProvideCapabilities: Map<string, unknown>;
  missingEntry: boolean;
}

export function createDefaultProbeBehavior(): ProbeBehavior {
  return {
    asyncHooks: new Set(),
    throwInHook: new Map(),
    providedImplementations: new Map(),
    skipProvideCapabilities: new Set(),
    extraProvideCapabilities: new Map(),
    missingEntry: false,
  };
}

const ACTIVE_WORLD_SYMBOL = Symbol.for('ridrs.test.activeWorld');

export function setActiveWorld(world: RidrsWorld | undefined): void {
  (globalThis as Record<symbol, unknown>)[ACTIVE_WORLD_SYMBOL] = world;
}

export function getActiveWorld(): RidrsWorld {
  const world = (globalThis as Record<symbol, unknown>)[ACTIVE_WORLD_SYMBOL] as
    | RidrsWorld
    | undefined;
  if (!world) {
    throw new Error('No active RidrsWorld registered');
  }
  return world;
}

export class RidrsWorld extends World {
  tempPluginDir = '';
  fixedTime = 1_700_000_000_000;
  readonly clock: Clock = {
    now: () => this.fixedTime,
  };

  host?: PluginHost;
  readonly capabilityContracts = new Map<string, CapabilityContract>();
  readonly eventDefinitions = new Map<string, EventDefinition>();
  readonly behaviors = new Map<string, ProbeBehavior>();
  readonly lifecycleCalls: Array<{ plugin: string; hook: LifecycleHookName }> = [];
  readonly hookTimeline: Array<{
    plugin: string;
    hook: LifecycleHookName;
    phase: 'called' | 'completed';
  }> = [];
  readonly receivedEvents = new Map<string, EventEnvelope[]>();
  readonly subscriptions = new Map<string, Map<string, EventSubscription>>();
  readonly capabilityAnswers = new Map<string, string>();
  lastPublishError?: unknown;
  lastCapabilityError?: unknown;

  // Headless e2e state
  headlessPluginsDir = '';
  headlessProcess?: ResultPromise;
  headlessOutput = '';
  headlessExitCode: number | null = null;
  headlessExited = false;

  async initTempDir(): Promise<void> {
    this.tempPluginDir = await mkdtemp(join(tmpdir(), 'ridrs-phase1-'));
  }

  async cleanup(): Promise<void> {
    if (this.headlessProcess && !this.headlessExited) {
      this.headlessProcess.kill('SIGKILL');
    }
    if (this.host) {
      await this.host.dispose();
      this.host = undefined;
    }
    if (this.tempPluginDir) {
      await rm(this.tempPluginDir, { recursive: true, force: true });
      this.tempPluginDir = '';
    }
  }

  ensureHost(): PluginHost {
    if (!this.host) {
      this.host = new PluginHost({
        pluginsDir: this.tempPluginDir,
        clock: this.clock,
        capabilities: this.capabilityContracts.values(),
      });
    }
    return this.host;
  }

  getBehavior(pluginId: string): ProbeBehavior {
    let behavior = this.behaviors.get(pluginId);
    if (!behavior) {
      behavior = createDefaultProbeBehavior();
      this.behaviors.set(pluginId, behavior);
    }
    return behavior;
  }

  getOrRegisterCapability(
    capId: string,
    cardinality: CapabilityCardinality = 'single',
  ): CapabilityContract {
    let contract = this.capabilityContracts.get(capId);
    if (!contract) {
      contract = defineCapability(capId, { cardinality });
      this.capabilityContracts.set(capId, contract);
      this.host?.registerCapability(contract);
    }
    return contract;
  }

  registerEventSchema(
    eventId: string,
    fields: ReadonlyArray<{ field: string; type: string }>,
  ): void {
    const shape: Record<string, z.ZodType> = {};
    for (const { field, type } of fields) {
      if (type === 'string') {
        shape[field] = z.string();
      } else if (type === 'number') {
        shape[field] = z.number();
      } else if (type === 'boolean') {
        shape[field] = z.boolean();
      } else {
        shape[field] = z.unknown();
      }
    }
    const def = defineEvent(eventId, z.object(shape));
    this.eventDefinitions.set(eventId, def);
  }

  getEventDefinition(eventId: string): EventDefinition {
    const def = this.eventDefinitions.get(eventId);
    if (!def) {
      throw new Error(`Event definition "${eventId}" is not registered in World`);
    }
    return def;
  }

  recordEvent(pluginId: string, envelope: EventEnvelope): void {
    const list = this.receivedEvents.get(pluginId) ?? [];
    list.push(envelope);
    this.receivedEvents.set(pluginId, list);
  }

  async writeProbePluginFolder(options: {
    folder: string;
    id: string;
    types?: string[];
    provides?: string[];
    requires?: string[];
    createEntry?: boolean;
  }): Promise<void> {
    const folderPath = join(this.tempPluginDir, options.folder);
    await mkdir(folderPath, { recursive: true });

    const manifest = {
      id: options.id,
      name: `Plugin ${options.id}`,
      version: '1.0.0',
      types: options.types && options.types.length > 0 ? options.types : ['example'],
      provides: options.provides ?? [],
      requires: options.requires ?? [],
      entry: 'index.ts',
    };

    await writeFile(join(folderPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    if (options.createEntry !== false) {
      const probeModulePath = resolve(import.meta.dirname, 'probe-plugin.ts');
      const entrySource = [
        '// SPDX-License-Identifier: AGPL-3.0-or-later',
        `export { default } from ${JSON.stringify(probeModulePath)};`,
        '',
      ].join('\n');
      await writeFile(join(folderPath, 'index.ts'), entrySource, 'utf8');
    }
  }
}

setWorldConstructor(RidrsWorld);
