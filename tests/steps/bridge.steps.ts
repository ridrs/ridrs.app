// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { AfterStep, type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { BridgeRejectedError, BridgeSession } from '@ridrs/ble-bridge';
import {
  DUMMY_PROFILES,
  DummyDevices,
  type DummyProfile,
  mergeBleCentrals,
} from '@ridrs/ble-simulator';
import {
  type BleCentral,
  type BleDiscoveredPeripheral,
  type BridgeState,
  bridgeCompanionsState,
  bridgeConnectService,
  bridgeDisconnectService,
  bridgeForgetService,
  bridgeLinkState,
  bridgePairingState,
  bridgePairService,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  parsePairingUri,
} from '@ridrs/contracts';
import {
  BleSimulator,
  SimulatedBridgeConnector,
  SimulatedCompanion,
  SimulatedNetwork,
} from '@ridrs/testing';
import { riderDiscovers } from '../support/device-links.ts';
import type { RidrsWorld } from '../support/world.ts';
import {
  latestMetric,
  peripheral,
  splitCsv,
  useRealPlugins as withRealPlugins,
  useSimulatedCentral as withSimulatedCentral,
} from './devices-and-metrics.steps.ts';

const COMPANION_ADDRESS = '192.168.178.110:42229';
const MOVED_ADDRESS = '192.168.178.111:42229';

type Attempt = { session: BridgeSession } | { error: unknown };

/** Results of the protocol scenarios' connection attempts, per World. */
const attempts = new WeakMap<RidrsWorld, { first?: Attempt; second?: Attempt; token?: string }>();
const received = new WeakMap<RidrsWorld, Uint8Array[]>();
const pendingCompanion = new WeakMap<RidrsWorld, { name: string }>();

function state(world: RidrsWorld) {
  let entry = attempts.get(world);
  if (!entry) {
    entry = {};
    attempts.set(world, entry);
  }
  return entry;
}

function companion(world: RidrsWorld): SimulatedCompanion {
  assert.ok(world.companion, 'Expected a companion (its pairing code makes it start)');
  return world.companion;
}

function network(world: RidrsWorld): SimulatedNetwork {
  world.bridgeNetwork ??= new SimulatedNetwork();
  return world.bridgeNetwork;
}

function connector(world: RidrsWorld): SimulatedBridgeConnector {
  world.bridgeConnector ??= new SimulatedBridgeConnector(network(world));
  return world.bridgeConnector;
}

function hexBytes(hex: string): number[] {
  return hex
    .trim()
    .split(/\s+/)
    .map((byte) => Number.parseInt(byte, 16));
}

async function attempt(
  world: RidrsWorld,
  credentials: { pairingCode?: string; pairingSecret?: string; token?: string; protocol?: string },
): Promise<Attempt> {
  const socket = await network(world).open(companion(world).address);
  // Handled right away: a rejection must not surface as unhandled while time is settling.
  const outcome = BridgeSession.open(socket, {
    clock: world.clock,
    clientName: 'ridrs test',
    ...credentials,
  }).then(
    (session): Attempt => {
      world.bridgeSessions.push(session);
      return { session };
    },
    (error: unknown): Attempt => ({ error }),
  );
  await world.settle();
  return outcome;
}

function welcomed(result: Attempt | undefined): BridgeSession {
  assert.ok(result, 'Expected a connection attempt');
  assert.ok(
    'session' in result,
    `Expected a welcome, got ${String((result as { error: unknown }).error)}`,
  );
  return result.session;
}

function rejectedWith(result: Attempt | undefined, reason: string): void {
  assert.ok(result && 'error' in result, 'Expected the companion to reject the connection');
  const { error } = result;
  assert.ok(error instanceof BridgeRejectedError, String(error));
  assert.equal(error.reason, reason);
}

