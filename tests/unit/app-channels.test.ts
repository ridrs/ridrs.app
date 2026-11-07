// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_CHANNEL_TYPES, parseManifestJson } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';

const PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');

/** Every plugin manifest under plugins/, read from the folder: new plugins are covered too. */
const MANIFESTS = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const result = parseManifestJson(
      readFileSync(resolve(PLUGINS_DIR, entry.name, 'manifest.json'), 'utf8'),
    );
    if (!result.success) {
      throw new Error(`plugins/${entry.name}: ${result.message}`);
    }
    return result.data;
  });

// ADR 0068, risk 1 of the proposal: simulation code never reads app state or calls services.
describe('app state and services stay on the input side', () => {
  const simulation = MANIFESTS.filter(
    (manifest) => !manifest.types.some((type) => APP_CHANNEL_TYPES.includes(type)),
  );

  it('covers the simulation plugins', () => {
    expect(simulation.map((m) => m.id)).toEqual(
      expect.arrayContaining(['activity-session', 'metric-power', 'physics-engine']),
    );
  });

  it.each(simulation.map((m) => [m.id, m] as const))('%s declares no state or services', (_, m) => {
    expect(m.state).toBeUndefined();
    expect(m.services).toBeUndefined();
  });
});
