// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  activityStateChangedEvent,
  bytesToHex,
  type ControllerButton,
  controllerButtonsChangedEvent,
  type DeviceRawWritePayload,
  type DrivetrainGearChangedPayload,
  deviceRawWriteEvent,
  drivetrainGearChangedEvent,
  type EventEnvelope,
  FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID,
  FTMS_SERVICE_UUID,
  type PhysicsStateBatch,
  type PluginContext,
  type PluginDefinition,
  physicsStateBatchEvent,
  type TerrainPreview,
  type TrainerCommand,
  type TrainerCommandPayload,
  type TrainerControlChangedPayload,
  trainerCommandEvent,
  trainerControlChangedEvent,
  trainerTargetPowerEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { createSilentLogger } from '@ridrs/core';
import type { ReplayResult } from '@ridrs/replay';
import {
  BleSimulator,
  FTMS_OP_CODES,
  FTMS_RESULT_CODES,
  type SimulatedPeripheral,
  SimulatedTauriBridge,
} from '@ridrs/testing';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv, useRealPlugins, useSimulatedCentral } from './devices-and-metrics.steps.ts';
import { addProbe, assertClose, stateAt, usePhysicsPlugins } from './physics.steps.ts';
import { publishThroughUiBridge } from './recording.steps.ts';

const PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');
const CONTROL_POINT = FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID;

// ---- Helpers -------------------------------------------------------------------------------

function trainer(world: RidrsWorld): SimulatedPeripheral {
  assert.ok(world.trainer, 'Expected a simulated trainer');
  return world.trainer;
}

function control(world: RidrsWorld) {
  const point = trainer(world).ftmsControl;
  assert.ok(point, 'Expected a simulated trainer with a control point');
  return point;
}

/** What the trainer received on its control point, as lowercase hex, oldest first. */
function controlWrites(world: RidrsWorld): { hex: string; withResponse: boolean }[] {
  return trainer(world)
    .getWrites(FTMS_SERVICE_UUID, CONTROL_POINT)
    .map((w) => ({ hex: bytesToHex(w.data), withResponse: w.withResponse }));
}

const compact = (hex: string) => hex.replace(/\s+/g, '').toLowerCase();

function tappedPayloads<T>(world: RidrsWorld, type: string): T[] {
  return world.tapped.filter((e) => e.type === type).map((e) => e.payload as T);
}

function latestOf<T>(world: RidrsWorld, type: string): T {
  const envelope = world.tapped.filter((e) => e.type === type).at(-1);
  assert.ok(envelope, `Expected a "${type}" event`);
  world.lastEnvelope = envelope;
  return envelope.payload as T;
}

function commands(world: RidrsWorld): TrainerCommand[] {
  return tappedPayloads<TrainerCommandPayload>(world, trainerCommandEvent.id).map((p) => p.command);
}

const isSimulation = (hex: string) => hex.startsWith('11');

function latestLoad(world: RidrsWorld) {
  const batch = tappedPayloads<PhysicsStateBatch>(world, physicsStateBatchEvent.id).at(-1);
  const load = batch?.samples.at(-1)?.trainerLoad;
  assert.ok(load, 'Expected a trainer load in the latest step batch');
  return load;
}

function loadAt(world: RidrsWorld, time: string) {
  const load = stateAt(world, time).trainerLoad;
  assert.ok(load, `Expected a trainer load at "${time}"`);
  return load;
}