/** The bridge's state as the app shows it (ADR 0069: the app state `bridge.state`). */
function latestBridgeState(world: RidrsWorld) {
  const payload = world
    .stateValues<{ state: BridgeState; reason?: string }>(bridgeLinkState.id)
    .at(-1);
  assert.ok(payload, 'Expected a "bridge.state" value');
  return payload;
}

function listedCompanions(world: RidrsWorld) {
  const payload = world
    .stateValues<{ companions: { name: string; address: string; paired: boolean }[] }>(
      bridgeCompanionsState.id,
    )
    .at(-1);
  assert.ok(payload, 'Expected a "bridge.companions" value');
  return payload.companions;
}

async function runOverNetwork(
  world: RidrsWorld,
  pluginsCsv: string,
  options: { readonly local?: boolean } = {},
): Promise<void> {
  await withRealPlugins(world, splitCsv(pluginsCsv));
  if (options.local) {
    // This device's Bluetooth as well: both links run at once.
    await withSimulatedCentral(world);
  }
  world
    .getBehavior('bridge-network')
    .providedImplementations.set('ble-bridge.connector', connector(world));
  await world.writeProbePluginFolder({
    folder: 'bridge-network',
    id: 'bridge-network',
    types: ['transport'],
    provides: ['ble-bridge.connector'],
  });
  await world.writeProbePluginFolder({
    folder: 'test-bridge-ui',
    id: 'test-bridge-ui',
    types: ['test'],
  });
  await world.ensureHost().start();
  await world.settle();
}

/** The rider pairs, as the UI does: a call of `bridge.pair` (ADR 0069). */
async function requestPairing(world: RidrsWorld, address: string, code: string): Promise<void> {
  await world
    .ensureHost()
    .callService(bridgePairService.id, { address, code }, { pluginId: 'ui-bridge' });
  await world.flushState();
}

// ---- Companion setup -----------------------------------------------------------------------

Given(
  'a companion {string} wrapping a simulated BLE environment with an FTMS trainer {string}',
  function (this: RidrsWorld, name: string, trainerName: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = this.bleSimulator.addFtmsTrainer(trainerName);
    this.companionCentral = this.bleSimulator;
    pendingCompanion.set(this, { name });
  },
);

Given(
  'a companion {string} wrapping a simulated BLE environment with an FTMS trainer {string} that supports simulation and target power',
  function (this: RidrsWorld, name: string, trainerName: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = this.bleSimulator.addFtmsTrainer(trainerName, {
      control: { simulation: true, targetPower: true },
    });
    this.companionCentral = this.bleSimulator;
    pendingCompanion.set(this, { name });
  },
);

Given(
  'a companion {string} wrapping a simulated BLE environment with a Zwift Ride {string}',
  function (this: RidrsWorld, name: string, controllerName: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.bleSimulator.addZwiftRide(controllerName);
    this.companionCentral = this.bleSimulator;
    pendingCompanion.set(this, { name });
  },
);

Given(
  'a companion {string} that sees an FTMS trainer {string}',
  function (this: RidrsWorld, name: string, trainerName: string) {
    // Its own devices: the phone gives the trainer another id than this device does.
    this.companionSimulator = new BleSimulator({ clock: this.clock });
    this.companionSimulator.addFtmsTrainer(trainerName, {
      peripheralId: `phone-${trainerName.toLowerCase().replaceAll(' ', '-')}`,
    });
    this.companionCentral = this.companionSimulator;
    pendingCompanion.set(this, { name });
  },
);

/**
 * "0157 a1b2c3d4": a company id (or a service) and the bytes it advertises; several are separated
 * by commas. Empty: none.
 */
export function advertisedData(cell: string | undefined): Record<string, string> | undefined {
  const parts = splitCsv(cell ?? '');
  if (parts.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    parts.map((part) => {
      const [key = '', ...bytes] = part.split(/\s+/);
      return [key.toLowerCase(), bytes.join('').toLowerCase()];
    }),
  );
}

