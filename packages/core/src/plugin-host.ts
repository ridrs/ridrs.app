// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  APP_CHANNEL_TYPES,
  type AppFiles,
  type CapabilityContract,
  type Clock,
  type Diagnostic,
  type DiagnosticCode,
  type EventDefinition,
  type EventEnvelope,
  type EventHandler,
  type EventSubscription,
  type HostDescription,
  type HostObserver,
  type HostPlatform,
  hostStartedEvent,
  type PluginContext,
  type PluginDefinition,
  type PluginLogger,
  type PluginManifest,
  type PluginServicesContext,
  type PluginSettingsContext,
  type PluginState,
  type PluginStateContext,
  RidrsError,
  type ServiceCaller,
  type ServiceDefinition,
  type ServiceHandler,
  type StateDefinition,
  type StateView,
  storageAppFilesCapability,
  type TaskId,
  type TimeSource,
  type UiRegistry,
  uiRegistryChangedEvent,
} from '@ridrs/contracts';
import { TEMPORAL_DEFAULTS } from '@ridrs/temporal';
import type { DepGraph } from 'dependency-graph';
import { CapabilityRegistry } from './capability-registry.ts';
import { LiveClock, ReplayClock, type TimerPort, type TurnClock } from './clock.ts';
import { DiagnosticCollector } from './diagnostics.ts';
import { type DiscoveredPlugin, discoverPlugins, type PluginSource } from './discovery.ts';
import { EventBus } from './event-bus.ts';
import { createSilentLogger } from './logger.ts';
import { resolveCapabilities } from './resolution.ts';
import { type ServiceCallObserver, ServiceRegistry } from './service-registry.ts';
import { createPluginSettings } from './settings-service.ts';
import { SpatialService } from './spatial-service.ts';
import { type StateObserver, StateStore } from './state-store.ts';
import { TemporalService } from './temporal-service.ts';
import { computeUiRegistry } from './ui-registry.ts';

export interface PluginHostOptions {
  /** Where plugins come from: a file-system source in Node hosts, a bundled source in apps. */
  readonly sources: readonly PluginSource[];
  readonly disabledPlugins?: Iterable<string>;
  /** Drives the live clock: the OS's monotonic clock by default, a fake one in tests. */
  readonly timeSource?: TimeSource;
  /** The live clock's wake-ups: global timers by default; tests deliver them late on purpose. */
  readonly timers?: TimerPort;
  /**
   * A replay host: a `ReplayClock` from `start`, the recorded `runId`, and inputs from its own
   * plugins dropped (their I/O is not replayed; the recorded inputs are injected instead).
   */
  readonly replay?: { readonly start: number; readonly runId?: string };
  /**
   * A host that continues an interrupted ride (ADR 0057): its clock is held at `start` with the
   * recorded `runId` until `goLive()`; plugin inputs wait until then. `describe()` names the
   * journal, so the recorder appends to it.
   */
  readonly continueFrom?: { readonly start: number; readonly runId: string; readonly file: string };
  readonly logger?: PluginLogger;
  readonly capabilities?: Iterable<CapabilityContract>;
  /** Event definitions the host can resolve by id (for bridges that only know ids). */
  readonly events?: Iterable<EventDefinition>;
  /** App state topics plugins may own and watch (ADR 0068); the core knows no concrete one. */
  readonly states?: Iterable<StateDefinition>;
  /** Services plugins may provide and call (ADR 0068); the core knows no concrete one. */
  readonly services?: Iterable<ServiceDefinition>;
  /** Who runs the host, for `describe()` (recordings name it). */
  readonly platform?: HostPlatform;
  /**
   * Where `ctx.settings` keeps its documents (ADR 0054): the provider of `storage.app-files` by
   * default, so a replay (no storage plugin) reads no settings. Tests pass their own.
   */
  readonly settingsFiles?: AppFiles;
}

/** For hosts whose composition root does not say (tests, tools). */
const UNKNOWN_PLATFORM: HostPlatform = Object.freeze({
  ridrsVersion: '0.0.0',
  runtime: 'node',
  os: 'unknown',
  appVersion: '0.0.0',
});

interface ManagedPlugin {
  readonly discovered: DiscoveredPlugin;
  state: PluginState;
  context?: PluginContext;
  definition?: PluginDefinition;
  abortController?: AbortController;
  publishingAllowed: boolean;
  /** Whether the plugin source can deliver `ui.client`; checked whenever the plugin starts. */
  clientAvailable: boolean;
}

/**
 * Plugins on the input side of the simulation (manifest types): their publications outside a turn
 * are external inputs and enter through the input queue. Everyone else must use `ctx.inputs`.
 */
const INPUT_SIDE_TYPES = new Set(['transport', 'storage', 'recording', 'export', 'ui']);

