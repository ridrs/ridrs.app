// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Then, When } from '@cucumber/cucumber';
import {
  controllerButtonSchema,
  controllerButtonsChangedEvent,
  type DeviceConnectionChangedPayload,
  type DeviceStatusChangedPayload,
  deviceConnectionChangedEvent,
  deviceKindSchema,
  deviceStatusChangedEvent,
  type EventDefinition,
  type MeasurementPayload,
  measurementHeartRateEvent,
  measurementPowerEvent,
  type PluginContext,
} from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

function latestStatus(world: RidrsWorld): DeviceStatusChangedPayload {
  const latest = world.hostObserved.filter((e) => e.type === deviceStatusChangedEvent.id).at(-1);
  assert.ok(latest, 'Expected a device status');
  return latest.payload as DeviceStatusChangedPayload;
}

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

Then(
  'every connection state of {string} is for a {string}',
  function (this: RidrsWorld, pluginId: string, kind: string) {
    const states = this.observed
      .filter((e) => e.type === deviceConnectionChangedEvent.id && e.source === pluginId)
      .map((e) => (e.payload as DeviceConnectionChangedPayload).kind);
    assert.ok(states.length > 0, `"${pluginId}" published no connection states`);
    assert.deepEqual(new Set(states), new Set([kind]));
  },
);

Then('the device status lists no device', function (this: RidrsWorld) {
  assert.deepEqual(latestStatus(this).devices, []);
});

Then('the device status is:', function (this: RidrsWorld, table: DataTable) {
  const shown = latestStatus(this).devices.map((d) => ({
    kind: d.kind,
    state: d.state,
    device: d.deviceName,
  }));
  assert.deepEqual(shown, table.hashes());
});

for (const verb of ['reports', 'reported']) {
  When(
    `{string} ${verb} its {string} {string} as {string}`,
    async function (this: RidrsWorld, pluginId: string, kind: string, name: string, state: string) {
      const ctx = this.ensureHost().getPluginContext(pluginId);
      assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
      // A test device reports from outside the host: an external input.
      ctx.inputs.accept(deviceConnectionChangedEvent, {
        deviceId: `${kind}-1`,
        deviceName: name,
        kind: deviceKindSchema.parse(kind),
        state: state as DeviceConnectionChangedPayload['state'],
      });
      await this.settle();
    },
  );
}

When(
  '{string} searches for a {string}',
  async function (this: RidrsWorld, pluginId: string, kind: string) {
    // No device is known while searching: no id, no name.
    pluginContext(this, pluginId).inputs.accept(deviceConnectionChangedEvent, {
      deviceId: '',
      deviceName: '',
      kind: deviceKindSchema.parse(kind),
      state: 'searching',
    });
    await this.settle();
  },
);

function pluginContext(world: RidrsWorld, pluginId: string): PluginContext {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
  return ctx;
}

/** The test device measures as the device it reported for that kind (`<kind>-1`). */
/** When each world measured last: on a clock that stands still, measurements still follow. */
const lastMeasuredAt = new WeakMap<RidrsWorld, number>();

async function measure(
  world: RidrsWorld,
  event: EventDefinition<MeasurementPayload>,
  deviceId: string,
  value: number,
): Promise<void> {
  const ctx = pluginContext(world, 'test-device');
  // A device never measures twice at once: the metrics drop a duplicate.
  const now = Math.max(
    ctx.clock.now(),
    (lastMeasuredAt.get(world) ?? Number.NEGATIVE_INFINITY) + 1,
  );
  lastMeasuredAt.set(world, now);
  ctx.inputs.accept(event, {
    deviceId,
    value,
    measuredAt: now,
    receivedAt: now,
    timestampOrigin: 'receive',
  });
  await world.settle();
}

When('the {string} measures {int} W', async function (this: RidrsWorld, kind: string, w: number) {
  await measure(this, measurementPowerEvent, `${kind}-1`, w);
});

When(
  'the {string} measures {int} bpm',
  async function (this: RidrsWorld, kind: string, bpm: number) {
    await measure(this, measurementHeartRateEvent, `${kind}-1`, bpm);
  },
);

When('another heart-rate sensor measures {int} bpm', async function (this: RidrsWorld, bpm) {
  await measure(this, measurementHeartRateEvent, 'heart-rate-2', bpm);
});