/** FTMS trainers with the advertising data of each row; ids are numbered, as names repeat. */
function addTrainers(simulator: BleSimulator, table: DataTable, idPrefix: string) {
  return table.hashes().map((row, i) => {
    const name = row.device ?? '';
    const manufacturerData = advertisedData(row['manufacturer data']);
    const serviceData = advertisedData(row['service data']);
    return simulator.addFtmsTrainer(name, {
      peripheralId: `${idPrefix}-${name.toLowerCase().replaceAll(' ', '-')}-${i + 1}`,
      ...(manufacturerData ? { manufacturerData } : {}),
      ...(serviceData ? { serviceData } : {}),
    });
  });
}

Given(
  'a simulated BLE environment with the FTMS trainers:',
  function (this: RidrsWorld, table: DataTable) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = addTrainers(this.bleSimulator, table, 'sim')[0];
  },
);

Given(
  'a companion {string} that sees the FTMS trainers:',
  function (this: RidrsWorld, name: string, table: DataTable) {
    // Its own devices: the phone gives every trainer another id than this device does.
    this.companionSimulator = new BleSimulator({ clock: this.clock });
    addTrainers(this.companionSimulator, table, 'phone');
    this.companionCentral = this.companionSimulator;
    pendingCompanion.set(this, { name });
  },
);

When(
  'ridrs runs paired with the companion and the device setup looks for devices',
  async function (this: RidrsWorld) {
    const pending = pendingCompanion.get(this);
    assert.ok(pending && this.companionCentral, 'Expected a companion to be described first');
    this.companion = new SimulatedCompanion({
      network: network(this),
      name: pending.name,
      address: COMPANION_ADDRESS,
      central: this.companionCentral,
      clock: this.clock,
      code: '482913',
    });
    connector(this).savePairing({
      companionId: this.companion.authority.companionId,
      companionName: pending.name,
      address: this.companion.address,
      token: this.companion.authority.issueToken('ridrs'),
    });
    await runOverNetwork(this, 'transport-ble-bridge, device-ftms-trainer', {
      local: true,
    });
    await riderDiscovers(this, true);
    // A device only the companion saw waits for the direct link this long.
    assert.ok(this.fakeClock, 'Expected a @fake-timers scenario');
    await this.fakeClock.tickAsync(2000);
    await this.settle();
  },
);

When(
  "the companion's trainer {string} advertises the manufacturer data {string}",
  async function (this: RidrsWorld, name: string, data: string) {
    const trainer = this.companionSimulator?.getPeripheralByName(name);
    assert.ok(trainer, `Expected the companion to see "${name}"`);
    trainer.advertise({ manufacturerData: advertisedData(data) ?? {} });
    await this.settle();
  },
);

Given('a simulated BLE environment without devices', function (this: RidrsWorld) {
  this.bleSimulator = new BleSimulator({ clock: this.clock });
});

for (const verb of ['run', 'running']) {
  Given(
    `the ridrs plugins {string} ${verb} with the simulated BLE central and over the simulated network`,
    async function (this: RidrsWorld, pluginsCsv: string) {
      await runOverNetwork(this, pluginsCsv, { local: true });
    },
  );
}

Given('the companion shows the pairing code {string}', function (this: RidrsWorld, code: string) {
  const pending = pendingCompanion.get(this);
  assert.ok(pending && this.companionCentral, 'Expected a companion to be described first');
  this.companion = new SimulatedCompanion({
    network: network(this),
    name: pending.name,
    address: COMPANION_ADDRESS,
    central: this.companionCentral,
    clock: this.clock,
    code,
  });
});

Given('the companion is not announced in the network', function (this: RidrsWorld) {
  network(this).setAnnounced(companion(this).address, false);
});

Given('the companion moved to another address', function (this: RidrsWorld) {
  companion(this).moveTo(MOVED_ADDRESS);
});

Given('the companion forgot all pairings', function (this: RidrsWorld) {
  companion(this).authority.forgetAll();
});

