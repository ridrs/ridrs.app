// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type ActivityState,
  activityStateChangedEvent,
  type EventEnvelope,
  type HostDescription,
  type PhysicsState,
  type PluginManifest,
  physicsStateEvent,
  type RecordingEvent,
  RidrsError,
  recordingCompletedEvent,
} from '@ridrs/contracts';
import { type Recording, readRecording } from '@ridrs/recording';
import { TEMPORAL_DEFAULTS } from '@ridrs/temporal';
import { BleSimulator, type SimulatedPeripheral } from '@ridrs/testing';
import type { RidrsWorld } from '../support/world.ts';
import {
  useSimulatedCentral as addSimulatedCentral,
  deliver,
  splitCsv,
  useRealPlugins,
} from './devices-and-metrics.steps.ts';
import { addProbe, currentSessionId, parseOffset, usePhysicsPlugins } from './physics.steps.ts';

const PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');
const DEVICE_PLUGINS = ['device-ftms-trainer', 'device-heart-rate'];
const METRIC_PLUGINS = [
  'metric-power',
  'metric-cadence',
  'metric-heart-rate',
  'metric-power-heart-rate-ratio',
];

// ---- Helpers shared by the recording, export and replay steps ----------------------------------

/** Events of the World's host-level tap, in global publish order. */
export function tappedOf(world: RidrsWorld, type: string): EventEnvelope[] {
  return world.tapped.filter((e) => e.type === type);
}

/** `<session>` in a file name stands for the first 8 characters of the ride's session id. */
export function withSession(world: RidrsWorld, path: string): string {
  return path.includes('<session>')
    ? path.replace('<session>', currentSessionId(world).slice(0, 8))
    : path;
}

function memory(world: RidrsWorld) {
  assert.ok(world.memoryFiles, 'Expected the memory storage');
  return world.memoryFiles;
}

export function memoryFile(world: RidrsWorld, path: string): Uint8Array {
  const bytes = memory(world).files.get(path);
  assert.ok(bytes, `No file "${path}"; files: ${[...memory(world).files.keys()].join(', ')}`);
  return bytes;
}

/** Waits until the ride's recording was completed or failed (compression runs on real I/O). */
export async function settleRecording(world: RidrsWorld): Promise<void> {
  const sessionId = currentSessionId(world);
  await world.waitForIo(
    () =>
      tappedOf(world, recordingCompletedEvent.id).some(
        (e) => (e.payload as { sessionId: string }).sessionId === sessionId,
      ) ||
      world
        .ensureHost()
        .getDiagnostics()
        .some((d) => d.code === 'recording-failed'),
    'the recording to complete',
  );
}

/** "the recording": the decompressed, parsed `.ridrs` of the last ride. */
export async function lastRecording(world: RidrsWorld): Promise<Recording> {
  await settleRecording(world);
  const completed = tappedOf(world, recordingCompletedEvent.id).at(-1);
  assert.ok(completed, 'Expected a "recording.completed" event');
  const file = (completed.payload as { file: string }).file;
  return readRecording(memoryFile(world, file));
}

function eventsOf(recording: Recording): readonly RecordingEvent[] {
  return recording.events;
}

function hostOf(recording: Recording): HostDescription {
  return recording.snapshot.host as unknown as HostDescription;
}

function sectionOf(recording: Recording, section: string): Record<string, unknown> {
  const value = recording.snapshot.sections[section];
  assert.ok(value && typeof value === 'object', `No snapshot section "${section}"`);
  return value as Record<string, unknown>;
}

/** Publishes as the in-process UI bridge does for client code: with the source "ui-bridge". */
export async function publishThroughUiBridge(world: RidrsWorld, eventId: string): Promise<void> {
  world.ensureHost().publishEvent('ui-bridge', world.getEventDefinition(eventId), {});
  await world.settle();
}

function readManifest(id: string): PluginManifest {
  return JSON.parse(readFileSync(resolve(PLUGINS_DIR, id, 'manifest.json'), 'utf8'));
}

// ---- Setup -------------------------------------------------------------------------------

Given(
  'the ridrs physics plugins, {string} and {string} together with a test device plugin {string}, a probe plugin {string} and the memory storage',
  async function (
    this: RidrsWorld,
    first: string,
    second: string,
    deviceId: string,
    probeId: string,
  ) {
    await usePhysicsPlugins(this);
    // The rides of these features deliver heart rate, so its metric runs as well.
    this.realPluginIds.push('metric-heart-rate', first, second);
    await addProbe(this, deviceId, { types: ['device'] });
    await addProbe(this, probeId);
    this.useMemoryStorage();
  },
);

