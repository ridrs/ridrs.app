// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import type {
  EstimationStrategy,
  TemporalAverage,
  TemporalSeriesReader,
  TemporalSnapshot,
  TemporalValue,
} from '@ridrs/contracts';
import { DEFAULT_FAKE_START } from '../support/hooks.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

/** Absolute tolerance of numeric comparisons in temporal steps. */
const TOLERANCE = 0.005;

/** "+250 ms" means 250 ms after T0 = 2026-11-01T10:00:00.000Z. */
function parseOffset(text: string): number {
  const match = /^\+(\d+) ms$/.exec(text.trim());
  assert.ok(match, `Unrecognized time "${text}", expected e.g. "+250 ms"`);
  return DEFAULT_FAKE_START + Number(match[1]);
}

function formatOffset(time: number): string {
  return `+${time - DEFAULT_FAKE_START} ms`;
}

function assertClose(actual: number | undefined, expected: number, what: string): void {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) <= TOLERANCE,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

async function advanceTo(world: RidrsWorld, time: number): Promise<void> {
  assert.ok(world.fakeClock, 'Temporal steps need @fake-timers');
  const delta = time - world.clock.now();
  if (delta > 0) {
    await world.fakeClock.tickAsync(delta);
  }
}

function writerOf(world: RidrsWorld, series: string) {
  const entry = world.temporalWriters.get(series);
  assert.ok(entry, `No probe plugin writes the series "${series}"`);
  return entry;
}

function writerOfPlugin(world: RidrsWorld, pluginId: string) {
  const series = world.getBehavior(pluginId).temporalWrite?.series;
  assert.ok(series, `The probe plugin "${pluginId}" writes no series`);
  return writerOf(world, series);
}

/** A reader of the series, from the probe plugin that reads or combines it (else its writer). */
function readerOf(world: RidrsWorld, series: string): TemporalSeriesReader {
  const candidates = [...world.behaviors.entries()];
  const pluginId =
    candidates.find(([, b]) => b.temporalReads.includes(series))?.[0] ??
    candidates.find(([, b]) => b.temporalCombines.some((list) => list.includes(series)))?.[0] ??
    writerOf(world, series).pluginId;
  return readersOf(world, pluginId, [series])[0] as TemporalSeriesReader;
}

