// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  activityStateChangedEvent,
  type EventEnvelope,
  type PhysicsSample,
  type PhysicsState,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
  physicsStateEvent,
  type TerrainPreview,
  type TerrainSurface,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import {
  DEMO_LANDSCAPE,
  remainingAhead,
  TERRAIN_WINDOW,
  type TerrainWindow,
  terrainWindow,
} from '../../plugins/ui-landscape-demo/client/landscape-model.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';
import { addProbe, assertClose, currentSessionId, stateAt } from './physics.steps.ts';

/** A mock world's terrain for a whole test ride: longer than any scenario rides. */
const WHOLE_RIDE = 10_000;

// ---- Mock worlds ---------------------------------------------------------------------------

/**
 * A mock world: sensor and driver in one test plugin, of the driver's type `transport` (a
 * replay leaves it out and injects what it recorded). It feeds its terrain through the same input
 * path as the UI landscape's driver (`ctx.inputs.accept` of `world.terrain-preview`): one window
 * from 0 m when a ride starts, as the landscape does when it is mounted for the ride.
 */
async function addMockWorld(
  world: RidrsWorld,
  probeId: string,
  window: Omit<TerrainPreview, 'revision'>,
  delayMs = 0,
): Promise<void> {
  world.getBehavior(probeId).onStart.push((ctx) => {
    let revision = 0;
    const feed = () => {
      revision += 1;
      ctx.inputs.accept(worldTerrainPreviewEvent, { revision, ...window });
    };
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'running' && payload.resumedAt === undefined) {
        if (delayMs === 0) {
          feed();
        } else {
          // A world that loads first, like a video route: its first window comes later.
          ctx.clock.scheduleAt(payload.startedAt + delayMs, feed);
        }
      }
    });
  });
  await addProbe(world, probeId, { types: ['transport'] });
}

function sampled(
  length: number,
  gradientAt: (distance: number) => number,
  surface?: TerrainSurface,
): Omit<TerrainPreview, 'revision'> {
  return {
    originDistance: 0,
    spacing: 1,
    samples: Array.from({ length: length + 1 }, (_, d) => ({
      gradient: gradientAt(d),
      ...(surface ? { surface } : {}),
    })),
  };
}

Given(
  'a mock world {string} feeds the terrain ahead with a constant gradient of {float} % when the ride starts',
  async function (this: RidrsWorld, probeId: string, percent: number) {
    await addMockWorld(
      this,
      probeId,
      sampled(WHOLE_RIDE, () => percent / 100),
    );
  },
);

Given(
  'a mock world {string} feeds the terrain ahead with a constant gradient of {float} % {float} s after the ride starts',
  async function (this: RidrsWorld, probeId: string, percent: number, seconds: number) {
    await addMockWorld(
      this,
      probeId,
      sampled(WHOLE_RIDE, () => percent / 100),
      seconds * 1000,
    );
  },
);

Given(
  'a mock world {string} feeds flat {string} ahead when the ride starts',
  async function (this: RidrsWorld, probeId: string, surface: string) {
    await addMockWorld(
      this,
      probeId,
      sampled(WHOLE_RIDE, () => 0, surface as TerrainSurface),
    );
  },
);

Given(
  'a mock world {string} feeds the terrain ahead, flat for the first {float} m and then climbing at {float} %, when the ride starts',
  async function (this: RidrsWorld, probeId: string, flat: number, percent: number) {
    await addMockWorld(
      this,
      probeId,
      sampled(WHOLE_RIDE, (d) => (d < flat ? 0 : percent / 100)),
    );
  },
);

Given(
  'a mock world {string} feeds a single window of {int} m with a constant gradient of {float} % when the ride starts',
  async function (this: RidrsWorld, probeId: string, length: number, percent: number) {
    await addMockWorld(
      this,
      probeId,
      sampled(length, () => percent / 100),
    );
  },
);