Given(
  'the ridrs plugins {string} together with a probe plugin {string} and the memory storage',
  async function (this: RidrsWorld, pluginsCsv: string, probeId: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    if (this.bleSimulator) {
      // Not a React hook: biome only goes by the `use` prefix.
      await addSimulatedCentral(this);
    }
    await addProbe(this, probeId);
    this.useMemoryStorage();
  },
);

Given(
  'the ridrs physics plugins, the device plugins, the metric plugins and {string} together with a probe plugin {string} and the memory storage',
  async function (this: RidrsWorld, pluginId: string, probeId: string) {
    await usePhysicsPlugins(this);
    this.realPluginIds = [
      ...new Set([...this.realPluginIds, ...DEVICE_PLUGINS, ...METRIC_PLUGINS, pluginId]),
    ];
    await addSimulatedCentral(this);
    await addProbe(this, probeId);
    this.useMemoryStorage();
  },
);

/**
 * The Phase 2 trainer script (as in `fixture-ble-simulator`) and a band that sends 145 bpm every
 * second for as long as it is connected, both on the World's simulator and clock.
 */
Given(
  'a simulated BLE environment with the Phase 2 trainer script {string} and a heart-rate band {string}',
  async function (this: RidrsWorld, trainerName: string, bandName: string) {
    const simulator = new BleSimulator({ clock: this.clock });
    this.bleSimulator = simulator;
    const playTrainer = (trainer: SimulatedPeripheral): void => {
      let connections = 0;
      trainer.onCentralConnected(() => {
        connections += 1;
        if (connections === 1) {
          let sent = 0;
          const tick = (): void => {
            trainer.notifyIndoorBikeData('45 00 B4 00 C8 00');
            sent += 1;
            if (sent < 4) {
              setTimeout(tick, 250);
              return;
            }
            trainer.dropConnectionAndRefuseNew();
            setTimeout(() => trainer.acceptConnections(), 500);
          };
          setTimeout(tick, 250);
        } else {
          const tick = (): void => {
            if (trainer.isConnected()) {
              trainer.notifyIndoorBikeData('45 00 B8 00 DC 00');
              setTimeout(tick, 250);
            }
          };
          setTimeout(tick, 250);
        }
      });
    };
    const playBand = (band: SimulatedPeripheral): void => {
      const stop = band.onCentralConnected(() => {
        stop();
        const tick = (): void => {
          if (band.isConnected()) {
            band.notifyHeartRateMeasurement('00 91');
            setTimeout(tick, 1000);
          }
        };
        setTimeout(tick, 1000);
      });
    };
    let started = false;
    simulator.onScanStart(() => {
      if (started) {
        return;
      }
      started = true;
      setTimeout(() => {
        this.trainer = simulator.addFtmsTrainer(trainerName);
        playTrainer(this.trainer);
      }, 200);
      setTimeout(() => {
        this.heartRateSensor = simulator.addHeartRateSensor(bandName);
        playBand(this.heartRateSensor);
      }, 300);
    });
  },
);

Given('the memory storage fails every write', function (this: RidrsWorld) {
  memory(this).failWrites = true;
});

Given(
  'the memory storage contains an interrupted recording {string} whose last line is torn',
  async function (this: RidrsWorld, path: string) {
    const startedAt = Date.UTC(2026, 10, 1, 9, 0, 0, 0);
    const sessionId = '0badc0de-0000-4000-8000-000000000000';
    const envelope = (seq: number, type: string, timestamp: number, payload: unknown) =>
      JSON.stringify({
        kind: 'event',
        seq,
        preroll: false,
        envelope: { id: `e${seq}`, type, source: 'activity-session', timestamp, payload },
      });
    const lines = [
      JSON.stringify({
        kind: 'header',
        format: 'ridrs.recording',
        formatVersion: 1,
        ridrsVersion: '0.1.0',
        sessionId,
        startedAt,
        timeZoneOffsetMinutes: 0,
        platform: { runtime: 'node', os: 'test', appVersion: '0.1.0' },
        prerollMs: 60_000,
      }),
      JSON.stringify({ kind: 'snapshot', host: {}, sections: {} }),
      envelope(1, 'activity.state-changed', startedAt, { state: 'running', sessionId, startedAt }),
      envelope(2, 'metric.power', startedAt + 1000, {
        status: 'available',
        value: 180,
        unit: 'W',
        deviceId: 'trainer-1',
        measuredAt: startedAt + 1000,
        receivedAt: startedAt + 1000,
      }),
      '{"kind":"event","seq":3,"preroll":fal',
    ];
    await memory(this).write(path, new TextEncoder().encode(lines.join('\n')));
    this.lastRecordingFile = path.replace(/\.jsonl$/, '');
  },
);

