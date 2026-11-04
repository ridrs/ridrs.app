// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type BleRoute,
  type BridgeState,
  bridgeConnectRequestedEvent,
  bridgeStateChangedEvent,
  type DeviceConnectionChangedPayload,
  type DeviceStatus,
  type DeviceStatusChangedPayload,
  deviceCandidatesChangedEvent,
  deviceConnectionChangedEvent,
  deviceConnectRequestedEvent,
  deviceDisconnectRequestedEvent,
  deviceDiscoveryRequestedEvent,
  deviceKindSchema,
  deviceRouteRequestedEvent,
  deviceStatusChangedEvent,
  type EventDefinition,
  type PluginContext,
} from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { peripheral, splitCsv } from './devices-and-metrics.steps.ts';

/** "companion" and "this device" are the words scenarios use for the two links. */
function route(word: string): BleRoute {
  assert.ok(word === 'companion' || word === 'this device', `Unknown link "${word}"`);
  return word === 'companion' ? 'companion' : 'local';
}

function statusOf(world: RidrsWorld, kind: string): DeviceStatus {
  const latest = world.hostObserved.filter((e) => e.type === deviceStatusChangedEvent.id).at(-1);
  assert.ok(latest, 'Expected a device status');
  const status = (latest.payload as DeviceStatusChangedPayload).devices.find(
    (d) => d.kind === kind,
  );
  assert.ok(status, `Expected a status for "${kind}"`);
  return status;
}

function pluginContext(world: RidrsWorld, pluginId: string): PluginContext {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
  return ctx;
}

/** The rider's requests come from outside the host, like the UI's: inputs of the observer. */
async function riderAsks<T>(world: RidrsWorld, event: EventDefinition<T>, payload: T) {
  pluginContext(world, 'test-observer').inputs.accept(event, payload);
  await world.settle();
}

/** The id the device status gives the device of that name: the one requests name. */
function candidateId(world: RidrsWorld, kind: string, name: string): string {
  const found = statusOf(world, kind).candidates?.find((c) => c.deviceName === name);
  assert.ok(found, `Expected "${name}" among the ${kind} devices found`);
  return found.deviceId;
}

// ---- The rider, headless -------------------------------------------------------------------

for (const verb of ['connects', 'connected']) {
  When(
    `the rider ${verb} the {string} {string}`,
    async function (this: RidrsWorld, kind: string, name: string) {
      await riderAsks(this, deviceConnectRequestedEvent, {
        kind: deviceKindSchema.parse(kind),
        deviceId: candidateId(this, kind, name),
      });
    },
  );
}

for (const verb of ['uses', 'used']) {
  for (const of of ['of the {string}', 'of {string}']) {
    When(
      `the rider ${verb} the {string} data ${of}`,
      async function (this: RidrsWorld, kind: string, link: string) {
        await riderAsks(this, deviceRouteRequestedEvent, {
          kind: deviceKindSchema.parse(kind),
          route: route(link),
        });
      },
    );
  }
}

for (const verb of ['disconnects', 'disconnected']) {
  When(`the rider ${verb} the {string}`, async function (this: RidrsWorld, kind: string) {
    await riderAsks(this, deviceDisconnectRequestedEvent, { kind: deviceKindSchema.parse(kind) });
  });
}

Given('the device setup looks for devices', async function (this: RidrsWorld) {
  await riderAsks(this, deviceDiscoveryRequestedEvent, { active: true });
});

When('the device setup stops looking for devices', async function (this: RidrsWorld) {
  await riderAsks(this, deviceDiscoveryRequestedEvent, { active: false });
});

// ---- Devices and links, headless -----------------------------------------------------------

Then(
  'the device status lists the {string} devices {string}',
  function (this: RidrsWorld, kind: string, names: string) {
    assert.deepEqual(
      statusOf(this, kind).candidates?.map((c) => c.deviceName),
      splitCsv(names),
    );
  },
);

for (const device of ['trainer', 'heart-rate sensor']) {
  Then(`the ${device} {string} is not connected`, function (this: RidrsWorld, name: string) {
    assert.equal(peripheral(this, name).isConnected(), false, `"${name}" is connected`);
  });
}

function companionDevice(world: RidrsWorld, name: string) {
  const found = world.companionSimulator?.getPeripheralByName(name);
  assert.ok(found, `Expected the companion to see "${name}"`);
  return found;
}

