// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type DeviceConnectionChangedPayload,
  deviceConnectionChangedEvent,
  type EventDefinition,
  type MeasurementPayload,
  type MetricCapability,
  type MetricReading,
  measurementCadenceEvent,
  measurementPowerEvent,
  metricCadenceCapability,
  metricPowerCapability,
} from '@ridrs/contracts';
import { BleSimulator, type SimulatedPeripheral, SimulatedTauriBridge } from '@ridrs/testing';
import type { RidrsWorld } from '../support/world.ts';

const METRIC_PLUGIN_CAPABILITIES: Record<string, string> = {
  'metric-power': 'metric.power',
  'metric-cadence': 'metric.cadence',
};

export function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** "10:00:00.250" means that time on 2026-11-01 UTC. */
export function parseTime(text: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(text);
  assert.ok(match, `Unrecognized time "${text}"`);
  const [, h, m, s, ms] = match.map(Number);
  return Date.UTC(2026, 10, 1, h, m, s, ms);
}

function simulator(world: RidrsWorld): BleSimulator {
  assert.ok(world.bleSimulator, 'Expected a simulated BLE environment');
  return world.bleSimulator;
}

export function peripheral(world: RidrsWorld, name: string): SimulatedPeripheral {
  const found = simulator(world).getPeripheralByName(name);
  assert.ok(found, `Unknown simulated peripheral "${name}"`);
  return found;
}

function currentTrainer(world: RidrsWorld): SimulatedPeripheral {
  assert.ok(world.trainer, 'Expected a simulated trainer');
  return world.trainer;
}

export async function useRealPlugins(world: RidrsWorld, ids: string[]): Promise<void> {
  world.realPluginIds = [...ids];
  await world.writeProbePluginFolder({
    folder: 'test-observer',
    id: 'test-observer',
    types: ['test'],
    module: 'observer-plugin.ts',
  });
  const metricCapabilities = ids
    .map((id) => METRIC_PLUGIN_CAPABILITIES[id])
    .filter((cap): cap is string => cap !== undefined);
  if (metricCapabilities.length > 0) {
    await world.writeProbePluginFolder({
      folder: 'test-reader',
      id: 'test-reader',
      types: ['test'],
      requires: metricCapabilities,
    });
  }
}

async function useSimulatedCentral(world: RidrsWorld): Promise<void> {
  world.getBehavior('ble-simulator').providedImplementations.set('ble.central', simulator(world));
  await world.writeProbePluginFolder({
    folder: 'ble-simulator',
    id: 'ble-simulator',
    types: ['transport'],
    provides: ['ble.central'],
  });
}

function eventsOf<T>(world: RidrsWorld, event: EventDefinition, from = 0): T[] {
  return world.observed
    .slice(from)
    .filter((e) => e.type === event.id)
    .map((e) => e.payload as T);
}

function deviceId(world: RidrsWorld, trainerName: string): string {
  return peripheral(world, trainerName).peripheralId;
}

function connectionStates(world: RidrsWorld, trainerName: string): string[] {
  const id = deviceId(world, trainerName);
  // "searching" is published before a device is known and therefore carries no device id.
  return eventsOf<DeviceConnectionChangedPayload>(world, deviceConnectionChangedEvent)
    .filter((p) => p.deviceId === id || p.deviceId === '')
    .map((p) => p.state);
}

function describe(value: number | undefined, unit: string): string {
  return value === undefined ? 'none' : `${value} ${unit}`;
}

function lastMeasurement(
  world: RidrsWorld,
  event: EventDefinition,
  from = 0,
): MeasurementPayload | undefined {
  return eventsOf<MeasurementPayload>(world, event, from).at(-1);
}

export function latestMetric(world: RidrsWorld, capabilityId: string): MetricReading {
  const ctx = world.ensureHost().getPluginContext('test-reader');
  assert.ok(ctx, 'Expected the test reader plugin to be running');
  const capability: MetricCapability =
    capabilityId === 'metric.power'
      ? ctx.capabilities.get(metricPowerCapability)
      : ctx.capabilities.get(metricCadenceCapability);
  return capability.latest();
}

// ---- Environment setup -------------------------------------------------------------------

Given(
  'a simulated BLE environment with an FTMS trainer {string}',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = this.bleSimulator.addFtmsTrainer(name);
  },
);

