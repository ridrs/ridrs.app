// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type ControllerButton,
  type ControllerButtonsChangedPayload,
  controllerButtonsChangedEvent,
  type DeviceConnectionChangedPayload,
  type DeviceRawNotificationPayload,
  type DeviceStatus,
  deviceConnectionChangedEvent,
  deviceConnectService,
  deviceKindSchema,
  deviceRawNotificationEvent,
  drivetrainGearChangedEvent,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  type RememberedParts,
  rememberedPartsSchema,
  ZWIFT_RIDE_CONTROL_POINT_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_SERVICE_UUID,
} from '@ridrs/contracts';
import { RecordingWriter } from '@ridrs/recording';
import { BleSimulator, type SimulatedPeripheral, SimulatedTauriBridge } from '@ridrs/testing';
import {
  GEAR_DEFAULTS,
  gearRatios,
  shifted,
  shiftOf,
} from '../../plugins/control-virtual-gears/gears.ts';
import { parseZwiftRidePacket } from '../../plugins/device-zwift-ride/parser.ts';
import { deviceStatuses, riderCalls } from '../support/device-links.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

/** The pairs of a scenario's simulated controllers, by name: the left and the right controller. */
const pairs = new WeakMap<
  RidrsWorld,
  Map<string, { left: SimulatedPeripheral; right: SimulatedPeripheral }>
>();

/** Handshakes by name, as hex: "RideOn" in ASCII. */
const HANDSHAKES: Record<string, string> = { RideOn: '526964654f6e' };

/**
 * A Zwift Ride pair of that name in `simulator`: its left and its right controller, each saying
 * which side it is, as their manufacturer data does.
 */