// ---- The ride ----------------------------------------------------------------------------

for (const verb of ['publishes', 'published']) {
  When(
    `{string} ${verb} {string} through the UI bridge`,
    async function (this: RidrsWorld, _probe: string, eventId: string) {
      await publishThroughUiBridge(this, eventId);
    },
  );
}

Given(
  'a ride from {string} to {string} with power {float} W every {float} s and heart rate {float} bpm every {float} s was recorded',
  async function (
    this: RidrsWorld,
    from: string,
    to: string,
    power: number,
    powerEvery: number,
    heartRate: number,
    heartRateEvery: number,
  ) {
    const clock = this.fakeClock;
    assert.ok(clock, 'Rides are recorded in @fake-timers scenarios');
    await clock.tickAsync(parseOffset(from) - this.clock.now());
    await publishThroughUiBridge(this, 'activity.start-requested');
    await deliver(
      this,
      'test-device',
      [
        { kind: 'power', device: 'trainer-1', value: power, everyMs: powerEvery * 1000 },
        { kind: 'heart-rate', device: 'hrm-1', value: heartRate, everyMs: heartRateEvery * 1000 },
      ],
      (parseOffset(to) - parseOffset(from)) / 1000,
      false,
    );
    await publishThroughUiBridge(this, 'activity.finish-requested');
    await settleRecording(this);
  },
);

When('the host restarts', async function (this: RidrsWorld) {
  await this.disposeHost();
  await this.ensureHost().start();
  await this.settle();
});

Given(
  'a probe plugin {string} without permissions calls {string}',
  async function (this: RidrsWorld, probeId: string, call: string) {
    assert.equal(call, 'ctx.host.observe');
    await this.writeProbePluginFolder({
      folder: probeId,
      id: probeId,
      types: ['test'],
      module: 'host-spy-plugin.ts',
    });
    // The host has no runtime discovery: compose it again with the probe, like an app restart.
    await this.disposeHost();
    await this.ensureHost().start();
    await this.settle();
    assert.equal(this.ensureHost().getPluginState(probeId), 'started');
  },
);

// ---- Storage -----------------------------------------------------------------------------

Then('the memory storage contains no files', function (this: RidrsWorld) {
  assert.deepEqual([...memory(this).files.keys()], []);
});

Then('the memory storage contains {string}', async function (this: RidrsWorld, path: string) {
  const file = withSession(this, path);
  if (/\.ridrs$/.test(file)) {
    await this.waitForIo(
      () =>
        tappedOf(this, recordingCompletedEvent.id).some(
          (e) => (e.payload as { file: string }).file === file,
        ),
      `"${file}" to be completed`,
    );
  } else {
    await this.waitForIo(() => memory(this).files.has(file), `"${file}"`);
  }
  memoryFile(this, file);
  this.lastRecordingFile = file;
});

Then('it contains no {string} file', function (this: RidrsWorld, suffix: string) {
  const found = [...memory(this).files.keys()].filter((path) => path.endsWith(suffix));
  assert.deepEqual(found, []);
});

Then(
  'the latest {string} event names that file with a distance of {float} m and a duration of {int} ms',
  function (this: RidrsWorld, eventId: string, distance: number, duration: number) {
    const latest = tappedOf(this, eventId).at(-1);
    assert.ok(latest, `Expected a "${eventId}" event`);
    const payload = latest.payload as { file: string; distance?: number; durationMs: number };
    assert.equal(payload.file, this.lastRecordingFile);
    assert.ok(
      payload.distance !== undefined && Math.abs(payload.distance - distance) <= 0.005,
      `distance ${payload.distance}`,
    );
    assert.equal(payload.durationMs, duration);
  },
);

Then('a {string} event names that file', async function (this: RidrsWorld, eventId: string) {
  await this.waitForIo(
    () =>
      tappedOf(this, eventId).some(
        (e) => (e.payload as { file?: string }).file === this.lastRecordingFile,
      ),
    `a "${eventId}" event naming "${this.lastRecordingFile}"`,
  );
});

Then('its footer has the status {string}', async function (this: RidrsWorld, status: string) {
  assert.ok(this.lastRecordingFile, 'Expected a file');
  const recording = await readRecording(memoryFile(this, this.lastRecordingFile));
  assert.equal(recording.footer?.status, status);
});

// ---- Records -----------------------------------------------------------------------------

