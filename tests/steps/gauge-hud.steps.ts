// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { type PhysicsState, physicsStateEvent, trainerTargetPowerEvent } from '@ridrs/contracts';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

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
Then('the telemetry sits at the bottom centre', async function (this: RidrsWorld) {
  const cluster = await within(ui(this)).findByTestId('gauges');
  assert.equal(cluster.style.position, 'absolute');
  assert.match(cluster.style.bottom, /var\(--ridrs-hud-inset-bottom/);
  assert.equal(cluster.style.left, '50%');
  assert.equal(cluster.style.transform, 'translateX(-50%)');
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

/** A stand-in for the physics: no physics plugin runs in these scenarios. */
async function reportPhysics(
  world: RidrsWorld,
  state: Pick<PhysicsState, 'step' | 'speed' | 'distance' | 'timeFromStep'>,
): Promise<void> {
  const ctx = world.ensureHost().getPluginContext('test-device');
  assert.ok(ctx, 'Expected the test device');
  ctx.inputs.accept(physicsStateEvent, {
    sessionId: 'session-1',
    at: state.step * 10,
    acceleration: 0,
    mass: 85,
    riderPower: { status: 'unavailable', at: 0, reason: 'no-source' },
    wheelPower: 0,
    driveForce: 0,
    resistance: { total: 0, contributions: [] },
    road: { gradient: 0, surface: 'asphalt', origin: 'default' },
    ...state,
  });
  await world.settle();
}

When(
  'the physics reports step {int} at a speed of {float} m\\/s after {int} m',
  async function (this: RidrsWorld, step: number, speed: number, distance: number) {
    await reportPhysics(this, { step, speed, distance });
  },
);

When(
  'the physics reports step {int} at a speed of {float} m\\/s after {int} m, waiting for the rider',
  async function (this: RidrsWorld, step: number, speed: number, distance: number) {
    await reportPhysics(this, { step, speed, distance, timeFromStep: step });
  },
);

When(
  'the physics reports step {int} at a speed of {float} m\\/s after {int} m, rolling since step {int}',
  async function (this: RidrsWorld, step: number, speed: number, distance: number, since: number) {
    await reportPhysics(this, { step, speed, distance, timeFromStep: since });
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

Then('the widgets of the HUD sit in the lower corners', async function (this: RidrsWorld) {
  const slot = await within(ui(this)).findByTestId('slot-hud-widget');
  assert.match(slot.style.bottom, /var\(--ridrs-hud-inset-bottom/);
  assert.equal(slot.style.justifyContent, 'space-between');
});

Then(
  'the {word} gauge shows {string} {string}',
  async function (this: RidrsWorld, kind: string, value: string, unit: string) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      assert.equal(element.dataset.status, 'available');
      assert.equal(Number(element.style.opacity || '1'), 1);
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

Then(
  'the {word} gauge does not draw its name {string}',
  async function (this: RidrsWorld, kind: string, name: string) {
    const drawn = (await gauge(this, kind)).querySelector('svg')?.textContent ?? '';
    assert.ok(
      !drawn.toLowerCase().includes(name.toLowerCase()),
      `the ${kind} gauge draws: ${drawn}`,
    );
  },
);

Then(
  'the {word} gauge lights its scale up to {int}',
  async function (this: RidrsWorld, kind: string, value: number) {
    const element = await gauge(this, kind);
    await eventually(this, () =>
      assert.equal(within(element).getByTestId('active-arc').dataset.value, String(value)),
    );
  },
);

Then(
  'the {word} gauge marks the FTP at {int} on its scale',
  async function (this: RidrsWorld, kind: string, value: number) {
    const element = await gauge(this, kind);
    await eventually(this, () =>
      assert.equal(within(element).getByTestId('ftp-marker').dataset.value, String(value)),
    );
  },
);

Then('the {word} gauge marks no FTP', async function (this: RidrsWorld, kind: string) {
  assert.equal(within(await gauge(this, kind)).queryByTestId('ftp-marker'), null);
});

Then(
  'the {word} gauge marks its average at {int} on its scale',
  async function (this: RidrsWorld, kind: string, value: number) {
    const element = await gauge(this, kind);
    await eventually(this, () =>
      assert.equal(within(element).getByTestId('average-marker').dataset.value, String(value)),
    );
  },
);

Then(
  'the {word} gauge marks no average on its scale',
  async function (this: RidrsWorld, kind: string) {
    assert.equal(within(await gauge(this, kind)).queryByTestId('average-marker'), null);
  },
);

Then(
  'the {word} gauge draws its {word} at least {int} units high on a dial of 200',
  async function (this: RidrsWorld, kind: string, part: string, size: number) {
    const element = await gauge(this, kind);
    const text = within(element).getByTestId(part);
    assert.equal(element.querySelector('svg')?.getAttribute('viewBox'), '0 0 200 200');
    assert.ok(
      Number(text.getAttribute('font-size')) >= size,
      `the ${part} is ${text.getAttribute('font-size')} units high`,
    );
  },
);

Then(
  'the {word} gauge is named {string} for screen readers',
  async function (this: RidrsWorld, kind: string, name: string) {
    const element = await gauge(this, kind);
    assert.match(element.getAttribute('aria-label') ?? '', new RegExp(`^${name} `));
  },
);

Then(
  'the {word} gauge draws its value at the centre of the dial',
  async function (this: RidrsWorld, kind: string) {
    const value = within(await gauge(this, kind)).getByTestId('value');
    assert.equal(value.getAttribute('x'), '100');
    assert.equal(value.getAttribute('y'), '100');
    assert.equal(value.getAttribute('text-anchor'), 'middle');
    assert.equal(value.getAttribute('dominant-baseline'), 'central');
  },
);

Then('the {word} gauge shows no average', async function (this: RidrsWorld, kind: string) {
  const element = await gauge(this, kind);
  assert.equal(within(element).queryByTestId('average'), null);
});

Then(
  'the {word} gauge is dimmed and shows {string} {string}',
  async function (this: RidrsWorld, kind: string, value: string, unit: string) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      assert.equal(element.dataset.status, 'unavailable');
      const opacity = Number(element.style.opacity || '1');
      assert.ok(opacity < 1, `Expected the ${kind} gauge to be dimmed, got opacity ${opacity}`);
      assert.equal(within(element).getByTestId('value').textContent, value);
      assert.equal(within(element).getByTestId('unit').textContent, unit);
      assert.equal(within(element).queryByTestId('reason'), null);
      assert.equal(within(element).queryByTestId('active-arc'), null);
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
  "the {word} gauge's scale ends at {int}",
  async function (this: RidrsWorld, kind: string, max: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => assert.equal(element.dataset.max, String(max)));
  },
);

Then(
  'the {word} gauge marks zone {int}',
  async function (this: RidrsWorld, kind: string, zone: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => assert.equal(element.dataset.zone, String(zone)));
  },
);

Then(
  /^(?:eventually )?the (\w[\w-]*) gauge shows the gear "([^"]+)"$/,
  async function (this: RidrsWorld, kind: string, gear: string) {
    const element = await gauge(this, kind);
    await waitFor(() => assert.equal(within(element).getByTestId('gear').textContent, gear));
  },
);

Then('the {word} gauge shows no gear', async function (this: RidrsWorld, kind: string) {
  const element = await gauge(this, kind);
  await waitFor(() => assert.equal(within(element).queryByTestId('gear'), null));
});

Then(
  /^eventually the ERG target power is (\d+) W$/,
  async function (this: RidrsWorld, watts: number) {
    await waitFor(() => {
      const latest = this.tapped
        .filter((event) => event.type === trainerTargetPowerEvent.id)
        .at(-1);
      assert.deepEqual(latest?.payload, { watts });
    });
  },
);

Then('the {word} gauge draws no needle', async function (this: RidrsWorld, kind: string) {
  assert.equal(within(await gauge(this, kind)).queryByTestId('needle'), null);
});

Then('the {word} gauge draws no ERG target', async function (this: RidrsWorld, kind: string) {
  assert.equal(within(await gauge(this, kind)).queryByTestId('target-arc'), null);
});

/** The alpha of each `rgb(… / a)` or `rgba(…, a)` in a CSS value; colours without one are opaque. */
function alphas(value: string): number[] {
  return [...value.matchAll(/(?:\/|rgba\([^)]*,)\s*([\d.]+)(%?)\s*\)/g)].map(
    ([, number = '1', percent]) => (percent ? Number(number) / 100 : Number(number)),
  );
}

Then(
  'the dial of the {word} gauge lets the scenery show through',
  async function (this: RidrsWorld, kind: string) {
    const element = await gauge(this, kind);
    const background = element.style.backgroundColor;
    const found = alphas(background);
    assert.ok(found.length > 0, `Expected a translucent dial, got "${background}"`);
    assert.ok(
      found.every((alpha) => alpha < 1),
      `Expected every colour of the dial to be translucent, got ${found.join(', ')}`,
    );
  },
);

Then(
  'everything the {word} gauge draws is fully opaque',
  async function (this: RidrsWorld, kind: string) {
    const element = await gauge(this, kind);
    const svg = element.querySelector('svg');
    assert.ok(svg, 'Expected the gauge to draw its dial');
    for (const shape of svg.querySelectorAll('path, line, polygon, text, circle')) {
      for (const name of ['opacity', 'fill-opacity', 'stroke-opacity']) {
        const value = shape.getAttribute(name);
        assert.ok(value === null || Number(value) === 1, `${shape.tagName} has ${name}="${value}"`);
      }
      for (const name of ['fill', 'stroke', 'filter']) {
        const value = shape.getAttribute(name) ?? '';
        assert.ok(
          alphas(value).every((alpha) => alpha === 1),
          `${shape.tagName} is see-through: ${name}="${value}"`,
        );
      }
      // A blurred glow is a see-through halo.
      assert.equal(shape.getAttribute('filter'), null, `${shape.tagName} has a glow filter`);
    }
  },
);

When('{int} millisecond(s) go(es) by', async function (this: RidrsWorld, ms: number) {
  this.fixedTime += ms;
  await this.settle();
});

Then(
  'the {word} gauge marks the target at {int} on its scale',
  async function (this: RidrsWorld, kind: string, value: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      const marker = within(element).getByTestId('target-marker');
      const spotlight = within(element).getByTestId('target-spotlight');
      assert.equal(marker.dataset.low, String(value));
      assert.equal(marker.dataset.high, String(value));
      assert.equal(marker.dataset.center, String(value));
      assert.equal(spotlight.dataset.center, String(value));
      assert.ok(within(marker).getByTestId('target-line'));
      assert.ok(within(marker).getByTestId('target-pointer'));
    });
  },
);

