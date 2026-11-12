// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type ActivityState,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  type CompletedWorkout,
  type DataSource,
  DEFAULT_PROVIDER,
  type EventEnvelope,
  type PhysicsSample,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
  type RideWorkout,
  type TrainerTargetPowerPayload,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  trainingHistoryState,
  type Workout,
  type WorkoutDuration,
  type WorkoutEffort,
  type WorkoutStepChangedPayload,
  workoutFinishedEvent,
  workoutNextStepRequestedEvent,
  workoutStepChangedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';
import { useRealPlugins } from './devices-and-metrics.steps.ts';
import { addProbe, usePhysicsPlugins } from './physics.steps.ts';
import { lastRecording } from './recording.steps.ts';

// ---- Per-scenario data -----------------------------------------------------------------------

interface Route {
  readonly meters: number;
  readonly gradient: number;
}

interface PlayerScenario {
  readonly workouts: Map<string, Workout>;
  route?: Route;
}

const scenarios = new WeakMap<RidrsWorld, PlayerScenario>();

function scenarioOf(world: RidrsWorld): PlayerScenario {
  let scenario = scenarios.get(world);
  if (!scenario) {
    scenario = { workouts: new Map() };
    scenarios.set(world, scenario);
  }
  return scenario;
}

/** The player's events are not in the World's list of phase 3; the host must know them. */
function registerPlayerEvents(world: RidrsWorld): void {
  for (const event of [
    workoutStepChangedEvent,
    workoutFinishedEvent,
    workoutNextStepRequestedEvent,
  ]) {
    world.eventDefinitions.set(event.id, event);
  }
}

// ---- Workouts --------------------------------------------------------------------------------

function durationOf(text: string): WorkoutDuration {
  const value = text.trim();
  if (value === 'open') {
    return { kind: 'open' };
  }
  const match = /^(\d+(?:\.\d+)?) (min|s|m)$/.exec(value);
  assert.ok(match, `Unrecognized duration "${text}"`);
  const amount = Number(match[1]);
  return match[2] === 'm'
    ? { kind: 'distance', meters: amount }
    : { kind: 'time', seconds: match[2] === 'min' ? amount * 60 : amount };
}

function effortOf(text: string): WorkoutEffort {
  const value = text.trim();
  if (value === 'free ride') {
    return { kind: 'free' };
  }
  const ramp = /^(\d+) W to (\d+) W$/.exec(value);
  if (ramp) {
    const [start, end] = [Number(ramp[1]), Number(ramp[2])];
    return {
      kind: 'target',
      primary: {
        unit: 'watts',
        start: { low: start, high: start },
        end: { low: end, high: end },
      },
    };
  }
  const steady = /^(\d+) W$/.exec(value);
  assert.ok(steady, `Unrecognized target "${text}"`);
  const watts = Number(steady[1]);
  return { kind: 'target', primary: { unit: 'watts', start: { low: watts, high: watts } } };
}

Given(
  'the workout {string} for the workout player:',
  function (this: RidrsWorld, name: string, table: DataTable) {
    const steps = table.hashes().map((row, i) => ({
      kind: 'interval' as const,
      id: `s${i + 1}`,
      duration: durationOf(row.duration ?? ''),
      effort: effortOf(row.target ?? ''),
    }));
    scenarioOf(this).workouts.set(name, {
      format: 'ridrs-workout',
      version: 1,
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      sport: 'virtual-ride',
      source: { kind: 'user' },
      steps,
    });
  },
);

function workoutNamed(world: RidrsWorld, name: string): Workout {
  const workout = scenarioOf(world).workouts.get(name);
  assert.ok(workout, `No workout "${name}" in this scenario`);
  return workout;
}

// ---- Setup -----------------------------------------------------------------------------------

async function usePlayerPlugins(world: RidrsWorld, pluginsCsv: string): Promise<void> {
  registerPlayerEvents(world);
  await useRealPlugins(
    world,
    pluginsCsv.split(',').map((id) => id.trim()),
  );
  await addProbe(world, 'test-ui');
}

Given(
  'the workout player runs with the ridrs plugins {string}',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await usePlayerPlugins(this, pluginsCsv);
  },
);

Given(
  'the workout player runs with the ridrs plugins {string} and the memory storage',
  async function (this: RidrsWorld, pluginsCsv: string) {
    await usePlayerPlugins(this, pluginsCsv);
    this.useMemoryStorage();
  },
);

/** A world sensor like the video world: the whole route from 0 m, flat beyond its end. */
const BEYOND_THE_END_METERS = 2000;