Then(
  'the first record of the recording is a {string} with the format {string} version {int}',
  async function (this: RidrsWorld, kind: string, format: string, version: number) {
    const { records } = await lastRecording(this);
    assert.equal(records[0]?.kind, kind);
    assert.ok(records[0]?.kind === 'header');
    assert.equal(records[0].format, format);
    assert.equal(records[0].formatVersion, version);
  },
);

Then('the second record is a {string}', async function (this: RidrsWorld, kind: string) {
  assert.equal((await lastRecording(this)).records[1]?.kind, kind);
});

Then(
  'the last record is a {string} with the status {string}',
  async function (this: RidrsWorld, kind: string, status: string) {
    const last = (await lastRecording(this)).records.at(-1);
    assert.equal(last?.kind, kind);
    assert.ok(last?.kind === 'footer');
    assert.equal(last.status, status);
  },
);

Then(
  'the event and diagnostic records are numbered 1, 2, 3 … without gaps, in publish order',
  async function (this: RidrsWorld) {
    const recording = await lastRecording(this);
    const events = eventsOf(recording);
    // Events and diagnostics share one sequence.
    const numbered = recording.records
      .flatMap((record) =>
        record.kind === 'event' || record.kind === 'diagnostic' ? [record.seq] : [],
      )
      .sort((a, b) => a - b);
    assert.deepEqual(
      numbered,
      numbered.map((_, i) => i + 1),
    );
    // The same order as the World's own tap on the bus.
    const recorded = new Set(events.map((e) => e.envelope.id));
    assert.deepEqual(
      events.map((e) => e.envelope.id),
      this.tapped.filter((e) => recorded.has(e.id)).map((e) => e.id),
    );
  },
);

Then(
  'the recording contains every {string} step from {int} to {int} exactly once',
  async function (this: RidrsWorld, eventId: string, from: number, to: number) {
    const steps = eventsOf(await lastRecording(this))
      .filter((e) => e.envelope.type === eventId)
      .flatMap((e) => (e.envelope.payload as { samples: { step: number }[] }).samples)
      .map((sample) => sample.step);
    assert.deepEqual(
      steps,
      Array.from({ length: to - from + 1 }, (_, i) => from + i),
    );
  },
);

Then(
  'every {string}, {string}, {string} and {string} event of the ride is in the recording with its exact payload and timestamp',
  async function (this: RidrsWorld, a: string, b: string, c: string, d: string) {
    const recording = await lastRecording(this);
    // The ride begins with the request that started it; everything before is pre-roll.
    const start = this.tapped.findLastIndex(
      (e) => e.type === 'activity.start-requested' && e.timestamp <= recording.header.startedAt,
    );
    const endedAt = recording.footer?.endedAt ?? Number.POSITIVE_INFINITY;
    for (const type of [a, b, c, d]) {
      const expected = this.tapped
        .slice(start)
        .filter((e) => e.type === type && e.timestamp <= endedAt)
        .map(({ timestamp, payload }) => ({ timestamp, payload }));
      const actual = recording.events
        .filter((e) => !e.preroll && e.envelope.type === type)
        .map(({ envelope: { timestamp, payload } }) => ({ timestamp, payload }));
      assert.ok(expected.length > 0, `Expected "${type}" events during the ride`);
      assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)), type);
    }
  },
);

// ---- Snapshot ----------------------------------------------------------------------------

Then(
  'the snapshot lists the plugin {string} with its version, types, provides and requires',
  async function (this: RidrsWorld, pluginId: string) {
    const plugin = hostOf(await lastRecording(this)).plugins.find((p) => p.id === pluginId);
    assert.ok(plugin, `"${pluginId}" is not in the snapshot`);
    const { version, types, provides, requires } = readManifest(pluginId);
    assert.deepEqual(
      {
        version: plugin.version,
        types: plugin.types,
        provides: plugin.provides,
        requires: plugin.requires,
      },
      { version, types, provides, requires },
    );
  },
);

Then(
  'the snapshot section {string} contains a mass of {float} and a CdA of {float}',
  async function (this: RidrsWorld, section: string, mass: number, cdA: number) {
    const value = sectionOf(await lastRecording(this), section) as {
      mass?: { value: number };
      cdA?: { value: number };
    };
    assert.equal(value.mass?.value, mass);
    assert.equal(value.cdA?.value, cdA);
  },
);

Then(
  'the snapshot section {string} contains the surface factors {string}',
  async function (this: RidrsWorld, section: string, factorsCsv: string) {
    const value = sectionOf(await lastRecording(this), section);
    const expected = Object.fromEntries(
      splitCsv(factorsCsv).map((pair) => {
        const [surface, factor] = pair.split(' ');
        return [surface, Number(factor)];
      }),
    );
    assert.deepEqual(value.surfaceFactors, expected);
  },
);

