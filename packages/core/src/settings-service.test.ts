// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppFileEntry, AppFiles, Diagnostic, PluginManifest } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPluginSettings } from './settings-service.ts';

class Files implements AppFiles {
  readonly files = new Map<string, string>();
  async append(path: string, text: string) {
    this.files.set(path, (this.files.get(path) ?? '') + text);
  }
  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, new TextDecoder().decode(bytes));
  }
  async replace(path: string, bytes: Uint8Array) {
    await this.write(path, bytes);
  }
  async read(path: string) {
    return new TextEncoder().encode(this.files.get(path) ?? '');
  }
  async list(directory: string): Promise<readonly AppFileEntry[]> {
    return [...this.files.keys()]
      .filter((p) => p.startsWith(`${directory}/`))
      .map((path) => ({ path, bytes: 0 }));
  }
  async remove(path: string) {
    this.files.delete(path);
  }
}

const manifest = (persistence?: ['machine']): PluginManifest => ({
  id: 'device-probe',
  name: 'Probe',
  version: '1.0.0',
  types: ['device'],
  provides: [],
  requires: [],
  entry: 'index.ts',
  ...(persistence ? { persistence } : {}),
});

const PATH = 'config/machine/device-probe/choice.json';
const v2 = {
  name: 'choice',
  version: 2,
  schema: z.object({ id: z.string() }).strict(),
  migrate: (from: number, value: unknown) => (from === 1 ? { id: String(value) } : value),
};

function setup() {
  const files = new Files();
  const diagnostics: Diagnostic[] = [];
  const settings = createPluginSettings(
    manifest(['machine']),
    () => files,
    (d) => diagnostics.push(d),
  );
  return { files, diagnostics, settings };
}

describe('ctx.settings.machine', () => {
  it('writes a versioned document and reads it back', async () => {
    const { files, settings } = setup();
    const doc = settings.machine(v2);
    expect(await doc.read()).toBeUndefined();
    await doc.write({ id: 'KICKR' });
    expect(JSON.parse(files.files.get(PATH) ?? '')).toEqual({ version: 2, value: { id: 'KICKR' } });
    expect(await doc.read()).toEqual({ id: 'KICKR' });
  });

  it('migrates an older version and drops a newer one with a diagnostic', async () => {
    const { files, diagnostics, settings } = setup();
    files.files.set(PATH, JSON.stringify({ version: 1, value: 'H10' }));
    expect(await settings.machine(v2).read()).toEqual({ id: 'H10' });
    files.files.set(PATH, JSON.stringify({ version: 3, value: { id: 'x' } }));
    expect(await settings.machine(v2).read()).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(['settings-invalid']);
  });

  it('reports values failing the schema and unreadable text, never throwing', async () => {
    const { files, diagnostics, settings } = setup();
    files.files.set(PATH, JSON.stringify({ version: 2, value: { id: 7 } }));
    expect(await settings.machine(v2).read()).toBeUndefined();
    files.files.set(PATH, '{not json');
    expect(await settings.machine(v2).read()).toBeUndefined();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.pluginId).toBe('device-probe');
  });

  it('refuses invalid values on write and plugins without the declaration', async () => {
    const { settings } = setup();
    await expect(settings.machine(v2).write({ id: 1 } as never)).rejects.toThrow();
    const without = createPluginSettings(
      manifest(),
      () => new Files(),
      () => undefined,
    );
    expect(() => without.machine(v2)).toThrow(/persistence/);
  });

  it('reads nothing and writes nowhere without files (a replay)', async () => {
    const settings = createPluginSettings(
      manifest(['machine']),
      () => undefined,
      () => undefined,
    );
    await settings.machine(v2).write({ id: 'KICKR' });
    expect(await settings.machine(v2).read()).toBeUndefined();
  });
});
