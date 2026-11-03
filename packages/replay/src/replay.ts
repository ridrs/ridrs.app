// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  bleCentralCapability,
  type CapabilityContract,
  configSnapshotCapability,
  defineEvent,
  definePlugin,
  deviceConnectionChangedEvent,
  type EventDefinition,
  type EventEnvelope,
  type HostDescription,
  type JsonValue,
  type PluginLogger,
  type RecordedEnvelope,
} from '@ridrs/contracts';
import {
  createBundledPluginSource,
  createSilentLogger,
  DiagnosticCollector,
  discoverPlugins,
  PluginHost,
  type PluginSource,
} from '@ridrs/core';
import { buildConfigSnapshot, type Recording } from '@ridrs/recording';
import diff from 'microdiff';
import { z } from 'zod';
import { type Comparison, compare, type Difference, type StreamComparison } from './compare.ts';

/**
 * The host-provided stand-in for the transports: a `ble.central` that finds nothing. Device
 * plugins start as live, but their own I/O is dropped; the recorded inputs replace it.
 */
export const REPLAY_CENTRAL_PLUGIN = 'replay-ble-central';

const inertCentral: BleCentral = {
  scan: (options) => ({
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) => {
          const done = () => resolve({ value: undefined, done: true });
          if (options.signal?.aborted) {
            done();
          }
          options.signal?.addEventListener('abort', done, { once: true });
        }),
    }),
  }),
  connect: async () => {
    throw new Error('A replay connects to nothing: it injects the recorded inputs');
  },
};

/**
 * Plugins a replay leaves out, by manifest type: transports (the replay central stands in),
 * storage, the recorder and the exporter (a replay writes nothing) and UI plugins.
 */
const NOT_REPLAYED_TYPES = new Set(['transport', 'storage', 'recording', 'export', 'ui']);

export interface ReplayOptions {
  /** The current plugin directories (or bundles). */
  readonly sources: readonly PluginSource[];
  readonly capabilities: Iterable<CapabilityContract>;
  /** Event types the replay knows: inputs of other types are republished opaquely. */
  readonly events: Iterable<EventDefinition>;
  /** Recorded plugin id -> the plugin to replay instead (e.g. a probe). */
  readonly replace?: Readonly<Record<string, string>>;
  readonly logger?: PluginLogger;
}

export interface SectionDifference {
  readonly section: string;
  readonly change: 'missing' | 'added' | 'differs';
  /** JSON paths of the differing values. */
  readonly paths: readonly string[];
}

/** Reported, never applied: there is no configuration mechanism yet. */
export interface ConfigurationDifferences {
  readonly versionChanges: readonly {
    readonly plugin: string;
    readonly recorded: string;
    readonly current: string;
  }[];
  readonly missingPlugins: readonly string[];
  readonly addedPlugins: readonly string[];
  readonly sections: readonly SectionDifference[];
}

export interface ReplayResult extends Comparison {
  readonly configuration: ConfigurationDifferences;
  /** Recorded input events republished, per type and source. */
  readonly inputs: readonly {
    readonly type: string;
    readonly source: string;
    readonly count: number;
  }[];
  /** Records of kinds this reader does not know, by kind. */
  readonly ignoredRecordKinds: Readonly<Record<string, number>>;
  /** Logical time the replay covered. */
  readonly virtualMs: number;
}

export { type Comparison, compare, type Difference, type StreamComparison };

interface RecordedPlugin {
  readonly id: string;
  readonly version: string;
  readonly types: readonly string[];
  readonly state: string;
}

function isLifecycle(type: string): boolean {
  return type.startsWith('core.') || type === deviceConnectionChangedEvent.id;
}

function pathOf(segments: readonly (string | number)[]): string {
  return segments
    .map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? s : `.${s}`))
    .join('');
}

function configurationDifferences(
  recorded: readonly RecordedPlugin[],
  recordedSections: Readonly<Record<string, JsonValue>>,
  current: HostDescription,
  currentSections: Readonly<Record<string, JsonValue>>,
  excluded: ReadonlySet<string>,
): ConfigurationDifferences {
  const before = new Map(recorded.map((p) => [p.id, p.version]));
  const after = new Map(
    current.plugins
      .filter((p) => p.state === 'started' && p.id !== REPLAY_CENTRAL_PLUGIN && !excluded.has(p.id))
      .map((p) => [p.id, p.version]),
  );
  const sections: SectionDifference[] = [];
  const sectionIds = [
    ...new Set([...Object.keys(recordedSections), ...Object.keys(currentSections)]),
  ].sort();
  for (const section of sectionIds) {
    if (excluded.has(section)) {
      continue;
    }
    const a = recordedSections[section];
    const b = currentSections[section];
    if (a === undefined) {
      sections.push({ section, change: 'added', paths: [] });
    } else if (b === undefined) {
      sections.push({ section, change: 'missing', paths: [] });
    } else {
      const paths =
        a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
          ? diff(a as Record<string, unknown>, b as Record<string, unknown>).map((d) =>
              pathOf(d.path),
            )
          : JSON.stringify(a) === JSON.stringify(b)
            ? []
            : [''];
      if (paths.length > 0) {
        sections.push({ section, change: 'differs', paths });
      }
    }
  }
  return {
    versionChanges: [...before]
      .filter(([id, version]) => after.has(id) && after.get(id) !== version)
      .map(([plugin, version]) => ({ plugin, recorded: version, current: after.get(plugin) ?? '' }))
      .sort((a, b) => a.plugin.localeCompare(b.plugin)),
    missingPlugins: [...before.keys()].filter((id) => !after.has(id)).sort(),
    addedPlugins: [...after.keys()].filter((id) => !before.has(id)).sort(),
    sections,
  };
}