Given(
  'the workout player rides with the ridrs physics plugins, the trainer load, the recorder and the memory storage',
  async function (this: RidrsWorld) {
    registerPlayerEvents(this);
    await usePhysicsPlugins(this);
    this.realPluginIds.push(
      'physics-trainer-load',
      'workout-player',
      'control-erg',
      'recording-session',
    );
    await addProbe(this, 'test-device', { types: ['device'] });
    await addProbe(this, 'test-ui');
    this.getBehavior('test-road').onStart.push((ctx) => {
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        const route = scenarioOf(this).route;
        if (!route || payload.state !== 'running' || payload.resumedAt !== undefined) {
          return;
        }
        ctx.inputs.accept(worldTerrainPreviewEvent, {
          revision: 1,
          originDistance: 0,
          spacing: 1,
          samples: Array.from({ length: route.meters + BEYOND_THE_END_METERS }, (_, at) => ({
            gradient: at < route.meters ? route.gradient : 0,
          })),
        });
      });
    });
    await addProbe(this, 'test-road', { types: ['transport'] });
    this.useMemoryStorage();
  },
);

Given(
  "the workout player's route is {int} m long at a gradient of {int} %",
  function (this: RidrsWorld, meters: number, percent: number) {
    scenarioOf(this).route = { meters, gradient: percent / 100 };
  },
);

// ---- The rider -------------------------------------------------------------------------------

async function startWith(world: RidrsWorld, payload: Record<string, unknown>): Promise<void> {
  world.ensureHost().publishEvent('ui-bridge', activityStartRequestedEvent, payload);
  await world.settle();
}

for (const verb of ['starts', 'started']) {
  When(
    `the rider ${verb} a ride with the workout {string}`,
    async function (this: RidrsWorld, name: string) {
      await startWith(this, { workout: { workout: workoutNamed(this, name) } });
    },
  );
}

When(
  'the rider starts a ride with the workout {string} planned as the {string} entry {string}',
  async function (this: RidrsWorld, name: string, provider: string, id: string) {
    const workout: RideWorkout = { workout: workoutNamed(this, name), planned: { provider, id } };
    await startWith(this, { workout });
  },
);

When(
  'the rider starts a ride with the workout {string} on the route',
  async function (this: RidrsWorld, name: string) {
    await startWith(this, {
      world: { landscape: 'test-road/route', route: 'test-route' },
      workout: { workout: workoutNamed(this, name) },
    });
  },
);

When('the rider asks the workout player for the next step', async function (this: RidrsWorld) {
  this.ensureHost().publishEvent('ui-bridge', workoutNextStepRequestedEvent, {});
  await this.settle();
});

When('the rider asks ERG for {string}', async function (this: RidrsWorld, change: string) {
  this.ensureHost().publishEvent('ui-bridge', trainerErgRequestedEvent, {
    change: change as 'enter' | 'up' | 'down' | 'leave',
  });
  await this.settle();
});

// ---- What happened ---------------------------------------------------------------------------

function tappedOfType(world: RidrsWorld, type: string): EventEnvelope[] {
  return world.tapped.filter((e) => e.type === type);
}

function activityStates(world: RidrsWorld): ActivityState[] {
  return tappedOfType(world, activityStateChangedEvent.id).map((e) => e.payload as ActivityState);
}

type RideState = Exclude<ActivityState, { state: 'idle' }>;

function rides(world: RidrsWorld): RideState[] {
  return activityStates(world).filter((state): state is RideState => state.state !== 'idle');
}

/** When the latest ride started. */
function rideStart(world: RidrsWorld): number {
  const ride = rides(world).at(-1);
  assert.ok(ride, 'Expected a ride to have started');
  return ride.startedAt;
}

/** "+120 s": that long after the ride started. */
function sinceStart(world: RidrsWorld, text: string): number {
  const match = /^\+(\d+(?:\.\d+)?) s$/.exec(text.trim());
  assert.ok(match, `Unrecognized time "${text}", expected e.g. "+120 s"`);
  return rideStart(world) + Math.round(Number(match[1]) * 1000);
}

const label = (world: RidrsWorld, at: number) => `+${(at - rideStart(world)) / 1000} s`;

/** The target in force at `at`: the latest `trainer.target-power` up to then; undefined if none. */
function targetAt(world: RidrsWorld, at: number): number | null | undefined {
  const latest = tappedOfType(world, trainerTargetPowerEvent.id)
    .filter((e) => e.timestamp <= at)
    .at(-1);
  return latest ? (latest.payload as TrainerTargetPowerPayload).watts : undefined;
}

function stepChanges(world: RidrsWorld): EventEnvelope[] {
  return tappedOfType(world, workoutStepChangedEvent.id);
}

