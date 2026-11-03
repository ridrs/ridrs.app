// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  defineEvent,
  definePlugin,
  type EventEnvelope,
  type PluginContext,
  type PluginDefinition,
  RidrsError,
} from '@ridrs/contracts';
import { TEMPORAL_DEFAULTS } from '@ridrs/temporal';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBundledPluginSource, PluginHost } from './index.ts';

const ping = defineEvent('demo.ping', z.object({ n: z.number() }));
const pong = defineEvent('demo.pong', z.object({ n: z.number() }));

interface TestPlugin {
  readonly id: string;
  readonly permissions?: string[];
  readonly definition: PluginDefinition;
}

async function startHost(plugins: readonly TestPlugin[]): Promise<PluginHost> {
  const manifests: Record<string, string> = {};
  const modules: Record<string, () => Promise<unknown>> = {};
  for (const plugin of plugins) {
    manifests[`plugins/${plugin.id}/manifest.json`] = JSON.stringify({
      id: plugin.id,
      name: plugin.id,
      version: '1.0.0',
      types: ['test'],
      provides: [],
      requires: [],
      entry: 'index.ts',
      ...(plugin.permissions ? { permissions: plugin.permissions } : {}),
    });
    modules[`plugins/${plugin.id}/index.ts`] = async () => ({ default: plugin.definition });
  }
  const host = new PluginHost({
    sources: [createBundledPluginSource({ manifests, modules })],
    timeSource: { now: () => 1000 },
  });
  await host.start();
  return host;
}

function contextOf(host: PluginHost, id: string): PluginContext {
  const ctx = host.getPluginContext(id);
  if (!ctx) {
    throw new Error(`no context for ${id}`);
  }
  return ctx;
}

describe('ctx.host', () => {
  it('needs the manifest permission "observe-host"', async () => {
    const host = await startHost([{ id: 'spy', definition: definePlugin({}) }]);
    const ctx = contextOf(host, 'spy');
    expect(() => ctx.host.observe({})).toThrowError(
      expect.objectContaining({ code: 'permission-denied' }),
    );
    expect(() => ctx.host.describe()).toThrowError(RidrsError);
    await host.dispose();
  });

  it('describes plugins, resolution and the temporal defaults', async () => {
    const host = await startHost([
      { id: 'recorder', permissions: ['observe-host'], definition: definePlugin({}) },
    ]);
    const description = contextOf(host, 'recorder').host.describe();
    expect(description.plugins).toEqual([
      {
        id: 'recorder',
        version: '1.0.0',
        types: ['test'],
        provides: [],
        requires: [],
        state: 'started',
      },
    ]);
    expect(description.coreDefaults.temporal).toEqual({ ...TEMPORAL_DEFAULTS });
    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
    await host.dispose();
  });

  it('observes in global publish order, before queued delivery, under nested publishes', async () => {
    const order: string[] = [];
    const echo = definePlugin({
      start(ctx) {
        ctx.events.subscribe(ping, ({ payload }) => {
          order.push(`deliver ping ${payload.n}`);
          ctx.events.publish(pong, { n: payload.n });
        });
        ctx.events.subscribe(pong, ({ payload }) => order.push(`deliver pong ${payload.n}`));
      },
    });
    const host = await startHost([
      { id: 'echo', definition: echo },
      { id: 'recorder', permissions: ['observe-host'], definition: definePlugin({}) },
    ]);
    contextOf(host, 'recorder').host.observe({
      onEvent: (envelope: EventEnvelope) =>
        order.push(`observe ${envelope.type} ${(envelope.payload as { n: number }).n}`),
    });
    const sender = contextOf(host, 'echo');
    sender.inputs.accept(ping, { n: 1 });
    expect(order).toEqual([
      'observe demo.ping 1',
      'deliver ping 1',
      'observe demo.pong 1',
      'deliver pong 1',
    ]);
    await host.dispose();
  });

  it('keeps observers read-only and turns a throwing observer into one diagnostic', async () => {
    const host = await startHost([
      { id: 'recorder', permissions: ['observe-host'], definition: definePlugin({}) },
    ]);
    const ctx = contextOf(host, 'recorder');
    let calls = 0;
    ctx.host.observe({
      onEvent: () => {
        calls += 1;
        ctx.events.publish(pong, { n: 0 });
      },
    });
    const diagnostics: string[] = [];
    host.observe('test', { onDiagnostic: (d) => diagnostics.push(d.code) });
    ctx.inputs.accept(ping, { n: 1 });
    expect(calls).toBe(1);
    expect(diagnostics).toEqual(['event-handler-failure']);
    await host.dispose();
  });

  it('releases observations when the plugin stops', async () => {
    const host = await startHost([
      { id: 'recorder', permissions: ['observe-host'], definition: definePlugin({}) },
      { id: 'sender', definition: definePlugin({}) },
    ]);
    const seen: string[] = [];
    contextOf(host, 'recorder').host.observe({ onEvent: (e) => seen.push(e.type) });
    await host.stopPlugin('recorder');
    contextOf(host, 'sender').inputs.accept(ping, { n: 1 });
    expect(seen).toEqual([]);
    await host.dispose();
  });
});