Given('the companion clock runs {int} seconds ahead', function (this: RidrsWorld, seconds: number) {
  companion(this).clockOffsetMs = seconds * 1000;
});

Given('the platform reports connection failures as plain text', function (this: RidrsWorld) {
  connector(this).failuresAsText = true;
});

Given('the companion left the network', function (this: RidrsWorld) {
  companion(this).leave();
});

When('the companion leaves the network', async function (this: RidrsWorld) {
  companion(this).leave();
  await this.settle();
});

When('the companion joins the network again', async function (this: RidrsWorld) {
  companion(this).join();
  await this.settle();
});

When(
  'the network delivers nothing for {int} seconds',
  async function (this: RidrsWorld, seconds: number) {
    assert.ok(this.fakeClock, 'Time can only pass in @fake-timers scenarios');
    network(this).stall();
    await this.fakeClock.tickAsync(seconds * 1000);
    network(this).resume();
    await this.settle();
  },
);

// ---- Protocol: ridrs side driven directly ------------------------------------------------------

When(
  'ridrs connects to the companion with the code {string}',
  async function (this: RidrsWorld, code: string) {
    state(this).first = await attempt(this, { pairingCode: code });
  },
);

Given(
  'ridrs tried the code {string} {int} times',
  async function (this: RidrsWorld, code: string, times: number) {
    for (let i = 0; i < times; i += 1) {
      rejectedWith(await attempt(this, { pairingCode: code }), 'bad-code');
    }
  },
);

Given('ridrs paired with the companion', async function (this: RidrsWorld) {
  const result = await attempt(this, { pairingCode: companion(this).authority.code });
  state(this).first = result;
  state(this).token = welcomed(result).welcome.token;
});

Given('ridrs paired with the companion and kept the token', async function (this: RidrsWorld) {
  const result = await attempt(this, { pairingCode: companion(this).authority.code });
  const session = welcomed(result);
  state(this).token = session.welcome.token;
  session.close();
  await this.settle();
});

When('ridrs reconnects to the companion with the stored token', async function (this: RidrsWorld) {
  const token = state(this).token;
  assert.ok(token, 'Expected a stored token');
  state(this).first = await attempt(this, { token });
});

When(
  'ridrs reconnects to the companion with the token {string}',
  async function (this: RidrsWorld, token: string) {
    state(this).first = await attempt(this, { token });
  },
);

When(
  'ridrs connects to the companion speaking protocol {string}',
  async function (this: RidrsWorld, protocol: string) {
    state(this).first = await attempt(this, {
      pairingCode: companion(this).authority.code,
      protocol,
    });
  },
);

When(
  'a second ridrs connects to the companion with the code {string}',
  async function (this: RidrsWorld, code: string) {
    state(this).second = await attempt(this, { pairingCode: code });
  },
);

Then('the companion welcomes ridrs and issues a token', function (this: RidrsWorld) {
  assert.match(welcomed(state(this).first).welcome.token, /^[0-9a-f]{32}$/);
});

Then('the companion welcomes ridrs', function (this: RidrsWorld) {
  welcomed(state(this).first);
});

Then(
  'the companion rejects ridrs with the reason {string}',
  function (this: RidrsWorld, reason: string) {
    rejectedWith(state(this).first, reason);
  },
);

Then(
  'the companion rejects the second ridrs with the reason {string}',
  function (this: RidrsWorld, reason: string) {
    rejectedWith(state(this).second, reason);
  },
);

Given(
  'ridrs is subscribed to Indoor Bike Data of {string} through the bridge',
  async function (this: RidrsWorld, name: string) {
    const session = welcomed(state(this).first);
    const connection = await session.connect(peripheral(this, name).peripheralId);
    const list: Uint8Array[] = [];
    received.set(this, list);
    await connection.subscribe(
      { serviceUuid: FTMS_SERVICE_UUID, characteristicUuid: INDOOR_BIKE_DATA_CHARACTERISTIC_UUID },
      (data: Uint8Array) => list.push(data),
    );
    await this.settle();
  },
);

