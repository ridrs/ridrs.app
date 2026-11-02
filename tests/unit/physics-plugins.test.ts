// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activityStartRequestedEvent,
  type CapabilityContract,
  measurementPowerEvent,
  metricPowerCapability,
  type PhysicsState,
  type PluginContext,
  type PluginDefinition,
  physicsBicycleCapability,
  physicsMotionCapability,
  physicsPowertrainCapability,
  physicsResistanceCapability,
  physicsRiderCapability,
  physicsStateEvent,
  physicsTotalResistanceCapability,
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
  'physics-total-resistance',
  'physics-powertrain',
  'physics-virtual-speed',
];

const RIDE_PLUGINS = ['activity-session', 'metric-power', 'physics-engine', ...CONTRIBUTORS];

async function definitionOf(id: string): Promise<PluginDefinition> {
  const module = (await import(`../../plugins/${id}/index.ts`)) as { default: PluginDefinition };
  return module.default;
}

/** A plugin context that records event use; everything else is inert. */
function recordingContext(id: string) {
  const used: string[] = [];
  const ctx = {
    manifest: JSON.parse(readFileSync(resolve(PLUGINS_DIR, id, 'manifest.json'), 'utf8')),
    logger: createSilentLogger(),
    clock: { now: () => T0 },
    events: {
      publish: (event: { id: string }) => used.push(`publish ${event.id}`),
      subscribe: (event: { id: string }) => {
        used.push(`subscribe ${event.id}`);
        return { unsubscribe: () => undefined };
      },
    },
    capabilities: {
      provide: () => undefined,
      get: () => ({}),
      getAll: () => [],
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
  return { ctx, used };
}

describe('physics contributors', () => {
  it.each(CONTRIBUTORS)('%s neither subscribes nor publishes', async (id) => {
    const definition = await definitionOf(id);
    const { ctx, used } = recordingContext(id);
    await definition.initialize?.(ctx);
    await definition.start?.(ctx);
    expect(used).toEqual([]);
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
      clock: { now: () => Date.now() },
      logger: createSilentLogger(),
      capabilities: [
        metricPowerCapability,
        physicsBicycleCapability,
        physicsRiderCapability,
        physicsResistanceCapability,
        physicsTotalResistanceCapability,
        physicsPowertrainCapability,
        physicsMotionCapability,
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
    driver.events.publish(activityStartRequestedEvent, {});
    for (let at = T0; at <= T0 + 5000; at += 250) {
      await clock.tickAsync(at - Date.now());
      driver.events.publish(measurementPowerEvent, {
        deviceId: 'trainer-1',
        value: 200,
        measuredAt: at,
        receivedAt: at,
        timestampOrigin: 'receive',
      });
    }
    // A blocked host: the step timer fires once, 30 s late, and computes one chunk of steps.
    clock.jump(30_000);
    const afterLateWake = states.at(-1)?.step ?? -1;
    // The rest follows in further chunks, each re-armed with delay 0 (1 ms in fake time).
    await clock.tickAsync(5);
    await host.stop();
    return { states, afterLateWake };
  }

  it('catches up after a late wake in chunks of 1000 steps, without losing a step', async () => {
    const { states, afterLateWake } = await ride();
    expect(afterLateWake).toBe(500 + 1000);
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
