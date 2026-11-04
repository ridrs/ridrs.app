// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type EventEnvelope,
  type TerrainPreview,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv, useRealPlugins } from './devices-and-metrics.steps.ts';

/** The source the UI bridge publishes client events with. */
const UI_BRIDGE = 'ui-bridge';

Given(
  'the ridrs plugins {string} together with a probe plugin {string} that reads the spatial series {string}',
  async function (this: RidrsWorld, pluginsCsv: string, probeId: string, series: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    this.getBehavior(probeId).spatialReads.push(series);
    await this.writeTemporalProbe(probeId);
  },
);

// ---- The sensor: what the UI landscape publishes ---------------------------------------------

// "observes" (When) and "observed" (Given); without a surface list the samples name none.
When(
  /^the UI observe[sd] revision (-?\d+) of the terrain from (-?[\d.]+) m, ([\d.]+) m apart, with the gradients "([^"]*)" %(?: on "([^"]*)")?$/,
  async function (
    this: RidrsWorld,
    revision: string,
    origin: string,
    spacing: string,
    gradientsCsv: string,
    surfacesCsv: string | null,
  ) {
    const surfaces = surfacesCsv === null ? [] : splitCsv(surfacesCsv);
    // As the in-process UI bridge does: an input from outside the plugins.
    this.ensureHost().publishEvent(UI_BRIDGE, uiTerrainObservedEvent, {
      revision: Number(revision),
      originDistance: Number(origin),
      spacing: Number(spacing),
      samples: splitCsv(gradientsCsv).map((percent, i) => ({
        gradient: Number(percent) / 100,
        ...(surfaces[i] === undefined ? {} : { surface: surfaces[i] }),
      })),
    });
    await this.settle();
  },
);

// ---- The driver ------------------------------------------------------------------------------

function accepted(world: RidrsWorld, pluginId: string): EventEnvelope<TerrainPreview>[] {
  return (
    world.hostObserved.filter(
      (e) => e.type === worldTerrainPreviewEvent.id && e.source === pluginId,
    ) as EventEnvelope<TerrainPreview>[]
  ).map((e) => {
    assert.equal(e.input, true, `"${e.type}" from "${e.source}" is not an input`);
    return e;
  });
}

Then(
  '{string} accepted the input {string} with revision {int} from {float} m',
  function (this: RidrsWorld, pluginId: string, eventId: string, revision: number, origin: number) {
    assert.equal(eventId, worldTerrainPreviewEvent.id);
    const latest = accepted(this, pluginId).at(-1);
    assert.ok(latest, `"${pluginId}" accepted no "${eventId}"`);
    assert.deepEqual(
      { revision: latest.payload.revision, originDistance: latest.payload.originDistance },
      { revision, originDistance: origin },
    );
  },
);

Then(
  /^"([^"]+)" accepted (no|\d+) "([^"]+)"$/,
  function (this: RidrsWorld, pluginId: string, count: string, eventId: string) {
    assert.equal(eventId, worldTerrainPreviewEvent.id);
    assert.equal(accepted(this, pluginId).length, count === 'no' ? 0 : Number(count));
  },
);

Then(
  'a {string} diagnostic says {string} for revision {int}',
  function (this: RidrsWorld, code: string, reason: string, revision: number) {
    const found = this.ensureHost()
      .getDiagnostics()
      .filter((d) => d.code === code);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.deepEqual(
      { reason: found[0]?.details?.reason, revision: found[0]?.details?.revision },
      { reason, revision },
    );
  },
);