function contextOf(world: RidrsWorld, pluginId: string): PluginContext {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected the plugin "${pluginId}" to be running`);
  return ctx;
}

/** The FTMS Indoor Bike Data packet of the fixtures, with this power: cadence 90 rpm. */
function indoorBikeData(watts: number): string {
  const power = new Uint8Array(new Int16Array([watts]).buffer);
  return `45 00 b4 00 ${bytesToHex(power.subarray(0, 1))} ${bytesToHex(power.subarray(1, 2))}`;
}

async function tick(world: RidrsWorld, ms: number): Promise<void> {
  assert.ok(world.fakeClock, 'Time can only pass in @fake-timers scenarios');
  await world.fakeClock.tickAsync(ms);
}

// ---- The simulated trainer -----------------------------------------------------------------

Given(
  'a simulated BLE environment with an FTMS trainer {string} that supports simulation and target power',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = this.bleSimulator.addFtmsTrainer(name, {
      control: { simulation: true, targetPower: true },
    });
  },
);

Given(
  'a simulated Tauri bridge with an FTMS trainer {string} that supports simulation and target power',
  function (this: RidrsWorld, name: string) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = this.bleSimulator.addFtmsTrainer(name, {
      control: { simulation: true, targetPower: true },
    });
    this.tauriBridge = new SimulatedTauriBridge(this.bleSimulator, this.clock);
    this.tauriBridge.install();
  },
);

Given('the trainer {string} offers no control point', function (this: RidrsWorld, name: string) {
  assert.equal(trainer(this).name, name);
  trainer(this).removeCharacteristic(FTMS_SERVICE_UUID, CONTROL_POINT);
});

Given(
  'the trainer {string} supports neither simulation nor target power',
  function (this: RidrsWorld, name: string) {
    assert.equal(trainer(this).name, name);
    control(this).setFeatures({ simulation: false, targetPower: false });
  },
);

Given('the trainer {string} supports simulation only', function (this: RidrsWorld, name: string) {
  assert.equal(trainer(this).name, name);
  control(this).setFeatures({ simulation: true, targetPower: false });
});

Given(
  'the trainer {string} supports target power from {int} W to {int} W',
  function (this: RidrsWorld, name: string, min: number, max: number) {
    assert.equal(trainer(this).name, name);
    control(this).setPowerRange({ min, max });
  },
);

Given(
  'the trainer {string} refuses {string}',
  function (this: RidrsWorld, name: string, op: string) {
    assert.equal(trainer(this).name, name);
    const opCode = FTMS_OP_CODES[op as keyof typeof FTMS_OP_CODES];
    assert.ok(opCode !== undefined, `Unknown op code "${op}"`);
    control(this).answer(opCode, FTMS_RESULT_CODES['Control Not Permitted']);
  },
);

Given(
  'the trainer {string} answers {string} with {string}',
  function (this: RidrsWorld, name: string, op: string, result: string) {
    assert.equal(trainer(this).name, name);
    const opCode = FTMS_OP_CODES[op as keyof typeof FTMS_OP_CODES];
    const code = FTMS_RESULT_CODES[result as keyof typeof FTMS_RESULT_CODES];
    assert.ok(opCode !== undefined && code !== undefined, `Unknown "${op}" or "${result}"`);
    control(this).answer(opCode, code);
  },
);

When(
  'the trainer {string} sends {int} W every {float} s for {int} seconds',
  async function (this: RidrsWorld, name: string, watts: number, every: number, seconds: number) {
    assert.equal(trainer(this).name, name);
    const interval = Math.round(every * 1000);
    for (let elapsed = interval; elapsed <= seconds * 1000; elapsed += interval) {
      await tick(this, interval);
      trainer(this).notifyIndoorBikeData(indoorBikeData(watts));
      await this.settle();
    }
  },
);

// ---- Setup ---------------------------------------------------------------------------------

Given(
  'the ridrs plugins {string} with the simulated BLE central and a probe plugin {string}',
  async function (this: RidrsWorld, pluginsCsv: string, probeId: string) {
    await useRealPlugins(this, splitCsv(pluginsCsv));
    await useSimulatedCentral(this);
    await addProbe(this, probeId);
  },
);

Given('the plugins {string} are loaded as well', function (this: RidrsWorld, idsCsv: string) {
  this.realPluginIds = [...new Set([...this.realPluginIds, ...splitCsv(idsCsv)])];
});

Given('the plugin {string} is not installed', function (this: RidrsWorld, id: string) {
  this.realPluginIds = this.realPluginIds.filter((p) => p !== id);
});

/** A device plugin that publishes the buttons of a handlebar controller, as the Zwift Ride does. */
Given('a test controller {string}', async function (this: RidrsWorld, id: string) {
  await addProbe(this, id, { types: ['device'] });
});

Given(
  'the simulated BLE central and a test controller {string}',
  async function (this: RidrsWorld, id: string) {
    await useSimulatedCentral(this);
    await addProbe(this, id, { types: ['device'] });
  },
);

Given(
  'a mock world {string} feeds a gradient that alternates between 0 % and 5 % every metre when the ride starts',
  async function (this: RidrsWorld, probeId: string) {
    const window: Omit<TerrainPreview, 'revision'> = {
      originDistance: 0,
      spacing: 1,
      samples: Array.from({ length: 2001 }, (_, d) => ({ gradient: d % 2 === 0 ? 0 : 0.05 })),
    };
    this.getBehavior(probeId).onStart.push((ctx) => {
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'running') {
          ctx.inputs.accept(worldTerrainPreviewEvent, { revision: 1, ...window });
        }
      });
    });
    await addProbe(this, probeId, { types: ['transport'] });
  },
);

// ---- The rider -----------------------------------------------------------------------------

async function buttons(world: RidrsWorld, id: string, held: ControllerButton[]): Promise<void> {
  contextOf(world, id).inputs.accept(controllerButtonsChangedEvent, {
    deviceId: id,
    buttons: held,
  });
  await world.settle();
}

When(
  /^"([^"]+)" presses "([^"]+)" (once|twice|\d+ times)$/,
  async function (this: RidrsWorld, id: string, button: string, how: string) {
    const times = how === 'once' ? 1 : how === 'twice' ? 2 : Number.parseInt(how, 10);
    for (let i = 0; i < times; i += 1) {
      await buttons(this, id, [button as ControllerButton]);
      await tick(this, 100);
      await buttons(this, id, []);
      await tick(this, 100);
    }
  },
);

When(
  '{string} taps {string} {int} times at once',
  async function (this: RidrsWorld, id: string, button: string, times: number) {
    for (let i = 0; i < times; i += 1) {
      await buttons(this, id, [button as ControllerButton]);
      await buttons(this, id, []);
    }
  },
);

When(
  '{string} holds {string} for {int} seconds',
  async function (this: RidrsWorld, id: string, button: string, seconds: number) {
    await buttons(this, id, [button as ControllerButton]);
    await tick(this, seconds * 1000);
    await buttons(this, id, []);
  },
);

async function setTarget(world: RidrsWorld, id: string, watts: number | null): Promise<void> {
  contextOf(world, id).inputs.accept(trainerTargetPowerEvent, { watts });
  await world.settle();
}

When(
  /^"([^"]+)" (?:sets|set) the target power to (\d+) W$/,
  async function (this: RidrsWorld, id: string, watts: string) {
    await setTarget(this, id, Number(watts));
  },
);

When('{string} leaves ERG', async function (this: RidrsWorld, id: string) {
  await setTarget(this, id, null);
});

// ---- Control point -------------------------------------------------------------------------

Then(
  'the trainer received the write {string} with response on {string}',
  function (this: RidrsWorld, hex: string, characteristic: string) {
    assert.equal(characteristic, CONTROL_POINT);
    const writes = controlWrites(this);
    assert.ok(
      writes.some((w) => w.hex === compact(hex) && w.withResponse),
      `Writes: ${JSON.stringify(writes)}`,
    );
  },
);

Then(
  'the trainer received the writes {string} with response on {string}',
  function (this: RidrsWorld, csv: string, characteristic: string) {
    assert.equal(characteristic, CONTROL_POINT);
    const writes = controlWrites(this);
    assert.ok(writes.every((w) => w.withResponse));
    assert.deepEqual(
      writes.map((w) => w.hex),
      splitCsv(csv).map(compact),
    );
  },
);

Then('the trainer received no writes', function (this: RidrsWorld) {
  assert.deepEqual(controlWrites(this), []);
});

Then('the trainer received {string} again', function (this: RidrsWorld, hex: string) {
  assert.ok(controlWrites(this).filter((w) => w.hex === compact(hex)).length >= 2);
});

Then('the trainer received the last simulation command again', function (this: RidrsWorld) {
  const writes = controlWrites(this).map((w) => w.hex);
  const control = writes.lastIndexOf('00');
  const before = writes.slice(0, control).filter(isSimulation).at(-1);
  assert.ok(before, 'Expected a simulation command before the reconnect');
  assert.ok(writes.slice(control).includes(before), `Writes: ${writes.join(', ')}`);
});

Then(
  'the trainer received {string} before the first simulation command',
  function (this: RidrsWorld, hex: string) {
    const writes = controlWrites(this).map((w) => w.hex);
    const first = writes.findIndex(isSimulation);
    assert.ok(first > 0, `Writes: ${writes.join(', ')}`);
    assert.ok(writes.slice(0, first).includes(compact(hex)), `Writes: ${writes.join(', ')}`);
  },
);

Then(
  /^the trainer received (at most )?(\d+) simulation commands?$/,
  function (this: RidrsWorld, atMost: string | undefined, count: string) {
    const sent = controlWrites(this).filter((w) => isSimulation(w.hex)).length;
    if (atMost) {
      assert.ok(sent > 0 && sent <= Number(count), `${sent} simulation commands`);
    } else {
      assert.equal(sent, Number(count));
    }
  },
);

Then(
  'the simulation commands were at least {int} ms apart',
  function (this: RidrsWorld, ms: number) {
    const times = tappedPayloads<DeviceRawWritePayload>(this, deviceRawWriteEvent.id)
      .filter((w) => isSimulation(w.data))
      .map((w) => w.writtenAt);
    assert.ok(
      times.slice(1).every((t, i) => t - (times[i] ?? 0) >= ms),
      times.join(', '),
    );
  },
);

function simulationsSince(world: RidrsWorld, seconds: number): DeviceRawWritePayload[] {
  const since = world.clock.now() - seconds * 1000;
  return tappedPayloads<DeviceRawWritePayload>(world, deviceRawWriteEvent.id).filter(
    (w) => isSimulation(w.data) && w.writtenAt > since,
  );
}

Then(
  'the trainer received no simulation command in the last {float} s',
  function (this: RidrsWorld, seconds: number) {
    assert.deepEqual(simulationsSince(this, seconds), []);
  },
);

Then(
  'the trainer received a simulation command in the last {float} s',
  function (this: RidrsWorld, seconds: number) {
    assert.equal(simulationsSince(this, seconds).length, 1);
  },
);

Then('the trainer received no target power command', function (this: RidrsWorld) {
  assert.ok(!controlWrites(this).some((w) => w.hex.startsWith('05')));
});

Then(
  'the trainer received no simulation command after the target power',
  function (this: RidrsWorld) {
    const writes = controlWrites(this).map((w) => w.hex);
    const target = writes.findIndex((w) => w.startsWith('05'));
    assert.ok(target >= 0, 'Expected a target power command');
    assert.deepEqual(writes.slice(target + 1).filter(isSimulation), []);
  },
);

Then("the trainer's last command leaves it neutral", function (this: RidrsWorld) {
  const last = controlWrites(this).at(-1)?.hex ?? '';
  // Set Indoor Bike Simulation Parameters with no wind and a grade of 0.
  assert.ok(last.startsWith('1100000000'), `Last write: ${last}`);
  assert.equal(control(this).targetPower, undefined);
  assert.equal(control(this).simulation?.gradient, 0);
});

Then(
  'the latest {string} event has the data {string}, the characteristic {string} and with response',
  function (this: RidrsWorld, type: string, data: string, characteristic: string) {
    const raw = latestOf<DeviceRawWritePayload>(this, type);
    assert.equal(raw.data, compact(data));
    assert.equal(raw.characteristicUuid, characteristic);
    assert.equal(raw.withResponse, true);
  },
);

Then('it was published before the trainer received the write', function (this: RidrsWorld) {
  const raw = this.lastEnvelope as EventEnvelope<DeviceRawWritePayload>;
  // The write arrives after the turn that published it: the event's time is no later.
  const write = trainer(this)
    .getWrites(FTMS_SERVICE_UUID, CONTROL_POINT)
    .find((w) => bytesToHex(w.data) === raw.payload.data);
  assert.ok(write, 'Expected the trainer to have received the write');
  const index = this.tapped.indexOf(raw);
  const control = this.tapped.findIndex(
    (e, i) => i > index && e.type === trainerControlChangedEvent.id,
  );
  // The trainer's answer (control granted) comes in a later turn than the raw write.
  assert.ok(control > index);
});

// ---- Control state -------------------------------------------------------------------------

function latestControl(world: RidrsWorld): TrainerControlChangedPayload {
  return latestOf<TrainerControlChangedPayload>(world, trainerControlChangedEvent.id);
}

Then(
  'the latest "trainer.control-changed" event has the control {string} and the features simulation and target power',
  function (this: RidrsWorld, controlState: string) {
    const latest = latestControl(this);
    assert.equal(latest.control, controlState);
    assert.deepEqual(latest.features, { simulation: true, targetPower: true });
  },
);

Then(
  'the latest "trainer.control-changed" event has the control {string} and the mode {string}',
  function (this: RidrsWorld, controlState: string, mode: string) {
    const latest = latestControl(this);
    assert.equal(latest.control, controlState);
    assert.equal(latest.mode, mode);
  },
);

Then(
  'the latest "trainer.control-changed" event has the control {string}',
  function (this: RidrsWorld, controlState: string) {
    assert.equal(latestControl(this).control, controlState);
  },
);

Then(
  'the latest "trainer.control-changed" event has the mode {string}',
  function (this: RidrsWorld, mode: string) {
    assert.equal(latestControl(this).mode, mode);
  },
);

// ---- Commands ------------------------------------------------------------------------------

function latestCommand(world: RidrsWorld): TrainerCommand {
  const command = commands(world).at(-1);
  assert.ok(command, 'Expected a "trainer.command" event');
  return command;
}

Then('the latest "trainer.command" is a simulation', function (this: RidrsWorld) {
  assert.equal(latestCommand(this).kind, 'simulation');
});

Then(
  'the latest "trainer.command" is a simulation with the gradient {float}',
  function (this: RidrsWorld, gradient: number) {
    const command = latestCommand(this);
    assert.equal(command.kind, 'simulation');
    assertClose(command.kind === 'simulation' ? command.gradient : undefined, gradient, 'gradient');
  },
);

Then(
  'the latest "trainer.command" is a simulation with the gradient of the trainer load with virtual gear',
  function (this: RidrsWorld) {
    const command = latestCommand(this);
    assert.equal(command.kind, 'simulation');
    const load = latestLoad(this);
    assert.ok(load.virtualGear, 'Expected a virtual gear in the trainer load');
    const gradient = command.kind === 'simulation' ? command.gradient : Number.NaN;
    // The command carries the load at its 0.01 % resolution.
    assert.ok(
      Math.abs(gradient - load.resistanceWithVirtualGear.gradient) <= 0.00005,
      `${gradient} vs ${load.resistanceWithVirtualGear.gradient}`,
    );
    assert.notEqual(load.resistanceWithVirtualGear.gradient, load.resistance.gradient);
  },
);

Then(
  'the latest "trainer.command" is a target power of {int} W',
  function (this: RidrsWorld, watts: number) {
    assert.deepEqual(latestCommand(this), { kind: 'target-power', watts });
  },
);

// ---- Trainer load --------------------------------------------------------------------------

Then(
  'the trainer load at {string} has the gradient {float}, the Crr {float} and the wind resistance coefficient {float}',
  function (this: RidrsWorld, time: string, gradient: number, crr: number, cw: number) {
    const { resistance } = loadAt(this, time);
    assertClose(resistance.gradient, gradient, 'gradient');
    assertClose(resistance.rollingResistanceCoefficient, crr, 'Crr');
    assertClose(resistance.windResistanceCoefficient, cw, 'cw');
    assert.equal(resistance.windSpeed, 0);
  },
);

Then(
  'the trainer load with virtual gear at {string} equals the trainer load',
  function (this: RidrsWorld, time: string) {
    const load = loadAt(this, time);
    assert.deepEqual(load.resistanceWithVirtualGear, load.resistance);
  },
);

Then(
  'the trainer load with virtual gear at {string} is higher than the trainer load',
  function (this: RidrsWorld, time: string) {
    const load = loadAt(this, time);
    assert.ok(load.resistanceWithVirtualGear.gradient > load.resistance.gradient);
  },
);

Then(
  'the trainer load at {string} names no virtual gear',
  function (this: RidrsWorld, time: string) {
    assert.equal(loadAt(this, time).virtualGear, undefined);
  },
);

Then(
  'the trainer load at {string} names the virtual gear {int}',
  function (this: RidrsWorld, time: string, index: number) {
    assert.equal(loadAt(this, time).virtualGear?.index, index);
  },
);

Then(
  'every sample of "physics.state-batch" has a trainer load with the gradient of its step',
  function (this: RidrsWorld) {
    const samples = tappedPayloads<PhysicsStateBatch>(this, physicsStateBatchEvent.id).flatMap(
      (b) => b.samples,
    );
    assert.ok(samples.some((s) => s.gradient > 0) && samples.some((s) => s.gradient === 0));
    for (const sample of samples) {
      assert.equal(sample.trainerLoad?.resistance.gradient, sample.gradient, `step ${sample.step}`);
    }
  },
);

/** Runs the plugin's lifecycle on a context that records every subscription and nothing else. */
Then('the plugin {string} subscribes to no event', async function (this: RidrsWorld, id: string) {
  const definition = (
    (await import(`../../plugins/${id}/index.ts`)) as { default: PluginDefinition }
  ).default;
  const subscribed: string[] = [];
  const inert = () => undefined;
  const ctx = {
    manifest: JSON.parse(readFileSync(resolve(PLUGINS_DIR, id, 'manifest.json'), 'utf8')),
    logger: createSilentLogger(),
    events: {
      publish: inert,
      subscribe: (event: { id: string }) => {
        subscribed.push(event.id);
        return { unsubscribe: inert };
      },
    },
    capabilities: { provide: inert, get: () => ({}), getAll: () => [], find: inert },
    temporal: { reader: (capability: { id: string }) => ({ series: capability.id }) },
    spatial: { reader: (capability: { id: string }) => ({ series: capability.id }) },
    signal: new AbortController().signal,
    reportDiagnostic: inert,
  } as unknown as PluginContext;
  await definition.initialize?.(ctx);
  await definition.start?.(ctx);
  assert.deepEqual(subscribed, []);
});

// ---- Gears ---------------------------------------------------------------------------------

Then(
  'the latest "drivetrain.gear-changed" event has the gear {int} of {int}',
  function (this: RidrsWorld, index: number, count: number) {
    const latest = latestOf<DrivetrainGearChangedPayload>(this, drivetrainGearChangedEvent.id);
    assert.equal(latest.index, index);
    assert.equal(latest.count, count);
  },
);

Then(
  '{int} {string} events were published',
  function (this: RidrsWorld, count: number, type: string) {
    assert.equal(tappedPayloads(this, type).length, count);
  },
);

// ---- Recording -----------------------------------------------------------------------------

function replayResult(world: RidrsWorld): ReplayResult {
  assert.equal(world.replayError, undefined, String(world.replayError));
  const last = world.replayResults.at(-1);
  assert.ok(last, 'Expected a replay');
  return last;
}

Then(
  /^the replay compared all of the (.+) events of the ride$/,
  function (this: RidrsWorld, list: string) {
    const types = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    const { streams } = replayResult(this);
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

Given(
  'a recorded ride with the simulated trainer, a climb, 3 shifts and 20 s of ERG at 180 W',
  async function (this: RidrsWorld) {
    this.bleSimulator = new BleSimulator({ clock: this.clock });
    this.trainer = this.bleSimulator.addFtmsTrainer('SIM KICKR', {
      control: { simulation: true, targetPower: true },
    });
    await usePhysicsPlugins(this);
    this.realPluginIds = [
      ...new Set([
        ...this.realPluginIds,
        'device-ftms-trainer',
        'metric-cadence',
        'physics-trainer-load',
        'control-virtual-gears',
        'control-erg',
        'recording-session',
      ]),
    ];
    await useSimulatedCentral(this);
    await addProbe(this, 'test-ui');
    await addProbe(this, 'test-ride', { types: ['device'] });
    this.useMemoryStorage();
    const window = {
      originDistance: 0,
      spacing: 1,
      samples: Array.from({ length: 2001 }, () => ({ gradient: 0.05 })),
    };
    this.getBehavior('test-road').onStart.push((ctx) => {
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'running') {
          ctx.inputs.accept(worldTerrainPreviewEvent, { revision: 1, ...window });
        }
      });
    });
    await addProbe(this, 'test-road', { types: ['transport'] });

    await this.ensureHost().start();
    await this.settle();
    await tick(this, 2000);
    await publishThroughUiBridge(this, 'activity.start-requested');
    const send = async (seconds: number) => {
      for (let t = 0; t < seconds * 4; t += 1) {
        await tick(this, 250);
        trainer(this).notifyIndoorBikeData(indoorBikeData(200));
        await this.settle();
      }
    };
    await send(5);
    for (let i = 0; i < 3; i += 1) {
      await buttons(this, 'test-ride', ['shift-up-right']);
      await buttons(this, 'test-ride', []);
      await send(2);
    }
    await setTarget(this, 'test-ui', 180);
    await send(20);
    await setTarget(this, 'test-ui', null);
    await send(3);
    await publishThroughUiBridge(this, 'activity.finish-requested');
    await tick(this, 1000);
  },
);