Then("the workout's target power was:", function (this: RidrsWorld, table: DataTable) {
  for (const row of table.hashes()) {
    const at = sinceStart(this, row.at ?? '');
    const expected = row.target === 'off' ? null : Number(/^(\d+) W$/.exec(row.target ?? '')?.[1]);
    assert.equal(targetAt(this, at), expected, `The target at ${row.at}`);
  }
});

Then(
  "the ramp's target changed every second from {string} to {string}",
  function (this: RidrsWorld, from: string, to: string) {
    const times = new Set(
      tappedOfType(this, trainerTargetPowerEvent.id)
        .filter((e) => e.source === 'workout-player')
        .map((e) => e.timestamp),
    );
    for (let at = sinceStart(this, from); at <= sinceStart(this, to); at += 1000) {
      assert.ok(times.has(at), `No new target at ${label(this, at)}`);
    }
  },
);

Then("the workout's steps began at {string}", function (this: RidrsWorld, list: string) {
  const expected = list.split(',').map((text) => sinceStart(this, text));
  const changes = stepChanges(this);
  assert.deepEqual(
    changes.map((e) => e.timestamp),
    expected,
    `Steps began at ${changes.map((e) => label(this, e.timestamp)).join(', ')}`,
  );
  changes.forEach((e, index) => {
    const payload = e.payload as WorkoutStepChangedPayload;
    assert.equal(payload.index, index);
    assert.equal(payload.startedAt, e.timestamp);
  });
});

Then("the workout's steps began {int} times", function (this: RidrsWorld, count: number) {
  assert.equal(stepChanges(this).length, count);
});

Then('the workout finished at {string}', function (this: RidrsWorld, text: string) {
  const finished = tappedOfType(this, workoutFinishedEvent.id);
  assert.equal(finished.length, 1, `${finished.length} "workout.finished" events`);
  const at = sinceStart(this, text);
  assert.equal(
    finished[0]?.timestamp,
    at,
    `Finished at ${label(this, finished[0]?.timestamp ?? 0)}`,
  );
  assert.deepEqual(finished[0]?.payload, { at });
});

Then(
  'the workout player set no target power between {string} and {string}',
  function (this: RidrsWorld, from: string, to: string) {
    const [a, b] = [sinceStart(this, from), sinceStart(this, to)];
    const set = tappedOfType(this, trainerTargetPowerEvent.id).filter(
      (e) => e.timestamp >= a && e.timestamp <= b,
    );
    assert.deepEqual(
      set.map((e) => label(this, e.timestamp)),
      [],
    );
  },
);

Then(
  'every activity state of the ride carries the workout {string} planned as the {string} entry {string}',
  function (this: RidrsWorld, name: string, provider: string, id: string) {
    const states = rides(this);
    assert.deepEqual(
      states.map((state) => state.state),
      ['running', 'paused', 'running', 'finished'],
    );
    for (const state of states) {
      assert.deepEqual(state.workout, {
        workout: workoutNamed(this, name),
        planned: { provider, id },
      });
    }
  },
);

// ---- The physics and the route ---------------------------------------------------------------

function samples(world: RidrsWorld): PhysicsSample[] {
  return tappedOfType(world, physicsStateBatchEvent.id).flatMap(
    (e) => (e.payload as PhysicsStateBatch).samples,
  );
}

function sampleAt(world: RidrsWorld, at: number): PhysicsSample {
  const sample = samples(world)
    .filter((s) => s.at <= at)
    .at(-1);
  assert.ok(sample, `No physics sample at ${label(world, at)}`);
  return sample;
}

Then(
  "the workout's second step began within a second of the virtual distance passing {int} m",
  function (this: RidrsWorld, meters: number) {
    const began = stepChanges(this)[1]?.timestamp;
    assert.ok(began !== undefined, 'The second step never began');
    const passed = samples(this).find((s) => s.distance >= meters)?.at;
    assert.ok(passed !== undefined, `The ride never passed ${meters} m`);
    // The player reads the distance from the physics batches (every 50 ms) at whole seconds.
    assert.ok(
      began >= passed && began <= passed + 1050,
      `Passed ${meters} m at ${label(this, passed)}, the step began at ${label(this, began)}`,
    );
  },
);

function route(world: RidrsWorld): Route {
  const known = scenarioOf(world).route;
  assert.ok(known, 'Expected a route');
  return known;
}

Then(
  'the ride passed the end of the route before {string}',
  function (this: RidrsWorld, text: string) {
    const sample = sampleAt(this, sinceStart(this, text));
    assert.ok(
      sample.distance > route(this).meters,
      `At ${text} the ride is at ${sample.distance} m`,
    );
  },
);

