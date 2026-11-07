// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineCapability,
  defineEvent,
  definePlugin,
  parseManifestJson,
  RidrsError,
} from './index.ts';

describe('manifestSchema & parseManifestJson', () => {
  it('accepts a valid manifest', () => {
    const raw = JSON.stringify({
      id: 'example-ping',
      name: 'Example Ping',
      version: '1.0.0',
      types: ['example'],
      provides: ['demo.clock'],
      requires: ['demo.store'],
      entry: 'index.ts',
    });
    const result = parseManifestJson(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('example-ping');
      expect(result.data.provides).toEqual(['demo.clock']);
    }
  });

  it('rejects invalid JSON and mentions JSON', () => {
    const result = parseManifestJson('{ this is not json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('JSON');
    }
  });

  it('rejects unknown fields via strict mode', () => {
    const raw = JSON.stringify({
      id: 'broken',
      name: 'Broken',
      version: '1.0.0',
      types: ['example'],
      provides: [],
      requires: [],
      entry: 'index.ts',
      colour: 'red',
    });
    const result = parseManifestJson(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('colour');
    }
  });

  it('rejects invalid capability identifiers in provides/requires', () => {
    const raw = JSON.stringify({
      id: 'broken',
      name: 'Broken',
      version: '1.0.0',
      types: ['example'],
      provides: ['InvalidCapability'],
      requires: [],
      entry: 'index.ts',
    });
    const result = parseManifestJson(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('provides');
    }
  });
});

describe('contract definitions', () => {
  it('creates frozen event and capability definitions', () => {
    const evt = defineEvent('demo.greeting', z.object({ text: z.string() }));
    expect(evt.id).toBe('demo.greeting');
    expect(Object.isFrozen(evt)).toBe(true);

    const cap = defineCapability<{ now(): string }>('demo.clock', { cardinality: 'single' });
    expect(cap.id).toBe('demo.clock');
    expect(cap.cardinality).toBe('single');
    expect(Object.isFrozen(cap)).toBe(true);
  });

  it('constructs RidrsError with code and pluginId', () => {
    const err = new RidrsError('undeclared-capability', 'Not declared', { pluginId: 'sneaky' });
    expect(err.code).toBe('undeclared-capability');
    expect(err.pluginId).toBe('sneaky');
    expect(err.message).toBe('Not declared');
  });

  it('returns plugin definition from definePlugin', () => {
    const def = definePlugin({});
    expect(def).toEqual({});
  });
});

describe('app state and services in the manifest (ADR 0068)', () => {
  const manifest = (fields: Record<string, unknown>) =>
    parseManifestJson(
      JSON.stringify({
        id: 'probe',
        name: 'Probe',
        version: '1.0.0',
        provides: [],
        requires: [],
        entry: 'index.ts',
        ...fields,
      }),
    );

  it('lets an input-side plugin own, watch, provide and call', () => {
    const result = manifest({
      types: ['transport'],
      state: { owns: ['route.offer'], watches: ['training.plan'] },
      services: { provides: ['route.fetch'], calls: ['training.upload'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.state).toEqual({ owns: ['route.offer'], watches: ['training.plan'] });
      expect(result.data.services?.calls).toEqual(['training.upload']);
    }
  });

  it.each([['state'], ['services']])('refuses %s on a simulation plugin', (field) => {
    const result = manifest({ types: ['physics'], [field]: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain(field);
    }
  });

  it('refuses unknown fields in the state section', () => {
    expect(manifest({ types: ['ui'], state: { reads: [] } }).success).toBe(false);
  });

  it('allows ui.state and ui.calls on ui plugins only', () => {
    const ui = { state: ['route.offer'], calls: ['route.fetch'] };
    expect(manifest({ types: ['ui'], ui }).success).toBe(true);
    const device = manifest({ types: ['device'], ui });
    expect(device.success).toBe(false);
    if (!device.success) {
      expect(device.message).toContain('ui.state');
    }
  });
});

describe('app channel types (ADR 0069)', () => {
  const manifest = (fields: Record<string, unknown>) =>
    parseManifestJson(
      JSON.stringify({
        id: 'probe',
        name: 'Probe',
        version: '1.0.0',
        provides: [],
        requires: [],
        entry: 'index.ts',
        ...fields,
      }),
    );

  it.each([['recording'], ['export']])(
    'lets a %s plugin own state and provide services',
    (type) => {
      expect(
        manifest({
          types: [type],
          state: { owns: ['recording.ride'] },
          services: { provides: ['recording.delete'] },
        }).success,
      ).toBe(true);
    },
  );

  it('keeps settings to the persistence types', () => {
    expect(manifest({ types: ['recording'], persistence: ['machine'] }).success).toBe(false);
  });

  it.each([
    ['state', { watches: ['device.status'] }],
    ['services', { calls: ['device.connect'] }],
  ])('refuses a device plugin that reads app state or calls services (%s)', (field, value) => {
    const result = manifest({ types: ['device'], [field]: value });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('replay');
    }
  });

  it('lets a device plugin own state and provide services', () => {
    expect(
      manifest({
        types: ['device'],
        state: { owns: ['device.status'] },
        services: { provides: ['device.connect'] },
      }).success,
    ).toBe(true);
  });
});