async function holdDown(world: RidrsWorld, deviceId: string, buttons: string): Promise<void> {
  pluginContext(world, 'test-device').inputs.accept(controllerButtonsChangedEvent, {
    deviceId,
    buttons: splitCsv(buttons).map((b) => controllerButtonSchema.parse(b)),
  });
  await world.settle();
}

When(
  'the {string} holds down {string}',
  async function (this: RidrsWorld, kind: string, buttons: string) {
    await holdDown(this, `${kind}-1`, buttons);
  },
);

When(
  'the other {string} of the pair holds down {string}',
  async function (this: RidrsWorld, kind: string, buttons: string) {
    await holdDown(this, `${kind}-2`, buttons);
  },
);

When('I open the device indicator', async function (this: RidrsWorld) {
  fireEvent.click(await within(ui(this)).findByTestId('device-indicator'));
  await this.settle();
});

Then('the device indicator says {string}', async function (this: RidrsWorld, text: string) {
  const indicator = await within(ui(this)).findByTestId('device-indicator');
  await waitFor(() => assert.equal(indicator.textContent, text));
});

Then('the device indicator shows:', async function (this: RidrsWorld, table: DataTable) {
  const indicator = await within(ui(this)).findByTestId('device-indicator');
  await waitFor(() => {
    const dots = [...indicator.querySelectorAll<HTMLElement>('[data-kind]')].map((dot) => ({
      device: dot.textContent ?? '',
      state: dot.dataset.state ?? '',
    }));
    assert.deepEqual(dots, table.hashes());
  });
});

/** The text a screen reader reads: decorations such as the ✓ are aria-hidden. */
function spokenText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent ?? '';
}

function setupRows(root: HTMLElement) {
  return within(root)
    .getAllByTestId('device-row')
    .map((row) => ({
      device: within(row).getByTestId('device-title').textContent ?? '',
      detail: within(row).getByTestId('device-detail').textContent ?? '',
      status: spokenText(within(row).getByRole('status')),
    }));
}

Then('the device setup shows:', async function (this: RidrsWorld, table: DataTable) {
  await within(ui(this)).findAllByTestId('device-row');
  await waitFor(() => assert.deepEqual(setupRows(ui(this)), table.hashes()));
});

Then(
  'the device setup shows the {string} as {string}',
  async function (this: RidrsWorld, device: string, status: string) {
    await within(ui(this)).findAllByTestId('device-row');
    await waitFor(() =>
      assert.equal(setupRows(ui(this)).find((row) => row.device === device)?.status, status),
    );
  },
);

Then('the device setup says {string}', async function (this: RidrsWorld, text: string) {
  const summary = await within(ui(this)).findByTestId('device-summary');
  await waitFor(() => assert.equal(summary.textContent, text));
});

function badges(root: HTMLElement, device: string): HTMLElement[] {
  const row = within(root)
    .getAllByTestId('device-row')
    .find((r) => within(r).getByTestId('device-title').textContent === device);
  assert.ok(row, `No setup row "${device}"`);
  return within(row).queryAllByTestId('status-badge');
}

Then(
  'the badge of the {string} shows {string}',
  async function (this: RidrsWorld, device: string, expected: string) {
    await within(ui(this)).findAllByTestId('device-row');
    await waitFor(() => {
      // Held buttons carry their name for screen readers; the check is decoration.
      const shown = badges(ui(this), device).map(
        (b) => b.getAttribute('aria-label') ?? b.textContent,
      );
      assert.equal(shown.join(', '), expected);
    });
  },
);

Then(
  'the badge of the {string} shows the symbols {string}',
  async function (this: RidrsWorld, device: string, expected: string) {
    await within(ui(this)).findAllByTestId('device-row');
    // Arrows are drawn, not written: the badge names its symbol.
    await waitFor(() =>
      assert.equal(
        badges(ui(this), device)
          .map((b) => b.dataset.symbol ?? b.textContent)
          .join(' '),
        expected,
      ),
    );
  },
);

Then(
  'the badge of the {string} draws {string} as icons',
  async function (this: RidrsWorld, device: string, names: string) {
    await within(ui(this)).findAllByTestId('device-row');
    await waitFor(() => {
      // Drawn, not written: some characters (⚡) render as colour emoji and break the style.
      const drawn = badges(ui(this), device)
        .filter((b) => b.querySelector('svg') && b.textContent === '')
        .map((b) => b.getAttribute('aria-label'));
      assert.deepEqual(drawn, splitCsv(names));
    });
  },
);