Then('ridrs receives the notification bytes {string}', function (this: RidrsWorld, hex: string) {
  const last = received.get(this)?.at(-1);
  assert.ok(last, 'Expected a notification');
  assert.deepEqual([...last], hexBytes(hex));
});

Given(
  'the trainer advertises the manufacturer data {string} and the service data {string}',
  function (this: RidrsWorld, manufacturer: string, service: string) {
    assert.ok(this.trainer, 'Expected a trainer');
    this.trainer.advertise({
      manufacturerData: advertisedData(manufacturer) ?? {},
      serviceData: advertisedData(service) ?? {},
    });
  },
);

Given('the trainer advertises a signal of {int} dBm', function (this: RidrsWorld, rssi: number) {
  assert.ok(this.trainer, 'Expected a trainer');
  this.trainer.setSignal(rssi);
});

const found = new WeakMap<RidrsWorld, BleDiscoveredPeripheral[]>();

When('ridrs looks for devices through the bridge', async function (this: RidrsWorld) {
  const session = welcomed(state(this).first);
  const list: BleDiscoveredPeripheral[] = [];
  found.set(this, list);
  const abort = new AbortController();
  const scan = (async () => {
    for await (const peripheral of session.scan({ serviceUuids: [], signal: abort.signal })) {
      list.push(peripheral);
    }
  })();
  await this.settle();
  abort.abort();
  await scan.catch(() => undefined);
});

When(
  'the trainer vanishes while ridrs looks for devices through the bridge',
  async function (this: RidrsWorld) {
    const session = welcomed(state(this).first);
    const list: BleDiscoveredPeripheral[] = [];
    found.set(this, list);
    const abort = new AbortController();
    const scan = (async () => {
      for await (const peripheral of session.scan({ serviceUuids: [], signal: abort.signal })) {
        list.push(peripheral);
      }
    })();
    await this.settle();
    assert.ok(this.trainer && this.bleSimulator, 'Expected a trainer');
    this.bleSimulator.removePeripheral(this.trainer.peripheralId);
    await this.settle();
    abort.abort();
    await scan.catch(() => undefined);
  },
);

function vanished(world: RidrsWorld, name: string): boolean {
  const id = foundByBridge(world, name).peripheralId;
  return found.get(world)?.some((p) => p.peripheralId === id && p.vanished === true) ?? false;
}

Then('ridrs is told that {string} vanished', function (this: RidrsWorld, name: string) {
  assert.ok(vanished(this, name), `ridrs was not told that "${name}" vanished`);
});

Then('ridrs is not told that {string} vanished', function (this: RidrsWorld, name: string) {
  assert.ok(!vanished(this, name), `ridrs was told that "${name}" vanished`);
});

function foundByBridge(world: RidrsWorld, name: string): BleDiscoveredPeripheral {
  const peripheral = found.get(world)?.find((p) => p.name === name);
  assert.ok(peripheral, `ridrs found no "${name}" through the bridge`);
  return peripheral;
}

Then(
  'ridrs finds {string} with the manufacturer data {string} and the service data {string}',
  function (this: RidrsWorld, name: string, manufacturer: string, service: string) {
    const peripheral = foundByBridge(this, name);
    assert.deepEqual(
      [peripheral.manufacturerData, peripheral.serviceData],
      [advertisedData(manufacturer), advertisedData(service)],
    );
  },
);

Then(
  'ridrs finds {string} with a signal of {int} dBm',
  function (this: RidrsWorld, name: string, rssi: number) {
    assert.equal(foundByBridge(this, name).rssi, rssi);
  },
);

