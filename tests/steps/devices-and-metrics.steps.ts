// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type CapabilityContract,
  type DeviceConnectionChangedPayload,
  deviceConnectionChangedEvent,
  type EventDefinition,
  type MeasurementPayload,
  type MetricCapability,
  type MetricReading,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  measurementPowerEvent,
} from '@ridrs/contracts';
import { BleSimulator, type SimulatedPeripheral, SimulatedTauriBridge } from '@ridrs/testing';
import type { RidrsWorld } from '../support/world.ts';

const METRIC_PLUGIN_CAPABILITIES: Record<string, string> = {
  'metric-power': 'metric.power',
  'metric-cadence': 'metric.cadence',
  'metric-heart-rate': 'metric.heart-rate',
  'metric-power-heart-rate-ratio': 'metric.power-heart-rate-ratio',
};

/** Measurement events by the word scenarios use for them. */
const MEASUREMENT_EVENTS: Record<string, EventDefinition<MeasurementPayload>> = {
  power: measurementPowerEvent,
  cadence: measurementCadenceEvent,
  'heart-rate': measurementHeartRateEvent,
};

function measurementEvent(kind: string): EventDefinition<MeasurementPayload> {
  const event = MEASUREMENT_EVENTS[kind];
  assert.ok(event, `Unknown measurement kind "${kind}"`);
  return event;
}

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

function currentHeartRateSensor(world: RidrsWorld): SimulatedPeripheral {
  assert.ok(world.heartRateSensor, 'Expected a simulated heart-rate sensor');
  return world.heartRateSensor;
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

export async function useSimulatedCentral(world: RidrsWorld): Promise<void> {
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
  const contract = world.capabilityContracts.get(capabilityId);
  assert.ok(contract?.cardinality === 'single', `Unknown metric "${capabilityId}"`);
  return ctx.capabilities.get(contract as CapabilityContract<MetricCapability, 'single'>).latest();
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

for (const device of ['trainer', 'heart-rate sensor']) {
  When(
    `the ${device} {string} drops the connection and refuses new connections`,
    async function (this: RidrsWorld, name: string) {
      peripheral(this, name).dropConnectionAndRefuseNew();
      await this.settle();
    },
  );

  When(
    `the ${device} {string} accepts connections again`,
    async function (this: RidrsWorld, name: string) {
      peripheral(this, name).acceptConnections();
      await this.settle();
    },
  );
}

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

for (const device of ['trainer', 'heart-rate sensor']) {
  Then(`the ${device} {string} is still connected`, function (this: RidrsWorld, name: string) {
    assert.ok(peripheral(this, name).isConnected());
  });
}

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
    const m = lastMeasurementOfAnyKind(this);
    assert.equal(m?.measuredAt, parseTime(time));
    assert.equal(m?.timestampOrigin, origin);
  },
);

Then('it names the trainer {string} as its device', function (this: RidrsWorld, name: string) {
  assert.equal(lastMeasurement(this, measurementPowerEvent)?.deviceId, deviceId(this, name));
});

function lastMeasurementOfAnyKind(world: RidrsWorld): MeasurementPayload | undefined {
  const types = new Set(Object.values(MEASUREMENT_EVENTS).map((event) => event.id));
  return world.observed.filter((e) => types.has(e.type)).at(-1)?.payload as
    | MeasurementPayload
    | undefined;
}

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
  for (const event of Object.values(MEASUREMENT_EVENTS)) {
    assert.equal(eventsOf(this, event).length, 0, `${event.id} was published`);
  }
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