Given(
  'a simulated Tauri bridge with an FTMS trainer {string}',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = this.bleSimulator.addFtmsTrainer(name);
    this.tauriBridge = new SimulatedTauriBridge(this.bleSimulator, this.clock);
    this.tauriBridge.install();
  },
);

Given(
  'the simulated BLE environment also contains a peripheral {string} without FTMS',
  function (this: RidrsWorld, name: string) {
    simulator(this).addPeripheral({ name, serviceUuids: ['180d'] });
  },
);

Given(
  'the ridrs plugins {string} running with the simulated BLE central',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    await useSimulatedCentral(this);
    await this.ensureHost().start();
    await this.settle();
  },
);

Given('the ridrs plugins {string} running', async function (this: RidrsWorld, pluginsCsv: string) {
  await useRealPlugins(this, splitCsv(pluginsCsv));
  await this.ensureHost().start();
  await this.settle();
});

Given(
  'the ridrs plugins {string} with the simulated BLE central',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    await useSimulatedCentral(this);
  },
);

Given(
  'the ridrs plugins {string} together with a test device plugin {string}',
  async function (this: RidrsWorld, pluginsCsv: string, deviceId: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    await this.writeProbePluginFolder({ folder: deviceId, id: deviceId, types: ['device'] });
  },
);

Given('the host clock shows {string}', function (this: RidrsWorld, time: string) {
  assert.ok(this.fakeClock, 'The host clock can only be set in @fake-timers scenarios');
  this.fakeClock.setSystemTime(parseTime(time));
});

When('{float} second(s) pass(es)', async function (this: RidrsWorld, seconds: number) {
  assert.ok(this.fakeClock, 'Time can only pass in @fake-timers scenarios');
  await this.fakeClock.tickAsync(Math.round(seconds * 1000));
});

// ---- Trainer simulation ------------------------------------------------------------------

Given('the trainer {string} is connected', function (this: RidrsWorld, name: string) {
  assert.ok(peripheral(this, name).isConnected(), `Expected "${name}" to be connected`);
});

Given('the trainer {string} is switched off', function (this: RidrsWorld, name: string) {
  peripheral(this, name).switchOff();
});

When('the trainer {string} is switched on', async function (this: RidrsWorld, name: string) {
  peripheral(this, name).switchOn();
  await this.settle();
});

When(
  'the trainer {string} drops the connection and refuses new connections',
  async function (this: RidrsWorld, name: string) {
    peripheral(this, name).dropConnectionAndRefuseNew();
    await this.settle();
  },
);

When(
  'the trainer {string} accepts connections again',
  async function (this: RidrsWorld, name: string) {
    peripheral(this, name).acceptConnections();
    await this.settle();
  },
);

When(
  'the trainer sends the Indoor Bike Data packet {string}',
  async function (this: RidrsWorld, hex: string) {
    this.packetMark = this.observed.length;
    currentTrainer(this).notifyIndoorBikeData(hex);
    await this.settle();
  },
);

// ---- Device assertions -------------------------------------------------------------------

Then(
  'the connection states of {string} were {string}',
  function (this: RidrsWorld, name: string, expectedCsv: string) {
    assert.deepEqual(connectionStates(this, name), splitCsv(expectedCsv));
  },
);

Then(
  'the connection state of {string} is {string}',
  function (this: RidrsWorld, name: string, expected: string) {
    assert.equal(connectionStates(this, name).at(-1), expected);
  },
);

Then(
  'the last connection state of {string} is {string}',
  function (this: RidrsWorld, name: string, expected: string) {
    assert.equal(connectionStates(this, name).at(-1), expected);
  },
);

Then(
  'the plugin is subscribed to Indoor Bike Data of {string}',
  function (this: RidrsWorld, name: string) {
    assert.ok(peripheral(this, name).isSubscribedToIndoorBikeData());
  },
);

Then('the plugin connected to {string}', function (this: RidrsWorld, name: string) {
  assert.ok(peripheral(this, name).wasEverConnected());
});

Then('the plugin never connected to {string}', function (this: RidrsWorld, name: string) {
  assert.equal(peripheral(this, name).wasEverConnected(), false);
});

Then('the simulated Tauri bridge received no new scan request', function (this: RidrsWorld) {
  assert.ok(this.tauriBridge, 'Expected a simulated Tauri bridge');
  assert.equal(this.tauriBridge.scanRequestCount(), 1);
});

