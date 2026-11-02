// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type ActivityState,
  activityStateChangedEvent,
  type BicycleCapability,
  type CapabilityContract,
  type EnvironmentCapability,
  type PhysicsState,
  physicsBicycleCapability,
  physicsEnvironmentCapability,
  physicsRiderCapability,
  physicsRoadCapability,
  physicsStateEvent,
  physicsTotalResistanceCapability,
  type ResistanceProvider,
  type RiderCapability,
  type RoadCapability,
  type RoadSample,
  type TotalResistanceCapability,
} from '@ridrs/contracts';
import { DEFAULT_FAKE_START } from '../support/hooks.ts';
import type { RidrsWorld } from '../support/world.ts';
import { publishMeasurement, splitCsv, useRealPlugins } from './devices-and-metrics.steps.ts';

/** Absolute tolerance of numeric comparisons; expected values are rounded to two decimals. */
const TOLERANCE = 0.005;

/** "The ridrs physics plugins", loaded through discovery. */
const PHYSICS_PLUGINS = [
  'activity-session',
  'metric-power',
  'physics-engine',
  'physics-bicycle',
  'physics-rider',
  'physics-rolling-resistance',
  'physics-aerodynamics',
  'physics-gravity-resistance',
  'physics-environment',
  'physics-road',
  'physics-total-resistance',
  'physics-powertrain',
  'physics-virtual-speed',
];

