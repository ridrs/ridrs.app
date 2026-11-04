// SPDX-License-Identifier: AGPL-3.0-or-later

// The proof of deterministic replay: a live host whose clock wakes late, whose turns take time,
// whose BLE notifications arrive asynchronously at jittered times and whose heart-rate source
// sends late and out-of-order measurements. Its recording must replay to identical results.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as contracts from '@ridrs/contracts';
import {
  type ActivityState,
  activityFinishRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  bleCentralCapability,
  type CapabilityContract,
  definePlugin,
  type EventDefinition,
  measurementHeartRateEvent,
  type PhysicsStateBatch,
  type PluginContext,
  physicsStateBatchEvent,
  recordingCompletedEvent,
  storageAppFilesCapability,
  uiTerrainObservedEvent,
} from '@ridrs/contracts';
import {
  createBundledPluginSource,
  createSilentLogger,
  PluginHost,
  type TimerPort,
} from '@ridrs/core';
import { readRecording } from '@ridrs/recording';
import { replay } from '@ridrs/replay';
import { BleSimulator, MemoryAppFiles } from '@ridrs/testing';
import { describe, expect, it } from 'vitest';
import { DEMO_LANDSCAPE } from '../../plugins/ui-landscape-demo/client/landscape-model.ts';
import { TerrainPublisher } from '../../plugins/ui-landscape-demo/client/terrain-publisher.ts';

const PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);
const PLUGINS = [
  'activity-session',
  'device-ftms-trainer',
  'metric-power',
  'metric-cadence',
  'metric-heart-rate',
  'metric-power-heart-rate-ratio',
  'recording-session',
  'physics-engine',
  'physics-bicycle',
  'physics-rider',
  'physics-rolling-resistance',
  'physics-aerodynamics',
  'physics-gravity-resistance',
  'physics-environment',
  'spatial-terrain',
  'world-driver-ui',
  'physics-total-resistance',
  'physics-powertrain',
  'physics-virtual-speed',
];

const capabilities = (Object.values(contracts) as unknown[]).filter(
  (v): v is CapabilityContract => typeof v === 'object' && v !== null && 'cardinality' in v,
);
const events = (Object.values(contracts) as unknown[]).filter(
  (v): v is EventDefinition => typeof v === 'object' && v !== null && 'schema' in v && 'id' in v,
);