export function publishMeasurement(
  world: RidrsWorld,
  pluginId: string,
  kind: string,
  value: number,
  device: string,
): void {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
  const now = world.clock.now();
  // A test device delivers from outside the host: an external input.
  ctx.inputs.accept(measurementEvent(kind), {
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
  ctx.inputs.accept(deviceConnectionChangedEvent, {
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

Then('the manifest of {string} requires nothing', function (this: RidrsWorld, id: string) {
  assert.deepEqual(this.ensureHost().getPluginManifest(id)?.requires, []);
});

Then(
  'the manifest of {string} requires exactly {string}',
  function (this: RidrsWorld, id: string, capabilities: string) {
    assert.deepEqual(this.ensureHost().getPluginManifest(id)?.requires, splitCsv(capabilities));
  },
);

// ---- Phase 4: rates, interleaved sources, derived metrics ----------------------------------

When(
  '{string} publishes {int} {word} measurements of {float} {word} from device {string} every {float} second(s)',
  async function (
    this: RidrsWorld,
    plugin: string,
    count: number,
    kind: string,
    value: number,
    _unit: string,
    device: string,
    seconds: number,
  ) {
    assert.ok(this.fakeClock, 'Time can only pass in @fake-timers scenarios');
    for (let i = 0; i < count; i += 1) {
      if (i > 0) {
        await this.fakeClock.tickAsync(Math.round(seconds * 1000));
      }
      publishMeasurement(this, plugin, kind, value, device);
      await this.settle();
    }
  },
);

interface Delivery {
  readonly kind: 'power' | 'heart-rate';
  readonly device: string;
  readonly value: number;
  readonly everyMs: number;
}

/**
 * Delivers interleaved series from `start` to `end`: each at its own interval, power before heart
 * rate at equal times, ending with the clock at the last delivery. A "more" delivery continues
 * one interval after each series' previous delivery, so nothing is delivered twice.
 */
export async function deliver(
  world: RidrsWorld,
  plugin: string,
  deliveries: readonly Delivery[],
  seconds: number,
  more: boolean,
): Promise<void> {
  assert.ok(world.fakeClock, 'Time can only pass in @fake-timers scenarios');
  const start = world.clock.now();
  const end = start + Math.round(seconds * 1000);
  const plan: Array<{ at: number; delivery: Delivery }> = [];
  for (const delivery of deliveries) {
    const previous = world.lastDeliveries.get(delivery.kind);
    const first = more && previous !== undefined ? previous + delivery.everyMs : start;
    for (let at = first; at <= end; at += delivery.everyMs) {
      plan.push({ at, delivery });
    }
  }
  plan.sort((a, b) => a.at - b.at);
  for (const { at, delivery } of plan) {
    await world.fakeClock.tickAsync(at - world.clock.now());
    publishMeasurement(world, plugin, delivery.kind, delivery.value, delivery.device);
    world.lastDeliveries.set(delivery.kind, at);
    await world.settle();
  }
}

for (const verb of ['delivers', 'delivered']) {
  for (const more of [false, true]) {
    When(
      `{string} ${verb} power {float} W every {float} s and heart rate {float} bpm every {float} s for {float} ${more ? 'more ' : ''}second(s)`,
      async function (
        this: RidrsWorld,
        plugin: string,
        power: number,
        powerEvery: number,
        heartRate: number,
        heartRateEvery: number,
        seconds: number,
      ) {
        await deliver(
          this,
          plugin,
          [
            { kind: 'power', device: 'trainer-1', value: power, everyMs: powerEvery * 1000 },
            {
              kind: 'heart-rate',
              device: 'hrm-1',
              value: heartRate,
              everyMs: heartRateEvery * 1000,
            },
          ],
          seconds,
          more,
        );
      },
    );
  }
}

for (const verb of ['delivers', 'delivered']) {
  When(
    `{string} ${verb} only power {float} W every {float} s for {float} second(s)`,
    async function (
      this: RidrsWorld,
      plugin: string,
      power: number,
      every: number,
      seconds: number,
    ) {
      await deliver(
        this,
        plugin,
        [{ kind: 'power', device: 'trainer-1', value: power, everyMs: every * 1000 }],
        seconds,
        false,
      );
    },
  );
}

When(
  '{string} delivers only power {float} W every {float} s for {float} more second(s)',
  async function (this: RidrsWorld, plugin: string, power: number, every: number, seconds: number) {
    await deliver(
      this,
      plugin,
      [{ kind: 'power', device: 'trainer-1', value: power, everyMs: every * 1000 }],
      seconds,
      true,
    );
  },
);

Then(
  'the latest {string} is {float} {word}',
  function (this: RidrsWorld, capability: string, expected: number, unit: string) {
    const reading = latestMetric(this, capability);
    assert.equal(reading.status, 'available', JSON.stringify(reading));
    assert.ok(reading.status === 'available');
    assert.equal(reading.unit, unit);
    // Compared after rounding half up to the precision the scenario states.
    const decimals = String(expected).split('.')[1]?.length ?? 0;
    const rounded = Math.round(Number(`${reading.value}e${decimals}`)) / 10 ** decimals;
    assert.equal(rounded, expected, `value ${reading.value}`);
  },
);

// ---- Phase 4: heart-rate sensor ----------------------------------------------------------

Given(
  'a simulated BLE environment with a heart-rate sensor {string}',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.heartRateSensor = this.bleSimulator.addHeartRateSensor(name);
  },
);

Given(
  'the simulated BLE environment also contains an FTMS trainer {string}',
  function (this: RidrsWorld, name: string) {
    this.trainer = simulator(this).addFtmsTrainer(name);
  },
);

Given(
  'the ridrs plugin {string} is running with the simulated BLE central',
  async function (this: RidrsWorld, pluginId: string) {
    // The host has no runtime discovery: compose it again with one more plugin, like an app
    // restart. The simulated devices keep their history.
    await this.disposeHost();
    this.realPluginIds.push(pluginId);
    await this.ensureHost().start();
    await this.settle();
  },
);

Given('the heart-rate sensor {string} is connected', function (this: RidrsWorld, name: string) {
  assert.ok(peripheral(this, name).isConnected(), `Expected "${name}" to be connected`);
});

When(
  'the heart-rate sensor sends the Heart Rate Measurement packet {string}',
  async function (this: RidrsWorld, hex: string) {
    this.packetMark = this.observed.length;
    currentHeartRateSensor(this).notifyHeartRateMeasurement(hex);
    await this.settle();
  },
);

Then(
  'the published heart-rate measurement is {string}',
  function (this: RidrsWorld, expected: string) {
    const m = lastMeasurement(this, measurementHeartRateEvent, this.packetMark);
    assert.equal(describe(m?.value, 'bpm'), expected);
  },
);

Then(
  'the heart-rate measurement was received at {string}',
  function (this: RidrsWorld, time: string) {
    assert.equal(lastMeasurement(this, measurementHeartRateEvent)?.receivedAt, parseTime(time));
  },
);

Then(
  'it names the heart-rate sensor {string} as its device',
  function (this: RidrsWorld, name: string) {
    assert.equal(lastMeasurement(this, measurementHeartRateEvent)?.deviceId, deviceId(this, name));
  },
);

Then(
  'the plugin {string} never connected to {string}',
  function (this: RidrsWorld, pluginId: string, name: string) {
    const states = this.observed.filter(
      (e) => e.type === deviceConnectionChangedEvent.id && e.source === pluginId,
    );
    assert.ok(states.length > 0, `"${pluginId}" published no connection states`);
    const id = deviceId(this, name);
    const named = states.filter(
      (e) => (e.payload as DeviceConnectionChangedPayload).deviceId === id,
    );
    assert.deepEqual(named, [], `"${pluginId}" connected to "${name}"`);
  },
);
