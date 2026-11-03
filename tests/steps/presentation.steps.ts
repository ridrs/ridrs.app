// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { After, type DataTable, Given, Then } from '@cucumber/cucumber';
import {
  type EventDefinition,
  type EventEnvelope,
  type PhysicsSample,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
} from '@ridrs/contracts';
import {
  createPhysicsPresentation,
  FrameClock,
  type FrameSource,
  type PhysicsPresentation,
  type PresentedPhysics,
  timerFrameSource,
} from '@ridrs/presentation';
import type { UiContext, UiFrame } from '@ridrs/ui-sdk';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';
import {
  addProbe,
  assertClose,
  currentSessionId,
  formatOffset,
  parseOffset,
  usePhysicsPlugins,
} from './physics.steps.ts';

const LANDSCAPE = 'ui-landscape-flat';

/** Per-scenario state of these steps; the World stays free of Phase 7 details. */
interface PresentationState {
  /** interpolation.feature: a presentation fed by hand. */
  fed?: { readonly subject: PhysicsPresentation; deliver?: (batch: PhysicsStateBatch) => void };
  /** Every result the scenario asked for, to check that they are read-only. */
  readonly results: PresentedPhysics[];
  /** render-clock.feature: a presentation on the in-process bridge, rendered by a frame clock. */
  client?: {
    readonly clock: FrameClock;
    readonly presentation: PhysicsPresentation;
    readonly frames: Array<{ readonly frame: UiFrame; readonly presented: PresentedPhysics }>;
    readonly stop: () => void;
  };
  /** ride-with-moving-road.feature: the frame source the native app renders with. */
  appFrames?: RecordingFrameSource;
}

const states = new WeakMap<RidrsWorld, PresentationState>();

function stateOf(world: RidrsWorld): PresentationState {
  let state = states.get(world);
  if (!state) {
    state = { results: [] };
    states.set(world, state);
  }
  return state;
}

After(function (this: RidrsWorld) {
  const state = states.get(this);
  state?.client?.stop();
  state?.fed?.subject.dispose();
  states.delete(this);
});

// ---- interpolation.feature: the presentation alone --------------------------------------

function fedPresentation(world: RidrsWorld) {
  const state = stateOf(world);
  if (!state.fed) {
    const fed: { deliver?: (batch: PhysicsStateBatch) => void } = {};
    const subject = createPhysicsPresentation({
      subscribe<T>(def: EventDefinition<T>, handler: (envelope: EventEnvelope<T>) => void) {
        assert.equal(def.id, physicsStateBatchEvent.id);
        fed.deliver = (batch) =>
          handler({
            id: `batch-${batch.samples[0]?.step}`,
            type: def.id,
            source: 'physics-engine',
            timestamp: batch.samples.at(-1)?.at ?? 0,
            seq: 0,
            payload: def.schema.parse(batch),
          });
        return () => {
          fed.deliver = undefined;
        };
      },
      publish() {
        throw new Error('A presentation never publishes');
      },
    });
    state.fed = Object.assign(fed, { subject });
  }
  return state.fed;
}

Given(
  'the presentation receives a batch of session {string}:',
  function (this: RidrsWorld, sessionId: string, table: DataTable) {
    const samples: PhysicsSample[] = table.hashes().map((row) => ({
      step: Number(row.step),
      at: parseOffset(row.at ?? ''),
      speed: Number(row.speed),
      distance: Number(row.distance),
      acceleration: 0,
      gradient: Number(row.gradient) / 100,
    }));
    const fed = fedPresentation(this);
    assert.ok(fed.deliver, 'The presentation is not subscribed');
    fed.deliver({ sessionId, samples });
  },
);

function presentAt(world: RidrsWorld, time: string): PresentedPhysics {
  const presented = fedPresentation(world).subject.at(parseOffset(time));
  stateOf(world).results.push(presented);
  return presented;
}