function readersOf(world: RidrsWorld, pluginId: string, series: string[]): TemporalSeriesReader[] {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected the plugin "${pluginId}" to be running`);
  return series.map((id) => ctx.temporal.reader(world.getOrRegisterCapability(id)));
}

async function record(
  world: RidrsWorld,
  writer: ReturnType<typeof writerOf>,
  value: number,
  measuredAt: number,
  receivedAt = measuredAt,
): Promise<void> {
  await advanceTo(world, receivedAt);
  world.lastRecordResult = writer.writer.record({
    value,
    measuredAt,
    receivedAt,
    sourceId: writer.pluginId,
  });
  await world.settle();
}

async function recordRows(world: RidrsWorld, pluginId: string, table: DataTable): Promise<void> {
  const writer = writerOfPlugin(world, pluginId);
  for (const row of table.hashes()) {
    const measuredAt = parseOffset(row.measuredAt ?? '');
    const receivedAt = row.receivedAt ? parseOffset(row.receivedAt) : measuredAt;
    await record(world, writer, Number(row.value), measuredAt, receivedAt);
  }
}

async function recordEvery(
  world: RidrsWorld,
  pluginId: string,
  value: number,
  everyMs: number,
  from: string,
  to: string,
): Promise<void> {
  const writer = writerOfPlugin(world, pluginId);
  for (let at = parseOffset(from); at <= parseOffset(to); at += everyMs) {
    await record(world, writer, value, at);
  }
}

// ---- Probe plugins -----------------------------------------------------------------------

Given(
  'the probe plugin {string} writes the temporal series {string} with the strategy {string}',
  async function (this: RidrsWorld, pluginId: string, series: string, strategy: string) {
    this.getBehavior(pluginId).temporalWrite = {
      series,
      strategy: strategy as EstimationStrategy,
    };
    await this.writeTemporalProbe(pluginId);
  },
);

Given(
  'the probe plugin {string} reads the temporal series {string}',
  async function (this: RidrsWorld, pluginId: string, seriesCsv: string) {
    this.getBehavior(pluginId).temporalReads.push(...splitCsv(seriesCsv));
    await this.writeTemporalProbe(pluginId);
  },
);

Given(
  'the probe plugin {string} combines {string}',
  async function (this: RidrsWorld, pluginId: string, seriesCsv: string) {
    this.getBehavior(pluginId).temporalCombines.push(splitCsv(seriesCsv));
    await this.writeTemporalProbe(pluginId);
  },
);

// ---- Recording ---------------------------------------------------------------------------

for (const verb of ['records', 'recorded']) {
  When(`{string} ${verb}:`, async function (this: RidrsWorld, pluginId: string, table: DataTable) {
    await recordRows(this, pluginId, table);
  });

  When(
    `{string} ${verb} one value every {int} ms from {string} to {string}`,
    async function (this: RidrsWorld, pluginId: string, every: number, from: string, to: string) {
      await recordEvery(this, pluginId, 100, every, from, to);
    },
  );

  When(
    `{string} ${verb} the value {float} every {int} ms from {string} to {string}`,
    async function (
      this: RidrsWorld,
      pluginId: string,
      value: number,
      every: number,
      from: string,
      to: string,
    ) {
      await recordEvery(this, pluginId, value, every, from, to);
    },
  );
}

for (const verb of ['were', 'are']) {
  When(`these measurements ${verb} recorded:`, async function (this: RidrsWorld, table: DataTable) {
    for (const row of table.hashes()) {
      const at = parseOffset(row.measuredAt ?? '');
      await record(this, writerOf(this, row.series ?? ''), Number(row.value), at);
    }
  });
}

for (const verb of ['reaches', 'reached']) {
  When(`the clock ${verb} {string}`, async function (this: RidrsWorld, time: string) {
    await advanceTo(this, parseOffset(time));
  });
}

When(
  '{string} marks {string} as disconnected at {string}',
  async function (this: RidrsWorld, _pluginId: string, series: string, time: string) {
    const at = parseOffset(time);
    await advanceTo(this, at);
    writerOf(this, series).writer.markUnavailable('disconnected', at);
    await this.settle();
  },
);

// ---- Timing ------------------------------------------------------------------------------

Then('the sampling interval of {string} is unknown', function (this: RidrsWorld, series: string) {
  assert.equal(readerOf(this, series).samplingInterval(), undefined);
});

Then(
  'the sampling interval of {string} is {int} ms',
  function (this: RidrsWorld, series: string, expected: number) {
    assertClose(readerOf(this, series).samplingInterval(), expected, 'sampling interval');
  },
);

Then(
  'the next measurement of {string} is expected at {string}',
  function (this: RidrsWorld, series: string, time: string) {
    assert.equal(readerOf(this, series).nextExpectedAt(), parseOffset(time));
  },
);

Then(
  'the freshness of {string} at {string} is {string}',
  async function (this: RidrsWorld, series: string, time: string, expected: string) {
    await advanceTo(this, parseOffset(time));
    assert.equal(readerOf(this, series).freshness(), expected);
  },
);

Then(
  'the freshness of {string} is {string}',
  function (this: RidrsWorld, series: string, expected: string) {
    assert.equal(readerOf(this, series).freshness(), expected);
  },
);

Then(
  'the freshness changes of {string} were:',
  function (this: RidrsWorld, series: string, table: DataTable) {
    const actual = (this.freshnessChanges.get(series) ?? []).map(({ freshness, at }) => ({
      freshness,
      at: formatOffset(at),
    }));
    assert.deepEqual(actual, table.hashes());
  },
);

Then(
  'the history of {string} holds {int} measurements',
  function (this: RidrsWorld, series: string, expected: number) {
    assert.equal(readerOf(this, series).historySize(), expected);
  },
);

Then('the record result was {string}', function (this: RidrsWorld, expected: string) {
  assert.equal(this.lastRecordResult, expected);
});

// ---- Values ------------------------------------------------------------------------------

function assertAvailable(value: TemporalValue, expected: number, quality: string): void {
  assert.equal(value.status, 'available', JSON.stringify(value));
  assert.ok(value.status === 'available');
  assertClose(value.value, expected, 'value');
  assert.equal(value.quality, quality);
}

Then(
  'the value of {string} at {string} is {float} {string}',
  async function (this: RidrsWorld, series: string, time: string, value: number, quality: string) {
    const at = parseOffset(time);
    await advanceTo(this, at);
    assertAvailable(readerOf(this, series).valueAt(at), value, quality);
  },
);

Then(
  'the value of {string} at {string} is unavailable because of {string}',
  async function (this: RidrsWorld, series: string, time: string, reason: string) {
    const at = parseOffset(time);
    await advanceTo(this, at);
    const value = readerOf(this, series).valueAt(at);
    assert.equal(value.status, 'unavailable', JSON.stringify(value));
    assert.equal(value.status === 'unavailable' && value.reason, reason);
  },
);

let lastAverage: TemporalAverage | undefined;

Then(
  'the {int} s average of {string} at {string} is {float} with a coverage of {float}',
  async function (
    this: RidrsWorld,
    windowSeconds: number,
    series: string,
    time: string,
    value: number,
    coverage: number,
  ) {
    const at = parseOffset(time);
    await advanceTo(this, at);
    lastAverage = readerOf(this, series).average({ window: windowSeconds * 1000, at });
    assertClose(lastAverage.value, value, 'average');
    assertClose(lastAverage.coverage, coverage, 'coverage');
  },
);

Then('its quality is {string}', function (this: RidrsWorld, quality: string) {
  assert.equal(lastAverage?.quality, quality);
});

// ---- Snapshots ---------------------------------------------------------------------------

function snapshotsOf(world: RidrsWorld, pluginId: string): TemporalSnapshot[] {
  return world.snapshots.get(pluginId) ?? [];
}

function assertSnapshotContains(snapshot: TemporalSnapshot, table: DataTable): void {
  for (const row of table.hashes()) {
    const series = row.series ?? '';
    const value = snapshot.values[series];
    assert.ok(value, `The snapshot has no value for "${series}"`);
    const context = `${series}: ${JSON.stringify(value)}`;
    assert.equal(value.status, row.status, context);
    if (value.status === 'available') {
      if (row.value) {
        assertClose(value.value, Number(row.value), context);
      }
      if (row.quality) {
        assert.equal(value.quality, row.quality, context);
      }
      if (row.sourceMeasuredAt) {
        assert.equal(value.sourceMeasuredAt, parseOffset(row.sourceMeasuredAt), context);
      }
    } else if (row.reason) {
      assert.equal(value.reason, row.reason, context);
    }
  }
}

Then(
  '{string} received {int} snapshots',
  function (this: RidrsWorld, pluginId: string, expected: number) {
    assert.equal(snapshotsOf(this, pluginId).length, expected);
  },
);

Then(
  '{string} received the snapshots:',
  function (this: RidrsWorld, pluginId: string, table: DataTable) {
    const actual = snapshotsOf(this, pluginId).map((s) => ({
      at: formatOffset(s.at),
      trigger: s.trigger?.series ?? '',
    }));
    assert.deepEqual(actual, table.hashes());
  },
);

Then(
  'the snapshot of {string} at {string} contains:',
  function (this: RidrsWorld, pluginId: string, time: string, table: DataTable) {
    const at = parseOffset(time);
    const snapshot = snapshotsOf(this, pluginId).findLast((s) => s.at === at);
    assert.ok(snapshot, `"${pluginId}" received no snapshot at ${time}`);
    assertSnapshotContains(snapshot, table);
  },
);

When(
  '{string} requests a snapshot at {string}',
  function (this: RidrsWorld, pluginId: string, time: string) {
    const series = this.getBehavior(pluginId).temporalCombines.flat();
    const ctx = this.ensureHost().getPluginContext(pluginId);
    assert.ok(ctx, `Expected the plugin "${pluginId}" to be running`);
    this.requestedSnapshot = ctx.temporal.snapshot(
      readersOf(this, pluginId, [...new Set(series)]),
      parseOffset(time),
    );
  },
);

Then('that snapshot contains:', function (this: RidrsWorld, table: DataTable) {
  assert.ok(this.requestedSnapshot, 'No snapshot was requested');
  assertSnapshotContains(this.requestedSnapshot, table);
});

Then('it has no trigger', function (this: RidrsWorld) {
  assert.ok(this.requestedSnapshot, 'No snapshot was requested');
  assert.equal(this.requestedSnapshot.trigger, undefined);
});