Then(
  'the {word} gauge marks the target from {int} to {int} on its scale',
  async function (this: RidrsWorld, kind: string, low: number, high: number) {
    const element = await gauge(this, kind);
    const center = String(Math.round((low + high) / 2));
    await eventually(this, () => {
      const marker = within(element).getByTestId('target-marker');
      const spotlight = within(element).getByTestId('target-spotlight');
      assert.equal(marker.dataset.low, String(low));
      assert.equal(marker.dataset.high, String(high));
      assert.equal(marker.dataset.center, center);
      assert.equal(spotlight.dataset.center, center);
      assert.ok(within(marker).getByTestId('target-line'));
      assert.ok(within(marker).getByTestId('target-pointer'));
    });
  },
);

Then(
  'the {word} gauge target is moving between {int} and {int} on its scale',
  async function (this: RidrsWorld, kind: string, from: number, to: number) {
    const element = await gauge(this, kind);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    await eventually(this, () => {
      const marker = within(element).getByTestId('target-marker');
      const center = Number(marker.dataset.center);
      assert.ok(
        center > low && center < high,
        `Expected the ${kind} target centre to be moving between ${low} and ${high}, got ${center}`,
      );
    });
  },
);

Then(
  'the {word} gauge marks no target on its scale',
  async function (this: RidrsWorld, kind: string) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      assert.ok(
        within(element).queryByTestId('target-marker') === null,
        'Expected no target marker',
      );
      assert.ok(
        within(element).queryByTestId('target-spotlight') === null,
        'Expected no target spotlight',
      );
    });
  },
);