Then(
  'the frame at {string} presents step {int} with a speed of {float} m\\/s, a distance of {float} m and a gradient of {float} % {string}',
  function (
    this: RidrsWorld,
    time: string,
    step: number,
    speed: number,
    distance: number,
    gradient: number,
    basis: string,
  ) {
    const presented = presentAt(this, time);
    assert.equal(presented.status, 'available', JSON.stringify(presented));
    assert.ok(presented.status === 'available');
    assert.equal(presented.basis, basis);
    assert.equal(presented.step, step);
    assertClose(presented.speed, speed, 'speed (m/s)');
    assertClose(presented.distance, distance, 'distance (m)');
    assertClose(presented.gradient * 100, gradient, 'gradient (%)');
  },
);

Then('the frame at {string} presents nothing', function (this: RidrsWorld, time: string) {
  assert.equal(presentAt(this, time).status, 'none');
});

Then('the presented states are read-only', function (this: RidrsWorld) {
  const { results } = stateOf(this);
  assert.ok(results.length > 0, 'Expected presented states');
  for (const presented of results) {
    assert.ok(Object.isFrozen(presented), JSON.stringify(presented));
    assert.throws(() => {
      (presented as { renderTime: number }).renderTime = 0;
    }, TypeError);
  }
  // Asking again gives the same answers: presenting never changes the history.
  const subject = fedPresentation(this).subject;
  for (const presented of results) {
    assert.deepEqual(
      subject.at(presented.renderTime + 60),
      presented,
      `at ${formatOffset(presented.renderTime)}`,
    );
  }
});

// ---- state-stream.feature: the engine's batches ------------------------------------------

function batches(world: RidrsWorld): PhysicsStateBatch[] {
  return world.hostObserved
    .filter((e) => e.type === physicsStateBatchEvent.id)
    .map((e) => e.payload as PhysicsStateBatch);
}

function currentBatches(world: RidrsWorld): PhysicsStateBatch[] {
  const sessionId = currentSessionId(world);
  return batches(world).filter((batch) => batch.sessionId === sessionId);
}

const stepsOf = (batch: PhysicsStateBatch) => batch.samples.map((sample) => sample.step);

Then(
  'the latest {string} event contains the steps {string}',
  function (this: RidrsWorld, eventId: string, stepsCsv: string) {
    assert.equal(eventId, physicsStateBatchEvent.id);
    const latest = batches(this).at(-1);
    assert.ok(latest, `Expected a "${eventId}" event`);
    assert.deepEqual(stepsOf(latest), splitCsv(stepsCsv).map(Number));
  },
);

Then('{int} physics state batches were published', function (this: RidrsWorld, count: number) {
  assert.equal(currentBatches(this).length, count);
});

Then(
  'together they contain every step from {int} to {int} exactly once, in order',
  function (this: RidrsWorld, from: number, to: number) {
    assert.deepEqual(
      currentBatches(this).flatMap(stepsOf),
      Array.from({ length: to - from + 1 }, (_, n) => from + n),
    );
  },
);

Then(
  'the sample of step {int} has a speed of {float} km\\/h and a distance of {float} m',
  function (this: RidrsWorld, step: number, speed: number, distance: number) {
    const sample = currentBatches(this)
      .flatMap((batch) => batch.samples)
      .find((s) => s.step === step);
    assert.ok(sample, `No sample of step ${step}`);
    assertClose(sample.speed * 3.6, speed, 'speed (km/h)');
    assertClose(sample.distance, distance, 'distance (m)');
  },
);

// ---- render-clock.feature: a presentation client on the in-process bridge -------------------

Given(
  'the ridrs physics plugins and {string} together with a test device plugin {string} and a probe plugin {string}',
  async function (this: RidrsWorld, uiPluginId: string, deviceId: string, probeId: string) {
    await usePhysicsPlugins(this);
    this.realPluginIds = [...this.realPluginIds, uiPluginId];
    // The in-process UI bridge is created with the host, its allow-list from the UI manifests.
    this.uiEnabled = true;
    await addProbe(this, deviceId, { types: ['device'] });
    await addProbe(this, probeId);
  },
);

