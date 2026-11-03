// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type DeviceRawNotificationPayload,
  deviceRawNotificationEvent,
  type EventEnvelope,
  measurementPowerEvent,
  type RiderCapability,
  RidrsError,
} from '@ridrs/contracts';
import { createFileSystemPluginSource } from '@ridrs/core/node';
import { gunzip, parseRecording } from '@ridrs/recording';
import { type ReplayResult, replay } from '@ridrs/replay';
import type { RidrsWorld } from '../support/world.ts';
import { addProbe } from './physics.steps.ts';
import { lastRecording, memoryFile, settleRecording, tappedOf } from './recording.steps.ts';

const REAL_PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');

// ---- Raw device data -----------------------------------------------------------------------

for (const verb of ['notifies', 'notified']) {
  When(`the trainer ${verb} {string}`, async function (this: RidrsWorld, hex: string) {
    assert.ok(this.trainer, 'Expected a simulated trainer');
    this.packetMark = this.tapped.length;
    this.trainer.notifyIndoorBikeData(hex);
    await this.settle();
  });
}

function latestOfPacket(world: RidrsWorld, type: string): EventEnvelope | undefined {
  return world.tapped
    .slice(world.packetMark)
    .filter((e) => e.type === type)
    .at(-1);
}

function latestRaw(world: RidrsWorld, type: string): DeviceRawNotificationPayload {
  assert.equal(type, deviceRawNotificationEvent.id);
  const envelope = latestOfPacket(world, type);
  assert.ok(envelope, `Expected a "${type}" event`);
  world.lastEnvelope = envelope;
  return envelope.payload as DeviceRawNotificationPayload;
}

Then(
  'the latest {string} event has the data {string}, the service {string} and the characteristic {string}',
  function (this: RidrsWorld, type: string, data: string, service: string, characteristic: string) {
    const raw = latestRaw(this, type);
    assert.deepEqual(
      { data: raw.data, service: raw.serviceUuid, characteristic: raw.characteristicUuid },
      { data, service, characteristic },
    );
  },
);

Then(
  'the latest {string} event has the data {string}',
  function (this: RidrsWorld, type: string, data: string) {
    assert.equal(latestRaw(this, type).data, data);
  },
);

Then('its source is {string}', function (this: RidrsWorld, source: string) {
  assert.equal(this.lastEnvelope?.source, source);
});

Then(
  'it was published before the {string} event of the same packet',
  function (this: RidrsWorld, type: string) {
    const raw = this.lastEnvelope;
    const decoded = latestOfPacket(this, type);
    assert.ok(raw && decoded, `Expected the raw and the "${type}" event of the packet`);
    assert.ok(this.tapped.indexOf(raw) < this.tapped.indexOf(decoded));
  },
);

Then('no {string} event was published for it', function (this: RidrsWorld, type: string) {
  assert.equal(type, measurementPowerEvent.id);
  assert.equal(latestOfPacket(this, type), undefined);
});

Then(
  'the recording contains {int} {string} events with the data {string} and {string}',
  async function (this: RidrsWorld, count: number, type: string, first: string, second: string) {
    const raws = (await lastRecording(this)).events
      .filter((e) => e.envelope.type === type)
      .map((e) => (e.envelope.payload as DeviceRawNotificationPayload).data);
    assert.equal(raws.length, count);
    assert.deepEqual(raws, [first, second]);
  },
);

Then(
  'the recording contains a {string} record with the code {string}',
  async function (this: RidrsWorld, kind: string, code: string) {
    const found = (await lastRecording(this)).records.filter(
      (r) => r.kind === kind && 'code' in r && r.code === code,
    );
    assert.ok(found.length > 0, `No "${kind}" record with the code "${code}"`);
  },
);

// ---- Replaying ---------------------------------------------------------------------------

/** The recording's lines, as the replay steps change them before replaying. */
async function recordingLines(world: RidrsWorld): Promise<string[]> {
  if (!world.replayLines) {
    await settleRecording(world);
    const completed = tappedOf(world, 'recording.completed').at(-1);
    assert.ok(completed, 'Expected a recorded ride');
    const file = (completed.payload as { file: string }).file;
    const text = new TextDecoder().decode(await gunzip(memoryFile(world, file)));
    world.replayLines = text.split('\n').filter((line) => line.length > 0);
  }
  return world.replayLines;
}