for (const through of ['through the {string}', 'through {string}']) {
  Then(
    `the {string} is connected ${through}`,
    async function (this: RidrsWorld, kind: string, link: string) {
      await this.settle();
      const status = statusOf(this, kind);
      assert.equal(status.state, 'connected');
      assert.equal(status.route, route(link));
      // The device itself agrees: the link that carries it holds its connection.
      const local = this.bleSimulator?.getPeripheralByName(status.deviceName);
      const phone = this.companionSimulator?.getPeripheralByName(status.deviceName);
      const carrier = route(link) === 'local' ? local : phone;
      assert.ok(carrier?.isConnected(), `"${status.deviceName}" holds no connection over ${link}`);
    },
  );
}

Then('the {string} is connected over both links', async function (this: RidrsWorld, kind) {
  await this.settle();
  const status = statusOf(this, kind);
  assert.deepEqual(status.connectedRoutes, ['local', 'companion']);
  assert.ok(peripheral(this, status.deviceName).isConnected(), 'Not connected directly');
  assert.ok(companionDevice(this, status.deviceName).isConnected(), 'Not connected via companion');
});

When(
  "the companion's trainer sends the Indoor Bike Data packet {string}",
  async function (this: RidrsWorld, hex: string) {
    const trainer = this.companionSimulator?.peripherals().find((p) => p.isConnected());
    assert.ok(trainer, 'Expected the companion to hold a trainer connection');
    this.packetMark = this.observed.length;
    trainer.notifyIndoorBikeData(hex);
    await this.settle();
  },
);

Then("the companion's trainer {string} is not connected", function (this: RidrsWorld, name) {
  assert.equal(companionDevice(this, name).isConnected(), false);
});

Then('the trainer keeps the device id it had over this device', function (this: RidrsWorld) {
  const status = statusOf(this, 'trainer');
  assert.equal(status.deviceId, peripheral(this, status.deviceName).peripheralId);
  const ids = this.observed
    .filter((e) => e.type === deviceConnectionChangedEvent.id)
    .map((e) => (e.payload as DeviceConnectionChangedPayload).deviceId)
    .filter((id) => id !== '');
  assert.deepEqual([...new Set(ids)], [status.deviceId]);
});

// ---- The test device and the companion bridge, for the UI -----------------------------------

Given(
  '{string} found the {string} devices {string}',
  async function (this: RidrsWorld, pluginId: string, kind: string, names: string) {
    pluginContext(this, pluginId).inputs.accept(deviceCandidatesChangedEvent, {
      kind: deviceKindSchema.parse(kind),
      // The test device names its devices `<kind>-1`, `<kind>-2`, … in the order found.
      devices: splitCsv(names).map((deviceName, i) => ({
        deviceId: `${kind}-${i + 1}`,
        deviceName,
        routes: ['local'],
      })),
    });
    await this.settle();
  },
);

Given(
  '{string} reported its {string} {string} as {string} over both links',
  async function (this: RidrsWorld, pluginId, kind: string, name: string, state) {
    pluginContext(this, pluginId).inputs.accept(deviceConnectionChangedEvent, {
      deviceId: `${kind}-1`,
      deviceName: name,
      kind: deviceKindSchema.parse(kind),
      state: state as DeviceConnectionChangedPayload['state'],
      route: 'local',
      connectedRoutes: ['local', 'companion'],
    });
    await this.settle();
  },
);

Given(
  '{string} reported its {string} {string} as {string} through the {string}',
  async function (this: RidrsWorld, pluginId, kind: string, name: string, state, link: string) {
    pluginContext(this, pluginId).inputs.accept(deviceConnectionChangedEvent, {
      deviceId: `${kind}-1`,
      deviceName: name,
      kind: deviceKindSchema.parse(kind),
      state: state as DeviceConnectionChangedPayload['state'],
      route: route(link),
    });
    await this.settle();
  },
);

async function bridgeReports(world: RidrsWorld, state: string, companionName?: string) {
  pluginContext(world, 'test-device').inputs.accept(bridgeStateChangedEvent, {
    state: state as BridgeState,
    ...(companionName ? { companionName } : {}),
  });
  await world.settle();
}

Given('the companion bridge reports {string}', async function (this: RidrsWorld, state: string) {
  await bridgeReports(this, state);
});

Given(
  'the companion bridge reports {string} to {string}',
  async function (this: RidrsWorld, state: string, name: string) {
    await bridgeReports(this, state, name);
  },
);

// ---- The device setup ----------------------------------------------------------------------

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