/** "+250 ms" and "+10 s" mean that long after T0 = 2026-11-01T10:00:00.000Z. */
function parseOffset(text: string): number {
  const match = /^\+(\d+(?:\.\d+)?) (ms|s)$/.exec(text.trim());
  assert.ok(match, `Unrecognized time "${text}", expected e.g. "+250 ms" or "+10 s"`);
  const amount = Number(match[1]);
  return DEFAULT_FAKE_START + Math.round(match[2] === 's' ? amount * 1000 : amount);
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

function activityStates(world: RidrsWorld): ActivityState[] {
  return world.hostObserved
    .filter((e) => e.type === activityStateChangedEvent.id)
    .map((e) => e.payload as ActivityState);
}

/** The session of the latest ride that ran. */
function currentSessionId(world: RidrsWorld): string {
  const ride = activityStates(world)
    .filter((state) => state.state !== 'idle')
    .at(-1);
  assert.ok(ride, 'Expected a ride to have started');
  return ride.sessionId;
}

function physicsStates(world: RidrsWorld): PhysicsState[] {
  return world.hostObserved
    .filter((e) => e.type === physicsStateEvent.id)
    .map((e) => e.payload as PhysicsState);
}

function currentStates(world: RidrsWorld): PhysicsState[] {
  const sessionId = currentSessionId(world);
  return physicsStates(world).filter((state) => state.sessionId === sessionId);
}

function stateAt(world: RidrsWorld, time: string): PhysicsState {
  const at = parseOffset(time);
  const state = currentStates(world).find((s) => s.at === at);
  assert.ok(
    state,
    `No physics state at "${time}"; published at ${currentStates(world)
      .map((s) => formatOffset(s.at))
      .join(', ')}`,
  );
  return state;
}

function latestState(world: RidrsWorld): PhysicsState {
  const state = physicsStates(world).at(-1);
  assert.ok(state, 'Expected a "physics.state" event');
  return state;
}

function capabilityOf<T>(
  world: RidrsWorld,
  pluginId: string,
  contract: CapabilityContract<T, 'single'>,
): T {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected the plugin "${pluginId}" to be running`);
  return ctx.capabilities.get(contract);
}

// ---- Setup -------------------------------------------------------------------------------

async function usePhysicsPlugins(world: RidrsWorld, without: string[] = []): Promise<void> {
  await useRealPlugins(
    world,
    PHYSICS_PLUGINS.filter((id) => !without.includes(id)),
  );
}

async function addProbe(
  world: RidrsWorld,
  id: string,
  options: { types?: string[]; provides?: string[]; requires?: string[] } = {},
): Promise<void> {
  await world.writeProbePluginFolder({ folder: id, id, types: ['test'], ...options });
}

Given(
  'the ridrs physics plugins together with a test device plugin {string} and a probe plugin {string}',
  async function (this: RidrsWorld, deviceId: string, probeId: string) {
    await usePhysicsPlugins(this);
    await addProbe(this, deviceId, { types: ['device'] });
    await addProbe(this, probeId);
  },
);

Given(
  'the ridrs physics plugins without {string} together with a test device plugin {string} and a probe plugin {string}',
  async function (this: RidrsWorld, without: string, deviceId: string, probeId: string) {
    await usePhysicsPlugins(this, splitCsv(without));
    await addProbe(this, deviceId, { types: ['device'] });
    await addProbe(this, probeId);
  },
);

Given(
  'the ridrs physics plugins together with a probe plugin {string}',
  async function (this: RidrsWorld, probeId: string) {
    await usePhysicsPlugins(this);
    await addProbe(this, probeId);
  },
);

Given(
  'the ridrs physics plugins together with a probe plugin {string} that requires {string}',
  async function (this: RidrsWorld, probeId: string, capabilitiesCsv: string) {
    await usePhysicsPlugins(this);
    await addProbe(this, probeId, { requires: splitCsv(capabilitiesCsv) });
  },
);

Given(
  'the ridrs physics plugins without {string} together with a probe plugin {string} that requires {string}',
  async function (this: RidrsWorld, without: string, probeId: string, capabilitiesCsv: string) {
    await usePhysicsPlugins(this, splitCsv(without));
    await addProbe(this, probeId, { requires: splitCsv(capabilitiesCsv) });
  },
);

Given(
  'a probe plugin {string} provides {string} with a mass of {float} kg and a CdA of {float} m²',
  async function (
    this: RidrsWorld,
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
    await addProbe(this, probeId, { provides: [capability] });
  },
);

Given(
  'a probe plugin {string} provides {string} with an air density of {float} kg\\/m³',
  async function (this: RidrsWorld, probeId: string, capability: string, airDensity: number) {
    const environment: EnvironmentCapability = {
      parameters: () => ({ airDensity: { value: airDensity, origin: 'default' } }),
    };
    this.getBehavior(probeId).providedImplementations.set(capability, environment);
    await addProbe(this, probeId, { provides: [capability] });
  },
);

async function addRoadProbe(
  world: RidrsWorld,
  probeId: string,
  capability: string,
  gradientAt: (distance: number) => number,
): Promise<void> {
  const road: RoadCapability = {
    source: probeId,
    at: (distance) => ({ gradient: gradientAt(distance), origin: 'default' }),
  };
  world.getBehavior(probeId).providedImplementations.set(capability, road);
  await addProbe(world, probeId, { provides: [capability] });
}

Given(
  'a probe plugin {string} provides {string} with a constant gradient of {float} %',
  async function (this: RidrsWorld, probeId: string, capability: string, percent: number) {
    await addRoadProbe(this, probeId, capability, () => percent / 100);
  },
);

Given(
  'a probe plugin {string} provides {string} that is flat for the first {float} m and then climbs at {float} %',
  async function (
    this: RidrsWorld,
    probeId: string,
    capability: string,
    flat: number,
    percent: number,
  ) {
    await addRoadProbe(this, probeId, capability, (distance) =>
      distance < flat ? 0 : percent / 100,
    );
  },
);

Given('the plugin {string} is loaded as well', function (this: RidrsWorld, pluginId: string) {
  assert.ok(!this.realPluginIds.includes(pluginId), `"${pluginId}" is already loaded`);
  this.realPluginIds = [...this.realPluginIds, pluginId];
});

Given(
  'a probe plugin {string} provides {string} and throws when evaluated',
  async function (this: RidrsWorld, probeId: string, capability: string) {
    const broken: ResistanceProvider = {
      source: probeId,
      force: () => {
        throw new Error('broken resistance');
      },
    };
    this.getBehavior(probeId).providedImplementations.set(capability, broken);
    await addProbe(this, probeId, { provides: [capability] });
  },
);

// ---- Time --------------------------------------------------------------------------------

When('{float} s pass(es)', async function (this: RidrsWorld, seconds: number) {
  assert.ok(this.fakeClock, 'Time can only pass in @fake-timers scenarios');
  await this.fakeClock.tickAsync(Math.round(seconds * 1000));
});

When('the host is blocked for {int} ms', async function (this: RidrsWorld, ms: number) {
  assert.ok(this.fakeClock, 'A blocked host needs @fake-timers');
  // `jump` moves the clock without running intermediate timers and then fires every overdue one
  // once, late - what a blocked event loop does. (`setSystemTime` would shift pending timers too.)
  this.fakeClock.jump(ms);
  await this.settle();
});

When(
  '{string} delivers these power measurements:',
  async function (this: RidrsWorld, plugin: string, table: DataTable) {
    const clock = this.fakeClock;
    assert.ok(clock, 'Time can only pass in @fake-timers scenarios');
    for (const row of table.hashes()) {
      const at = parseOffset(row.at ?? '');
      await clock.tickAsync(at - this.clock.now());
      publishMeasurement(this, plugin, 'power', Number(row.value), 'trainer-1');
      this.lastDeliveries.set('power', at);
      await this.settle();
    }
  },
);

Then('no timers are pending', function (this: RidrsWorld) {
  assert.ok(this.fakeClock, 'Pending timers are only visible in @fake-timers scenarios');
  assert.equal(this.fakeClock.countTimers(), 0);
});

// ---- Published states ----------------------------------------------------------------------

Then('no physics state was published', function (this: RidrsWorld) {
  assert.deepEqual(physicsStates(this), []);
});

Then('no physics state was published for this ride', function (this: RidrsWorld) {
  assert.deepEqual(currentStates(this), []);
});

Then(
  'the latest {string} event is step {int} at {string} with a speed of {float} km\\/h and a distance of {float} m',
  function (
    this: RidrsWorld,
    eventId: string,
    step: number,
    time: string,
    speed: number,
    distance: number,
  ) {
    assert.equal(eventId, physicsStateEvent.id);
    const state = latestState(this);
    assert.equal(state.step, step);
    assert.equal(formatOffset(state.at), formatOffset(parseOffset(time)));
    assertClose(state.speed * 3.6, speed, 'speed (km/h)');
    assertClose(state.distance, distance, 'distance (m)');
  },
);

Then('physics states were published at {string}', function (this: RidrsWorld, timesCsv: string) {
  assert.deepEqual(
    currentStates(this).map((s) => formatOffset(s.at)),
    splitCsv(timesCsv).map((t) => formatOffset(parseOffset(t))),
  );
});

Then(
  'physics states were published at {string} after {string}',
  function (this: RidrsWorld, timesCsv: string, after: string) {
    const from = parseOffset(after);
    assert.deepEqual(
      currentStates(this)
        .filter((s) => s.at > from)
        .map((s) => formatOffset(s.at)),
      splitCsv(timesCsv).map((t) => formatOffset(parseOffset(t))),
    );
  },
);

Then(
  'the state at {string} is step {int}',
  function (this: RidrsWorld, time: string, step: number) {
    assert.equal(stateAt(this, time).step, step);
  },
);

Then('its session differs from the one of the finished ride', function (this: RidrsWorld) {
  const finished = activityStates(this)
    .filter((state) => state.state === 'finished')
    .at(-1);
  assert.ok(finished?.state === 'finished', 'Expected a finished ride');
  assert.notEqual(latestState(this).sessionId, finished.sessionId);
});

Then(
  'the virtual speed at {string} is {float} km\\/h',
  function (this: RidrsWorld, time: string, speed: number) {
    assertClose(stateAt(this, time).speed * 3.6, speed, 'speed (km/h)');
  },
);

Then(
  'the virtual distance at {string} is {float} m',
  function (this: RidrsWorld, time: string, distance: number) {
    assertClose(stateAt(this, time).distance, distance, 'distance (m)');
  },
);

Then(
  'the gradient at {string} is {float} %',
  function (this: RidrsWorld, time: string, percent: number) {
    assertClose(stateAt(this, time).road.gradient * 100, percent, 'gradient (%)');
  },
);

Then(
  'the acceleration at {string} is {float} m\\/s²',
  function (this: RidrsWorld, time: string, acceleration: number) {
    assertClose(stateAt(this, time).acceleration, acceleration, 'acceleration (m/s²)');
  },
);

// ---- Inputs ------------------------------------------------------------------------------

function assertRiderPower(world: RidrsWorld, time: string, value: number, quality?: string) {
  const { riderPower } = stateAt(world, time);
  assert.equal(riderPower.status, 'available', JSON.stringify(riderPower));
  assert.ok(riderPower.status === 'available');
  assertClose(riderPower.value, value, 'rider power (W)');
  if (quality !== undefined) {
    assert.equal(riderPower.quality, quality);
  }
}

Then(
  'the rider power at {string} is {float} W',
  function (this: RidrsWorld, time: string, value: number) {
    assertRiderPower(this, time, value);
  },
);

Then(
  'the rider power at {string} is {float} W {string}',
  function (this: RidrsWorld, time: string, value: number, quality: string) {
    assertRiderPower(this, time, value, quality);
  },
);

Then(
  'the rider power at {string} is unavailable because of {string}',
  function (this: RidrsWorld, time: string, reason: string) {
    const { riderPower } = stateAt(this, time);
    assert.equal(riderPower.status, 'unavailable', JSON.stringify(riderPower));
    assert.equal(riderPower.status === 'unavailable' && riderPower.reason, reason);
  },
);

Then(
  'the wheel power at {string} is {float} W',
  function (this: RidrsWorld, time: string, value: number) {
    assertClose(stateAt(this, time).wheelPower, value, 'wheel power (W)');
  },
);

// ---- Forces and parameters -----------------------------------------------------------------

function evaluateTotalResistance(
  world: RidrsWorld,
  probeId: string,
  speed: number,
  mass: number,
  road: RoadSample,
): void {
  const total = capabilityOf<TotalResistanceCapability>(
    world,
    probeId,
    physicsTotalResistanceCapability,
  );
  world.lastResistance = total.evaluate({ at: world.clock.now(), speed, mass, road });
}

When(
  '{string} evaluates the total resistance at {float} m\\/s with a mass of {float} kg',
  function (this: RidrsWorld, probeId: string, speed: number, mass: number) {
    evaluateTotalResistance(this, probeId, speed, mass, { gradient: 0, origin: 'default' });
  },
);

When(
  '{string} evaluates the total resistance at {float} m\\/s with a mass of {float} kg on a gradient of {float} %',
  function (this: RidrsWorld, probeId: string, speed: number, mass: number, percent: number) {
    evaluateTotalResistance(this, probeId, speed, mass, {
      gradient: percent / 100,
      origin: 'default',
    });
  },
);

function lastResistance(world: RidrsWorld) {
  assert.ok(world.lastResistance, 'Expected the total resistance to have been evaluated');
  return world.lastResistance;
}

Then(
  'the contribution of {string} is {float} N',
  function (this: RidrsWorld, source: string, force: number) {
    const contribution = lastResistance(this).contributions.find((c) => c.source === source);
    assert.ok(contribution, `No contribution of "${source}"`);
    assertClose(contribution.force, force, `force of "${source}" (N)`);
  },
);

Then('the total resistance is {float} N', function (this: RidrsWorld, force: number) {
  assertClose(lastResistance(this).total, force, 'total resistance (N)');
});

Then(
  'the contributions are {string} in this order',
  function (this: RidrsWorld, sourcesCsv: string) {
    assert.deepEqual(
      lastResistance(this).contributions.map((c) => c.source),
      splitCsv(sourcesCsv),
    );
  },
);

/** The probe that reads parameters: the one plugin started with "requires". */
const PARAMETER_PROBE = 'test-physics';

Then(
  'the bicycle parameters are a mass of {float} kg and a rolling resistance coefficient of {float}, all with the origin {string}',
  function (this: RidrsWorld, mass: number, crr: number, origin: string) {
    const parameters = capabilityOf<BicycleCapability>(
      this,
      PARAMETER_PROBE,
      physicsBicycleCapability,
    ).parameters();
    assert.deepEqual(parameters, {
      mass: { value: mass, origin },
      rollingResistanceCoefficient: { value: crr, origin },
    });
  },
);

Then(
  'the rider parameters are a mass of {float} kg and a CdA of {float} m², all with the origin {string}',
  function (this: RidrsWorld, mass: number, cdA: number, origin: string) {
    const parameters = capabilityOf<RiderCapability>(
      this,
      PARAMETER_PROBE,
      physicsRiderCapability,
    ).parameters();
    assert.deepEqual(parameters, { mass: { value: mass, origin }, cdA: { value: cdA, origin } });
  },
);

Then(
  'the environment parameters are an air density of {float} kg\\/m³, all with the origin {string}',
  function (this: RidrsWorld, airDensity: number, origin: string) {
    const parameters = capabilityOf<EnvironmentCapability>(
      this,
      PARAMETER_PROBE,
      physicsEnvironmentCapability,
    ).parameters();
    assert.deepEqual(parameters, { airDensity: { value: airDensity, origin } });
  },
);

Then(
  'the road gradient at {float} m is {float} % with the origin {string}',
  function (this: RidrsWorld, distance: number, percent: number, origin: string) {
    // The one probe that requires "physics.road" asks the real road plugin.
    const sample = capabilityOf<RoadCapability>(this, 'test-road-reader', physicsRoadCapability).at(
      distance,
    );
    assertClose(sample.gradient * 100, percent, `gradient at ${distance} m (%)`);
    assert.equal(sample.origin, origin);
  },
);

// ---- Failures ----------------------------------------------------------------------------

Then(
  'a {string} diagnostic names the plugin {string}',
  function (this: RidrsWorld, code: string, pluginId: string) {
    const diagnostics = this.ensureHost().getDiagnostics();
    const found = diagnostics.filter((d) => d.code === code && d.details?.plugin === pluginId);
    assert.equal(
      found.length,
      1,
      `Expected one "${code}" naming "${pluginId}", got ${JSON.stringify(diagnostics)}`,
    );
  },
);