/** Replays on a replay clock of its own: the scenario's clock does not take part. */
async function replayOnce(
  world: RidrsWorld,
  replace?: Readonly<Record<string, string>>,
): Promise<ReplayResult> {
  const lines = await recordingLines(world);
  const recording = parseRecording(lines.join('\n'), { events: world.eventDefinitions.values() });
  return replay(recording, {
    sources: [world.tempPluginDir, REAL_PLUGINS_DIR, ...world.extraPluginDirs].map(
      createFileSystemPluginSource,
    ),
    capabilities: world.capabilityContracts.values(),
    events: world.eventDefinitions.values(),
    replace,
  });
}

async function replayInto(
  world: RidrsWorld,
  replace?: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    world.replayResults.push(await replayOnce(world, replace));
  } catch (error) {
    world.replayError = error;
  }
}

function result(world: RidrsWorld): ReplayResult {
  assert.equal(world.replayError, undefined, String(world.replayError));
  const last = world.replayResults.at(-1);
  assert.ok(last, 'Expected a replay');
  return last;
}

When('the recording is replayed', async function (this: RidrsWorld) {
  await replayInto(this);
});

When('the recording is replayed twice', async function (this: RidrsWorld) {
  await replayInto(this);
  await replayInto(this);
});

When(
  'the recording is replayed with {string} replaced by a probe plugin {string} that provides {string} with a mass of {float} kg and a CdA of {float} m²',
  async function (
    this: RidrsWorld,
    replaced: string,
    probeId: string,
    capability: string,
    mass: number,
    cdA: number,
  ) {
    const rider: RiderCapability = {
      parameters: () => ({
        mass: { value: mass, origin: 'default' },
        cdA: { value: cdA, origin: 'default' },
      }),
    };
    this.getBehavior(probeId).providedImplementations.set(capability, rider);
    await addProbe(this, probeId, { types: ['physics'], provides: [capability] });
    await replayInto(this, { [replaced]: probeId });
  },
);

Then('the replay is identical', function (this: RidrsWorld) {
  const { identical, firstDifference } = result(this);
  assert.ok(identical, `First difference: ${JSON.stringify(firstDifference)}`);
});

Then('the replay is not identical', function (this: RidrsWorld) {
  assert.equal(result(this).identical, false);
});

Then(
  /^the replay compared every (.+) event of the ride$/,
  function (this: RidrsWorld, list: string) {
    const types = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    assert.equal(types.length, 10);
    const { streams } = result(this);
    for (const type of types) {
      const of = streams.filter((s) => s.type === type);
      assert.ok(of.length > 0 && of.every((s) => s.recorded > 0), `No "${type}" events compared`);
      for (const stream of of) {
        assert.equal(stream.matched, stream.recorded, `${type} from ${stream.source}`);
        assert.equal(stream.replayed, stream.recorded, `${type} from ${stream.source}`);
      }
    }
  },
);

Then('the replay reports no configuration differences', function (this: RidrsWorld) {
  assert.deepEqual(result(this).configuration, {
    versionChanges: [],
    missingPlugins: [],
    addedPlugins: [],
    sections: [],
  });
});

Then('both replays are deep-equal', function (this: RidrsWorld) {
  assert.equal(this.replayResults.length, 2);
  assert.deepEqual(this.replayResults[1], this.replayResults[0]);
});

Then(
  'the first difference is in {string} step {int} at the field {string}: {int} recorded, {int} replayed',
  function (
    this: RidrsWorld,
    type: string,
    step: number,
    field: string,
    recorded: number,
    replayed: number,
  ) {
    const difference = result(this).firstDifference;
    assert.ok(difference, 'Expected a difference');
    assert.equal(difference.type, type);
    assert.equal(difference.index, step, 'the first state of a ride is step 0');
    assert.equal(difference.path, field);
    assert.equal(difference.recorded, recorded);
    assert.equal(difference.replayed, replayed);
  },
);