async function setupRow(world: RidrsWorld, title: string): Promise<HTMLElement> {
  await within(ui(world)).findAllByTestId('device-row');
  return waitFor(() => {
    const row = within(ui(world))
      .getAllByTestId('device-row')
      .find((r) => within(r).getByTestId('device-title').textContent === title);
    assert.ok(row, `No setup row "${title}"`);
    return row;
  });
}

When('I open the {string} in the device setup', async function (this: RidrsWorld, title: string) {
  const row = await setupRow(this, title);
  fireEvent.click(within(row).getByRole('button'));
  await this.settle();
});

function shownDetails(root: HTMLElement): Record<string, string> {
  const details = within(root).getByTestId('device-details');
  const shown: Record<string, string> = {};
  for (const term of details.querySelectorAll('dt')) {
    shown[term.textContent ?? ''] = term.nextElementSibling?.textContent ?? '';
  }
  return shown;
}

Then('the device details show:', async function (this: RidrsWorld, table: DataTable) {
  const expected = table.rowsHash();
  await within(ui(this)).findByTestId('device-details');
  await waitFor(() => {
    const shown = shownDetails(ui(this));
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, shown[key]])),
      expected,
    );
  });
});

Then(
  'the details card is headed {string} {string} with the status {string}',
  async function (this: RidrsWorld, title: string, subtitle: string, status: string) {
    const card = await within(ui(this)).findByTestId('details-card');
    await waitFor(() => {
      assert.equal(within(card).getByRole('heading', { level: 2 }).textContent, title);
      assert.equal(within(card).getByTestId('details-subtitle').textContent, subtitle);
      assert.equal(within(card).getByTestId('details-status').textContent, status);
    });
  },
);

Then('the details give the tip {string}', async function (this: RidrsWorld, tip: string) {
  const shown = await within(ui(this)).findByTestId('details-tip');
  await waitFor(() => assert.equal(shown.textContent, tip));
});

When('I press Escape', async function (this: RidrsWorld) {
  fireEvent.keyDown(within(ui(this)).getByTestId('details-card'), { key: 'Escape' });
  await this.settle();
});

Then(
  /^the "([^"]+)" shows that (\d+) more devices? (?:was|were) found$/,
  async function (this: RidrsWorld, title: string, count: string) {
    const row = await setupRow(this, title);
    await waitFor(() => {
      const hint = within(row).getByTestId('more-found');
      assert.equal(hint.textContent, `+${count}`);
    });
  },
);

When('I choose the link {string}', async function (this: RidrsWorld, label: string) {
  const links = await within(ui(this)).findByRole('radiogroup', { name: 'Link' });
  fireEvent.click(within(links).getByRole('radio', { name: label }));
  await this.settle();
});

Then('there is no choice of link', async function (this: RidrsWorld) {
  await within(ui(this)).findByTestId('device-details');
  assert.equal(within(ui(this)).queryByRole('radiogroup', { name: 'Link' }), null);
});

// ---- What the rider asked for --------------------------------------------------------------

function asked<T>(world: RidrsWorld, event: EventDefinition<T>): T[] {
  return world.hostObserved.filter((e) => e.type === event.id).map((e) => e.payload as T);
}

Then('the rider asked to disconnect the {string}', async function (this: RidrsWorld, kind) {
  await waitFor(() =>
    assert.deepEqual(asked(this, deviceDisconnectRequestedEvent).at(-1), { kind }),
  );
});

Then(
  'the rider asked to connect the {string} {string}',
  async function (this: RidrsWorld, kind: string, deviceId: string) {
    await waitFor(() =>
      assert.deepEqual(asked(this, deviceConnectRequestedEvent).at(-1), { kind, deviceId }),
    );
  },
);

Then(
  'the rider asked to use the {string} data of the {string}',
  async function (this: RidrsWorld, kind: string, link: string) {
    await waitFor(() =>
      assert.deepEqual(asked(this, deviceRouteRequestedEvent).at(-1), {
        kind,
        route: route(link),
      }),
    );
  },
);

Then('the device details are closed', async function (this: RidrsWorld) {
  await waitFor(() => {
    // Not assert.equal: its diff of a DOM element against null takes minutes.
    assert.ok(within(ui(this)).queryByTestId('device-details') === null, 'The details are open');
    assert.ok(within(ui(this)).queryAllByTestId('device-row').length > 0, 'No device rows');
  });
});

Then('the rider asked to connect the companion', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(asked(this, bridgeConnectRequestedEvent).length, 1));
});