Then(
  'ridrs finds {string} without signal and advertising data',
  function (this: RidrsWorld, name: string) {
    const peripheral = foundByBridge(this, name);
    assert.deepEqual(
      [peripheral.rssi, peripheral.manufacturerData, peripheral.serviceData],
      [undefined, undefined, undefined],
    );
  },
);

When('the ridrs socket closes', async function (this: RidrsWorld) {
  welcomed(state(this).first).close();
  await this.settle();
});

Then('the companion holds no subscriptions', async function (this: RidrsWorld) {
  await this.settle();
  assert.equal(companion(this).server.status().subscriptions, 0);
});

// ---- transport-ble-bridge ------------------------------------------------------------------

Given('ridrs is paired with the companion', function (this: RidrsWorld) {
  const c = companion(this);
  connector(this).savePairing({
    companionId: c.authority.companionId,
    companionName: 'Pixel 8',
    address: c.address,
    token: c.authority.issueToken('ridrs'),
  });
});

Given(
  'the ridrs plugins {string} running over the simulated network',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await runOverNetwork(this, pluginsCsv);
  },
);

When(
  'the ridrs plugins {string} are running over the simulated network',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await runOverNetwork(this, pluginsCsv);
  },
);

When(
  'ridrs asks to pair with {string} using the code {string}',
  async function (this: RidrsWorld, name: string, code: string) {
    const listed = listedCompanions(this).find((c) => c.name === name);
    assert.ok(listed, `Expected "${name}" to be listed`);
    await requestPairing(this, listed.address, code);
  },
);

When(
  'ridrs asks to pair with the address of {string} using the code {string}',
  async function (this: RidrsWorld, _name: string, code: string) {
    await requestPairing(this, companion(this).address, code);
  },
);

Then('the bridge state is {string}', function (this: RidrsWorld, expected: string) {
  assert.equal(latestBridgeState(this).state, expected);
});

Then(
  'the bridge state is {string} with the reason {string}',
  function (this: RidrsWorld, expected: string, reason: string) {
    const latest = latestBridgeState(this);
    assert.equal(latest.state, expected);
    assert.equal(latest.reason, reason);
  },
);

Then('the listed companions are {string}', function (this: RidrsWorld, namesCsv: string) {
  assert.deepEqual(
    listedCompanions(this).map((c) => c.name),
    splitCsv(namesCsv),
  );
});

Then('the listed companion {string} is paired', function (this: RidrsWorld, name: string) {
  assert.equal(listedCompanions(this).find((c) => c.name === name)?.paired, true);
});

Then('the pairing with {string} is stored', function (this: RidrsWorld, name: string) {
  const pairing = connector(this).loadPairing();
  assert.equal(pairing?.companionName, name);
  assert.equal(pairing?.companionId, companion(this).authority.companionId);
  assert.ok(pairing && companion(this).authority.verifyToken(pairing.token));
});

Then('no pairing is stored', function (this: RidrsWorld) {
  assert.equal(connector(this).loadPairing(), undefined);
});

Then('the companion received {int} scan request(s)', function (this: RidrsWorld, count: number) {
  assert.equal(companion(this).server.scanRequests, count);
});

Then(
  'the latest {string} is {float} {word} from the trainer {string}',
  function (this: RidrsWorld, capability: string, value: number, _unit: string, name: string) {
    const reading = latestMetric(this, capability);
    assert.ok(reading.status === 'available', JSON.stringify(reading));
    assert.equal(reading.value, value);
    assert.equal(reading.deviceId, peripheral(this, name).peripheralId);
  },
);

// ---- Developer companion with dummy devices ----------------------------------------------

const dummiesOf = new WeakMap<RidrsWorld, DummyDevices>();

function dummies(world: RidrsWorld): DummyDevices {
  const found = dummiesOf.get(world);
  assert.ok(found, 'Expected a developer companion');
  return found;
}