Then('the simulated Tauri bridge holds no subscriptions', function (this: RidrsWorld) {
  assert.ok(this.tauriBridge, 'Expected a simulated Tauri bridge');
  assert.equal(this.tauriBridge.subscriptionCount(), 0);
});

Then('the trainer {string} is no longer connected', function (this: RidrsWorld, name: string) {
  assert.equal(peripheral(this, name).isConnected(), false);
});

Then('the trainer {string} is still connected', function (this: RidrsWorld, name: string) {
  assert.ok(peripheral(this, name).isConnected());
});

Then(
  'the reconnection attempts were made after waiting {string} seconds',
  function (this: RidrsWorld, expectedCsv: string) {
    assert.deepEqual(
      currentTrainer(this).getReconnectWaitDurationsSeconds(),
      splitCsv(expectedCsv).map(Number),
    );
  },
);

Then('no reconnection attempt was made after the plugin stopped', function (this: RidrsWorld) {
  const mark = this.stopMarks.get('device-ftms-trainer');
  assert.ok(mark, 'Expected the plugin to have been stopped');
  assert.equal(simulator(this).connectAttemptCount(), mark.connectAttempts);
});

Then('the simulated BLE central has no active scan', function (this: RidrsWorld) {
  assert.equal(simulator(this).hasActiveScan(), false);
});

Then("the plugin's abort signal is aborted", function (this: RidrsWorld) {
  const ctx = this.ensureHost().getPluginContext('device-ftms-trainer');
  assert.ok(ctx);
  assert.equal(ctx.signal.aborted, true);
});

// ---- Measurement assertions --------------------------------------------------------------

Then('the published power measurement is {string}', function (this: RidrsWorld, expected: string) {
  const m = lastMeasurement(this, measurementPowerEvent, this.packetMark);
  assert.equal(describe(m?.value, 'W'), expected);
});

Then(
  'the published cadence measurement is {string}',
  function (this: RidrsWorld, expected: string) {
    const m = lastMeasurement(this, measurementCadenceEvent, this.packetMark);
    assert.equal(describe(m?.value, 'rpm'), expected);
  },
);

Then('the power measurement was received at {string}', function (this: RidrsWorld, time: string) {
  assert.equal(lastMeasurement(this, measurementPowerEvent)?.receivedAt, parseTime(time));
});

Then(
  'its measurement time is {string} with the timestamp origin {string}',
  function (this: RidrsWorld, time: string, origin: string) {
    const m = lastMeasurement(this, measurementPowerEvent);
    assert.equal(m?.measuredAt, parseTime(time));
    assert.equal(m?.timestampOrigin, origin);
  },
);

Then('it names the trainer {string} as its device', function (this: RidrsWorld, name: string) {
  assert.equal(lastMeasurement(this, measurementPowerEvent)?.deviceId, deviceId(this, name));
});

function assertMeasurementTable(world: RidrsWorld, event: EventDefinition, table: DataTable) {
  const actual = eventsOf<MeasurementPayload>(world, event).map((m) => ({
    value: m.value,
    receivedAt: m.receivedAt,
  }));
  const expected = table.hashes().map((row) => ({
    value: Number(row.value),
    receivedAt: parseTime(row.receivedAt ?? ''),
  }));
  assert.deepEqual(actual, expected);
}

Then('the power measurements were:', function (this: RidrsWorld, table: DataTable) {
  assertMeasurementTable(this, measurementPowerEvent, table);
});

Then('the cadence measurements were:', function (this: RidrsWorld, table: DataTable) {
  assertMeasurementTable(this, measurementCadenceEvent, table);
});

Then('no measurement events were published', function (this: RidrsWorld) {
  assert.equal(eventsOf(this, measurementPowerEvent).length, 0);
  assert.equal(eventsOf(this, measurementCadenceEvent).length, 0);
});

// ---- Problems reported by the host -------------------------------------------------------

Then(
  'the host reported exactly one {string} problem for plugin {string} mentioning {string}',
  function (this: RidrsWorld, code: string, pluginId: string, snippet: string) {
    const found = this.ensureHost()
      .getDiagnostics()
      .filter((d) => d.code === code && d.pluginId === pluginId);
    assert.equal(found.length, 1);
    assert.ok(found[0]?.message.includes(snippet), found[0]?.message ?? 'no message');
  },
);

