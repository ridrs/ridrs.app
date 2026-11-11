// SPDX-License-Identifier: AGPL-3.0-or-later

import { uiManifestSectionSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { computeUiRegistry, type UiRegistryInput } from './ui-registry.ts';

function plugin(pluginId: string, ui: unknown, clientAvailable = true): UiRegistryInput {
  return { pluginId, ui: uiManifestSectionSchema.parse(ui), clientAvailable };
}

const badgeProvider = (pluginId: string, clientAvailable = true) =>
  plugin(
    pluginId,
    { client: 'client/index.js', provides: [{ capability: 'ui.test-badge', export: 'Badge' }] },
    clientAvailable,
  );

describe('computeUiRegistry: UI capabilities (ADR 0083)', () => {
  it('indexes the one provider of each capability, sorted by capability id', () => {
    const { registry, problems } = computeUiRegistry([
      plugin('charts', {
        client: 'client/index.js',
        provides: [
          { capability: 'ui.workout-chart', export: 'WorkoutChart' },
          { capability: 'ui.route-profile', export: 'RouteProfile' },
        ],
      }),
      badgeProvider('badges'),
    ]);

    expect(problems).toEqual([]);
    expect(registry.capabilities).toEqual([
      {
        pluginId: 'charts',
        capability: 'ui.route-profile',
        export: 'RouteProfile',
        client: 'client/index.js',
      },
      {
        pluginId: 'badges',
        capability: 'ui.test-badge',
        export: 'Badge',
        client: 'client/index.js',
      },
      {
        pluginId: 'charts',
        capability: 'ui.workout-chart',
        export: 'WorkoutChart',
        client: 'client/index.js',
      },
    ]);
  });

  it('carries what each plugin uses, so the shell can check its calls of ctx.render', () => {
    const { registry } = computeUiRegistry([
      plugin('today', { uses: ['ui.workout-chart', 'ui.test-badge', 'ui.workout-chart'] }),
      plugin('quiet', {}),
    ]);

    expect(registry.plugins.map(({ pluginId, uses }) => ({ pluginId, uses }))).toEqual([
      { pluginId: 'quiet', uses: [] },
      { pluginId: 'today', uses: ['ui.test-badge', 'ui.workout-chart'] },
    ]);
  });

  it('leaves a provider out whose client module is missing', () => {
    const { registry, problems } = computeUiRegistry([badgeProvider('badges', false)]);

    expect(registry.capabilities).toEqual([]);
    expect(problems).toEqual([
      expect.objectContaining({ code: 'client-entry-missing', pluginId: 'badges' }),
    ]);
  });

  it('draws none of two rival providers and names both, whatever the input order', () => {
    const forward = computeUiRegistry([badgeProvider('badges-a'), badgeProvider('badges-b')]);
    const backward = computeUiRegistry([badgeProvider('badges-b'), badgeProvider('badges-a')]);

    expect(forward).toEqual(backward);
    expect(forward.registry.capabilities).toEqual([]);
    expect(forward.problems.map(({ code, pluginId }) => ({ code, pluginId }))).toEqual([
      { code: 'ambiguous-provider', pluginId: 'badges-a' },
      { code: 'ambiguous-provider', pluginId: 'badges-b' },
    ]);
    expect(forward.problems[0]?.message).toContain('badges-a, badges-b');
  });
});