export function addZwiftRidePair(world: RidrsWorld, simulator: BleSimulator, name: string): void {
  const id = `sim-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const left = simulator.addZwiftRide(name, { peripheralId: `${id}-left`, side: 'left' });
  const right = simulator.addZwiftRide(name, { peripheralId: `${id}-right`, side: 'right' });
  const known = pairs.get(world) ?? new Map();
  known.set(name, { left, right });
  pairs.set(world, known);
}

function pairOf(world: RidrsWorld, name?: string) {
  const known = pairs.get(world);
  const pair = name === undefined ? [...(known?.values() ?? [])][0] : known?.get(name);
  assert.ok(pair, `Expected the Zwift Ride pair "${name ?? ''}"`);
  return pair;
}

function side(world: RidrsWorld, which: string): SimulatedPeripheral {
  assert.ok(which === 'left' || which === 'right', `Unknown side "${which}"`);
  return pairOf(world)[which];
}

function byId(world: RidrsWorld, id: string): SimulatedPeripheral {
  const found = world.bleSimulator?.getPeripheralById(id);
  assert.ok(found, `Unknown simulated peripheral with the id "${id}"`);
  return found;
}

function handshakesOf(controller: SimulatedPeripheral, handshake: string) {
  const expected = HANDSHAKES[handshake];
  assert.ok(expected, `Unknown handshake "${handshake}"`);
  const bytes = Buffer.from(expected, 'hex');
  const name = controller.peripheralId;
  const writes = controller.getWrites(
    ZWIFT_RIDE_SERVICE_UUID,
    ZWIFT_RIDE_CONTROL_POINT_CHARACTERISTIC_UUID,
  );
  assert.ok(
    writes.every((w) => Buffer.from(w.data).equals(bytes)),
    `"${name}" received other writes than "${handshake}"`,
  );
  return writes;
}

function buttonChanges(world: RidrsWorld, from = 0): ControllerButtonsChangedPayload[] {
  return world.hostObserved
    .slice(from)
    .filter((e) => e.type === controllerButtonsChangedEvent.id)
    .map((e) => e.payload as ControllerButtonsChangedPayload);
}

function describeButtons(buttons: readonly string[] | undefined): string {
  return buttons === undefined || buttons.length === 0 ? 'none' : buttons.join(', ');
}

const packetMarks = new WeakMap<RidrsWorld, number>();

Given(
  'a simulated BLE environment with the Zwift Ride pair {string}',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    addZwiftRidePair(this, this.bleSimulator, name);
  },
);

Given(
  'a simulated Tauri bridge with the Zwift Ride pair {string}',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    addZwiftRidePair(this, this.bleSimulator, name);
    this.tauriBridge = new SimulatedTauriBridge(this.bleSimulator, this.clock);
    this.tauriBridge.install();
  },
);

Given(
  'the simulated BLE environment also contains a heart-rate sensor {string}',
  function (this: RidrsWorld, name: string) {
    assert.ok(this.bleSimulator, 'Expected a simulated BLE environment');
    this.heartRateSensor = this.bleSimulator.addHeartRateSensor(name);
  },
);

for (const still of ['', 'still ']) {
  Then(
    `both controllers of {string} are ${still}connected`,
    function (this: RidrsWorld, name: string) {
      for (const controller of Object.values(pairOf(this, name))) {
        assert.ok(
          controller.isConnected(),
          `Expected "${controller.peripheralId}" to be connected`,
        );
      }
    },
  );
}

for (const kind of ['keypad packet', 'packet']) {
  When(
    `the {word} controller sends the ${kind} {string}`,
    async function (this: RidrsWorld, which: string, hex: string) {
      packetMarks.set(this, this.hostObserved.length);
      side(this, which).notifyZwiftRide(hex);
      await this.settle();
    },
  );
}

When(
  'the {word} controller drops the connection and refuses new connections',
  async function (this: RidrsWorld, which: string) {
    side(this, which).dropConnectionAndRefuseNew();
    await this.settle();
  },
);

When('the {word} controller accepts connections again', async function (this: RidrsWorld, which) {
  side(this, which).acceptConnections();
  await this.settle();
});

Then(
  'each controller of {string} received {string} {int} time(s)',
  function (this: RidrsWorld, name: string, handshake: string, times: number) {
    for (const controller of Object.values(pairOf(this, name))) {
      assert.equal(handshakesOf(controller, handshake).length, times, controller.peripheralId);
    }
  },
);

Then(
  'the {word} controller received {string} {int} time(s)',
  function (this: RidrsWorld, which: string, handshake: string, times: number) {
    assert.equal(handshakesOf(side(this, which), handshake).length, times);
  },
);

Then(
  'each controller was already listened to when it received {string}',
  function (this: RidrsWorld, handshake: string) {
    for (const controller of Object.values(pairOf(this))) {
      const writes = handshakesOf(controller, handshake);
      assert.ok(writes.length > 0, `No "${handshake}" was written`);
      const notifications = `${ZWIFT_RIDE_SERVICE_UUID}:${ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID}`;
      for (const write of writes) {
        assert.ok(write.subscribed.includes(notifications), 'Greeted before it was listened to');
      }
    }
  },
);

Then('the buttons held down are {string}', function (this: RidrsWorld, expected: string) {
  assert.equal(describeButtons(buttonChanges(this).at(-1)?.buttons), expected);
});

Then('the buttons held down were:', function (this: RidrsWorld, table: DataTable) {
  assert.deepEqual(
    buttonChanges(this).map((p) => ({ buttons: describeButtons(p.buttons) })),
    table.hashes(),
  );
});

Then('no button change was published', function (this: RidrsWorld) {
  assert.deepEqual(buttonChanges(this, packetMarks.get(this) ?? 0), []);
});

Then('no button change was published for {string}', function (this: RidrsWorld, id: string) {
  assert.deepEqual(
    buttonChanges(this).filter((p) => p.deviceId === id),
    [],
  );
});

// ---- The pair: two controllers named alike, told apart by id ------------------------------

Given(
  'a simulated BLE environment with the Zwift Ride controllers {string} and {string}',
  function (this: RidrsWorld, left: string, right: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    for (const peripheralId of [left, right]) {
      this.bleSimulator.addZwiftRide('Zwift Ride', { peripheralId });
    }
  },
);

Given(
  'the simulated BLE environment also contains a Zwift Ride with the id {string}',
  async function (this: RidrsWorld, peripheralId: string) {
    assert.ok(this.bleSimulator, 'Expected a simulated BLE environment');
    this.bleSimulator.addZwiftRide('Zwift Ride', { peripheralId });
    await this.settle();
  },
);

Then('the controller with the id {string} is connected', function (this: RidrsWorld, id: string) {
  assert.ok(byId(this, id).isConnected(), `Expected "${id}" to be connected`);
});

Then(
  'the controller with the id {string} was never connected',
  function (this: RidrsWorld, id: string) {
    assert.equal(byId(this, id).wasEverConnected(), false);
  },
);

Then(
  'the controller with the id {string} received {string} {int} time(s)',
  function (this: RidrsWorld, id: string, handshake: string, times: number) {
    assert.equal(handshakesOf(byId(this, id), handshake).length, times);
  },
);

When(
  'the controller with the id {string} sends the keypad packet {string}',
  async function (this: RidrsWorld, id: string, hex: string) {
    byId(this, id).notifyZwiftRide(hex);
    await this.settle();
  },
);

Then(
  'the buttons held down on {string} are {string}',
  function (this: RidrsWorld, id: string, expected: string) {
    const latest = buttonChanges(this)
      .filter((p) => p.deviceId === id)
      .at(-1);
    assert.equal(describeButtons(latest?.buttons), expected);
  },
);

for (const verb of [
  'drops the connection and refuses new connections',
  'accepts connections again',
]) {
  When(
    `the controller with the id {string} ${verb}`,
    async function (this: RidrsWorld, id: string) {
      const controller = byId(this, id);
      if (verb === 'accepts connections again') {
        controller.acceptConnections();
      } else {
        controller.dropConnectionAndRefuseNew();
      }
      await this.settle();
    },
  );
}

Then('the controller with the id {string} is not connected', function (this: RidrsWorld, id) {
  assert.equal(byId(this, id).isConnected(), false, `Expected "${id}" not to be connected`);
});

for (const not of ['', 'not ']) {
  Then(
    `the controllers with the ids {string} are ${not}connected`,
    function (this: RidrsWorld, ids) {
      for (const id of splitCsv(ids)) {
        assert.equal(
          byId(this, id).isConnected(),
          not === '',
          `"${id}" is ${not}expected connected`,
        );
      }
    },
  );
}

// ---- Two sets in a room, told apart by side and signal --------------------------------------

Given(
  'a simulated BLE environment with the Zwift Ride controllers:',
  function (this: RidrsWorld, table: DataTable) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    for (const row of table.hashes()) {
      const which = row.side;
      assert.ok(which === 'left' || which === 'right', `Unknown side "${which}"`);
      this.bleSimulator.addZwiftRide('Zwift Ride', {
        peripheralId: row.id ?? '',
        side: which,
        ...(row.signal ? { rssi: Number(row.signal) } : {}),
      });
    }
  },
);

When(
  'the simulated BLE environment also contains the {word} Zwift Ride controller {string}',
  async function (this: RidrsWorld, which: string, peripheralId: string) {
    assert.ok(this.bleSimulator, 'Expected a simulated BLE environment');
    assert.ok(which === 'left' || which === 'right', `Unknown side "${which}"`);
    this.bleSimulator.addZwiftRide('Zwift Ride', { peripheralId, side: which });
    await this.settle();
  },
);

function controllerStatus(world: RidrsWorld, kind: string): DeviceStatus {
  const status = deviceStatuses(world).find((d) => d.kind === kind);
  assert.ok(status, `Expected a status for "${kind}"`);
  return status;
}

Then(
  'the device status gives the {string} the id {string}',
  function (this: RidrsWorld, kind: string, id: string) {
    assert.equal(controllerStatus(this, kind).deviceId, id);
  },
);

Then(
  'the device status offers the {string} devices {string}',
  function (this: RidrsWorld, kind: string, ids: string) {
    assert.deepEqual(
      controllerStatus(this, kind).candidates?.map((c) => c.deviceId),
      splitCsv(ids),
    );
  },
);

Then(
  'the device status of the {string} waits for its {string} part',
  function (this: RidrsWorld, kind: string, part: string) {
    assert.deepEqual(controllerStatus(this, kind).missingParts, [part]);
  },
);

Then(
  'the device status of the {string} waits for no part',
  function (this: RidrsWorld, kind: string) {
    assert.equal(controllerStatus(this, kind).missingParts, undefined);
  },
);

Then(
  'the latest connection state of {string} names the parts:',
  function (this: RidrsWorld, pluginId: string, table: DataTable) {
    const latest = this.observed
      .filter((e) => e.type === deviceConnectionChangedEvent.id && e.source === pluginId)
      .map((e) => e.payload as DeviceConnectionChangedPayload)
      .at(-1);
    assert.deepEqual(
      latest?.parts?.map((p) => ({ part: p.part, id: p.deviceId })),
      table.hashes(),
    );
  },
);

for (const verb of ['connects', 'connected']) {
  When(
    `the rider ${verb} the other {string} pair`,
    async function (this: RidrsWorld, kind: string) {
      const status = controllerStatus(this, kind);
      const other = status.candidates?.find((c) => c.deviceId !== status.deviceId);
      assert.ok(other, `Expected another ${kind} found`);
      await riderCalls(this, deviceConnectService, deviceKindSchema.parse(kind), {
        deviceId: other.deviceId,
      });
    },
  );
}

// ---- What the plugin remembers, now and before the pair --------------------------------------

/** The settings documents of the plugin: one for the pair, one per link before. */
function documentPath(pluginId: string, name: string): string {
  return `config/machine/${pluginId}/${name}.json`;
}

async function writeDocument(world: RidrsWorld, path: string, text: string): Promise<void> {
  await world.settingsFiles.write(path, new TextEncoder().encode(text));
}

function linkEntry(peripheralId: string): string {
  const value = { state: 'chosen', route: 'local', peripheralId, name: 'Zwift Ride' };
  return JSON.stringify({ version: 1, value });
}

Given(
  '{string} remembered {string} and {string} with one link each, as before the pair',
  async function (this: RidrsWorld, pluginId: string, first: string, second: string) {
    await writeDocument(this, documentPath(pluginId, 'device-controller'), linkEntry(first));
    await writeDocument(this, documentPath(pluginId, 'device-controller-2'), linkEntry(second));
  },
);

Given(
  "{string} remembered {string} with its first link, and its second link's document holds {string}, as before the pair",
  async function (this: RidrsWorld, pluginId: string, first: string, text: string) {
    await writeDocument(this, documentPath(pluginId, 'device-controller'), linkEntry(first));
    await writeDocument(this, documentPath(pluginId, 'device-controller-2'), text);
  },
);

Then(
  '{string} remembers the pair {string} with the controllers {string}',
  async function (this: RidrsWorld, pluginId: string, id: string, ids: string) {
    await this.settle();
    const bytes = this.settingsFiles.files.get(documentPath(pluginId, 'device-controller'));
    assert.ok(bytes, 'Expected the remembered pair');
    const document = JSON.parse(new TextDecoder().decode(bytes)) as {
      version: number;
      value: RememberedParts;
    };
    assert.equal(document.version, 2);
    const value = rememberedPartsSchema.parse(document.value);
    assert.equal(value.state, 'chosen');
    if (value.state === 'chosen') {
      assert.equal(value.deviceId, id);
      assert.deepEqual(
        value.parts.map((p) => p.peripheralId),
        splitCsv(ids),
      );
    }
  },
);

// ---- A recording from before the pair ---------------------------------------------------------

/** When the hand-made recording starts, and how far apart its inputs are. */
const RECORDED_FROM = 1_700_000_000_000;
const STEP_MS = 1000;

Given(
  'a recording from before the pair with {string} and {string}, in which:',
  function (this: RidrsWorld, devicePlugin: string, gearsPlugin: string, table: DataTable) {
    // As the plugin recorded it with one link per controller: a connection state per controller,
    // no parts, and the buttons of each under its own id.
    const writer = new RecordingWriter();
    const events: string[] = [];
    let at = RECORDED_FROM;
    let id = 0;
    const event = (type: string, source: string, payload: unknown, input: boolean): void => {
      id += 1;
      events.push(
        writer.event(
          {
            type,
            timestamp: at,
            json: JSON.stringify({
              id: `e${id}`,
              type,
              source,
              timestamp: at,
              payload,
              ...(input ? { input: true } : {}),
            }),
          },
          false,
        ),
      );
    };
    const rows = table.hashes();
    const controllers = [...new Set(rows.map((r) => r.controller ?? ''))].sort();
    for (const deviceId of controllers) {
      at += STEP_MS;
      const connection: DeviceConnectionChangedPayload = {
        deviceId,
        deviceName: 'Zwift Ride',
        kind: 'controller',
        state: 'connected',
        route: 'local',
      };
      event(deviceConnectionChangedEvent.id, devicePlugin, connection, true);
    }
    const held = new Map<string, readonly string[]>();
    let gear: number = GEAR_DEFAULTS.startGear;
    const ratios = gearRatios();
    for (const row of rows) {
      at += STEP_MS;
      const deviceId = row.controller ?? '';
      const hex = (row['keypad packet'] ?? '').replace(/\s+/g, '');
      const raw: DeviceRawNotificationPayload = {
        deviceId,
        deviceName: 'Zwift Ride',
        serviceUuid: ZWIFT_RIDE_SERVICE_UUID,
        characteristicUuid: ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
        data: hex,
        receivedAt: at,
      };
      event(deviceRawNotificationEvent.id, devicePlugin, raw, true);
      const parsed = parseZwiftRidePacket(Buffer.from(hex, 'hex'));
      assert.ok(parsed.ok && parsed.buttons, `"${hex}" is no keypad packet`);
      const before = held.get(deviceId) ?? [];
      held.set(deviceId, parsed.buttons);
      event(
        controllerButtonsChangedEvent.id,
        devicePlugin,
        { deviceId, buttons: parsed.buttons },
        false,
      );
      const by = shiftOf(before as ControllerButton[], parsed.buttons);
      const next = shifted(gear, by, ratios.length);
      if (next !== gear) {
        gear = next;
        const payload = { index: gear, ratio: ratios[gear - 1] ?? 1, count: ratios.length };
        event(drivetrainGearChangedEvent.id, gearsPlugin, payload, false);
      }
    }
    const plugin = (pluginId: string, types: readonly string[]) => ({
      id: pluginId,
      version: '0.1.0',
      types,
      state: 'started',
    });
    const lines = [
      writer.header({
        format: RECORDING_FORMAT,
        formatVersion: RECORDING_FORMAT_VERSION,
        ridrsVersion: '0.0.0',
        sessionId: 'before-the-pair',
        startedAt: RECORDED_FROM,
        timeZoneOffsetMinutes: 0,
        platform: { runtime: 'node', os: 'test', appVersion: '0.0.0' },
        prerollMs: 0,
      }),
      writer.snapshot({
        host: { plugins: [plugin(devicePlugin, ['device']), plugin(gearsPlugin, ['control'])] },
        sections: {},
      }),
      ...events,
      writer.footer('complete', at + STEP_MS),
    ];
    this.replayLines = lines
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
  },
);
