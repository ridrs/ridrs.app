// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** Every plugin manifest of the repository: the real plugins and the test fixtures. */
function manifests(): Array<{
  path: string;
  manifest: { ui?: { events?: { publish?: string[] } } };
}> {
  return ['plugins', 'tests/fixtures/plugins'].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('manifest.json') && !path.includes('node_modules'))
      .map((path) => ({
        path: join(dir, path),
        manifest: JSON.parse(readFileSync(join(ROOT, dir, path), 'utf8')),
      })),
  );
}

describe('UI manifests', () => {
  it('finds the UI plugins', () => {
    expect(manifests().filter(({ manifest }) => manifest.ui).length).toBeGreaterThan(5);
  });

  // Rendering never drives or writes the simulation: the GUI reaches the core only through user
  // input events. A repository rule, not core logic - the core knows no concrete event names.
  it('never publish a physics event', () => {
    const offenders = manifests().flatMap(({ path, manifest }) =>
      (manifest.ui?.events?.publish ?? [])
        .filter((event) => event.startsWith('physics.'))
        .map((event) => `${path}: ${event}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('UI plugin clients', () => {
  // The shell owns the one render clock; plugins reach it through ctx.frames.
  it('never create a frame clock', () => {
    const offenders = ['plugins', 'tests/fixtures/plugins'].flatMap((dir) =>
      readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
        .filter((path) => /\.tsx?$/.test(path) && !path.includes('node_modules'))
        .filter((path) => readFileSync(join(ROOT, dir, path), 'utf8').includes('new FrameClock'))
        .map((path) => join(dir, path)),
    );
    expect(offenders).toEqual([]);
  });
});
