// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineCapability, defineEvent, RidrsError } from '@ridrs/contracts';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry, createSystemClock, DiagnosticCollector, EventBus } from './index.ts';

describe('createSystemClock', () => {
  it('returns an integer epoch timestamp in milliseconds', () => {
    const clock = createSystemClock();
    const now = clock.now();
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('CapabilityRegistry', () => {
  it('replaces existing provider for the same plugin and removes providers on cleanup', () => {
    const registry = new CapabilityRegistry();
    const contract = defineCapability<{ value: number }>('demo.value', { cardinality: 'single' });
    registry.registerContract(contract);

    const providerCtx = registry.createPluginCapabilitiesContext({
      id: 'provider-a',
      name: 'Provider A',
      version: '1.0.0',
      types: ['example'],
      provides: ['demo.value'],
      requires: [],
      entry: 'index.ts',
    });

    const consumerCtx = registry.createPluginCapabilitiesContext({
      id: 'consumer-b',
      name: 'Consumer B',
      version: '1.0.0',
      types: ['example'],
      provides: [],
      requires: ['demo.value'],
      entry: 'index.ts',
    });

    providerCtx.provide(contract, { value: 1 });
    providerCtx.provide(contract, { value: 2 });
    expect(consumerCtx.get(contract).value).toBe(2);

    registry.removeProvidersForPlugin('provider-a');
    expect(registry.hasProvided('provider-a', 'demo.value')).toBe(false);
    expect(() => consumerCtx.get(contract)).toThrowError(RidrsError);
  });
});

describe('EventBus', () => {
  it('delivers system events and tracks subscription counts accurately', () => {
    const diagnostics = new DiagnosticCollector(pino({ level: 'silent' }));
    const bus = new EventBus({
      clock: { now: () => 42 },
      diagnostics,
      canPluginPublish: () => true,
    });

    const evt = defineEvent('demo.ping', z.object({ ok: z.boolean() }));
    const ctx = bus.createPluginEventsContext('listener');
    const received: boolean[] = [];

    const sub = ctx.subscribe(evt, (env) => {
      received.push(env.payload.ok);
    });

    expect(bus.getSubscriptionCount('listener')).toBe(1);
    expect(bus.getSubscriptionCount()).toBe(1);

    bus.publishSystemEvent('core.host', evt, { ok: true });
    expect(received).toEqual([true]);

    sub.unsubscribe();
    expect(bus.getSubscriptionCount('listener')).toBe(0);
    expect(bus.getSubscriptionCount()).toBe(0);
  });
});