/** mulberry32: a seeded PRNG, so a failing seed can be rerun. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bundle(simulator: BleSimulator, files: MemoryAppFiles) {
  const manifests: Record<string, string> = {};
  const modules: Record<string, () => Promise<unknown>> = {};
  for (const id of PLUGINS) {
    manifests[`plugins/${id}/manifest.json`] = readFileSync(
      resolve(PLUGINS_DIR, id, 'manifest.json'),
      'utf8',
    );
    modules[`plugins/${id}/index.ts`] = () => import(`../../plugins/${id}/index.ts`);
  }
  const fixture = (id: string, types: string[], provides: string[], plugin: unknown) => {
    manifests[`fixtures/${id}/manifest.json`] = JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      types,
      provides,
      requires: [],
      entry: 'index.ts',
    });
    modules[`fixtures/${id}/index.ts`] = async () => ({ default: plugin });
  };
  fixture(
    'sim-central',
    ['transport'],
    ['ble.central'],
    definePlugin({
      initialize: (ctx) => ctx.capabilities.provide(bleCentralCapability, simulator),
    }),
  );
  fixture(
    'memory-storage',
    ['storage'],
    ['storage.app-files'],
    definePlugin({
      initialize: (ctx) => ctx.capabilities.provide(storageAppFilesCapability, files),
    }),
  );
  // A heart-rate source that sends device timestamps: sometimes late, sometimes out of order.
  fixture('test-hrm', ['device'], [], definePlugin({}));
  return createBundledPluginSource({ manifests, modules });
}

/** A live ride with an unruly event loop; returns the recording. */
async function rideLive(seed: number): Promise<Uint8Array> {
  const rnd = random(seed);
  let now = T0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const port: TimerPort = {
    // Every wake-up comes 0-6 ms late.
    setTimeout: (callback, delay) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delay + Math.floor(rnd() * 7), callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const simulator = new BleSimulator({ clock: { now: () => now } });
  const files = new MemoryAppFiles();
  const host = new PluginHost({
    sources: [bundle(simulator, files)],
    timeSource: { now: () => now },
    timers: port,
    logger: createSilentLogger(),
    capabilities,
    events,
  });
  // Turns take time: the source advances while the host computes.
  host.observe('computing', {
    onEvent: () => {
      if (rnd() < 0.2) {
        now += 1;
      }
    },
  });
  let file: string | undefined;
  host.observe('done', {
    onEvent: (e) => {
      if (e.type === recordingCompletedEvent.id) {
        file = (e.payload as { file: string }).file;
      }
    },
  });
  // The UI landscape as a sensor: its real publisher, fed with the odometer it would present
  // (the latest batch), publishing through the bridge like the in-process UI bridge does.
  const landscape = new TerrainPublisher(DEMO_LANDSCAPE, ({ samples, ...window }) =>
    host.publishEvent('ui-bridge', uiTerrainObservedEvent, { ...window, samples: [...samples] }),
  );
  let presented: PhysicsStateBatch | undefined;
  host.observe('landscape', {
    onEvent: (e) => {
      if (e.type === activityStateChangedEvent.id) {
        landscape.rideState(e.payload as ActivityState);
      } else if (e.type === physicsStateBatchEvent.id) {
        presented = e.payload as PhysicsStateBatch;
      }
    },
  });
  await host.start();
  const trainer = simulator.addFtmsTrainer('SIM KICKR');
  const hrm = host.getPluginContext('test-hrm') as PluginContext;

  // External events, at jittered times.
  type Arrival = { at: number; deliver: () => void };
  const arrivals: Arrival[] = [];
  for (let at = T0 + 300; at < T0 + 40_000; at += 250) {
    const watts = 150 + Math.floor(rnd() * 150);
    const halfRpm = 160 + Math.floor(rnd() * 40);
    const packet = Uint8Array.of(0x45, 0, halfRpm & 0xff, halfRpm >> 8, watts & 0xff, watts >> 8);
    arrivals.push({
      at: at + Math.floor(rnd() * 30),
      deliver: () => trainer.notifyIndoorBikeData(packet),
    });
  }
  let lastMeasured = T0;
  for (let at = T0 + 500; at < T0 + 40_000; at += 1000) {
    // Device time: usually ~40 ms before arrival, every so often older than the last one.
    const measuredAt = rnd() < 0.15 ? lastMeasured - 200 : at - 40;
    lastMeasured = Math.max(lastMeasured, measuredAt);
    const value = 130 + Math.floor(rnd() * 30);
    arrivals.push({
      at,
      deliver: () =>
        hrm.inputs.accept(measurementHeartRateEvent, {
          deviceId: 'hrm-1',
          value,
          measuredAt,
          receivedAt: now,
          timestampOrigin: 'device',
        }),
    });
  }
  arrivals.push({
    at: T0 + 10_003,
    deliver: () => host.publishEvent('ui-bridge', activityStartRequestedEvent, {}),
  });
  // The landscape is mounted a frame after the ride started, then draws a frame every 17 ms.
  arrivals.push({ at: T0 + 10_020, deliver: () => landscape.mount() });
  for (let at = T0 + 10_037; at < T0 + 38_000; at += 17) {
    arrivals.push({
      at,
      deliver: () => {
        const sample = presented?.samples.at(-1);
        if (presented && sample) {
          landscape.frame({
            status: 'available',
            renderTime: at,
            basis: 'held',
            sessionId: presented.sessionId,
            ...sample,
          });
        }
      },
    });
  }
  arrivals.push({
    at: T0 + 38_000,
    deliver: () => host.publishEvent('ui-bridge', activityFinishRequestedEvent, {}),
  });
  arrivals.sort((a, b) => a.at - b.at);

  // The event loop: whatever is due next runs, after letting promise chains settle.
  const flush = () => new Promise((r) => setImmediate(r));
  while (arrivals.length > 0 || [...timers.values()].some((t) => t.at <= T0 + 40_000)) {
    const timer = [...timers.entries()].sort(([, a], [, b]) => a.at - b.at)[0];
    const arrival = arrivals[0];
    if (arrival && (!timer || arrival.at <= timer[1].at)) {
      arrivals.shift();
      now = Math.max(now, arrival.at);
      // Asynchronous delivery: the callback runs a few promise hops later.
      await Promise.resolve();
      arrival.deliver();
    } else if (timer) {
      timers.delete(timer[0]);
      now = Math.max(now, timer[1].at);
      timer[1].callback();
    }
    await flush();
  }
  // Compression runs on real I/O turns.
  for (let i = 0; i < 5000 && !file; i += 1) {
    await flush();
  }
  await host.dispose();
  expect(file, 'the recording was completed').toBeDefined();
  return files.files.get(file as string) as Uint8Array;
}

describe('live recording and replay', () => {
  it.each([1, 2, 3])(
    'replays a live ride with late wake-ups and jittered input identically (seed %i)',
    async (seed) => {
      const recording = await readRecording(await rideLive(seed), { events });
      const options = {
        sources: [bundle(new BleSimulator(), new MemoryAppFiles())],
        capabilities,
        events,
      };
      const first = await replay(recording, options);
      expect(first.firstDifference).toBeUndefined();
      expect(first.identical).toBe(true);
      const compared = new Set(first.streams.filter((s) => s.recorded > 0).map((s) => s.type));
      for (const type of [
        'device.raw-notification',
        'measurement.power',
        'metric.power',
        'metric.heart-rate',
        'metric.power-heart-rate-ratio',
        'physics.state',
        'physics.state-batch',
      ]) {
        expect(compared, type).toContain(type);
      }
      // The terrain the landscape observed came in as inputs and was injected on replay.
      const terrain = first.inputs.filter((input) => input.type === 'world.terrain-preview');
      expect(terrain.reduce((sum, input) => sum + input.count, 0)).toBeGreaterThan(1);
      expect(recording.diagnostics.filter((d) => d.code.startsWith('terrain-preview'))).toEqual([]);
      // Late heart-rate measurements were rejected live, and the same way on replay.
      expect(recording.diagnostics.some((d) => d.code === 'late-measurement')).toBe(true);
      expect(await replay(recording, options)).toEqual(first);
    },
    60_000,
  );
});