for (const where of ['within the route', 'beyond the end of the route']) {
  Then(
    `the trainer's load at {string} has the gradient {int} %, ${where}`,
    function (this: RidrsWorld, text: string, percent: number) {
      const sample = sampleAt(this, sinceStart(this, text));
      const beyond = sample.distance > route(this).meters;
      assert.equal(
        beyond,
        where !== 'within the route',
        `At ${text} the ride is at ${sample.distance} m`,
      );
      const gradient = sample.trainerLoad?.resistance.gradient;
      assert.ok(gradient !== undefined, 'Expected a trainer load');
      assert.ok(Math.abs(gradient - percent / 100) < 1e-9, `The gradient is ${gradient}`);
    },
  );
}

// ---- Continuing ------------------------------------------------------------------------------

/**
 * The ridden time at `at`: the running spans of the latest run of the ride's activity states (a
 * continued ride publishes them again from its start).
 */
function riddenAt(world: RidrsWorld, at: number): number {
  const states = activityStates(world);
  const start = states.findLastIndex((s) => s.state === 'running' && s.resumedAt === undefined);
  let ridden = 0;
  let since: number | undefined;
  for (const state of states.slice(start)) {
    if (state.state === 'running') {
      since = state.resumedAt ?? state.startedAt;
    } else if (state.state === 'paused' && since !== undefined) {
      ridden += Math.min(state.pausedAt, at) - since;
      since = undefined;
    }
    if (since !== undefined && since > at) {
      break;
    }
  }
  return ridden + (since !== undefined ? Math.max(0, at - since) : 0);
}

Then(
  "the continued ride is at the workout's step {int}",
  function (this: RidrsWorld, step: number) {
    const latest = stepChanges(this).at(-1)?.payload as WorkoutStepChangedPayload | undefined;
    assert.equal(latest?.index, step - 1);
    const paused = activityStates(this).at(-1);
    assert.ok(paused?.state === 'paused' && paused.reason === 'interrupted');
  },
);

Then(
  "the workout's step {int} began after {int} s of ridden time",
  function (this: RidrsWorld, step: number, seconds: number) {
    const began = stepChanges(this)
      .filter((e) => (e.payload as WorkoutStepChangedPayload).index === step - 1)
      .at(-1);
    assert.ok(began, `Step ${step} never began`);
    assert.equal(riddenAt(this, began.timestamp), seconds * 1000);
  },
);

Then(
  'the workout finished after {int} s of ridden time',
  function (this: RidrsWorld, seconds: number) {
    const finished = tappedOfType(this, workoutFinishedEvent.id).at(-1);
    assert.ok(finished, 'The workout never finished');
    assert.equal(riddenAt(this, finished.timestamp), seconds * 1000);
  },
);

// ---- The recording and the history -----------------------------------------------------------

Then(
  "the recording holds the rider's {string} as an input at {string}",
  async function (this: RidrsWorld, type: string, text: string) {
    const at = sinceStart(this, text);
    const recorded = (await lastRecording(this)).events.filter((e) => e.envelope.type === type);
    assert.deepEqual(
      recorded.map((e) => ({ input: e.envelope.input, at: e.envelope.timestamp })),
      [{ input: true, at }],
    );
  },
);

async function savedRide(world: RidrsWorld): Promise<CompletedWorkout> {
  const sessionId = rides(world).at(-1);
  assert.ok(sessionId, 'Expected a ride');
  const find = () =>
    world
      .stateValues<DataSource<{ workouts: CompletedWorkout[] }>>(trainingHistoryState.id)
      .at(-1)
      ?.data?.workouts.find((ride) => ride.id === sessionId.sessionId);
  await world.waitForIo(() => find() !== undefined, 'the saved ride in the history');
  const ride = find();
  assert.ok(ride);
  return ride;
}

Then(
  'the rides saved on this device list the ride as {string}, done for the {string} entry {string}',
  async function (this: RidrsWorld, name: string, provider: string, id: string) {
    const ride = await savedRide(this);
    assert.equal(ride.name, name);
    assert.deepEqual(ride.planned, { provider, id });
    assert.equal(this.stateOf(trainingHistoryState.id).at(-1)?.key, DEFAULT_PROVIDER);
  },
);

Then(
  'the rides saved on this device list the ride as {string}, without a planned entry',
  async function (this: RidrsWorld, name: string) {
    const ride = await savedRide(this);
    assert.equal(ride.name, name);
    assert.equal(ride.planned, undefined);
  },
);
