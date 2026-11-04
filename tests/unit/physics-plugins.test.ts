// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activityStartRequestedEvent,
  type CapabilityContract,
  configSnapshotCapability,
  measurementPowerEvent,
  metricPowerCapability,
  type PhysicsState,
  type PluginContext,
  type PluginDefinition,
  physicsBicycleCapability,
  physicsEnvironmentCapability,
  physicsMotionCapability,
  physicsPowertrainCapability,
  physicsResistanceCapability,
  physicsRiderCapability,
  physicsStateEvent,
  physicsTotalResistanceCapability,
  type ResistanceProvider,
  spatialTerrainCapability,
} from '@ridrs/contracts';
import { createBundledPluginSource, createSilentLogger, PluginHost } from '@ridrs/core';
import FakeTimers from '@sinonjs/fake-timers';
import { afterEach, describe, expect, it } from 'vitest';

const PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

/** Every physics plugin except the engine: they compute only when the engine calls them. */
const CONTRIBUTORS = [
  'physics-bicycle',
  'physics-rider',
  'physics-rolling-resistance',
  'physics-aerodynamics',
  'physics-gravity-resistance',
  'physics-environment',
  'physics-total-resistance',
  'physics-powertrain',
  'physics-virtual-speed',
];

/** Every plugin under plugins/physics-*, read from the folder: new ones are covered too. */
const PHYSICS_PLUGINS = readdirSync(PLUGINS_DIR).filter((id) => id.startsWith('physics-'));

const RIDE_PLUGINS = [
  'activity-session',
  'metric-power',
  'physics-engine',
  'spatial-terrain',
  ...CONTRIBUTORS,
];

async function definitionOf(id: string): Promise<PluginDefinition> {
  const module = (await import(`../../plugins/${id}/index.ts`)) as { default: PluginDefinition };
  return module.default;
}

/** A plugin context that records event use; everything else is inert. */
function recordingContext(id: string) {
  const used: string[] = [];
  const capabilities: string[] = [];
  const provided: unknown[] = [];
  const ctx = {
    manifest: JSON.parse(readFileSync(resolve(PLUGINS_DIR, id, 'manifest.json'), 'utf8')),
    logger: createSilentLogger(),
    timeSource: { now: () => T0 },
    events: {
      publish: (event: { id: string }) => used.push(`publish ${event.id}`),
      subscribe: (event: { id: string }) => {
        used.push(`subscribe ${event.id}`);
        return { unsubscribe: () => undefined };
      },
    },
    capabilities: {
      provide: (capability: { id: string }, implementation: unknown) => {
        capabilities.push(`provide ${capability.id}`);
        provided.push(implementation);
      },
      get: (capability: { id: string }) => {
        capabilities.push(`get ${capability.id}`);
        return {};
      },
      getAll: (capability: { id: string }) => {
        capabilities.push(`getAll ${capability.id}`);
        return [];
      },
    },
    spatial: {
      reader: (capability: CapabilityContract) => {
        capabilities.push(`spatial reader ${capability.id}`);
        return { series: capability.id };
      },
      writer: () => {
        used.push('spatial writer');
        throw new Error('physics plugins never write a series');
      },
    },
    temporal: {
      reader: (capability: CapabilityContract) => ({ series: capability.id }),
      writer: () => {
        used.push('temporal writer');
        throw new Error('physics plugins never write a series');
      },
      combine: () => () => undefined,
      snapshot: () => ({ at: T0, values: {} }),
    },
    signal: new AbortController().signal,
    ui: { registry: () => ({}) },
    reportDiagnostic: () => undefined,
  } as unknown as PluginContext;
  return { ctx, used, capabilities, provided };
}

describe('physics contributors', () => {
  it.each(CONTRIBUTORS)('%s publishes nothing and listens to nothing', async (id) => {
    const definition = await definitionOf(id);
    const { ctx, used } = recordingContext(id);
    await definition.initialize?.(ctx);
    await definition.start?.(ctx);
    expect(used).toEqual([]);
  });
});

describe('data never reaches the physics by event', () => {
  it('finds the physics plugins', () => {
    expect(PHYSICS_PLUGINS).toEqual(expect.arrayContaining(['physics-engine', ...CONTRIBUTORS]));
  });

  it.each(PHYSICS_PLUGINS)('%s subscribes to lifecycle events (activity.*) only', async (id) => {
    const definition = await definitionOf(id);
    const { ctx, used } = recordingContext(id);
    await definition.initialize?.(ctx);
    await definition.start?.(ctx);
    const subscriptions = used.filter((use) => use.startsWith('subscribe '));
    expect(subscriptions.filter((use) => !use.startsWith('subscribe activity.'))).toEqual([]);
  });
});