Given(
  'a mock world {string} feeds the terrain ahead with the gradients {string} % {float} m apart when the ride starts',
  async function (this: RidrsWorld, probeId: string, percentsCsv: string, spacing: number) {
    await addMockWorld(this, probeId, {
      originDistance: 0,
      spacing,
      samples: splitCsv(percentsCsv).map((percent) => ({ gradient: Number(percent) / 100 })),
    });
  },
);

/**
 * The demo landscape as the UI publishes it, but read at the physics odometer (no presentation
 * lag): the window from 0 m when the ride starts, a new one whenever less than half is left.
 */
Given(
  /^a mock world "([^"]+)" feeds the demo (landscape|course on asphalt)$/,
  async function (this: RidrsWorld, probeId: string, what: string) {
    // "the demo course on asphalt": the gradients only; a window without surface is asphalt.
    const surfaces = what === 'landscape';
    this.getBehavior(probeId).onStart.push((ctx) => {
      let revision = 0;
      let current: TerrainWindow | undefined;
      const feed = (distance: number) => {
        revision += 1;
        current = terrainWindow(DEMO_LANDSCAPE, distance);
        const samples = current.samples.map(({ gradient, surface }) =>
          surfaces ? { gradient, surface } : { gradient },
        );
        ctx.inputs.accept(worldTerrainPreviewEvent, { revision, ...current, samples });
      };
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'running') {
          feed(0);
        }
      });
      ctx.events.subscribe(physicsStateBatchEvent, ({ payload }) => {
        const distance = payload.samples.at(-1)?.distance;
        if (
          current &&
          distance !== undefined &&
          remainingAhead(current, distance) < TERRAIN_WINDOW.republishBelow
        ) {
          feed(distance);
        }
      });
    });
    await addProbe(this, probeId, { types: ['transport'] });
  },
);

When(
  '{string} feeds a window that starts {float} m ahead',
  async function (this: RidrsWorld, probeId: string, ahead: number) {
    const ctx = this.ensureHost().getPluginContext(probeId);
    assert.ok(ctx, `Expected plugin "${probeId}" to be running`);
    const distance = batches(this).at(-1)?.payload.samples.at(-1)?.distance ?? 0;
    ctx.inputs.accept(worldTerrainPreviewEvent, {
      revision: 1000,
      ...sampled(20, () => 0),
      originDistance: Math.floor(distance + ahead),
    });
    await this.settle();
  },
);

const reportedSteps = new WeakMap<RidrsWorld, number>();

When(
  '{string} reports the odometer at {float} m in a {string}',
  async function (this: RidrsWorld, probeId: string, distance: number, eventId: string) {
    assert.equal(eventId, physicsStateBatchEvent.id);
    const ctx = this.ensureHost().getPluginContext(probeId);
    assert.ok(ctx, `Expected plugin "${probeId}" to be running`);
    // Consecutive reports are consecutive steps: a presentation drops repeated ones.
    const step = (reportedSteps.get(this) ?? 0) + 1;
    reportedSteps.set(this, step);
    const sample: PhysicsSample = {
      step,
      // Without fake timers the World's clock stands still: a frame shows the physics 60 ms in
      // the past, so a sample stamped now would never be shown. Stamp it a second earlier then.
      at: this.fakeClock ? ctx.clock.now() : ctx.clock.now() - 1000,
      speed: 0,
      distance,
      acceleration: 0,
      gradient: 0,
    };
    ctx.inputs.accept(physicsStateBatchEvent, {
      sessionId: currentSessionId(this),
      samples: [sample],
    });
    await this.settle();
  },
);

// ---- Published batches ---------------------------------------------------------------------

function batches(world: RidrsWorld): EventEnvelope<PhysicsStateBatch>[] {
  const sessionId = currentSessionId(world);
  return (
    world.hostObserved.filter(
      (e) => e.type === physicsStateBatchEvent.id,
    ) as EventEnvelope<PhysicsStateBatch>[]
  ).filter((e) => e.payload.sessionId === sessionId);
}