/** `ctx.events` of `pluginId` on the World's bridge: subscribe only, payloads validated. */
function bridgeEvents(world: RidrsWorld, pluginId: string): UiContext['events'] {
  const bridge = world.uiBridge;
  assert.ok(bridge, 'Expected the in-process UI bridge');
  return {
    subscribe<T>(def: EventDefinition<T>, handler: (envelope: EventEnvelope<T>) => void) {
      const declared = bridge.registry().plugins.find((p) => p.pluginId === pluginId)?.events;
      assert.ok(declared?.subscribe.includes(def.id), `"${pluginId}" did not declare "${def.id}"`);
      return bridge.subscribe(def.id, (envelope) =>
        handler({ ...envelope, payload: def.schema.parse(envelope.payload) }),
      );
    },
    publish() {
      throw new Error('The presentation client publishes nothing');
    },
  };
}

Given(
  'a presentation client renders at {int} frames per second',
  function (this: RidrsWorld, fps: number) {
    if (fps === 0) {
      return;
    }
    const bridge = this.uiBridge;
    assert.ok(bridge, 'Expected the in-process UI bridge');
    const presentation = createPhysicsPresentation(bridgeEvents(this, LANDSCAPE));
    const clock = new FrameClock({
      source: timerFrameSource(fps),
      now: () => bridge.now(),
      onError: (error, owner) =>
        bridge.reportClientError(owner ?? LANDSCAPE, `frame handler: ${String(error)}`),
    });
    const frames: NonNullable<PresentationState['client']>['frames'] = [];
    const stopFrames = clock.onFrame(
      (frame) => frames.push({ frame, presented: presentation.at(frame.time) }),
      LANDSCAPE,
    );
    stateOf(this).client = {
      clock,
      presentation,
      frames,
      stop: () => {
        stopFrames();
        presentation.dispose();
      },
    };
  },
);

function client(world: RidrsWorld) {
  const found = stateOf(world).client;
  assert.ok(found, 'Expected a presentation client');
  return found;
}

Given(
  'a second frame handler of {string} throws on every frame',
  function (this: RidrsWorld, pluginId: string) {
    client(this).clock.onFrame(() => {
      throw new Error('broken frame handler');
    }, pluginId);
  },
);

Then('{int} frames were rendered', function (this: RidrsWorld, count: number) {
  assert.equal(client(this).frames.length, count);
});

function frameAt(world: RidrsWorld, time: string): PresentedPhysics {
  const at = parseOffset(time);
  const { frames } = client(world);
  const found = frames.find((f) => f.frame.time === at);
  assert.ok(
    found,
    `No frame at "${time}"; frames around it at ${frames
      .filter((f) => Math.abs(f.frame.time - at) < 50)
      .map((f) => formatOffset(f.frame.time))
      .join(', ')}`,
  );
  return found.presented;
}

Then(
  'the frame at {string} presented a speed of {float} km\\/h and a distance of {float} m {string}',
  function (this: RidrsWorld, time: string, speed: number, distance: number, basis: string) {
    const presented = frameAt(this, time);
    assert.equal(presented.status, 'available', JSON.stringify(presented));
    assert.ok(presented.status === 'available');
    assert.equal(presented.basis, basis);
    assertClose(presented.speed * 3.6, speed, 'speed (km/h)');
    assertClose(presented.distance, distance, 'distance (m)');
  },
);

Then('the frame at {string} presented nothing', function (this: RidrsWorld, time: string) {
  assert.equal(frameAt(this, time).status, 'none');
});

Then(
  'a client failure of {string} was reported once',
  function (this: RidrsWorld, pluginId: string) {
    const failures = this.ensureHost()
      .getDiagnostics()
      .filter((d) => d.code === 'client-load-failure' && d.pluginId === pluginId);
    assert.equal(failures.length, 1, JSON.stringify(failures));
  },
);