function randomRunId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const EMPTY_UI_REGISTRY: UiRegistry = Object.freeze({
  revision: 0,
  screens: [],
  contributions: [],
  events: { subscribe: [], publish: [] },
  state: [],
  calls: [],
  plugins: [],
});

export class PluginHost {
  private readonly sources: readonly PluginSource[];
  private readonly disabledPlugins: Set<string>;
  private readonly clock: TurnClock;
  private readonly runId: string;
  private readonly replayMode: boolean;
  private readonly continuing: { readonly file: string } | undefined;
  /** While a continuing host is held: the plugins' inputs, in order of arrival. */
  private heldInputs: Array<() => void> | undefined;
  /** Lifecycle hooks run outside the turn queue; publishing is allowed while one runs. */
  private lifecycleDepth = 0;
  private inputSeq = 0;
  /** Tasks each plugin scheduled, cancelled when it stops. */
  private readonly pluginTasks = new Map<string, Set<TaskId>>();
  /** Per plugin: the logical time of its last id and how many it took then. */
  private readonly idCounters = new Map<string, { at: number; count: number }>();
  private readonly logger: PluginLogger;
  private readonly diagnostics: DiagnosticCollector;
  private readonly capabilityRegistry: CapabilityRegistry;
  private readonly eventBus: EventBus;
  private readonly temporal: TemporalService;
  private readonly spatial: SpatialService;
  private readonly stateStore: StateStore;
  private readonly serviceRegistry: ServiceRegistry;
  private readonly plugins = new Map<string, ManagedPlugin>();
  private readonly pluginSettings = new Map<string, PluginSettingsContext>();
  private dependencyGraph?: DepGraph<string>;
  private startOrder: string[] = [];
  private initializedOrder: string[] = [];
  private discoveredOnce = false;
  private running = false;
  private readonly eventDefinitions = new Map<string, EventDefinition>();
  private uiRegistry: UiRegistry = EMPTY_UI_REGISTRY;
  private readonly reportedUiProblems = new Set<string>();
  private readonly platform: HostPlatform;
  private readonly settingsFiles: AppFiles | undefined;
  private readonly hostObservations = new Map<string, Set<EventSubscription>>();

