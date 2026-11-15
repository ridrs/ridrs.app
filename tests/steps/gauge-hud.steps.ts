// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { type PhysicsState, physicsStateEvent } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

const EN_DASH = '–';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

/** Waits for `check`; under fake timers `waitFor` would wait for timers that never run, so the host settles and it checks once. */
async function eventually(world: RidrsWorld, check: () => void): Promise<void> {
  if (world.fakeClock) {
    await world.settle();
    check();
    return;
  }
  await waitFor(check);
}

async function gauge(world: RidrsWorld, kind: string): Promise<HTMLElement> {
  return within(ui(world)).findByTestId(`gauge-${kind}`);
}

function zones(element: HTMLElement): Element[] {
  return [...element.querySelectorAll('[data-zone-band]')];
}

Then(
  'pointer events pass through the gauge HUD except on its gauges and widgets',
  async function (this: RidrsWorld) {
    const hud = await within(ui(this)).findByTestId('hud');
    assert.equal(getComputedStyle(hud).pointerEvents, 'none');
    assert.equal(
      getComputedStyle(within(hud).getByTestId('slot-hud-widget')).pointerEvents,
      'none',
    );
    const cluster = await within(ui(this)).findByTestId('gauges');
    assert.equal(getComputedStyle(cluster).pointerEvents, 'none');
    for (const element of within(cluster).getAllByTestId(/^gauge-/)) {
      assert.equal(getComputedStyle(element).pointerEvents, 'auto');
    }
  },
);

Then('the gauges are shown', async function (this: RidrsWorld) {
  await within(ui(this)).findByTestId('gauge-power');
  await this.settle();
});

Then('the gauges are shown in the order {string}', async function (this: RidrsWorld, csv: string) {
  const cluster = await within(ui(this)).findByTestId('gauges');
  const kinds = within(cluster)
    .getAllByTestId(/^gauge-/)
    .map((element) => element.dataset.testid?.replace('gauge-', ''));
  assert.deepEqual(
    kinds,
    csv.split(',').map((kind) => kind.trim()),
  );
});

// happy-dom has no layout: the place is asserted on the declared position, as for the HUD layers.
Then('the telemetry sits at the top left', async function (this: RidrsWorld) {
  const cluster = await within(ui(this)).findByTestId('gauges');
  assert.equal(cluster.style.position, 'absolute');
  assert.equal(cluster.style.top, '16px');
  assert.equal(cluster.style.left, '16px');
});

Then(
  "the ride's time, distance and speed sit at the top centre",
  async function (this: RidrsWorld) {
    const ride = await within(ui(this)).findByTestId('ride-facts');
    assert.equal(ride.style.position, 'absolute');
    assert.equal(ride.style.top, '16px');
    assert.equal(ride.style.left, '50%');
    assert.equal(ride.style.transform, 'translateX(-50%)');
  },
);

When(
  'the physics reports step {int} at a speed of {float} m\\/s after {int} m',
  async function (this: RidrsWorld, step: number, speed: number, distance: number) {
    const ctx = this.ensureHost().getPluginContext('test-device');
    assert.ok(ctx, 'Expected the test device');
    const state: PhysicsState = {
      sessionId: 'session-1',
      step,
      at: step * 10,
      speed,
      distance,
      acceleration: 0,
      mass: 85,
      riderPower: { status: 'unavailable', at: 0, reason: 'no-source' },
      wheelPower: 0,
      driveForce: 0,
      resistance: { total: 0, contributions: [] },
      road: { gradient: 0, surface: 'asphalt', origin: 'default' },
    };
    // A stand-in for the physics: no physics plugin runs in these scenarios.
    ctx.inputs.accept(physicsStateEvent, state);
    await this.settle();
  },
);

async function fact(world: RidrsWorld, kind: string): Promise<HTMLElement> {
  const ride = await within(ui(world)).findByTestId('ride-facts');
  return within(ride).getByTestId(`ride-${kind}`);
}

Then('the ride shows the time {string}', async function (this: RidrsWorld, value: string) {
  const element = await fact(this, 'time');
  await eventually(this, () =>
    assert.equal(within(element).getByTestId('value').textContent, value),
  );
});

for (const kind of ['distance', 'speed']) {
  Then(
    `the ride shows the ${kind} {string} {string}`,
    async function (this: RidrsWorld, value: string, unit: string) {
      const element = await fact(this, kind);
      await eventually(this, () => {
        assert.equal(within(element).getByTestId('value').textContent, value);
        assert.equal(within(element).getByTestId('unit').textContent, unit);
      });
    },
  );
}

Then("the widgets of the HUD keep clear of the ride's buttons", async function (this: RidrsWorld) {
  const slot = await within(ui(this)).findByTestId('slot-hud-widget');
  assert.match(slot.style.bottom, /var\(--ridrs-hud-inset-bottom/);
});

Then(
  'the {word} gauge shows {string} {string}',
  async function (this: RidrsWorld, kind: string, value: string, unit: string) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      assert.equal(element.dataset.status, 'available');
      assert.equal(within(element).getByTestId('value').textContent, value);
      assert.equal(within(element).getByTestId('unit').textContent, unit);
    });
  },
);

Then(
  'the {word} gauge shows the average {string}',
  async function (this: RidrsWorld, kind: string, value: string) {
    const element = await gauge(this, kind);
    await eventually(this, () =>
      assert.equal(within(element).getByTestId('average').textContent, value),
    );
  },
);

Then('the {word} gauge shows no average', async function (this: RidrsWorld, kind: string) {
  const element = await gauge(this, kind);
  assert.equal(within(element).queryByTestId('average'), null);
});

Then('the {word} gauge is unavailable', async function (this: RidrsWorld, kind: string) {
  const element = await gauge(this, kind);
  assert.equal(element.dataset.status, 'unavailable');
  assert.equal(within(element).getByTestId('value').textContent, EN_DASH);
});

Then(
  'the {word} gauge is unavailable with the reason {string}',
  async function (this: RidrsWorld, kind: string, reason: string) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      assert.equal(element.dataset.status, 'unavailable');
      assert.equal(within(element).getByTestId('value').textContent, EN_DASH);
      assert.equal(within(element).getByTestId('reason').textContent, reason);
    });
  },
);

Then(
  'the {word} gauge has {int} zones on its scale',
  async function (this: RidrsWorld, kind: string, count: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => assert.equal(zones(element).length, count));
  },
);

function zoneBand(element: HTMLElement, zone: number): Element {
  const band = zones(element).find((item) => item.getAttribute('data-zone') === String(zone));
  assert.ok(band, `No zone ${zone} on the scale`);
  return band;
}

Then(
  'zone {int} of the {word} gauge runs from {int} to {int}',
  async function (this: RidrsWorld, zone: number, kind: string, from: number, to: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      const band = zoneBand(element, zone);
      assert.equal(band.getAttribute('data-from'), String(from));
      assert.equal(band.getAttribute('data-to'), String(to));
    });
  },
);

Then(
  'zone {int} of the {word} gauge runs from {int} to the end of the scale',
  async function (this: RidrsWorld, zone: number, kind: string, from: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      const band = zoneBand(element, zone);
      assert.equal(band.getAttribute('data-from'), String(from));
      assert.equal(band.getAttribute('data-to'), element.dataset.max);
    });
  },
);

Then(
  'the {word} gauge marks zone {int}',
  async function (this: RidrsWorld, kind: string, zone: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => assert.equal(element.dataset.zone, String(zone)));
  },
);