// ---- ride-with-moving-road.feature: the native app on real time ---------------------------

/** Wraps a frame source to count frames and see whether one is requested. */
interface RecordingFrameSource extends FrameSource {
  readonly fired: number;
  readonly pending: boolean;
  /** Resolves after the next frame's handlers ran. */
  nextFrame(): Promise<void>;
}

function recording(source: FrameSource): RecordingFrameSource {
  let fired = 0;
  let pending = 0;
  const waiting: Array<() => void> = [];
  return {
    get fired() {
      return fired;
    },
    get pending() {
      return pending > 0;
    },
    nextFrame: () => new Promise((resolve) => waiting.push(resolve)),
    request(callback) {
      pending += 1;
      let done = false;
      const cancel = source.request(() => {
        done = true;
        pending -= 1;
        fired += 1;
        callback();
        for (const resolve of waiting.splice(0)) {
          resolve();
        }
      });
      return () => {
        if (!done) {
          done = true;
          pending -= 1;
          cancel();
        }
      };
    },
  };
}

function appFrames(world: RidrsWorld): RecordingFrameSource {
  const frames = stateOf(world).appFrames;
  assert.ok(frames, 'Expected the app to render with a test frame source');
  return frames;
}

Given('the app renders with a {int} FPS frame source', function (this: RidrsWorld, fps: number) {
  const source = recording(timerFrameSource(fps));
  stateOf(this).appFrames = source;
  this.nativeFrameSource = source;
});

async function landscape(world: RidrsWorld): Promise<HTMLElement> {
  const roots = world.uiViews.map((view) => view.root);
  assert.ok(roots[0], 'Expected the app to be shown');
  return within(roots[0]).findByTestId('landscape-flat');
}

/** The distance the landscape presents, or undefined while it presents nothing. */
function presentedDistance(svg: Element): number | undefined {
  const text = svg.getAttribute('data-distance') ?? '';
  return text === '' ? undefined : Number(text);
}

Then(
  'eventually the landscape presents a distance of more than {float} m',
  { timeout: 15_000 },
  async function (this: RidrsWorld, bound: number) {
    const svg = await landscape(this);
    await waitFor(
      () => {
        const distance = presentedDistance(svg);
        assert.ok(distance !== undefined && distance > bound, `presents ${distance} m`);
        assert.ok(['exact', 'interpolated', 'held'].includes(svg.getAttribute('data-basis') ?? ''));
      },
      { timeout: 12_000 },
    );
  },
);

Then(
  "the landscape's distance never decreases over {int} frames",
  async function (this: RidrsWorld, count: number) {
    const svg = await landscape(this);
    const source = appFrames(this);
    const distances: number[] = [];
    while (distances.length < count) {
      await source.nextFrame();
      const distance = presentedDistance(svg);
      assert.ok(distance !== undefined, 'The landscape stopped presenting');
      distances.push(distance);
    }
    for (let n = 1; n < distances.length; n += 1) {
      assert.ok(
        (distances[n] ?? 0) >= (distances[n - 1] ?? 0),
        `distance fell in frame ${n}: ${distances.join(', ')}`,
      );
    }
    assert.ok(
      (distances.at(-1) ?? 0) > (distances[0] ?? 0),
      `no movement: ${distances.join(', ')}`,
    );
  },
);

Then(
  'between {int} and {int} frames are rendered per second',
  async function (this: RidrsWorld, min: number, max: number) {
    const source = appFrames(this);
    const before = source.fired;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const perSecond = (source.fired - before) / 2;
    assert.ok(perSecond >= min && perSecond <= max, `${perSecond} frames per second`);
  },
);

Then('no frames are rendered', async function (this: RidrsWorld) {
  const source = appFrames(this);
  await waitFor(() => assert.equal(source.pending, false, 'A frame is still requested'));
  const before = source.fired;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(source.fired, before);
});
