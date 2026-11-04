// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import {
  activityStateChangedEvent,
  type EventEnvelope,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
  type TerrainPreview,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

/*
 * The landscape as a sensor in the e2e app. The fixture "fixture-terrain-observer" records
 * what the landscape observed, what the driver accepted and the odometer into `hostObserved`.
 */

function ofType<T>(world: RidrsWorld, type: string): EventEnvelope<T>[] {
  return world.hostObserved.filter((e) => e.type === type) as EventEnvelope<T>[];
}

const observed = (world: RidrsWorld) => ofType<TerrainPreview>(world, uiTerrainObservedEvent.id);

const endOf = (window: TerrainPreview) =>
  window.originDistance + (window.samples.length - 1) * window.spacing;

function landscape(world: RidrsWorld): Promise<HTMLElement> {
  const root = world.uiViews[0]?.root;
  assert.ok(root, 'Expected the app to be shown');
  return within(root).findByTestId('landscape');
}

function assertWindows(
  world: RidrsWorld,
  count: number,
  origin: number,
  samples: number,
  spacing: number,
) {
  const windows = observed(world).map((e) => e.payload);
  assert.equal(windows.length, count, JSON.stringify(windows.map((w) => w.originDistance)));
  for (const window of windows) {
    assert.deepEqual(
      { origin: window.originDistance, samples: window.samples.length, spacing: window.spacing },
      { origin, samples, spacing },
    );
  }
}

Then(
  /^(eventually )?the landscape observed (\d+) windows?, from ([\d.]+) m with (\d+) samples ([\d.]+) m apart$/,
  async function (
    this: RidrsWorld,
    eventually: string | null,
    count: string,
    origin: string,
    samples: string,
    spacing: string,
  ) {
    const check = () =>
      assertWindows(this, Number(count), Number(origin), Number(samples), Number(spacing));
    if (eventually) {
      await waitFor(check, { timeout: 5000 });
    } else {
      check();
    }
  },
);

When('{int} second(s) pass(es) in the app', async function (this: RidrsWorld, seconds: number) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
});

Then(
  'every window of the ride went out with less than {float} m left of the one before, from the whole metre at or behind the odometer',
  function (this: RidrsWorld, half: number) {
    const running = ofType(this, activityStateChangedEvent.id).find(
      (e) => (e.payload as { state: string }).state === 'running',
    );
    assert.ok(running, 'Expected the ride to run');
    // The first window goes out when the landscape is mounted for the ride, from 0 m.
    const windows = observed(this).filter((e) => e.seq > running.seq);
    assert.equal(windows[0]?.payload.originDistance, 0);
    const ride = windows.slice(1);
    assert.ok(ride.length > 0, 'Expected windows while riding');
    const batches = ofType<PhysicsStateBatch>(this, physicsStateBatchEvent.id);
    for (const window of ride) {
      const previous = windows[windows.indexOf(window) - 1];
      assert.ok(previous);
      const { originDistance, spacing } = window.payload;
      // The presented position was within `half` of the previous window's end, and the window
      // starts at the whole metre at or before it.
      assert.ok(
        originDistance > endOf(previous.payload) - half - spacing,
        `window ${window.payload.revision} from ${originDistance} m, ${endOf(previous.payload)} m end before`,
      );
      const odometer = batches
        .filter((b) => b.seq < window.seq)
        .at(-1)
        ?.payload.samples.at(-1)?.distance;
      assert.ok(odometer !== undefined && originDistance <= odometer, `odometer ${odometer} m`);
    }
  },
);

Then(
  '{string} accepted every window the landscape observed',
  function (this: RidrsWorld, driverId: string) {
    const accepted = ofType<TerrainPreview>(this, worldTerrainPreviewEvent.id).filter(
      (e) => e.source === driverId,
    );
    assert.ok(accepted.every((e) => e.input === true));
    assert.deepEqual(
      accepted.map((e) => e.payload),
      observed(this).map((e) => e.payload),
    );
  },
);

Then('the app reported no {string} diagnostic', function (this: RidrsWorld, code: string) {
  assert.ok(this.nativeApp, 'Expected the ridrs app to run');
  assert.deepEqual(
    this.nativeApp.host.getDiagnostics().filter((d) => d.code === code),
    [],
  );
});

// ---- What the landscape draws ----------------------------------------------------------------

/** The drawn road sections; React renders the group before its effect draws into it. */
async function sections(world: RidrsWorld) {
  const road = await within(await landscape(world)).findByTestId('road');
  await waitFor(() => assert.ok(road.children.length > 0, 'No road sections drawn'));
  return [...road.children].map((path) => ({
    surface: path.getAttribute('data-surface'),
    from: Number(path.getAttribute('data-from')),
    to: Number(path.getAttribute('data-to')),
    fill: path.getAttribute('fill'),
  }));
}

Then(
  'the landscape draws the road ahead as {string} from {float} m to {float} m only',
  async function (this: RidrsWorld, surface: string, from: number, to: number) {
    const all = await sections(this);
    assert.deepEqual(
      all.map((s) => [s.surface, s.from, s.to]),
      [[surface, from, to]],
    );
  },
);

Then(
  /^(?:eventually )?the landscape draws the road ahead as "([^"]+)" from ([\d.]+) m to ([\d.]+) m, then "([^"]+)" to ([\d.]+) m$/,
  { timeout: 10_000 },
  async function (
    this: RidrsWorld,
    first: string,
    fromText: string,
    boundaryText: string,
    second: string,
    toText: string,
  ) {
    const [from, boundary, to] = [fromText, boundaryText, toText].map(Number);
    await waitFor(
      async () => {
        const [a, b] = await sections(this);
        assert.deepEqual(
          [a && [a.surface, a.from, a.to], b && [b.surface, b.from, b.to]],
          [
            [first, from, boundary],
            [second, boundary, to],
          ],
        );
      },
      { timeout: 5000 },
    );
  },
);

Then(
  'the landscape draws {string} and {string} in different colours',
  async function (this: RidrsWorld, first: string, second: string) {
    const all = await sections(this);
    const fill = (surface: string) => all.find((s) => s.surface === surface)?.fill;
    assert.ok(fill(first) && fill(second) && fill(first) !== fill(second), JSON.stringify(all));
  },
);

Then(
  /^(eventually )?the landscape shows "([^"]+)" under the rider$/,
  { timeout: 15_000 },
  async function (this: RidrsWorld, eventually: string | null, surface: string) {
    const svg = await landscape(this);
    const check = () => assert.equal(svg.getAttribute('data-surface'), surface);
    if (eventually) {
      await waitFor(check, { timeout: 12_000 });
    } else {
      check();
    }
  },
);

Then(
  'eventually {string} accepted the input {string} from {float} m',
  async function (this: RidrsWorld, driverId: string, eventId: string, origin: number) {
    await waitFor(() => {
      const accepted = ofType<TerrainPreview>(this, eventId).filter(
        (e) => e.source === driverId && e.input === true,
      );
      assert.equal(accepted.at(-1)?.payload.originDistance, origin);
    });
  },
);