Given(
  'a developer companion {string} without real Bluetooth devices',
  function (this: RidrsWorld, name: string) {
    const devices = new DummyDevices({ clock: this.clock });
    dummiesOf.set(this, devices);
    // Steps that look up a trainer by name find the dummies in their simulator.
    this.bleSimulator = devices.central;
    const empty = new BleSimulator({ clock: this.clock });
    // Like blec on the phone: it keeps searching for an address it does not know.
    const real: BleCentral = {
      scan: (options) => empty.scan(options),
      connect: (_id, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    };
    this.companionCentral = mergeBleCentrals(real, devices.central, (id) => devices.owns(id));
    pendingCompanion.set(this, { name });
  },
);

async function addDummy(world: RidrsWorld, profile: string): Promise<void> {
  assert.ok(profile in DUMMY_PROFILES, `Unknown dummy profile "${profile}"`);
  dummies(world).add(profile as DummyProfile);
  await world.settle();
}

When(
  'the developer adds a dummy FTMS trainer with the profile {string}',
  async function (this: RidrsWorld, profile: string) {
    await addDummy(this, profile);
  },
);

Given(
  'the developer added a dummy FTMS trainer with the profile {string}',
  async function (this: RidrsWorld, profile: string) {
    await addDummy(this, profile);
  },
);

When(
  'the developer removes the dummy trainer {string}',
  async function (this: RidrsWorld, name: string) {
    const device = dummies(this)
      .list()
      .find((d) => d.name === name);
    assert.ok(device, `Expected a dummy trainer "${name}"`);
    dummies(this).remove(device.peripheralId);
    await this.settle();
  },
);

When(
  'the developer sets the dummy trainer {string} to {int} W',
  async function (this: RidrsWorld, name: string, watts: number) {
    const device = dummies(this)
      .list()
      .find((d) => d.name === name);
    assert.ok(device, `Expected a dummy trainer "${name}"`);
    dummies(this).setWatts(device.peripheralId, watts);
    await this.settle();
  },
);

// ---- Pairing by QR code --------------------------------------------------------------------

function latestOfferUri(world: RidrsWorld): string | null | undefined {
  // The last write of `bridge.pairing`: an offer, or its removal.
  const last = world.stateOf(bridgePairingState.id).at(-1);
  return last ? ((last.value as { uri: string } | undefined)?.uri ?? null) : undefined;
}

Given('ridrs offers a pairing QR code', function (this: RidrsWorld) {
  const uri = latestOfferUri(this);
  assert.ok(uri && parsePairingUri(uri), `Expected a pairing QR code, got ${String(uri)}`);
});

Then('ridrs offers no pairing QR code', function (this: RidrsWorld) {
  assert.ok(!latestOfferUri(this), 'Expected no pairing QR code');
});

When('the companion scans the pairing QR code', async function (this: RidrsWorld) {
  const offer = parsePairingUri(latestOfferUri(this) ?? '');
  assert.ok(offer, 'Expected a pairing QR code to scan');
  companion(this).authority.acceptScannedSecret(offer.secret);
  await this.settle();
});

Given(
  'the companion scanned a pairing QR code with the secret {string}',
  function (this: RidrsWorld, secret: string) {
    companion(this).authority.acceptScannedSecret(secret);
  },
);

When(
  'ridrs connects to the companion with the secret {string}',
  async function (this: RidrsWorld, secret: string) {
    state(this).first = await attempt(this, { pairingSecret: secret });
  },
);

When('ridrs closes the connection', async function (this: RidrsWorld) {
  welcomed(state(this).first).close();
  await this.settle();
});

Given(
  'ridrs tried the secret {string} {int} times',
  async function (this: RidrsWorld, secret: string, times: number) {
    for (let i = 0; i < times; i += 1) {
      rejectedWith(await attempt(this, { pairingSecret: secret }), 'unknown-secret');
    }
  },
);

// ---- Connection control on both devices ----------------------------------------------------

/** The rider asks the bridge, as the UI does: a service call (ADR 0069). */
async function requestInRidrs(world: RidrsWorld, service: { readonly id: string }) {
  await world.ensureHost().callService(service.id, {}, { pluginId: 'ui-bridge' });
  await world.flushState();
}

function phonePairing(world: RidrsWorld) {
  const pairing = companion(world).server.status().pairings[0];
  assert.ok(pairing, 'Expected the phone to be paired with ridrs');
  return pairing;
}

When('the rider disconnects in ridrs', async function (this: RidrsWorld) {
  await requestInRidrs(this, bridgeDisconnectService);
});

Given('the rider disconnected in ridrs', async function (this: RidrsWorld) {
  await requestInRidrs(this, bridgeDisconnectService);
});

When('the rider connects in ridrs', async function (this: RidrsWorld) {
  await requestInRidrs(this, bridgeConnectService);
});

When('the rider forgets the companion in ridrs', async function (this: RidrsWorld) {
  await requestInRidrs(this, bridgeForgetService);
});

When('the rider disconnects on the phone', async function (this: RidrsWorld) {
  companion(this).server.disconnect(phonePairing(this).token);
  await this.settle();
});

Given('the rider disconnected on the phone', async function (this: RidrsWorld) {
  companion(this).server.disconnect(phonePairing(this).token);
  await this.settle();
});

When('the rider connects on the phone', async function (this: RidrsWorld) {
  companion(this).server.connect(phonePairing(this).token);
  await this.settle();
});

When('the rider forgets ridrs on the phone', async function (this: RidrsWorld) {
  companion(this).server.forget(phonePairing(this).token);
  await this.settle();
});

When('ridrs restarts', async function (this: RidrsWorld) {
  await this.disposeHost();
  await this.ensureHost().start();
  await this.settle();
});

When('the companion restarts', async function (this: RidrsWorld) {
  companion(this).restart();
  await this.settle();
});

/** What each side shows, in the words of the feature. */
const BOTH_SHOW: Record<string, { ridrs: readonly string[]; phone: string | undefined }> = {
  connected: { ridrs: ['connected'], phone: 'connected' },
  disconnected: { ridrs: ['disconnected'], phone: 'disconnected' },
  waiting: { ridrs: ['connecting', 'reconnecting', 'unreachable'], phone: 'waiting' },
  'not paired': { ridrs: ['unpaired'], phone: undefined },
};

Then('ridrs and the companion both show {string}', function (this: RidrsWorld, expected: string) {
  const want = BOTH_SHOW[expected];
  assert.ok(want, `Unknown display "${expected}"`);
  const ridrs = latestBridgeState(this).state;
  assert.ok(want.ridrs.includes(ridrs), `ridrs shows "${ridrs}", expected ${expected}`);
  const phone = companion(this).server.status().pairings[0]?.state;
  assert.equal(phone, want.phone, `the phone shows "${String(phone)}", expected ${expected}`);
});

Then('ridrs shows that {string} disconnected', function (this: RidrsWorld, who: string) {
  const latest = latestBridgeState(this);
  assert.equal(latest.state, 'disconnected');
  assert.equal(latest.reason, who === 'ridrs' ? 'by-ridrs' : 'by-companion');
});

/**
 * Both devices must agree: connected on one side means connected on the other. Checked after
 * every step of `@consistent` features, once ridrs runs.
 */
AfterStep({ tags: '@consistent' }, async function (this: RidrsWorld) {
  if (!this.host || !this.companion) {
    return;
  }
  const states = this.stateValues(bridgeLinkState.id);
  if (states.length === 0) {
    return;
  }
  await this.settle();
  const ridrsConnected = latestBridgeState(this).state === 'connected';
  const phoneConnected = this.companion.server.status().client !== undefined;
  assert.equal(
    ridrsConnected,
    phoneConnected,
    `Inconsistent: ridrs ${ridrsConnected ? 'connected' : 'not connected'}, the phone ${
      phoneConnected ? 'connected' : 'not connected'
    }`,
  );
});