// ---- Test device and metrics -------------------------------------------------------------

function publishMeasurement(
  world: RidrsWorld,
  pluginId: string,
  kind: string,
  value: number,
  device: string,
): void {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
  const now = world.clock.now();
  ctx.events.publish(kind === 'power' ? measurementPowerEvent : measurementCadenceEvent, {
    deviceId: device,
    value,
    measuredAt: now,
    receivedAt: now,
    timestampOrigin: 'receive',
  });
}

function reportConnection(world: RidrsWorld, pluginId: string, device: string, state: string) {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
  ctx.events.publish(deviceConnectionChangedEvent, {
    deviceId: device,
    deviceName: device,
    state: state as DeviceConnectionChangedPayload['state'],
  });
}

for (const verb of ['publishes', 'published']) {
  When(
    `{string} ${verb} a(n) {word} measurement of {float} {word} from device {string}`,
    async function (
      this: RidrsWorld,
      plugin: string,
      kind: string,
      value: number,
      _unit: string,
      device: string,
    ) {
      publishMeasurement(this, plugin, kind, value, device);
      await this.settle();
    },
  );
}

for (const verb of ['reports', 'reported']) {
  When(
    `{string} ${verb} device {string} as {string}`,
    async function (this: RidrsWorld, plugin: string, device: string, state: string) {
      reportConnection(this, plugin, device, state);
      await this.settle();
    },
  );
}

Then(
  'the latest {string} is unavailable because of {string}',
  function (this: RidrsWorld, capability: string, reason: string) {
    const reading = latestMetric(this, capability);
    assert.equal(reading.status, 'unavailable');
    assert.equal(reading.status === 'unavailable' && reading.reason, reason);
  },
);

function assertAvailable(
  world: RidrsWorld,
  capability: string,
  value: number,
  device: string,
  time: string,
): void {
  const reading = latestMetric(world, capability);
  assert.equal(reading.status, 'available', JSON.stringify(reading));
  assert.ok(reading.status === 'available');
  assert.equal(reading.value, value);
  assert.equal(reading.deviceId, device);
  assert.equal(reading.measuredAt, parseTime(time));
}

Then(
  'the latest {string} is {float} {word} from device {string} measured at {string}',
  function (
    this: RidrsWorld,
    capability: string,
    value: number,
    _unit: string,
    device: string,
    time: string,
  ) {
    assertAvailable(this, capability, value, device, time);
  },
);

Then(
  'the latest {string} is {float} {word} from the trainer {string} measured at {string}',
  function (
    this: RidrsWorld,
    capability: string,
    value: number,
    _unit: string,
    name: string,
    time: string,
  ) {
    assertAvailable(this, capability, value, deviceId(this, name), time);
  },
);

Then(
  'a {string} event with {float} {word} was published',
  function (this: RidrsWorld, type: string, value: number, _unit: string) {
    const found = this.observed.filter(
      (e) => e.type === type && (e.payload as { value?: number }).value === value,
    );
    assert.ok(found.length > 0, `Expected a "${type}" event with ${value}`);
  },
);

Then(
  'exactly one {string} event reporting {string} was published',
  function (this: RidrsWorld, type: string, status: string) {
    const found = this.observed.filter(
      (e) => e.type === type && (e.payload as { status?: string }).status === status,
    );
    assert.equal(found.length, 1);
  },
);

Then(
  'no {string} event was published after the plugin stopped',
  function (this: RidrsWorld, type: string) {
    const mark = this.stopMarks.get(type.replace('metric.', 'metric-'));
    assert.ok(mark, 'Expected the plugin to have been stopped');
    assert.equal(this.observed.slice(mark.observed).filter((e) => e.type === type).length, 0);
  },
);

// ---- Manifests ---------------------------------------------------------------------------

Then('the manifest of {string} requires no capability', function (this: RidrsWorld, id: string) {
  assert.deepEqual(this.ensureHost().getPluginManifest(id)?.requires, []);
});

Then(
  'the manifest of {string} requires exactly {string}',
  function (this: RidrsWorld, id: string, capability: string) {
    assert.deepEqual(this.ensureHost().getPluginManifest(id)?.requires, [capability]);
  },
);
