// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setWorldConstructor, World } from '@cucumber/cucumber';
import type { BridgeSession } from '@ridrs/ble-bridge';
import {
  activityFinishRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  authBrowserSignInCapability,
  type BleCentral,
  bleBridgeConnectorCapability,
  bleCentralCapability,
  bridgeCompanionsChangedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
  bridgeForgetRequestedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
  bridgeStateChangedEvent,
  type CapabilityCardinality,
  type CapabilityContract,
  configSnapshotCapability,
  controllerButtonsChangedEvent,
  defineCapability,
  defineEvent,
  deviceCandidatesChangedEvent,
  deviceConnectionChangedEvent,
  deviceConnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceForgetRequestedEvent,
  deviceRawNotificationEvent,
  deviceScanChangedEvent,
  deviceStatusChangedEvent,
  type EstimationStrategy,
  type EventDefinition,
  type EventEnvelope,
  type EventSubscription,
  exportFitWrittenEvent,
  type Freshness,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  measurementPowerEvent,
  metricCadenceCapability,
  metricCadenceEvent,
  metricHeartRateCapability,
  metricHeartRateEvent,
  metricPowerCapability,
  metricPowerEvent,
  metricPowerHeartRateRatioCapability,
  metricPowerHeartRateRatioEvent,
  netHttpCapability,
  type PluginContext,
  physicsBicycleCapability,
  physicsEnvironmentCapability,
  physicsMotionCapability,
  physicsPowertrainCapability,
  physicsResistanceCapability,
  physicsRiderCapability,
  physicsStateBatchEvent,
  physicsStateEvent,
  physicsTotalResistanceCapability,
  type ResistanceBreakdown,
  recordingCompletedEvent,
  recordingFailedEvent,
  type SpatialSeriesWriter,
  type SpatialWriteResult,
  spatialTerrainCapability,
  storageAppFilesCapability,
  storageSecretsCapability,
  type TemporalRecordResult,
  type TemporalSeriesWriter,
  type TemporalSnapshot,
  type TerrainPoint,
  type TimeSource,
  trainingAccountChangedEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingPlanChangedEvent,
  trainingRefreshRequestedEvent,
  uiRegistryChangedEvent,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { type BundledPluginSet, createBundledPluginSource, PluginHost } from '@ridrs/core';
import { createFileSystemPluginSource } from '@ridrs/core/node';
import type { FrameSource } from '@ridrs/presentation';
import type { ReplayResult } from '@ridrs/replay';
import {
  type BleSimulator,
  MemoryAppFiles,
  type SimulatedBridgeConnector,
  type SimulatedCompanion,
  type SimulatedNetwork,
  type SimulatedPeripheral,
  type SimulatedTauriBridge,
} from '@ridrs/testing';
import { createInProcessUiBridge, type InProcessUiBridge } from '@ridrs/ui-bridge';
import type FakeTimers from '@sinonjs/fake-timers';
import type { ResultPromise } from 'execa';
import { z } from 'zod';

const REAL_PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');

export type LifecycleHookName = 'initialize' | 'start' | 'stop' | 'dispose';

export interface ProbeBehavior {
  readonly asyncHooks: Set<LifecycleHookName>;
  readonly throwInHook: Map<LifecycleHookName, string>;
  readonly providedImplementations: Map<string, unknown>;
  readonly skipProvideCapabilities: Set<string>;
  readonly extraProvideCapabilities: Map<string, unknown>;
  missingEntry: boolean;
  /** Phase 4: the temporal series this probe writes, reads (freshness log) and combines. */
  temporalWrite?: { readonly series: string; readonly strategy: EstimationStrategy };
  readonly temporalReads: string[];
  readonly temporalCombines: string[][];
  /** Phase 10: the spatial series this probe writes and reads. */
  spatialWrite?: string;
  readonly spatialReads: string[];
  /** Run when the probe starts, e.g. to subscribe like a real plugin. */
  readonly onStart: ((ctx: PluginContext) => void)[];
}

export function createDefaultProbeBehavior(): ProbeBehavior {
  return {
    asyncHooks: new Set(),
    throwInHook: new Map(),
    providedImplementations: new Map(),
    skipProvideCapabilities: new Set(),
    extraProvideCapabilities: new Map(),
    missingEntry: false,
    temporalReads: [],
    temporalCombines: [],
    spatialReads: [],
    onStart: [],
  };
}

/** Events of the real ridrs contracts that scenarios publish or observe by id. */
const PHASE_3_EVENTS: readonly EventDefinition[] = [
  activityStartRequestedEvent,
  activityFinishRequestedEvent,
  activityStateChangedEvent,
  metricPowerEvent,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerHeartRateRatioEvent,
  physicsStateEvent,
  physicsStateBatchEvent,
  worldTerrainPreviewEvent,
  uiTerrainObservedEvent,
  measurementPowerEvent,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  deviceConnectionChangedEvent,
  deviceCandidatesChangedEvent,
  deviceConnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceScanChangedEvent,
  deviceForgetRequestedEvent,
  deviceStatusChangedEvent,
  controllerButtonsChangedEvent,
  uiRegistryChangedEvent,
  bridgeCompanionsChangedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
  bridgeForgetRequestedEvent,
  bridgePairingOfferEvent,
  bridgePairRequestedEvent,
  bridgeStateChangedEvent,
  deviceRawNotificationEvent,
  recordingCompletedEvent,
  recordingFailedEvent,
  exportFitWrittenEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingRefreshRequestedEvent,
  trainingAccountChangedEvent,
  trainingPlanChangedEvent,
];

/** Events the World records from the bus directly (host-level), independent of any plugin. */
const HOST_OBSERVED_EVENTS: readonly EventDefinition[] = [
  uiRegistryChangedEvent,
  deviceStatusChangedEvent,
  controllerButtonsChangedEvent,
  activityStateChangedEvent,
  physicsStateEvent,
  physicsStateBatchEvent,
  worldTerrainPreviewEvent,
  uiTerrainObservedEvent,
  bridgeCompanionsChangedEvent,
  bridgePairingOfferEvent,
  bridgeStateChangedEvent,
  // What the rider asks for in the device setup.
  deviceConnectRequestedEvent,
  deviceForgetRequestedEvent,
  bridgeConnectRequestedEvent,
  bridgeDisconnectRequestedEvent,
];

const ACTIVE_WORLD_SYMBOL = Symbol.for('ridrs.test.activeWorld');
const MEMORY_STORAGE_SYMBOL = Symbol.for('ridrs.fixture.memory-storage');
const MEMORY_STORAGE_DIR = resolve(import.meta.dirname, '../fixtures/plugins/memory-storage');

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
  fakeClock?: ReturnType<typeof FakeTimers.install>;
  readonly clock: TimeSource = {
    now: () => (this.fakeClock ? Date.now() : this.fixedTime),
  };

  // Phase 2 state
  realPluginIds: string[] = [];
  bleSimulator?: BleSimulator;
  tauriBridge?: SimulatedTauriBridge;
  // Phase 3b state: the simulated network, the companion on it and ridrs' side of it.
  bridgeNetwork?: SimulatedNetwork;
  bridgeConnector?: SimulatedBridgeConnector;
  companion?: SimulatedCompanion;
  companionCentral?: BleCentral;
  /** The companion's own simulated devices, when this device's Bluetooth sees others. */
  companionSimulator?: BleSimulator;
  readonly bridgeSessions: BridgeSession[] = [];
  trainer?: SimulatedPeripheral;
  heartRateSensor?: SimulatedPeripheral;
  readonly observed: EventEnvelope[] = [];
  /** Events recorded by the World's own host-level subscriptions (see HOST_OBSERVED_EVENTS). */
  readonly hostObserved: EventEnvelope[] = [];
  /** Phase 9: every envelope of every host, in global publish order (the recorder's tap). */
  readonly tapped: EventEnvelope[] = [];
  /** Phase 9: the files of `fixture-storage-memory`; they survive host restarts. */
  memoryFiles?: MemoryAppFiles;
  /** Phase 9: the file a step named last ("that file"). */
  lastRecordingFile?: string;
  /** Phase 9: the recording's lines as replay steps changed them. */
  replayLines?: string[];
  readonly replayResults: ReplayResult[] = [];
  replayError?: unknown;
  /** Phase 9: the event a step looked at last ("its source"). */
  lastEnvelope?: EventEnvelope;
  /** Phase 9: the app's data directory (RIDRS_DATA_DIR) in the e2e. */
  dataDir?: string;
  /** Phase 9: the last `ridrs-headless` command a step ran. */
  cliResult?: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
  /** Phase 9: the FIT file the CLI exported. */
  cliFitBytes?: Uint8Array;
  /** Phase 9: what a probe's call to `ctx.host` threw. */
  lastHostCallError?: unknown;
  readonly pendingUi = new Map<string, Record<string, unknown>>();
  extraPluginDirs: string[] = [];

  // UI state (@ui scenarios): the in-process bridge is created with the host, like in apps/native.
  uiEnabled = false;
  uiBridge?: InProcessUiBridge;
  /** The native app's composition root, when a scenario starts it instead of a bare host. */
  nativeApp?: { readonly host: PluginHost; close(): Promise<void> };
  readonly keepAwakeRequests: boolean[] = [];
  /** What the native app's shell does on the platform's back button, while it listens. */
  backButtonPress?: () => void;
  /** Phase 7: paces the native app's render clock instead of requestAnimationFrame. */
  nativeFrameSource?: FrameSource;
  readonly uiViews: Array<{ readonly root: HTMLElement; dispose: () => void }> = [];
  packetMark = 0;
  readonly stopMarks = new Map<
    string,
    { observed: number; hostObserved: number; connectAttempts: number }
  >();

  host?: PluginHost;
  bundled?: { manifests: Record<string, string>; modules: Record<string, () => Promise<unknown>> };
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
  // Phase 4 state: temporal probes, keyed by series id (writers, freshness log) or plugin id.
  readonly temporalWriters = new Map<
    string,
    { readonly pluginId: string; readonly writer: TemporalSeriesWriter }
  >();
  readonly freshnessChanges = new Map<string, Array<{ freshness: Freshness; at: number }>>();
  readonly snapshots = new Map<string, TemporalSnapshot[]>();
  lastRecordResult?: TemporalRecordResult;
  // Phase 10 state: spatial probes, keyed by series id.
  readonly spatialWriters = new Map<
    string,
    { readonly pluginId: string; readonly writer: SpatialSeriesWriter<TerrainPoint> }
  >();
  lastSpatialWriteResult?: SpatialWriteResult;
  requestedSnapshot?: TemporalSnapshot;
  /** Last delivery per series of the "delivers ... every ..." steps. */
  readonly lastDeliveries = new Map<string, number>();
  /** Environment variables a scenario set; restored afterwards. */
  readonly envOverrides = new Map<string, string | undefined>();
  lastPublishError?: unknown;
  lastCapabilityError?: unknown;
  /** Phase 5: the last total resistance a probe evaluated. */
  lastResistance?: ResistanceBreakdown;

  // Headless e2e state
  headlessPluginsDir = '';
  headlessProcess?: ResultPromise;
  headlessOutput = '';
  headlessExitCode: number | null = null;
  headlessExited = false;
  headlessPluginDirs: string[] = [];
  headlessDisabled: string[] = [];
  headlessEnv: Record<string, string> = {};
  headlessCursor = 0;

  async initTempDir(): Promise<void> {
    this.tempPluginDir = await mkdtemp(join(tmpdir(), 'ridrs-phase1-'));
    for (const contract of [
      bleCentralCapability,
      bleBridgeConnectorCapability,
      metricPowerCapability,
      metricCadenceCapability,
      metricHeartRateCapability,
      metricPowerHeartRateRatioCapability,
      physicsBicycleCapability,
      physicsRiderCapability,
      physicsEnvironmentCapability,
      physicsResistanceCapability,
      physicsTotalResistanceCapability,
      physicsPowertrainCapability,
      physicsMotionCapability,
      configSnapshotCapability,
      storageAppFilesCapability,
      spatialTerrainCapability,
      netHttpCapability,
      authBrowserSignInCapability,
      storageSecretsCapability,
    ]) {
      this.capabilityContracts.set(contract.id, contract);
    }
    for (const event of PHASE_3_EVENTS) {
      this.eventDefinitions.set(event.id, event);
    }
  }

  /** Real plugin folders under plugins/ that this scenario did not ask for. */
  unusedRealPlugins(): string[] {
    return readdirSync(REAL_PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !this.realPluginIds.includes(entry.name))
      .map((entry) => entry.name);
  }

  /** Lets pending promise chains settle; with fake timers this runs zero-delay timers too. */
  async settle(): Promise<void> {
    if (this.fakeClock) {
      await this.fakeClock.tickAsync(0);
    }
  }

  async cleanup(): Promise<void> {
    if (this.headlessProcess && !this.headlessExited) {
      this.headlessProcess.kill('SIGKILL');
    }
    await this.disposeHost();
    for (const session of this.bridgeSessions.splice(0)) {
      session.close();
    }
    this.companion?.server.close();
    this.tauriBridge?.uninstall();
    this.tauriBridge = undefined;
    if (this.tempPluginDir) {
      await rm(this.tempPluginDir, { recursive: true, force: true });
      this.tempPluginDir = '';
    }
    if (this.dataDir) {
      await rm(this.dataDir, { recursive: true, force: true });
      this.dataDir = undefined;
    }
    this.fakeClock?.uninstall();
    this.fakeClock = undefined;
    for (const [name, value] of this.envOverrides) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    this.envOverrides.clear();
    delete (globalThis as Record<symbol, unknown>)[MEMORY_STORAGE_SYMBOL];
  }

  /** Phase 9: the plugins use `fixture-storage-memory`, whose files the World owns. */
  useMemoryStorage(): MemoryAppFiles {
    if (!this.memoryFiles) {
      this.memoryFiles = new MemoryAppFiles();
      (globalThis as Record<symbol, unknown>)[MEMORY_STORAGE_SYMBOL] = this.memoryFiles;
      this.extraPluginDirs.push(MEMORY_STORAGE_DIR);
    }
    return this.memoryFiles;
  }

  /**
   * Lets storage, compression and promise chains run without moving the clock: compression
   * streams finish on real I/O turns. Resolves once `done()` holds.
   */
  async waitForIo(done: () => boolean, what: string): Promise<void> {
    for (let turn = 0; turn < 2000; turn += 1) {
      if (done()) {
        return;
      }
      await this.settle();
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /** Sets an environment variable for this scenario only. */
  setEnv(name: string, value: string): void {
    if (!this.envOverrides.has(name)) {
      this.envOverrides.set(name, process.env[name]);
    }
    process.env[name] = value;
  }

  /** (Re)writes a probe plugin folder from its temporal behavior: writes provide, reads require. */
  async writeTemporalProbe(pluginId: string): Promise<void> {
    const behavior = this.getBehavior(pluginId);
    const write = behavior.temporalWrite?.series ?? behavior.spatialWrite;
    await this.writeProbePluginFolder({
      folder: pluginId,
      id: pluginId,
      provides: write ? [write] : [],
      requires: [
        ...new Set([
          ...behavior.temporalReads,
          ...behavior.temporalCombines.flat(),
          ...behavior.spatialReads,
        ]),
      ].filter((series) => series !== write),
    });
  }

  /** Unmounts every UI view, then disposes the bridge and the host. */
  async disposeHost(): Promise<void> {
    await this.nativeApp?.close();
    this.nativeApp = undefined;
    for (const view of this.uiViews.splice(0)) {
      view.dispose();
      view.root.remove();
    }
    this.uiBridge?.dispose();
    this.uiBridge = undefined;
    if (this.host) {
      await this.host.dispose();
      this.host = undefined;
    }
  }

  ensureHost(): PluginHost {
    if (!this.host) {
      const dirs = [
        ...(this.realPluginIds.length > 0
          ? [this.tempPluginDir, REAL_PLUGINS_DIR]
          : [this.tempPluginDir]),
        ...this.extraPluginDirs,
      ];
      this.host = new PluginHost({
        sources: this.bundled
          ? [createBundledPluginSource(this.bundled satisfies BundledPluginSet)]
          : dirs.map(createFileSystemPluginSource),
        disabledPlugins: this.realPluginIds.length > 0 ? this.unusedRealPlugins() : [],
        timeSource: this.clock,
        capabilities: this.capabilityContracts.values(),
        events: this.eventDefinitions.values(),
      });
      if (this.uiEnabled) {
        this.uiBridge = createInProcessUiBridge(this.host, PHASE_3_EVENTS);
      }
      for (const event of HOST_OBSERVED_EVENTS) {
        this.host.subscribeEvent('test-world', event, (envelope) => {
          this.hostObserved.push(envelope);
        });
      }
      this.host.observe('test-world', { onEvent: (envelope) => this.tapped.push(envelope) });
    }
    return this.host;
  }

  bundle(): NonNullable<RidrsWorld['bundled']> {
    this.bundled ??= { manifests: {}, modules: {} };
    return this.bundled;
  }

  /** Adds a probe plugin to the in-memory bundle, as `import.meta.glob` would deliver it. */
  addBundledProbePlugin(options: {
    folder: string;
    id: string;
    types: string[];
    provides: string[];
    requires: string[];
  }): void {
    const bundle = this.bundle();
    bundle.manifests[`plugins/${options.folder}/manifest.json`] = JSON.stringify({
      id: options.id,
      name: `Plugin ${options.id}`,
      version: '1.0.0',
      types: options.types.length > 0 ? options.types : ['example'],
      provides: options.provides,
      requires: options.requires,
      entry: 'index.ts',
    });
    bundle.modules[`plugins/${options.folder}/index.ts`] = () => import('./probe-plugin.ts');
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
    module?: string;
    ui?: Record<string, unknown>;
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
      ...(options.ui ? { ui: options.ui } : {}),
    };

    if (typeof options.ui?.client === 'string') {
      const clientPath = join(folderPath, options.ui.client);
      await mkdir(join(clientPath, '..'), { recursive: true });
      await writeFile(clientPath, '// empty client module\n', 'utf8');
    }

    await writeFile(join(folderPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    if (options.createEntry !== false) {
      const probeModulePath = resolve(import.meta.dirname, options.module ?? 'probe-plugin.ts');
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
