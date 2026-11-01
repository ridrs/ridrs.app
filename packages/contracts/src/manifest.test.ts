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