// ---- What the physics made of it -----------------------------------------------------------

Then(
  'the gradient of every step is {float} % per metre of the distance one step before',
  function (this: RidrsWorld, percentPerMetre: number) {
    const samples = batches(this).flatMap((b) => b.payload.samples);
    assert.ok(samples.length > 100, 'Expected the ride to have moved for a while');
    assert.equal(samples[0]?.gradient, 0);
    for (let n = 1; n < samples.length; n += 1) {
      const before = samples[n - 1];
      const sample = samples[n];
      assert.ok(before && sample && sample.step === before.step + 1);
      const expected = (percentPerMetre / 100) * before.distance;
      assert.ok(
        Math.abs(sample.gradient - expected) < 1e-12,
        `step ${sample.step}: gradient ${sample.gradient}, expected ${expected}`,
      );
    }
  },
);

Then(
  'the virtual distance at {string} is between {float} m and {float} m',
  function (this: RidrsWorld, time: string, from: number, to: number) {
    const { distance } = stateAt(this, time);
    assert.ok(distance > from && distance < to, `distance ${distance} m`);
  },
);

// ---- Diagnostics ---------------------------------------------------------------------------

function diagnosticsOf(world: RidrsWorld, code: string) {
  return world
    .ensureHost()
    .getDiagnostics()
    .filter((d) => d.code === code);
}

Then('no {string} diagnostic was reported', function (this: RidrsWorld, code: string) {
  assert.deepEqual(diagnosticsOf(this, code), []);
});

function onlyDistanceOf(world: RidrsWorld, code: string): number {
  const found = diagnosticsOf(world, code);
  assert.equal(found.length, 1, JSON.stringify(found));
  const distance = found[0]?.details?.distance;
  assert.equal(typeof distance, 'number');
  return distance as number;
}

Then(
  'a {string} diagnostic was reported once, at {float} m',
  function (this: RidrsWorld, code: string, distance: number) {
    assert.equal(onlyDistanceOf(this, code), distance);
  },
);

Then(
  'a {string} diagnostic was reported once, just after {float} m',
  function (this: RidrsWorld, code: string, distance: number) {
    const at = onlyDistanceOf(this, code);
    assert.ok(at > distance && at < distance + 1, `reported at ${at} m`);
  },
);

Then(
  'a {string} diagnostic was reported once, at {float} m, because of {string}',
  function (this: RidrsWorld, code: string, distance: number, reason: string) {
    assert.equal(onlyDistanceOf(this, code), distance);
    assert.equal(diagnosticsOf(this, code)[0]?.details?.reason, reason);
  },
);

Then(
  'the road at {string} is {string}',
  function (this: RidrsWorld, time: string, surface: string) {
    assert.equal(stateAt(this, time).road.surface, surface);
  },
);

Then(
  'step {int} rode on a gradient of {float} % on {string}',
  function (this: RidrsWorld, step: number, percent: number, surface: string) {
    const sample = batches(this)
      .flatMap((b) => b.payload.samples)
      .find((s) => s.step === step);
    assert.ok(sample, `No sample of step ${step}`);
    assertClose(sample.gradient * 100, percent, 'gradient (%)');
    // Batches carry no surface; the state of step 0 is published, later ones every 25 steps.
    const sessionId = currentSessionId(this);
    const state = this.hostObserved
      .filter((e) => e.type === physicsStateEvent.id)
      .map((e) => e.payload as PhysicsState)
      .find((s) => s.sessionId === sessionId && s.step === step);
    if (state) {
      assert.equal(state.road.surface, surface);
    }
  },
);

Then(
  'a {string} diagnostic was reported once, because of {string}',
  function (this: RidrsWorld, code: string, reason: string) {
    const found = diagnosticsOf(this, code);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0]?.details?.reason, reason);
  },
);
