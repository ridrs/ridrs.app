// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type SpatialValue,
  spatialTerrainCapability,
  type TerrainPoint,
  type TerrainSurface,
} from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';
import { assertClose } from './physics.steps.ts';

const TERRAIN_CHANNELS = { gradient: 'linear', surface: 'step' } as const;

Given(
  'the probe plugin {string} writes the spatial series {string}',
  async function (this: RidrsWorld, pluginId: string, series: string) {
    assert.equal(series, spatialTerrainCapability.id);
    const behavior = this.getBehavior(pluginId);
    behavior.spatialWrite = series;
    behavior.providedImplementations.set(series, { channels: TERRAIN_CHANNELS });
    await this.writeTemporalProbe(pluginId);
  },
);

Given(
  'the probe plugin {string} reads the spatial series {string}',
  async function (this: RidrsWorld, pluginId: string, series: string) {
    this.getBehavior(pluginId).spatialReads.push(series);
    await this.writeTemporalProbe(pluginId);
  },
);

/** Gradients in % in the table, rise over run in the window. */
function samplesOf(table: DataTable): TerrainPoint[] {
  return table.hashes().map((row) => ({
    gradient: Number(row.gradient) / 100,
    surface: row.surface as TerrainSurface,
  }));
}

async function writeWindow(
  world: RidrsWorld,
  pluginId: string,
  revision: number,
  originDistance: number,
  spacing: number,
  table: DataTable,
): Promise<void> {
  const entry = world.spatialWriters.get(spatialTerrainCapability.id);
  assert.ok(entry && entry.pluginId === pluginId, `"${pluginId}" writes no spatial series`);
  // Writes are simulation state: inside a turn, like an input would.
  world.ensureHost().input(() => {
    world.lastSpatialWriteResult = entry.writer.write({
      sourceId: pluginId,
      revision,
      originDistance,
      spacing,
      samples: samplesOf(table),
    });
  });
  await world.settle();
}

// Matches "writes" (When) and "wrote" (Given); Cucumber ignores the keyword.
When(
  /^"([^"]+)" (?:writes|wrote) revision (\d+) of the terrain from ([\d.]+) m, ([\d.]+) m apart:$/,
  async function (
    this: RidrsWorld,
    pluginId: string,
    revision: string,
    origin: string,
    spacing: string,
    table: DataTable,
  ) {
    await writeWindow(this, pluginId, Number(revision), Number(origin), Number(spacing), table);
  },
);

function valueAt(
  world: RidrsWorld,
  pluginId: string,
  distance: number,
): SpatialValue<TerrainPoint> {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected the plugin "${pluginId}" to be running`);
  return ctx.spatial.reader(spatialTerrainCapability).valueAt(distance);
}

Then(
  '{string} reads at {float} m a gradient of {float} % on {string} \\({string})',
  function (
    this: RidrsWorld,
    pluginId: string,
    distance: number,
    percent: number,
    surface: string,
    quality: string,
  ) {
    const value = valueAt(this, pluginId, distance);
    assert.equal(value.status, 'available', JSON.stringify(value));
    assert.ok(value.status === 'available');
    assertClose(value.value.gradient * 100, percent, 'gradient (%)');
    assert.deepEqual(
      { surface: value.value.surface, quality: value.quality },
      { surface, quality },
    );
  },
);

Then(
  '{string} reads no terrain at {float} m, because of {string}',
  function (this: RidrsWorld, pluginId: string, distance: number, reason: string) {
    assert.deepEqual(valueAt(this, pluginId, distance), {
      status: 'unavailable',
      distance,
      reason,
    });
  },
);

Then('the spatial write result was {string}', function (this: RidrsWorld, result: string) {
  assert.equal(this.lastSpatialWriteResult, result);
});