Then(
  'the {string} and {string} step {int} streams match up to their first difference',
  function (this: RidrsWorld, first: string, second: string, step: number) {
    const { streams } = result(this);
    const firstStreams = streams.filter((s) => s.type === first);
    assert.ok(firstStreams.length > 0, `No "${first}" stream`);
    for (const stream of firstStreams) {
      assert.equal(stream.matched, stream.recorded, `"${first}" does not depend on the rider`);
    }
    // Batches hold five steps each: the one with step 0 still matches.
    const batches = streams.find((s) => s.type === second);
    assert.ok(batches && batches.matched >= Math.floor(step / 5) + 1, JSON.stringify(batches));
    assert.ok(batches.matched < batches.recorded, `"${second}" never diverged`);
  },
);

Then(
  'the replay reports that the configuration section {string} is missing',
  function (this: RidrsWorld, section: string) {
    assert.ok(
      result(this).configuration.sections.some(
        (s) => s.section === section && s.change === 'missing',
      ),
      JSON.stringify(result(this).configuration),
    );
  },
);

Then(
  'the replay reports that the plugin {string} is missing and {string} was added',
  function (this: RidrsWorld, missing: string, added: string) {
    const { configuration } = result(this);
    assert.deepEqual(configuration.missingPlugins, [missing]);
    assert.deepEqual(configuration.addedPlugins, [added]);
  },
);

// ---- Changed recordings ------------------------------------------------------------------

function changeRecord(
  lines: string[],
  index: number,
  change: (record: Record<string, unknown>) => void,
): void {
  const record = JSON.parse(lines[index] ?? '{}') as Record<string, unknown>;
  change(record);
  lines[index] = JSON.stringify(record);
}

/** Inserts lines before the footer, the last line. */
function insertBeforeFooter(lines: string[], ...added: string[]): void {
  lines.splice(lines.length - 1, 0, ...added);
}

Given(
  "the recording's snapshot lists {string} with the version {string}",
  async function (this: RidrsWorld, pluginId: string, version: string) {
    changeRecord(await recordingLines(this), 1, (snapshot) => {
      const host = snapshot.host as { plugins: { id: string; version: string }[] };
      const plugin = host.plugins.find((p) => p.id === pluginId);
      assert.ok(plugin, `"${pluginId}" is not in the snapshot`);
      plugin.version = version;
    });
  },
);

Given(
  "the recording's header has the format version {int}",
  async function (this: RidrsWorld, version: number) {
    changeRecord(await recordingLines(this), 0, (header) => {
      header.formatVersion = version;
    });
  },
);

Given(
  'the recording contains an extra record of the kind {string}',
  async function (this: RidrsWorld, kind: string) {
    insertBeforeFooter(
      await recordingLines(this),
      JSON.stringify({ kind, note: 'from a future ridrs' }),
    );
  },
);

Given(
  'the recording contains an event of the unknown type {string} from the source {string}',
  async function (this: RidrsWorld, type: string, source: string) {
    const lines = await recordingLines(this);
    const header = JSON.parse(lines[0] ?? '{}') as { startedAt: number };
    const footer = JSON.parse(lines.at(-1) ?? '{}') as { lastSeq: number };
    insertBeforeFooter(
      lines,
      JSON.stringify({
        kind: 'event',
        seq: footer.lastSeq + 1,
        preroll: false,
        envelope: {
          id: 'future-1',
          type,
          source,
          timestamp: header.startedAt + 1000,
          payload: { anything: [1, 'two'] },
          // Recorded as an input, as a newer ridrs would record one.
          input: true,
          receivedAt: header.startedAt + 1000,
        },
      }),
    );
  },
);

Then(
  'the replay reports the plugin version change {string}: {string} recorded, the current version now',
  function (this: RidrsWorld, pluginId: string, recorded: string) {
    const current = this.ensureHost().getPluginManifest(pluginId)?.version;
    assert.deepEqual(result(this).configuration.versionChanges, [
      { plugin: pluginId, recorded, current },
    ]);
  },
);

Then('the replay failed with {string}', function (this: RidrsWorld, code: string) {
  assert.ok(this.replayError instanceof RidrsError, String(this.replayError));
  assert.equal(this.replayError.code, code);
});

Then('the replay ignored the {string} record', function (this: RidrsWorld, kind: string) {
  assert.equal(result(this).ignoredRecordKinds[kind], 1);
});

Then(
  'the replay republished {string} as an input event',
  function (this: RidrsWorld, type: string) {
    assert.ok(
      result(this).inputs.some((input) => input.type === type && input.count === 1),
      JSON.stringify(result(this).inputs),
    );
  },
);
