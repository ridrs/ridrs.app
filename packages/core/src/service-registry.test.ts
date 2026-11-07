// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService, defineState, RidrsError } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ServiceRegistry } from './service-registry.ts';
import { StateStore } from './state-store.ts';

const offerState = defineState('test.offer', z.object({ title: z.string() }).strict());
const fetchService = defineService('test.fetch', {
  request: z.object({ key: z.string() }).strict(),
  response: z.object({ accepted: z.boolean() }).strict(),
  keyedBy: offerState,
});
const pingService = defineService('test.ping', {
  request: z.object({ text: z.string() }).strict(),
  response: z.object({ echo: z.string() }).strict(),
});

function setup() {
  const store = new StateStore({ report: () => {} });
  store.register([offerState]);
  const registry = new ServiceRegistry({ store });
  registry.register([fetchService, pingService]);
  return { store, registry };
}

async function rejection(promise: Promise<unknown>): Promise<RidrsError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RidrsError);
  return error as RidrsError;
}

describe('defineService', () => {
  it('refuses a keyed service whose request has no string key', () => {
    expect(() =>
      defineService('test.broken', {
        request: z.object({ id: z.string() }),
        response: z.object({}),
        keyedBy: offerState,
      }),
    ).toThrow(/key/);
  });
});

describe('ServiceRegistry', () => {
  it('reaches the single provider and resolves with its answer', async () => {
    const { registry } = setup();
    const callers: string[] = [];
    registry.provide('pinger', pingService, ({ text }, caller) => {
      callers.push(caller.pluginId);
      return { echo: text };
    });
    await expect(
      registry.call(pingService.id, { text: 'hi' }, { pluginId: 'ui-bridge' }),
    ).resolves.toEqual({ echo: 'hi' });
    expect(callers).toEqual(['ui-bridge']);
  });

  it('runs the handler outside the caller, after a microtask', async () => {
    const { registry } = setup();
    let ran = false;
    registry.provide('pinger', pingService, ({ text }) => {
      ran = true;
      return { echo: text };
    });
    const pending = registry.call(pingService.id, { text: 'hi' }, { pluginId: 'caller' });
    expect(ran).toBe(false);
    await pending;
    expect(ran).toBe(true);
  });

  it('routes a keyed call to the owner of the key', async () => {
    const { store, registry } = setup();
    const handled: string[] = [];
    for (const owner of ['source-a', 'source-b']) {
      registry.provide(owner, fetchService, ({ key }) => {
        handled.push(`${owner}:${key}`);
        return { accepted: true };
      });
    }
    store.set('source-a', offerState.id, 'source-a/one', { title: 'One' });
    store.set('source-b', offerState.id, 'source-b/two', { title: 'Two' });
    await registry.call(fetchService.id, { key: 'source-b/two' }, { pluginId: 'ui-bridge' });
    await registry.call(fetchService.id, { key: 'source-a/one' }, { pluginId: 'ui-bridge' });
    expect(handled).toEqual(['source-b:source-b/two', 'source-a:source-a/one']);
  });

  it('rejects a keyed call for a key nobody owns', async () => {
    const { registry } = setup();
    registry.provide('source-a', fetchService, () => ({ accepted: true }));
    const error = await rejection(
      registry.call(fetchService.id, { key: 'nobody/route' }, { pluginId: 'ui-bridge' }),
    );
    expect(error.code).toBe('unknown-key');
  });

  it("rejects with the handler's error and message", async () => {
    const { registry } = setup();
    registry.provide('pinger', pingService, () => {
      throw new Error('This app cannot download routes yet');
    });
    const error = await rejection(
      registry.call(pingService.id, { text: 'hi' }, { pluginId: 'ui-bridge' }),
    );
    expect(error.code).toBe('service-failed');
    expect(error.message).toBe('This app cannot download routes yet');

    registry.releasePlugin('pinger');
    registry.provide('pinger', pingService, async () => {
      throw new RidrsError('permission-denied', 'Not you');
    });
    const own = await rejection(
      registry.call(pingService.id, { text: 'hi' }, { pluginId: 'ui-bridge' }),
    );
    expect(own.code).toBe('permission-denied');
  });

  it('refuses an invalid request before the handler and an invalid response after it', async () => {
    const { registry } = setup();
    let calls = 0;
    registry.provide('pinger', pingService, () => {
      calls += 1;
      return { echo: 42 } as never;
    });
    const invalid = await rejection(
      registry.call(pingService.id, { text: 7 }, { pluginId: 'ui-bridge' }),
    );
    expect(invalid.code).toBe('invalid-request');
    expect(calls).toBe(0);
    const response = await rejection(
      registry.call(pingService.id, { text: 'hi' }, { pluginId: 'ui-bridge' }),
    );
    expect(response.code).toBe('invalid-response');
  });

  it('rejects calls without a provider, or after it stopped', async () => {
    const { registry } = setup();
    expect(
      (await rejection(registry.call(pingService.id, { text: 'hi' }, { pluginId: 'x' }))).code,
    ).toBe('service-unavailable');
    registry.provide('pinger', pingService, ({ text }) => ({ echo: text }));
    registry.releasePlugin('pinger');
    expect(
      (await rejection(registry.call(pingService.id, { text: 'hi' }, { pluginId: 'x' }))).code,
    ).toBe('service-unavailable');
    expect((await rejection(registry.call('test.unknown', {}, { pluginId: 'x' }))).code).toBe(
      'unknown-service',
    );
  });

  it('refuses a second provider of an unkeyed service', () => {
    const { registry } = setup();
    registry.provide('first', pingService, ({ text }) => ({ echo: text }));
    expect(() => registry.provide('second', pingService, ({ text }) => ({ echo: text }))).toThrow(
      RidrsError,
    );
  });
});

describe('ServiceRegistry observers', () => {
  it('tell every finished call with its answer or its error', async () => {
    const { registry } = setup();
    const seen: unknown[] = [];
    registry.observe((call) => seen.push(call));
    registry.provide('pinger', pingService, ({ text }) => ({ echo: text }));
    await registry.call(pingService.id, { text: 'hi' }, { pluginId: 'ui-bridge' });
    await registry.call(pingService.id, { text: 1 }, { pluginId: 'ui-bridge' }).catch(() => {});
    expect(seen).toEqual([
      {
        service: 'test.ping',
        caller: 'ui-bridge',
        request: { text: 'hi' },
        response: { echo: 'hi' },
      },
      {
        service: 'test.ping',
        caller: 'ui-bridge',
        request: { text: 1 },
        error: expect.stringContaining('text'),
      },
    ]);
  });
});