Then('the snapshot contains the core temporal defaults', async function (this: RidrsWorld) {
  assert.deepEqual(hostOf(await lastRecording(this)).coreDefaults.temporal, {
    ...TEMPORAL_DEFAULTS,
  });
});

// ---- Pre-roll ----------------------------------------------------------------------------

Then(
  "the recording's pre-roll events start at {string}",
  async function (this: RidrsWorld, time: string) {
    const preroll = eventsOf(await lastRecording(this)).filter((e) => e.preroll);
    assert.ok(preroll.length > 0, 'Expected pre-roll events');
    assert.equal(preroll[0]?.envelope.timestamp, parseOffset(time));
  },
);

Then('every pre-roll event is marked as pre-roll', async function (this: RidrsWorld) {
  const recording = await lastRecording(this);
  const events = eventsOf(recording);
  const firstLive = events.findIndex((e) => !e.preroll);
  assert.ok(firstLive > 0, 'Expected pre-roll events before the ride');
  assert.ok(
    events.slice(0, firstLive).every((e) => e.envelope.timestamp <= recording.header.startedAt),
  );
  assert.ok(events.slice(firstLive).every((e) => !e.preroll));
});

Then(
  'the first event that is not pre-roll is {string}',
  async function (this: RidrsWorld, eventId: string) {
    const live = eventsOf(await lastRecording(this)).find((e) => !e.preroll);
    assert.equal(live?.envelope.type, eventId);
  },
);

// ---- Diagnostics and permissions ---------------------------------------------------------

Then('a {string} diagnostic was reported once', async function (this: RidrsWorld, code: string) {
  await this.waitForIo(
    () =>
      this.ensureHost()
        .getDiagnostics()
        .some((d) => d.code === code),
    `a "${code}" diagnostic`,
  );
  assert.equal(
    this.ensureHost()
      .getDiagnostics()
      .filter((d) => d.code === code).length,
    1,
  );
});

Then('a {string} diagnostic was reported', async function (this: RidrsWorld, code: string) {
  await this.waitForIo(
    () =>
      this.ensureHost()
        .getDiagnostics()
        .some((d) => d.code === code),
    `a "${code}" diagnostic`,
  );
});

Then('the call failed with {string}', function (this: RidrsWorld, code: string) {
  assert.ok(this.lastHostCallError instanceof RidrsError, String(this.lastHostCallError));
  assert.equal(this.lastHostCallError.code, code);
});

Then(
  'the manifest of {string} declares the permission {string}',
  function (this: RidrsWorld, pluginId: string, permission: string) {
    assert.ok(readManifest(pluginId).permissions?.includes(permission as 'observe-host'));
  },
);

/** The ride's `running` state, for steps that need the session. */
export function rideState(world: RidrsWorld): Extract<ActivityState, { state: 'running' }> {
  const running = world.hostObserved
    .filter((e) => e.type === activityStateChangedEvent.id)
    .map((e) => e.payload as ActivityState)
    .findLast((s) => s.state === 'running');
  assert.ok(running?.state === 'running', 'Expected a ride');
  return running;
}

// ---- Phase 10: the terrain as an input -------------------------------------------------------

Then(
  'every recorded {string} of the ride is not pre-roll',
  async function (this: RidrsWorld, type: string) {
    const recorded = eventsOf(await lastRecording(this)).filter((e) => e.envelope.type === type);
    assert.ok(recorded.length > 0, `No "${type}" recorded`);
    assert.ok(
      recorded.every((e) => !e.preroll && e.envelope.timestamp >= rideState(this).startedAt),
    );
  },
);

function recordedStatesOfRide(recording: Recording, world: RidrsWorld): PhysicsState[] {
  const { sessionId } = rideState(world);
  const states = eventsOf(recording)
    .filter((e) => e.envelope.type === physicsStateEvent.id)
    .map((e) => e.envelope.payload as PhysicsState)
    .filter((state) => state.sessionId === sessionId);
  assert.ok(states.length > 10, `Only ${states.length} physics states recorded`);
  return states;
}

Then(
  'every recorded {string} of the ride is on {string}',
  async function (this: RidrsWorld, type: string, surface: string) {
    assert.equal(type, physicsStateEvent.id);
    const surfaces = new Set(
      recordedStatesOfRide(await lastRecording(this), this).map((state) => state.road.surface),
    );
    assert.deepEqual([...surfaces], [surface]);
  },
);
