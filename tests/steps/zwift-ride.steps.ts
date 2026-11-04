// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type ControllerButtonsChangedPayload,
  controllerButtonsChangedEvent,
  ZWIFT_RIDE_CONTROL_POINT_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_SERVICE_UUID,
} from '@ridrs/contracts';
import { BleSimulator, type SimulatedPeripheral, SimulatedTauriBridge } from '@ridrs/testing';
import type { RidrsWorld } from '../support/world.ts';
import { peripheral } from './devices-and-metrics.steps.ts';

/** The controller the scenario talks to, by world. */
const controllers = new WeakMap<RidrsWorld, SimulatedPeripheral>();

/** Handshakes by name, as hex: "RideOn" in ASCII. */
const HANDSHAKES: Record<string, string> = { RideOn: '526964654f6e' };

function controller(world: RidrsWorld): SimulatedPeripheral {
  const found = controllers.get(world) ?? world.bleSimulator?.peripherals().find(isZwiftRide);
  assert.ok(found, 'Expected a simulated Zwift Ride');
  return found;
}

function isZwiftRide(p: SimulatedPeripheral): boolean {
  return p.serviceUuids.includes(ZWIFT_RIDE_SERVICE_UUID);
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
  const name = controller.name;
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
  'a simulated BLE environment with a Zwift Ride {string}',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    controllers.set(this, this.bleSimulator.addZwiftRide(name));
  },
);

Given(
  'a simulated Tauri bridge with a Zwift Ride {string}',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    controllers.set(this, this.bleSimulator.addZwiftRide(name));
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

Given('the controller {string} is connected', function (this: RidrsWorld, name: string) {
  assert.ok(peripheral(this, name).isConnected(), `Expected "${name}" to be connected`);
});

for (const kind of ['keypad packet', 'packet']) {
  When(`the controller sends the ${kind} {string}`, async function (this: RidrsWorld, hex) {
    packetMarks.set(this, this.hostObserved.length);
    controller(this).notifyZwiftRide(hex);
    await this.settle();
  });
}

Then(
  'the controller {string} received {string} {int} time(s)',
  function (this: RidrsWorld, name: string, handshake: string, times: number) {
    assert.equal(handshakesOf(peripheral(this, name), handshake).length, times);
  },
);

Then(
  'it was already listened to when it received {string}',
  function (this: RidrsWorld, handshake: string) {
    const writes = handshakesOf(controller(this), handshake);
    assert.ok(writes.length > 0, `No "${handshake}" was written`);
    const notifications = `${ZWIFT_RIDE_SERVICE_UUID}:${ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID}`;
    for (const write of writes) {
      assert.ok(write.subscribed.includes(notifications), 'Greeted before it was listened to');
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