Then(
  'the target spotlight of the {word} gauge fades to transparent',
  async function (this: RidrsWorld, kind: string) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      const stops = [...element.querySelectorAll(`#target-glow-${kind} stop`)];
      assert.ok(stops.length >= 2, 'Expected radial gradient stops for the target spotlight');
      assert.equal(stops[0]?.getAttribute('stop-opacity'), '0');
      const startOffset = Number.parseFloat(stops[0]?.getAttribute('offset') ?? '0');
      assert.ok(
        startOffset >= 84,
        `Expected the inner spotlight fade to start at >= 84% of the outer radius, got ${startOffset}%`,
      );
      const colors = new Set(stops.map((stop) => stop.getAttribute('stop-color')));
      assert.equal(
        colors.size,
        1,
        `Expected the spotlight to fade one colour to transparent, got ${[...colors].join(', ')}`,
      );
    });
  },
);

Then(
  'the {word} gauge keeps all {int} scale lines across the target',
  async function (this: RidrsWorld, kind: string, expectedCount: number) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      const tickLines = element.querySelectorAll('svg > line');
      assert.equal(
        tickLines.length,
        expectedCount,
        `Expected ${expectedCount} scale tick lines on the ${kind} gauge, got ${tickLines.length}`,
      );
    });
  },
);