describe('physics inputs and forces stay apart', () => {
  it.each([['physics-environment', 'physics.environment']])(
    '%s provides only its parameters and computes no forces',
    async (id, capability) => {
      const { ctx, capabilities } = recordingContext(id);
      await (await definitionOf(id)).initialize?.(ctx);
      // The parameters, and the same parameters as the plugin's configuration snapshot.
      expect(capabilities).toEqual([`provide ${capability}`, 'provide config.snapshot']);
    },
  );

  it('physics-gravity-resistance reads no provider: mass and road come in the input', async () => {
    const { ctx, capabilities, provided } = recordingContext('physics-gravity-resistance');
    await (await definitionOf('physics-gravity-resistance')).initialize?.(ctx);
    const [resistance] = provided as ResistanceProvider[];
    resistance?.force({
      at: T0,
      speed: 0,
      mass: 85,
      road: { gradient: 0.05, surface: 'asphalt', origin: 'default' },
    });
    expect(capabilities).toEqual(['provide physics.resistance']);
  });
});

describe('physics engine on the real host', () => {
  let clock: ReturnType<typeof FakeTimers.install> | undefined;

  afterEach(() => {
    clock?.uninstall();
    clock = undefined;
  });

  /** Starts a ride, delivers 200 W every 250 ms for 5 s, lets the host sleep 30 s, finishes. */
  async function ride(): Promise<{ states: PhysicsState[]; afterLateWake: number }> {
    clock = FakeTimers.install({
      now: T0,
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const manifests: Record<string, string> = {};
    const modules: Record<string, () => Promise<unknown>> = {};
    for (const id of RIDE_PLUGINS) {
      manifests[`plugins/${id}/manifest.json`] = readFileSync(
        resolve(PLUGINS_DIR, id, 'manifest.json'),
        'utf8',
      );
      modules[`plugins/${id}/index.ts`] = () => import(`../../plugins/${id}/index.ts`);
    }
    const host = new PluginHost({
      sources: [createBundledPluginSource({ manifests, modules })],
      timeSource: { now: () => Date.now() },
      logger: createSilentLogger(),
      capabilities: [
        metricPowerCapability,
        physicsBicycleCapability,
        physicsRiderCapability,
        physicsEnvironmentCapability,
        physicsResistanceCapability,
        physicsTotalResistanceCapability,
        physicsPowertrainCapability,
        physicsMotionCapability,
        configSnapshotCapability,
        spatialTerrainCapability,
      ],
    });
    const states: PhysicsState[] = [];
    host.subscribeEvent('test', physicsStateEvent, ({ payload }) => {
      states.push(payload);
    });
    await host.start();
    const driver = host.getPluginContext('activity-session');
    if (!driver) {
      throw new Error('activity-session did not start');
    }
    driver.inputs.accept(activityStartRequestedEvent, {});
    for (let at = T0; at <= T0 + 5000; at += 250) {
      await clock.tickAsync(at - Date.now());
      driver.inputs.accept(measurementPowerEvent, {
        deviceId: 'trainer-1',
        value: 200,
        measuredAt: at,
        receivedAt: at,
        timestampOrigin: 'receive',
      });
    }
    // A blocked host: the clock wakes once, 30 s late, and runs one chunk of 1000 overdue turns
    // (steps and other due tasks), each at its planned time.
    clock.jump(30_000);
    const afterLateWake = states.at(-1)?.step ?? -1;
    // The rest follows in further chunks after yielding to the event loop.
    await clock.tickAsync(5);
    await host.stop();
    return { states, afterLateWake };
  }

  it('catches up after a late wake in chunks, each step at its planned time, none lost', async () => {
    const { states, afterLateWake } = await ride();
    // One chunk is at most 1000 turns: the catch-up yields long before step 3500.
    expect(afterLateWake).toBeGreaterThan(500);
    expect(afterLateWake).toBeLessThanOrEqual(500 + 1000);
    const steps = states.map((s) => s.step);
    expect(steps).toEqual(Array.from({ length: 35_000 / 250 + 1 }, (_, i) => i * 25));
    expect(states.every((s) => s.at === T0 + 10 * s.step)).toBe(true);
  });

  it('gives deep-equal states for the same event and clock sequence', async () => {
    const withoutSession = ({ sessionId: _sessionId, ...state }: PhysicsState) => state;
    const first = (await ride()).states.map(withoutSession);
    clock?.uninstall();
    const second = (await ride()).states.map(withoutSession);
    expect(second).toEqual(first);
    expect(first.at(-1)?.speed).toBeGreaterThan(0);
  });

  it('leaves no timer behind once the host stopped', async () => {
    await ride();
    expect(clock?.countTimers()).toBe(0);
  });
});