/**
 * Replays a recorded ride through the current plugins: the recorded plugin set (without transports,
 * storage, recorder, exporter and UI) on a virtual clock, fed with the recorded device bytes and the
 * recorded rider input at their recorded times. Compares every derived event of the ride with the
 * recording, and the configuration with the recorded snapshot.
 */
export async function replay(recording: Recording, options: ReplayOptions): Promise<ReplayResult> {
  const { header, snapshot } = recording;
  const endedAt = recording.footer?.endedAt ?? header.startedAt;
  const recordedHost = snapshot.host as unknown as HostDescription;
  const recordedPlugins: RecordedPlugin[] = (recordedHost.plugins ?? []).map((p) => ({
    id: p.id,
    version: p.version,
    types: p.types,
    state: p.state,
  }));
  const allRecordedIds = new Set(recordedPlugins.map((p) => p.id));
  const excluded = new Set(
    recordedPlugins.filter((p) => p.types.some((t) => NOT_REPLAYED_TYPES.has(t))).map((p) => p.id),
  );
  const replace = options.replace ?? {};
  const recordedSet = recordedPlugins.filter((p) => p.state === 'started' && !excluded.has(p.id));
  const replaySet = new Set(recordedSet.map((p) => replace[p.id] ?? p.id));

  // The plugin directories as they are now: everything not in the replay set is disabled.
  const discovered = await discoverPlugins(
    options.sources,
    new DiagnosticCollector(createSilentLogger()),
  );
  const disabledPlugins = discovered.map((p) => p.manifest.id).filter((id) => !replaySet.has(id));

  const events = recording.events;
  const definitions = new Map([...options.events].map((d) => [d.id, d] as const));
  // Inputs: what entered the recorded host through its input queue. Recordings from before the
  // queue carry no flag: there, anything from outside the recorded plugins counts.
  const flagged = events.some((e) => e.envelope.input === true);
  const inputs = events.filter((e) =>
    flagged
      ? e.envelope.input === true
      : !allRecordedIds.has(e.envelope.source) && !isLifecycle(e.envelope.type),
  );
  const inputCounts = new Map<string, number>();
  for (const { envelope } of inputs) {
    const key = JSON.stringify([envelope.type, envelope.source]);
    inputCounts.set(key, (inputCounts.get(key) ?? 0) + 1);
  }

  const startAt = Math.min(header.startedAt, events[0]?.envelope.timestamp ?? header.startedAt);
  const centralSource = createBundledPluginSource({
    manifests: {
      [`replay/${REPLAY_CENTRAL_PLUGIN}/manifest.json`]: JSON.stringify({
        id: REPLAY_CENTRAL_PLUGIN,
        name: 'Replay BLE Central',
        version: '0.1.0',
        types: ['transport'],
        provides: ['ble.central'],
        requires: [],
        entry: 'index.ts',
      }),
    },
    modules: {
      [`replay/${REPLAY_CENTRAL_PLUGIN}/index.ts`]: async () => ({
        default: definePlugin({
          initialize(ctx) {
            ctx.capabilities.provide(bleCentralCapability, inertCentral);
          },
        }),
      }),
    },
  });
  // The same host and turn queue as live, on a replay clock and with the recorded run id.
  const host = new PluginHost({
    sources: [...options.sources, centralSource],
    disabledPlugins,
    replay: { start: startAt, runId: header.runId },
    logger: options.logger ?? createSilentLogger(),
    capabilities: options.capabilities,
    events: definitions.values(),
    platform: recordedHost.platform,
  });
  const replayed: RecordedEnvelope[] = [];
  // The recorder's tap; serialized like the recorder does, so both sides went through JSON.
  host.observe('replay', {
    onEvent: (envelope: EventEnvelope) => {
      const { id, type, source, timestamp, payload } = envelope;
      replayed.push(JSON.parse(JSON.stringify({ id, type, source, timestamp, payload })));
    },
  });
  try {
    await host.start();
    for (const { envelope } of inputs) {
      host.injectInput(
        envelope as EventEnvelope,
        definitions.get(envelope.type) ?? defineEvent(envelope.type, z.unknown()),
      );
    }
    host.advanceTo(endedAt);

    const currentHost = host.describe();
    const currentSections = buildConfigSnapshot(
      currentHost,
      host.getProviders(configSnapshotCapability).map((p) => p.implementation),
    ).sections;
    const configuration = configurationDifferences(
      recordedSet,
      snapshot.sections as Readonly<Record<string, JsonValue>>,
      currentHost,
      currentSections,
      excluded,
    );

    const pluginSources = new Set([...allRecordedIds, ...replaySet]);
    const comparison = compare(
      events.map((e) => e.envelope),
      replayed,
      {
        from: header.startedAt,
        to: endedAt,
        compared: (type, source) =>
          pluginSources.has(source) &&
          !excluded.has(source) &&
          source !== REPLAY_CENTRAL_PLUGIN &&
          !isLifecycle(type),
        // Ids derive from the run id: comparable once the recording carries it.
        ids: header.runId !== undefined,
      },
    );

    return {
      ...comparison,
      configuration,
      inputs: [...inputCounts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => {
          const [type, source] = JSON.parse(key) as [string, string];
          return { type, source, count };
        }),
      ignoredRecordKinds: { ...recording.ignoredKinds },
      virtualMs: endedAt - startAt,
    };
  } finally {
    await host.dispose().catch(() => undefined);
  }
}
