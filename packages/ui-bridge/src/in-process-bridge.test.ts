// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, defineService, defineState, RidrsError } from '@ridrs/contracts';
import { createBundledPluginSource, PluginHost } from '@ridrs/core';
import type { StateUpdate } from '@ridrs/ui-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInProcessUiBridge, type InProcessUiBridge } from './in-process-bridge.ts';

const offerState = defineState('test.offer', z.object({ title: z.string() }).strict());
const otherState = defineState('test.other', z.object({ title: z.string() }).strict());
const fetchService = defineService('test.fetch', {
  request: z.object({ key: z.string() }).strict(),
  response: z.object({}).strict(),
  keyedBy: offerState,
});

const manifest = (id: string, fields: Record<string, unknown>) =>
  JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    provides: [],
    requires: [],
    entry: 'index.ts',
    ...fields,
  });

const source = definePlugin({
  start(ctx) {
    ctx.state.set(offerState, 'col-a', { title: 'Col A' });
    ctx.services.provide(fetchService, ({ key }) => {
      if (key === 'col-b') {
        throw new RidrsError('unknown-key', 'Col B is gone');
      }
      return {};
    });
  },
});

let host: PluginHost | undefined;
let bridge: InProcessUiBridge | undefined;

async function start(): Promise<{ host: PluginHost; bridge: InProcessUiBridge }> {
  host = new PluginHost({
    sources: [
      createBundledPluginSource({
        manifests: {
          'source/manifest.json': manifest('source', {
            types: ['transport'],
            state: { owns: ['test.offer'] },
            services: { provides: ['test.fetch'] },
          }),
          'client/manifest.json': manifest('client', {
            types: ['ui'],
            ui: { state: ['test.offer'], calls: ['test.fetch'] },
          }),
        },
        modules: {
          'source/index.ts': async () => ({ default: source }),
          'client/index.ts': async () => ({ default: definePlugin({}) }),
        },
      }),
    ],
    states: [offerState, otherState],
    services: [fetchService],
  });
  bridge = createInProcessUiBridge(host, []);
  await host.start();
  return { host, bridge };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(async () => {
  bridge?.dispose();
  await host?.dispose();
});

describe('in-process UI bridge: app state and services', () => {
  it('sends the snapshot, then the changed keys, as messages', async () => {
    const { host, bridge } = await start();
    const updates: StateUpdate[] = [];
    bridge.watchState('test.offer', (update) => updates.push(update));
    await flush();
    expect(updates).toEqual([
      { snapshot: true, values: { 'col-a': { title: 'Col A' } }, removed: [] },
    ]);
    await host.stopPlugin('source');
    await flush();
    expect(updates.at(-1)).toEqual({ snapshot: false, values: {}, removed: ['col-a'] });
  });

  it('refuses topics and services no UI plugin declares', async () => {
    const { bridge } = await start();
    expect(() => bridge.watchState('test.other', () => {})).toThrow(
      expect.objectContaining({ code: 'state-not-allowed' }),
    );
    await expect(bridge.call('test.ping', {})).rejects.toMatchObject({ code: 'call-not-allowed' });
  });

  it("passes a call's answer and a RidrsError's code and message to the client", async () => {
    const { bridge } = await start();
    await expect(bridge.call('test.fetch', { key: 'col-a' })).resolves.toEqual({});
    await expect(bridge.call('test.fetch', { key: 'col-b' })).rejects.toMatchObject({
      code: 'unknown-key',
    });
  });

  it('ends its watches when it is disposed', async () => {
    const { host, bridge } = await start();
    const updates: StateUpdate[] = [];
    bridge.watchState('test.offer', (update) => updates.push(update));
    await flush();
    bridge.dispose();
    await host.stopPlugin('source');
    await flush();
    expect(updates).toHaveLength(1);
  });
});