Then(
  'the {word} gauge stacks the inner target, the scale lines and numbers, the current reading and the outer target in that order',
  async function (this: RidrsWorld, kind: string) {
    const element = await gauge(this, kind);
    await eventually(this, () => {
      const svg = element.querySelector('svg');
      assert.ok(svg, 'Expected the gauge SVG');
      const all = [...svg.querySelectorAll('*')];
      const indexOf = (node: Element) => all.indexOf(node);
      const spotlight = within(element).getByTestId('target-spotlight');
      const tickLines = [...svg.querySelectorAll(':scope > line')];
      const tickNumbers = [...svg.querySelectorAll(':scope > text')].filter(
        (text) => !text.hasAttribute('data-testid') && text.textContent !== 'AVG',
      );
      const activeArc = within(element).getByTestId('active-arc');
      const value = within(element).getByTestId('value');
      const unit = within(element).getByTestId('unit');
      const marker = within(element).getByTestId('target-marker');

      assert.ok(tickLines.length > 0, 'Expected scale tick lines');
      assert.ok(tickNumbers.length > 0, 'Expected scale numbers');

      const spotlightEnd = Math.max(
        indexOf(spotlight),
        ...[...spotlight.querySelectorAll('*')].map(indexOf),
      );
      const scaleStart = Math.min(...tickLines.map(indexOf), ...tickNumbers.map(indexOf));
      const scaleEnd = Math.max(...tickLines.map(indexOf), ...tickNumbers.map(indexOf));
      const gaugeStart = Math.min(indexOf(activeArc), indexOf(value), indexOf(unit));
      const gaugeEnd = Math.max(indexOf(activeArc), indexOf(value), indexOf(unit));
      const markerStart = indexOf(marker);

      assert.ok(
        spotlightEnd < scaleStart,
        `Expected inner target (${spotlightEnd}) before scale lines and numbers (${scaleStart})`,
      );
      assert.ok(
        scaleEnd < gaugeStart,
        `Expected scale lines and numbers (${scaleEnd}) before current reading (${gaugeStart})`,
      );
      assert.ok(
        gaugeEnd < markerStart,
        `Expected current reading (${gaugeEnd}) before outer target (${markerStart})`,
      );
    });
  },
);