  constructor(options: PluginHostOptions) {
    this.sources = options.sources;
    this.platform = options.platform ?? UNKNOWN_PLATFORM;
    this.settingsFiles = options.settingsFiles;
    this.disabledPlugins = new Set(options.disabledPlugins ?? []);
    this.replayMode = options.replay !== undefined;
    this.continuing = options.continueFrom ? { file: options.continueFrom.file } : undefined;
    this.heldInputs = options.continueFrom ? [] : undefined;
    this.clock = options.replay
      ? new ReplayClock(options.replay.start)
      : new LiveClock({
          timeSource: options.timeSource,
          timers: options.timers,
          heldAt: options.continueFrom?.start,
        });
    this.runId = options.replay?.runId ?? options.continueFrom?.runId ?? randomRunId();
    this.clock.onError = (error, turn) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.diagnostics.report({
        code: 'event-handler-failure',
        message: `A ${turn} turn failed: ${reason}`,
        details: { turn },
      });
    };
    this.logger = options.logger ?? createSilentLogger();
    this.diagnostics = new DiagnosticCollector(this.logger);
    this.capabilityRegistry = new CapabilityRegistry();
    if (options.capabilities) {
      this.capabilityRegistry.registerContracts(options.capabilities);
    }
    this.registerEvents(options.events ?? []);
    this.eventBus = new EventBus({
      clock: this.clock,
      diagnostics: this.diagnostics,
      canPluginPublish: (pluginId) => {
        const managed = this.plugins.get(pluginId);
        return Boolean(managed?.publishingAllowed && managed.state === 'started');
      },
      inTurn: () => this.inTurn(),
      outsideTurn: (source, event, payload) => {
        const types = this.plugins.get(source)?.discovered.manifest.types ?? [];
        if (!types.some((type) => INPUT_SIDE_TYPES.has(type))) {
          throw new RidrsError(
            'outside-turn',
            `Plugin "${source}" published "${event.id}" outside a turn: results of asynchronous work enter through ctx.inputs`,
            { pluginId: source },
          );
        }
        this.acceptInput(source, event, payload, true);
      },
      runId: this.runId,
    });
    this.temporal = new TemporalService({
      clock: this.clock,
      diagnostics: this.diagnostics,
      isPluginActive: (pluginId) => this.plugins.get(pluginId)?.state === 'started',
      mayWrite: () => this.inTurn(),
    });
    this.spatial = new SpatialService({
      isPluginActive: (pluginId) => this.plugins.get(pluginId)?.state === 'started',
      mayWrite: () => this.inTurn(),
    });
    this.stateStore = new StateStore({
      report: (diagnostic) => this.diagnostics.report(diagnostic),
    });
    this.stateStore.register(options.states ?? []);
    this.serviceRegistry = new ServiceRegistry({ store: this.stateStore });
    this.serviceRegistry.register(options.services ?? []);
  }

  registerCapability(contract: CapabilityContract): void {
    this.capabilityRegistry.registerContract(contract);
  }

  registerCapabilities(contracts: Iterable<CapabilityContract>): void {
    this.capabilityRegistry.registerContracts(contracts);
  }

  registerEvents(definitions: Iterable<EventDefinition>): void {
    for (const definition of definitions) {
      this.eventDefinitions.set(definition.id, definition);
    }
  }

  getEventDefinition(eventId: string): EventDefinition | undefined {
    return this.eventDefinitions.get(eventId);
  }

  /**
   * An external input with an arbitrary source, e.g. a UI bridge acting for client code: validated
   * at once, published in its own turn after the tasks due by then.
   */
  publishEvent<TPayload, TType extends string>(
    source: string,
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
  ): void {
    this.acceptInput(source, event, payload, false);
  }

  /** Runs `run` as an input turn at the current time (composition roots and tests). */
  input(run: () => void): void {
    this.clock.enqueueInput(run);
  }

  /** Replay: queues a recorded input with its recorded time, id, source and payload. */
  injectInput(envelope: EventEnvelope, definition: EventDefinition): void {
    this.inputSeq += 1;
    // New input ids go on after the recorded ones (a continuing host, ADR 0057).
    const recorded = envelope.id.startsWith(`${this.runId}:in:`)
      ? Number(envelope.id.slice(this.runId.length + 4))
      : Number.NaN;
    if (Number.isInteger(recorded) && recorded > this.inputSeq) {
      this.inputSeq = recorded;
    }
    const inputSeq = this.inputSeq;
    this.clock.enqueueInput(
      () =>
        this.eventBus.publishInput(envelope.source, definition, envelope.payload, {
          inputSeq,
          receivedAt: envelope.receivedAt ?? envelope.timestamp,
          id: envelope.id,
        }),
      envelope.timestamp,
    );
  }

  /**
   * Replay, or a continuing host before `goLive()`: moves logical time to `time`, running every
   * task and input due by then.
   */
  advanceTo(time: number): void {
    if (
      this.clock instanceof ReplayClock ||
      (this.clock instanceof LiveClock && this.clock.isHeld())
    ) {
      this.clock.advanceTo(time);
      return;
    }
    throw new Error('advanceTo needs a replay host or a held continuing host');
  }

  /**
   * A continuing host goes live (ADR 0057): the clock follows its time source from now on, and
   * the plugins' inputs that waited enter now, in order.
   */
  goLive(): void {
    const waiting = this.heldInputs;
    if (!waiting || !(this.clock instanceof LiveClock)) {
      throw new Error('goLive needs a continuing host');
    }
    this.heldInputs = undefined;
    this.clock.release();
    for (const accept of waiting) {
      accept();
    }
  }

  /** Tasks scheduled on the host clock. */
  pendingTasks(): number {
    return this.clock.pendingTasks();
  }

  private inTurn(): boolean {
    return this.clock.inTurn() || this.lifecycleDepth > 0;
  }

  private acceptInput<TPayload, TType extends string>(
    source: string,
    event: EventDefinition<TPayload, TType>,
    payload: TPayload,
    fromPlugin: boolean,
  ): void {
    const data = this.eventBus.validate(source, event, payload);
    if (this.replayMode && fromPlugin) {
      // A replay host's own I/O: the recorded inputs stand in for it.
      return;
    }
    if (this.heldInputs && fromPlugin) {
      // A continuing host rebuilds the ride first: live I/O enters once it goes live.
      this.heldInputs.push(() => this.acceptInput(source, event, data, fromPlugin));
      return;
    }
    const at = this.clock.now();
    this.inputSeq += 1;
    const inputSeq = this.inputSeq;
    this.clock.enqueueInput(
      () => this.eventBus.publishInput(source, event, data, { inputSeq, receivedAt: at }),
      at,
    );
  }

  private async lifecycle<T>(run: () => Promise<T>): Promise<T> {
    this.lifecycleDepth += 1;
    try {
      return await run();
    } finally {
      this.lifecycleDepth -= 1;
    }
  }

  /** `ctx.clock`: the host clock, with the plugin's tasks owned by its context. */
  private createPluginClock(pluginId: string): Clock {
    const owned = (): Set<TaskId> => {
      let tasks = this.pluginTasks.get(pluginId);
      if (!tasks) {
        tasks = new Set();
        this.pluginTasks.set(pluginId, tasks);
      }
      return tasks;
    };
    return Object.freeze({
      now: () => this.clock.now(),
      scheduleAt: (timestamp: number, callback: () => void): TaskId => {
        const id: TaskId = this.clock.scheduleAt(timestamp, () => {
          owned().delete(id);
          callback();
        });
        owned().add(id);
        return id;
      },
      scheduleEvery: (interval: number, callback: () => void): TaskId => {
        const id = this.clock.scheduleEvery(interval, callback);
        owned().add(id);
        return id;
      },
      cancel: (taskId: TaskId): void => {
        owned().delete(taskId);
        this.clock.cancel(taskId);
      },
    });
  }

  private releasePluginTasks(pluginId: string): void {
    for (const id of this.pluginTasks.get(pluginId) ?? []) {
      this.clock.cancel(id);
    }
    this.pluginTasks.delete(pluginId);
  }

  /** Bus subscription owned by the composition root; it outlives plugin stops. */
  subscribeEvent<TPayload, TType extends string>(
    owner: string,
    event: EventDefinition<TPayload, TType>,
    handler: EventHandler<TPayload, TType>,
  ): EventSubscription {
    return this.eventBus.subscribeSystem(owner, event, handler);
  }

  reportDiagnostic(diagnostic: Diagnostic): void {
    this.diagnostics.report(diagnostic);
  }

  /**
   * Host-level tap owned by the composition root (a replay, a test): every envelope at publish
   * time in global publish order, and every diagnostic. Plugins get it as `ctx.host.observe`.
   */
  observe(owner: string, observer: HostObserver): EventSubscription {
    const events = this.eventBus.observe(owner, observer);
    const onDiagnostic = observer.onDiagnostic;
    const stopDiagnostics = onDiagnostic
      ? this.diagnostics.onReport((diagnostic) => onDiagnostic(diagnostic))
      : undefined;
    return {
      unsubscribe: () => {
        events.unsubscribe();
        stopDiagnostics?.();
      },
    };
  }

  /** The plugin set, its capability resolution and the core defaults that influence results. */
  describe(): HostDescription {
    const plugins = [...this.plugins.values()]
      .map(({ discovered, state }) => ({
        id: discovered.manifest.id,
        version: discovered.manifest.version,
        types: [...discovered.manifest.types],
        provides: [...discovered.manifest.provides],
        requires: [...discovered.manifest.requires],
        state,
      }))
      .filter((plugin) => !this.disabledPlugins.has(plugin.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      runId: this.runId,
      platform: { ...this.platform },
      plugins,
      disabledPlugins: [...this.disabledPlugins]
        .filter((id) => this.plugins.has(id))
        .sort((a, b) => a.localeCompare(b)),
      resolution: this.capabilityRegistry.resolution(),
      coreDefaults: { temporal: { ...TEMPORAL_DEFAULTS } },
      ...(this.continuing ? { continuing: { ...this.continuing } } : {}),
    };
  }

  /** The provider of a `single` capability, for composition roots (reading a journal, ADR 0057). */
  getProvider<TImpl>(contract: CapabilityContract<TImpl, 'single'>): TImpl | undefined {
    return this.capabilityRegistry.providersOf(contract.id)[0]?.implementation as TImpl | undefined;
  }

  /** The providers of a `multiple` capability, for composition roots; sorted by plugin id. */
  getProviders<TImpl>(
    contract: CapabilityContract<TImpl, 'multiple'>,
  ): readonly { readonly pluginId: string; readonly implementation: TImpl }[] {
    return this.capabilityRegistry.providersOf(contract.id) as readonly {
      readonly pluginId: string;
      readonly implementation: TImpl;
    }[];
  }

  getUiRegistry(): UiRegistry {
    return this.uiRegistry;
  }

  /**
   * The settings documents of a plugin that is currently in the UI registry, for its client code
   * (ADR 0059): the same documents, permissions and write order as its own `ctx.settings`.
   */
  getClientSettings(pluginId: string): PluginSettingsContext {
    const managed = this.plugins.get(pluginId);
    if (managed?.state !== 'started' || managed.discovered.manifest.ui?.client === undefined) {
      throw new Error(`Plugin "${pluginId}" has no client module in the UI registry`);
    }
    return this.settingsOf(managed.discovered.manifest);
  }

  /** One settings access per plugin, so its writes keep one order from wherever they come. */
  private settingsOf(manifest: Readonly<PluginManifest>): PluginSettingsContext {
    let settings = this.pluginSettings.get(manifest.id);
    if (!settings) {
      settings = createPluginSettings(
        manifest,
        () =>
          this.settingsFiles ??
          (this.capabilityRegistry.providersOf(storageAppFilesCapability.id)[0]?.implementation as
            | AppFiles
            | undefined),
        (diagnostic) => this.diagnostics.report(diagnostic),
      );
      this.pluginSettings.set(manifest.id, settings);
    }
    return settings;
  }

  /** Loads the client module of a plugin that is currently in the UI registry. */
  async loadClientModule(pluginId: string): Promise<unknown> {
    const managed = this.plugins.get(pluginId);
    const client = managed?.discovered.manifest.ui?.client;
    if (managed?.state !== 'started' || client === undefined) {
      throw new Error(`Plugin "${pluginId}" has no client module in the UI registry`);
    }
    return managed.discovered.candidate.loadModule(client);
  }

  async discover(): Promise<readonly PluginManifest[]> {
    const discoveredList = await discoverPlugins(this.sources, this.diagnostics);
    this.plugins.clear();
    this.pluginSettings.clear();
    for (const item of discoveredList) {
      this.plugins.set(item.manifest.id, {
        discovered: item,
        state: 'discovered',
        publishingAllowed: false,
        clientAvailable: false,
      });
    }
    this.discoveredOnce = true;
    return discoveredList.map((d) => d.manifest);
  }

  start(): Promise<void> {
    return this.lifecycle(() => this.startHosted());
  }

  private async startHosted(): Promise<void> {
    if (!this.discoveredOnce) {
      await this.discover();
    }

    const enabledDiscoveredList = [...this.plugins.values()]
      .filter((p) => !this.disabledPlugins.has(p.discovered.manifest.id))
      .map((p) => p.discovered);

    const resolution = resolveCapabilities(
      enabledDiscoveredList,
      this.capabilityRegistry.getContracts(),
      this.diagnostics,
      {
        states: new Set(this.stateStore.topicIds()),
        services: this.serviceRegistry.definitionsById(),
      },
    );

    this.dependencyGraph = resolution.dependencyGraph;
    this.startOrder = [...resolution.startOrder];
    this.initializedOrder = [];

    for (const blockedId of resolution.blockedPlugins) {
      const managed = this.plugins.get(blockedId);
      if (managed) {
        managed.state = 'blocked';
        this.logger.warn(
          { pluginId: blockedId, state: 'blocked' },
          `Plugin "${blockedId}" is blocked`,
        );
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

      const abortController = new AbortController();
      managed.abortController = abortController;
      managed.definition = definition;
      managed.context = this.createPluginContext(managed, abortController.signal);

      try {
        await definition.initialize?.(managed.context);
      } catch (error) {
        abortController.abort();
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
        this.releaseHostObservations(pluginId);
        this.releasePluginTasks(pluginId);
        this.temporal.releasePlugin(pluginId);
        this.spatial.releasePlugin(pluginId);
        this.releaseAppChannels(pluginId);
        this.failPluginAndBlockDependents(pluginId);
        continue;
      }

      // Verify all declared capabilities were provided during initialize.
      const missingProvided = managed.discovered.manifest.provides.find(
        (capId) => !this.capabilityRegistry.hasProvided(pluginId, capId),
      );
      if (missingProvided) {
        abortController.abort();
        this.diagnostics.report({
          code: 'capability-not-provided',
          pluginId,
          message: `Plugin "${pluginId}" did not provide declared capability "${missingProvided}" during initialize`,
          details: { capability: missingProvided },
        });
        this.capabilityRegistry.removeProvidersForPlugin(pluginId);
        this.eventBus.removeSubscriptionsForPlugin(pluginId);
        this.releaseHostObservations(pluginId);
        this.releasePluginTasks(pluginId);
        this.temporal.releasePlugin(pluginId);
        this.spatial.releasePlugin(pluginId);
        this.releaseAppChannels(pluginId);
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
      managed.clientAvailable = await this.checkClient(managed);

      try {
        await managed.definition?.start?.(managed.context);
        startedPlugins.push(pluginId);
      } catch (error) {
        managed.abortController?.abort();
        managed.publishingAllowed = false;
        const reason = error instanceof Error ? error.message : String(error);
        this.diagnostics.report({
          code: 'lifecycle-failure',
          pluginId,
          message: `Plugin "${pluginId}" failed in "start" hook: ${reason}`,
          details: { hook: 'start' },
        });
        this.eventBus.removeSubscriptionsForPlugin(pluginId);
        this.releaseHostObservations(pluginId);
        this.releasePluginTasks(pluginId);
        this.temporal.releasePlugin(pluginId);
        this.spatial.releasePlugin(pluginId);
        this.releaseAppChannels(pluginId);
        this.failPluginAndBlockDependents(pluginId);
      }
    }

    this.running = true;
    // Once for the whole start, so transient states (a contribution started before its screen) never surface.
    this.refreshUiRegistry();
    this.eventBus.publishSystemEvent('core.host', hostStartedEvent, {
      startedPlugins,
    });
  }

  stopPlugin(pluginId: string): Promise<void> {
    return this.lifecycle(() => this.stopPluginHosted(pluginId));
  }

  private async stopPluginHosted(pluginId: string): Promise<void> {
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
    this.refreshUiRegistry();
  }

  /** Starts a plugin again after `stopPlugin`, with a fresh context and abort signal. */
  startPlugin(pluginId: string): Promise<void> {
    return this.lifecycle(() => this.startPluginHosted(pluginId));
  }

  private async startPluginHosted(pluginId: string): Promise<void> {
    const managed = this.plugins.get(pluginId);
    if (managed?.state !== 'stopped' || !managed.definition) {
      return;
    }
    const abortController = new AbortController();
    managed.abortController = abortController;
    managed.context = this.createPluginContext(managed, abortController.signal);
    managed.state = 'started';
    managed.publishingAllowed = true;
    managed.clientAvailable = await this.checkClient(managed);
    try {
      await managed.definition.start?.(managed.context);
    } catch (error) {
      abortController.abort();
      managed.publishingAllowed = false;
      const reason = error instanceof Error ? error.message : String(error);
      this.diagnostics.report({
        code: 'lifecycle-failure',
        pluginId,
        message: `Plugin "${pluginId}" failed in "start" hook: ${reason}`,
        details: { hook: 'start' },
      });
      this.eventBus.removeSubscriptionsForPlugin(pluginId);
      this.releaseHostObservations(pluginId);
      this.releasePluginTasks(pluginId);
      this.temporal.releasePlugin(pluginId);
      this.spatial.releasePlugin(pluginId);
      this.releaseAppChannels(pluginId);
      this.failPluginAndBlockDependents(pluginId);
    }
    this.refreshUiRegistry();
  }

  stop(): Promise<void> {
    return this.lifecycle(() => this.stopHosted());
  }

  private async stopHosted(): Promise<void> {
    const reverseOrder = [...this.startOrder].reverse();
    for (const pluginId of reverseOrder) {
      await this.stopSinglePlugin(pluginId);
    }
    this.refreshUiRegistry();
    this.eventBus.removeAllSubscriptions();
    this.running = false;
  }

  dispose(): Promise<void> {
    return this.lifecycle(() => this.disposeHosted());
  }

  private async disposeHosted(): Promise<void> {
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
        this.releaseHostObservations(pluginId);
        this.releasePluginTasks(pluginId);
        this.temporal.releasePlugin(pluginId);
        this.spatial.releasePlugin(pluginId);
        this.releaseAppChannels(pluginId);
      }
    }
    if (this.clock instanceof LiveClock) {
      this.clock.dispose();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The host's logical time (epoch ms). */
  now(): number {
    return this.clock.now();
  }

  /** `<runId>:<plugin>:<logical time>:<k>`: unique within the run and the same on replay. */
  private nextId(pluginId: string): string {
    const at = this.clock.now();
    const counter = this.idCounters.get(pluginId);
    const count = counter?.at === at ? counter.count + 1 : 0;
    this.idCounters.set(pluginId, { at, count });
    return `${this.runId}:${pluginId}:${at}:${count}`;
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

    managed.abortController?.abort();
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
      managed.publishingAllowed = false;
      this.eventBus.removeSubscriptionsForPlugin(pluginId);
      this.releaseHostObservations(pluginId);
      this.releasePluginTasks(pluginId);
      this.temporal.releasePlugin(pluginId);
      this.spatial.releasePlugin(pluginId);
      this.releaseAppChannels(pluginId);
    }
  }

  /** A stopped plugin's app state keys go, and so do its watches and services (ADR 0068). */
  private releaseAppChannels(pluginId: string): void {
    this.stateStore.releasePlugin(pluginId);
    this.serviceRegistry.releasePlugin(pluginId);
  }

  /** The current entries of an app state topic (composition roots, tests). */
  getState(topicId: string): ReadonlyMap<string, unknown> {
    return this.stateStore.entries(topicId);
  }

  /** Calls a service for a composition root or a bridge; `ui-bridge` calls for UI clients. */
  callService(
    serviceId: string,
    request: unknown,
    caller: ServiceCaller = { pluginId: 'core.host' },
  ): Promise<unknown> {
    return this.serviceRegistry.call(serviceId, request, caller);
  }

  /**
   * A service the composition root provides itself (ADR 0069), e.g. continuing a ride, which only
   * the root can do. Kept until the host is disposed; a second provider of a service without a
   * key is refused (`ambiguous-service`).
   */
  provideService<Req, Res>(
    owner: string,
    service: ServiceDefinition<Req, Res>,
    handler: ServiceHandler<Req, Res>,
  ): void {
    this.serviceRegistry.provide(owner, service, handler);
  }

  /** Every app state write as it happens, read-only (composition roots, tests). */
  observeState(owner: string, observer: StateObserver): EventSubscription {
    return this.stateStore.observe(owner, observer);
  }

  /** Every finished service call with its answer or error, read-only (composition roots, tests). */
  observeCalls(_owner: string, observer: ServiceCallObserver): EventSubscription {
    return this.serviceRegistry.observe(observer);
  }

  /** A topic's snapshot, then its changed keys, coalesced: what a UI bridge forwards. */
  watchState(
    owner: string,
    topicId: string,
    listener: (view: StateView<unknown>) => void,
  ): EventSubscription {
    return this.stateStore.watch(owner, topicId, listener);
  }

  /** `ctx.state` and `ctx.services`: input-side types only, as the manifest declares. */
  private createAppChannels(managed: ManagedPlugin): Pick<PluginContext, 'state' | 'services'> {
    const manifest = managed.discovered.manifest;
    const pluginId = manifest.id;
    const denied = (call: string): RidrsError | undefined =>
      manifest.types.some((type) => APP_CHANNEL_TYPES.includes(type))
        ? undefined
        : new RidrsError(
            'permission-denied',
            `Plugin "${pluginId}" called "${call}": only plugins of the types ${APP_CHANNEL_TYPES.join(', ')} use app state and services`,
            { pluginId },
          );
    const assertState = (call: string, topicId: string, declared: readonly string[]): void => {
      const error = denied(`ctx.state.${call}`);
      if (error) {
        throw error;
      }
      if (!declared.includes(topicId)) {
        throw new RidrsError(
          'undeclared-state',
          `Plugin "${pluginId}" did not declare "${topicId}" for "ctx.state.${call}" in its manifest`,
          { pluginId },
        );
      }
    };
    // A stopped plugin's keys are gone; late work of it (a download) cannot bring them back.
    const assertStarted = (call: string, topicId: string): void => {
      if (managed.state !== 'started') {
        throw new RidrsError(
          'plugin-not-active',
          `Plugin "${pluginId}" cannot call "ctx.state.${call}" on "${topicId}" because it is not started`,
          { pluginId },
        );
      }
    };
    const owns = manifest.state?.owns ?? [];
    const readable = [...owns, ...(manifest.state?.watches ?? [])];
    const state: PluginStateContext = Object.freeze({
      set: <T>(topic: StateDefinition<T>, key: string, value: T): void => {
        assertState('set', topic.id, owns);
        assertStarted('set', topic.id);
        this.stateStore.set(pluginId, topic.id, key, value);
      },
      remove: (topic: StateDefinition, key: string): void => {
        assertState('remove', topic.id, owns);
        assertStarted('remove', topic.id);
        this.stateStore.remove(pluginId, topic.id, key);
      },
      get: <T>(topic: StateDefinition<T>, key: string): T | undefined => {
        assertState('get', topic.id, readable);
        return this.stateStore.get(topic.id, key) as T | undefined;
      },
      entries: <T>(topic: StateDefinition<T>): ReadonlyMap<string, T> => {
        assertState('entries', topic.id, readable);
        return this.stateStore.entries(topic.id) as ReadonlyMap<string, T>;
      },
      watch: <T>(
        topic: StateDefinition<T>,
        listener: (view: StateView<T>) => void,
      ): EventSubscription => {
        assertState('watch', topic.id, manifest.state?.watches ?? []);
        return this.stateStore.watch(
          pluginId,
          topic.id,
          listener as (view: StateView<unknown>) => void,
        );
      },
    });
    const undeclared = (call: string, serviceId: string, field: string): RidrsError =>
      new RidrsError(
        'undeclared-service',
        `Plugin "${pluginId}" did not declare "${serviceId}" in services.${field} for "ctx.services.${call}"`,
        { pluginId },
      );
    const services: PluginServicesContext = Object.freeze({
      provide: <Req, Res>(
        service: ServiceDefinition<Req, Res>,
        handler: ServiceHandler<Req, Res>,
      ): void => {
        const error =
          denied('ctx.services.provide') ??
          (manifest.services?.provides.includes(service.id)
            ? undefined
            : undeclared('provide', service.id, 'provides'));
        if (error) {
          throw error;
        }
        this.serviceRegistry.provide(pluginId, service, handler);
      },
      call: async <Req, Res>(service: ServiceDefinition<Req, Res>, request: Req): Promise<Res> => {
        const error =
          denied('ctx.services.call') ??
          (manifest.services?.calls.includes(service.id)
            ? undefined
            : undeclared('call', service.id, 'calls'));
        if (error) {
          throw error;
        }
        return (await this.serviceRegistry.call(service.id, request, { pluginId })) as Res;
      },
    });
    return { state, services };
  }

  private createPluginContext(managed: ManagedPlugin, signal: AbortSignal): PluginContext {
    const manifest = managed.discovered.manifest;
    return Object.freeze({
      manifest,
      logger: this.logger.child({ pluginId: manifest.id }),
      clock: this.createPluginClock(manifest.id),
      events: this.eventBus.createPluginEventsContext(manifest.id),
      inputs: Object.freeze({
        accept: <TPayload, TType extends string>(
          event: EventDefinition<TPayload, TType>,
          payload: TPayload,
        ): void => {
          if (!(managed.publishingAllowed && managed.state === 'started')) {
            throw new RidrsError(
              'plugin-not-active',
              `Plugin "${manifest.id}" cannot accept input "${event.id}" because it is not started`,
              { pluginId: manifest.id },
            );
          }
          this.acceptInput(manifest.id, event, payload, true);
        },
      }),
      ids: Object.freeze({ next: () => this.nextId(manifest.id) }),
      capabilities: this.capabilityRegistry.createPluginCapabilitiesContext(manifest),
      // Writers are handed out while the plugin initializes; its state is still 'discovered'.
      temporal: this.temporal.createPluginTemporalContext(
        manifest,
        () => managed.state === 'discovered',
      ),
      spatial: this.spatial.createPluginSpatialContext(
        manifest,
        () => managed.state === 'discovered',
      ),
      signal,
      ui: Object.freeze({ registry: () => this.uiRegistry }),
      host: this.createHostAccess(managed),
      settings: this.settingsOf(manifest),
      ...this.createAppChannels(managed),
      reportDiagnostic: (
        code: DiagnosticCode,
        message: string,
        details?: Readonly<Record<string, unknown>>,
      ): void => {
        this.diagnostics.report({
          code,
          pluginId: manifest.id,
          message,
          details,
        });
      },
    });
  }

  /** `ctx.host`, enforcing the manifest permission `observe-host` on every call. */
  private createHostAccess(managed: ManagedPlugin): PluginContext['host'] {
    const manifest = managed.discovered.manifest;
    const assertPermitted = (call: string): void => {
      if (!manifest.permissions?.includes('observe-host')) {
        throw new RidrsError(
          'permission-denied',
          `Plugin "${manifest.id}" called "ctx.host.${call}" without the permission "observe-host"`,
          { pluginId: manifest.id },
        );
      }
    };
    return Object.freeze({
      observe: (observer: HostObserver): EventSubscription => {
        assertPermitted('observe');
        const subscription = this.observe(manifest.id, observer);
        const owned = this.hostObservations.get(manifest.id) ?? new Set<EventSubscription>();
        owned.add(subscription);
        this.hostObservations.set(manifest.id, owned);
        return {
          unsubscribe: () => {
            owned.delete(subscription);
            subscription.unsubscribe();
          },
        };
      },
      describe: (): HostDescription => {
        assertPermitted('describe');
        return this.describe();
      },
    });
  }

  /** Observations end with the plugin, like its subscriptions. */
  private releaseHostObservations(pluginId: string): void {
    for (const subscription of this.hostObservations.get(pluginId) ?? []) {
      subscription.unsubscribe();
    }
    this.hostObservations.delete(pluginId);
  }

  private async loadPluginEntry(managed: ManagedPlugin): Promise<PluginDefinition | undefined> {
    const pluginId = managed.discovered.manifest.id;
    try {
      const imported = (await managed.discovered.candidate.loadModule(
        managed.discovered.manifest.entry,
      )) as { default?: unknown };
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

  private async checkClient(managed: ManagedPlugin): Promise<boolean> {
    const client = managed.discovered.manifest.ui?.client;
    if (client === undefined) {
      return false;
    }
    return managed.discovered.candidate.hasModule(client).catch(() => false);
  }

  /** Recomputes the UI registry from the started plugins and announces it if it changed. */
  private refreshUiRegistry(): void {
    const inputs = [...this.plugins.values()].flatMap((managed) => {
      const ui = managed.discovered.manifest.ui;
      return managed.state === 'started' && ui
        ? [
            {
              pluginId: managed.discovered.manifest.id,
              ui,
              clientAvailable: managed.clientAvailable,
            },
          ]
        : [];
    });
    const { registry, problems } = computeUiRegistry(inputs);

    for (const problem of problems) {
      const key = `${problem.code}|${problem.pluginId}|${problem.message}`;
      if (!this.reportedUiProblems.has(key)) {
        this.reportedUiProblems.add(key);
        this.diagnostics.report(problem);
      }
    }

    const { revision: _previous, ...previous } = this.uiRegistry;
    if (JSON.stringify(previous) === JSON.stringify(registry)) {
      return;
    }
    this.uiRegistry = Object.freeze({ revision: this.uiRegistry.revision + 1, ...registry });
    this.eventBus.publishSystemEvent('core.host', uiRegistryChangedEvent, {
      revision: this.uiRegistry.revision,
    });
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
        this.releaseHostObservations(depId);
        this.releasePluginTasks(depId);
        this.temporal.releasePlugin(depId);
        this.spatial.releasePlugin(depId);
        this.releaseAppChannels(depId);
        this.logger.warn({ pluginId: depId, state: 'blocked' }, `Plugin "${depId}" is blocked`);
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
