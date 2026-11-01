// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, it } from 'vitest';
import { discoverBundledPlugins } from '../src/probe/bundled-discovery.ts';

it('finds the browser-safe plugins through import.meta.glob, validates manifests and loads entries lazily', async () => {
  const { plugins, problems } = discoverBundledPlugins();

  expect(problems).toEqual([]);
  expect(plugins.map((p) => p.manifest.id)).toEqual(['device-ftms-trainer', 'metric-cadence', 'metric-power']);
  expect(plugins.find((p) => p.manifest.id === 'device-ftms-trainer')?.manifest.requires).toEqual(['ble.central']);

  for (const plugin of plugins) {
    const definition = await plugin.load();
    expect(typeof definition.start).toBe('function');
  }
});
