// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import {
  type BleRoute,
  type BridgeState,
  bridgeConnectService,
  bridgeForgetService,
  bridgeLinkState,
  type DeviceConnectionChangedPayload,
  type DeviceStatus,
  deviceConnectionStateSchema,
  deviceConnectService,
  deviceForgetService,
  deviceKindSchema,
  type PluginContext,
} from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { HEART_RATE_THOUGHTS } from '../../plugins/ui-devices/client/devices.ts';
import {
  asked,
  deviceStatuses,
  reportConnection,
  riderCalls,
  riderDiscovers,
  testDeviceLink,
} from '../support/device-links.ts';
import type { RidrsWorld } from '../support/world.ts';
import { peripheral, splitCsv } from './devices-and-metrics.steps.ts';

/** "companion" and "this device" are the words scenarios use for the two links. */
function route(word: string): BleRoute {
  assert.ok(word === 'companion' || word === 'this device', `Unknown link "${word}"`);
  return word === 'companion' ? 'companion' : 'local';
}

/** The words for the links, in the order the device status lists them. */
function linkWords(routes: readonly BleRoute[]): string {
  return routes.map((r) => (r === 'local' ? 'this device' : 'companion')).join(', ');
}

function statusOf(world: RidrsWorld, kind: string): DeviceStatus {
  const status = deviceStatuses(world).find((d) => d.kind === kind);
  assert.ok(status, `Expected a status for "${kind}"`);
  return status;
}

function pluginContext(world: RidrsWorld, pluginId: string): PluginContext {
  const ctx = world.ensureHost().getPluginContext(pluginId);
  assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
  return ctx;
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
      await riderCalls(this, deviceConnectService, deviceKindSchema.parse(kind), {
        deviceId: candidateId(this, kind, name),
      });
    },
  );
}

for (const verb of ['connects', 'connected']) {
  for (const through of ['through the {string}', 'through {string}']) {
    When(
      `the rider ${verb} the {string} ${through}`,
      async function (this: RidrsWorld, kind: string, link: string) {
        // Each link's device is a device of its own: the rider connects the one over that link.
        const found = statusOf(this, kind).candidates?.find((c) => c.routes.includes(route(link)));
        assert.ok(found, `Expected a ${kind} found over ${link}`);
        await riderCalls(this, deviceConnectService, deviceKindSchema.parse(kind), {
          deviceId: found.deviceId,
        });
      },
    );
  }
}

for (const verb of ['forgets', 'forgot']) {
  When(`the rider ${verb} the {string}`, async function (this: RidrsWorld, kind: string) {
    await riderCalls(this, deviceForgetService, deviceKindSchema.parse(kind));
  });
}

Given('the device setup looks for devices', async function (this: RidrsWorld) {
  await riderDiscovers(this, true);
});

for (const verb of ['stops', 'stopped']) {
  When(`the device setup ${verb} looking for devices`, async function (this: RidrsWorld) {
    await riderDiscovers(this, false);
  });
}

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

Then(
  'the device status lists the {string} devices with their links:',
  async function (this: RidrsWorld, kind: string, table: DataTable) {
    await this.settle();
    assert.deepEqual(
      statusOf(this, kind).candidates?.map((c) => ({
        device: c.deviceName,
        links: linkWords(c.routes),
      })),
      table.hashes(),
    );
  },
);

Then(
  'the device status pairs the {string} devices:',
  async function (this: RidrsWorld, kind: string, table: DataTable) {
    await this.settle();
    const candidates = statusOf(this, kind).candidates ?? [];
    assert.deepEqual(
      candidates.map((c) => {
        const twin = candidates.find((o) => o.deviceId === c.sameDeviceAs);
        return {
          device: c.deviceName,
          link: linkWords(c.routes),
          'same device over': twin ? linkWords(twin.routes) : '',
        };
      }),
      table.hashes(),
    );
  },
);

Then(
  'the device status says ridrs looks for {string} devices over {string}',
  async function (this: RidrsWorld, kind: string, links: string) {
    await this.settle();
    assert.equal(linkWords(statusOf(this, kind).scanning ?? []), links);
  },
);

Then(
  'the device status says ridrs looks for {string} devices over no link',
  async function (this: RidrsWorld, kind: string) {
    await this.settle();
    assert.deepEqual(statusOf(this, kind).scanning, []);
  },
);

When("the simulated BLE central's searches fail", async function (this: RidrsWorld) {
  assert.ok(this.bleSimulator, 'Expected a simulated BLE central');
  this.bleSimulator.failScans(new Error('Bluetooth is off'));
  await this.settle();
});

When('the trainer {string} advertises its name', async function (this: RidrsWorld, name: string) {
  peripheral(this, name).advertiseName();
  await this.settle();
});

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

// ---- The test device and the companion bridge, for the UI -----------------------------------

Given(
  '{string} found the {string} devices {string}',
  async function (this: RidrsWorld, pluginId: string, kind: string, names: string) {
    testDeviceLink(this, pluginId, deviceKindSchema.parse(kind)).found(
      // The test device names its devices `<kind>-1`, `<kind>-2`, … in the order found.
      splitCsv(names).map((deviceName, i) => ({
        deviceId: `${kind}-${i + 1}`,
        deviceName,
        routes: ['local'],
      })),
    );
    await this.flushState();
  },
);

Given(
  '{string} found the {string} devices with signals:',
  async function (this: RidrsWorld, pluginId: string, kind: string, table: DataTable) {
    testDeviceLink(this, pluginId, deviceKindSchema.parse(kind)).found(
      table.hashes().map(({ device, signal }, i) => ({
        deviceId: `${kind}-${i + 1}`,
        deviceName: device ?? '',
        routes: ['local'],
        ...(signal ? { rssi: Number(signal) } : {}),
      })),
    );
    await this.flushState();
  },
);

Given(
  '{string} found the {string} devices over the links:',
  async function (this: RidrsWorld, pluginId: string, kind: string, table: DataTable) {
    // One device per link, as the links report them; the links of one row are the same device.
    // An optional signal column gives each link its signal, in the order of the links.
    const rows = table.hashes().map(({ device, links, signals }) => ({
      deviceName: device ?? '',
      routes: splitCsv(links ?? '').map(route),
      signals: signals ? splitCsv(signals).map(Number) : [],
    }));
    const ids: string[][] = [];
    let next = 1;
    for (const row of rows) {
      ids.push(row.routes.map(() => `${kind}-${next++}`));
    }
    testDeviceLink(this, pluginId, deviceKindSchema.parse(kind)).found(
      rows.flatMap((row, r) =>
        row.routes.map((link, l) => {
          const twin = ids[r]?.find((_, other) => other !== l);
          const rssi = row.signals[l];
          return {
            deviceId: ids[r]?.[l] ?? '',
            deviceName: row.deviceName,
            routes: [link],
            ...(rssi === undefined ? {} : { rssi }),
            ...(twin ? { sameDeviceAs: twin } : {}),
          };
        }),
      ),
    );
    await this.flushState();
  },
);

Then(
  'the device status gives the {string} devices the signals:',
  function (this: RidrsWorld, kind: string, table: DataTable) {
    assert.deepEqual(
      statusOf(this, kind).candidates?.map((c) => ({
        device: c.deviceName,
        signal: c.rssi === undefined ? '' : String(c.rssi),
      })),
      table.hashes(),
    );
  },
);

Given(
  '{string} reported its {string} {string} as {string} through the {string}',
  async function (this: RidrsWorld, pluginId, kind: string, name: string, state, link: string) {
    await reportConnection(this, pluginId, {
      deviceId: `${kind}-1`,
      deviceName: name,
      kind: deviceKindSchema.parse(kind),
      state: state as DeviceConnectionChangedPayload['state'],
      route: route(link),
    });
  },
);

/** The links a device plugin looks over for devices of a kind, as it reports them. */
async function looksOver(world: RidrsWorld, pluginId: string, kind: string, routes: BleRoute[]) {
  testDeviceLink(world, pluginId, deviceKindSchema.parse(kind)).scans(routes);
  await world.flushState();
}

for (const verb of ['looks', 'looked']) {
  Given(
    `{string} ${verb} for {string} devices over {string}`,
    async function (this: RidrsWorld, pluginId: string, kind: string, links: string) {
      await looksOver(this, pluginId, kind, splitCsv(links).map(route));
    },
  );
  Given(
    `{string} ${verb} for {string} devices over no link`,
    async function (this: RidrsWorld, pluginId: string, kind: string) {
      await looksOver(this, pluginId, kind, []);
    },
  );
}

/** The companion bridge's state, as its stand-in reports it (ADR 0069: the app state `bridge.state`). */
async function bridgeReports(world: RidrsWorld, state: string, companionName?: string) {
  pluginContext(world, 'test-bridge').state.set(bridgeLinkState, 'test-bridge', {
    state: state as BridgeState,
    ...(companionName ? { companionName } : {}),
  });
  await world.flushState();
}

Given(
  'a stand-in {string} for the companion bridge',
  async function (this: RidrsWorld, id: string) {
    await this.writeProbePluginFolder({
      folder: id,
      id,
      types: ['transport'],
      state: { owns: [bridgeLinkState.id] },
      services: { provides: [bridgeConnectService.id, bridgeForgetService.id] },
    });
    this.getBehavior(id).onStart.push((ctx) => {
      for (const service of [bridgeConnectService, bridgeForgetService]) {
        ctx.services.provide(service, () => {
          const calls = this.serviceCalls.get(id) ?? [];
          calls.push({ service: service.id, request: {} });
          this.serviceCalls.set(id, calls);
          return {};
        });
      }
    });
  },
);

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

/** The page names the kind in its heading. */
async function assertHeading(world: RidrsWorld, title: string) {
  await waitFor(() =>
    assert.equal(within(ui(world)).getByRole('heading', { level: 1 }).textContent, title),
  );
}

/** The card's top line: the device, as a device found shows it. */
async function cardHeader(world: RidrsWorld): Promise<HTMLElement> {
  const card = await within(ui(world)).findByTestId('details-card');
  return within(card).getByTestId('card-header');
}

Then(
  'the details are headed {string}, the card {string} with the status {string}',
  async function (this: RidrsWorld, title: string, device: string, status: string) {
    await assertHeading(this, title);
    await waitFor(async () => {
      const header = await cardHeader(this);
      assert.deepEqual(
        [
          within(header).getByTestId('details-device').textContent,
          within(header).getByTestId('card-status').textContent,
        ],
        [device, status],
      );
    });
  },
);

Then('the details are headed {string}', async function (this: RidrsWorld, title: string) {
  await assertHeading(this, title);
});

Then('the top right of the details says {string}', async function (this: RidrsWorld, text) {
  await waitFor(() => {
    const bar = within(ui(this)).getByTestId('details-bar');
    assert.equal(within(bar).getByTestId('details-status').textContent, text);
  });
});

Then('the details card shows the links {string}', async function (this: RidrsWorld, links) {
  await waitFor(async () => {
    const header = await cardHeader(this);
    assert.equal(
      within(header)
        .queryAllByTestId('found-link')
        .map((icon) => icon.getAttribute('aria-label'))
        .join(', '),
      links,
    );
  });
});

Then('the details card shows the signal {string}', async function (this: RidrsWorld, signal) {
  await waitFor(async () => {
    const header = await cardHeader(this);
    assert.equal(within(header).getByTestId('found-signal').getAttribute('aria-label'), signal);
  });
});

Then('the badge of the details card shows {string}', async function (this: RidrsWorld, expected) {
  await waitFor(async () => {
    const header = await cardHeader(this);
    const shown = within(header)
      .getAllByTestId('status-badge')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    assert.equal(shown.join(', '), expected);
  });
});

Then('the details show no card', async function (this: RidrsWorld) {
  await this.settle();
  assert.ok(within(ui(this)).queryByTestId('details-card') === null, 'The details show a card');
});

Then('the status is at the top right of the details', async function (this: RidrsWorld) {
  // No layout in a headless DOM: the status sits in the top bar, after Back, at its end.
  const status = within(ui(this)).getByTestId('details-status');
  const bar = status.closest<HTMLElement>('[data-testid="details-bar"]');
  assert.ok(bar, 'The status is not in the top bar of the details');
  assert.equal(bar.style.justifyContent, 'space-between');
  assert.equal(bar.lastElementChild?.contains(status), true, 'The status is not at the right');
});

/** An icon beside a status: a badge, or a slot that draws something (the slot itself aligns). */
function statusIcons(status: Element): string[] {
  // Markup, not elements: a diff of DOM elements takes minutes.
  return [...status.querySelectorAll('[data-testid="status-badge"], [aria-hidden]')]
    .filter((el) => el.getAttribute('data-testid') === 'status-badge' || el.childNodes.length > 0)
    .map((el) => el.outerHTML.slice(0, 80));
}

Then('the status of the {string} shows no icon', async function (this: RidrsWorld, title) {
  const row = await setupRow(this, title);
  await waitFor(() => assert.deepEqual(statusIcons(within(row).getByRole('status')), []));
});

Then('the status of the details card shows no icon', async function (this: RidrsWorld) {
  await waitFor(async () => {
    const header = await cardHeader(this);
    assert.deepEqual(statusIcons(within(header).getByRole('status')), []);
  });
});

Then(
  'the page offers a {string} button with a bin icon',
  async function (this: RidrsWorld, label: string) {
    const button = await within(ui(this)).findByRole('button', { name: label });
    assert.ok(button.querySelector('[data-icon="trash"]'), `"${label}" shows no bin icon`);
  },
);

Then('the details say one of the thoughts on the heart', async function (this: RidrsWorld) {
  const about = await within(ui(this)).findByTestId('details-about');
  assert.ok(
    HEART_RATE_THOUGHTS.includes(about.textContent ?? ''),
    `"${about.textContent}" is no thought on the heart`,
  );
});

Then('the details give the tip {string}', async function (this: RidrsWorld, tip: string) {
  const shown = await within(ui(this)).findByTestId('details-tip');
  await waitFor(() => assert.equal(shown.textContent, tip));
});

When('I press Escape', async function (this: RidrsWorld) {
  fireEvent.keyDown(within(ui(this)).getByRole('main'), { key: 'Escape' });
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

Then(
  'the {string} counts {int} devices found',
  async function (this: RidrsWorld, title: string, count: number) {
    const row = await setupRow(this, title);
    await waitFor(() => {
      const counter = within(row).getByTestId('found-count');
      assert.equal(counter.textContent, `${count} found`);
    });
  },
);

Then('the {string} shows no more devices found', async function (this: RidrsWorld, title) {
  const row = await setupRow(this, title);
  assert.equal(within(row).queryByTestId('more-found'), null);
});

Then('the details card offers a {string} button', async function (this: RidrsWorld, label: string) {
  const card = await within(ui(this)).findByTestId('details-card');
  await within(card).findByRole('button', { name: label });
});

Then(
  'the details card offers the buttons {string} side by side',
  async function (this: RidrsWorld, labels: string) {
    await waitFor(async () => {
      const card = await within(ui(this)).findByTestId('details-card');
      const buttons = within(card).queryAllByRole('button');
      assert.deepEqual(
        buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent),
        splitCsv(labels),
      );
      // Side by side: one row of buttons holds them all.
      assert.equal(new Set(buttons.map((b) => b.parentElement)).size, 1, 'Not side by side');
    });
  },
);

Then(
  'the {string} button shows the link {string} and no signal',
  async function (this: RidrsWorld, label: string, link: string) {
    const button = await within(ui(this)).findByRole('button', { name: label });
    assert.deepEqual(
      [
        within(button)
          .queryAllByTestId('found-link')
          .map((icon) => icon.getAttribute('aria-label'))
          .join(', '),
        within(button).queryByTestId('found-signal')?.getAttribute('aria-label') ?? '',
      ],
      [link, ''],
    );
  },
);

/** A box: an element drawn with a border of its own, but not a control or the status pill. */
function boxesIn(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>('*')].filter(
    (el) =>
      (el.style.border !== '' || el.style.borderStyle !== '') &&
      !el.closest('button, [role="status"]'),
  );
}

Then('the details card holds no other box', async function (this: RidrsWorld) {
  const card = await within(ui(this)).findByTestId('details-card');
  assert.deepEqual(
    boxesIn(card).map((box) => box.outerHTML.slice(0, 80)),
    [],
  );
});

Then('the devices found follow the details card as rows', async function (this: RidrsWorld) {
  const card = await within(ui(this)).findByTestId('details-card');
  const found = await within(ui(this)).findByRole('list', { name: 'Devices found' });
  assert.ok(!card.contains(found), 'The devices found are inside the details card');
  assert.ok(
    card.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING,
    'The devices found do not follow the details card',
  );
  const items = within(found).getAllByRole('listitem');
  assert.ok(items.length > 0, 'No devices found');
  for (const item of items) {
    assert.ok(item.querySelector('button.rd-row'), 'A device found is no row');
  }
});

Then('the page shows {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.ok((ui(this).textContent ?? '').includes(text), `The page does not show "${text}"`),
  );
});

Then('the page shows no {string}', async function (this: RidrsWorld, text: string) {
  await this.settle();
  assert.ok(!(ui(this).textContent ?? '').includes(text), `The page shows "${text}"`);
});

Then('the page names {string} once', async function (this: RidrsWorld, text: string) {
  await this.settle();
  const shown = (ui(this).textContent ?? '').split(text).length - 1;
  assert.equal(shown, 1, `The page names "${text}" ${shown} times`);
});

Then('the devices found are listed as:', async function (this: RidrsWorld, table: DataTable) {
  const found = await within(ui(this)).findByRole('list', { name: 'Devices found' });
  await waitFor(() =>
    assert.deepEqual(
      within(found)
        .getAllByRole('listitem')
        .map((item) => ({
          device: within(item).getByTestId('found-name').textContent ?? '',
          // The bars are drawn; their name says how many are lit.
          signal: within(item).queryByTestId('found-signal')?.getAttribute('aria-label') ?? '',
        })),
      table.hashes(),
    ),
  );
});

Then('the devices found show their links:', async function (this: RidrsWorld, table: DataTable) {
  const found = await within(ui(this)).findByRole('list', { name: 'Devices found' });
  await waitFor(() =>
    assert.deepEqual(
      within(found)
        .getAllByRole('listitem')
        .map((item) => ({
          device: within(item).getByTestId('found-name').textContent ?? '',
          links: within(item)
            .queryAllByTestId('found-link')
            .map((icon) => icon.getAttribute('aria-label'))
            .join(', '),
        })),
      table.hashes(),
    ),
  );
});

Then(
  'the box of {string} shows the lines:',
  async function (this: RidrsWorld, name: string, table: DataTable) {
    const found = await within(ui(this)).findByRole('list', { name: 'Devices found' });
    await waitFor(() => {
      const box = within(found)
        .getAllByRole('listitem')
        .find((item) => within(item).queryByTestId('found-name')?.textContent === name);
      assert.ok(box, `No box of "${name}"`);
      // Each line is a button of its own; the name belongs to the line on top.
      assert.deepEqual(
        within(box)
          .getAllByRole('button')
          .map((line) => ({
            line: [...line.querySelectorAll('b, small, span')]
              .filter(
                (el) =>
                  el.children.length === 0 &&
                  !el.closest('[aria-hidden]') &&
                  (el.textContent ?? '').trim() !== '',
              )
              .map((el) => (el.textContent ?? '').trim())
              .join(' '),
            named: line.querySelector('[data-testid="found-name"]') ? 'yes' : 'no',
          })),
        table.hashes(),
      );
    });
  },
);

Then('the devices found show no dBm', async function (this: RidrsWorld) {
  const found = await within(ui(this)).findByRole('list', { name: 'Devices found' });
  assert.doesNotMatch(found.textContent ?? '', /dBm/);
});

// ---- What the rider asked for --------------------------------------------------------------

Then('the rider asked to forget the {string}', async function (this: RidrsWorld, kind) {
  await waitFor(() => assert.deepEqual(asked(this, deviceForgetService.id).at(-1), { kind }));
});

Then(
  'the rider asked to connect the {string} {string}',
  async function (this: RidrsWorld, kind: string, deviceId: string) {
    await waitFor(() =>
      assert.deepEqual(asked(this, deviceConnectService.id).at(-1), { kind, deviceId }),
    );
  },
);

Then('the device details stay open', async function (this: RidrsWorld) {
  await this.settle();
  assert.ok(within(ui(this)).queryByTestId('details-bar') !== null, 'The details are closed');
});

When(
  '{string} reports its {string} {string} with the id {string} as {string}',
  async function (
    this: RidrsWorld,
    pluginId: string,
    kind: string,
    name: string,
    deviceId: string,
    state: string,
  ) {
    await reportConnection(this, pluginId, {
      deviceId,
      deviceName: name,
      kind: deviceKindSchema.parse(kind),
      state: deviceConnectionStateSchema.parse(state),
    });
  },
);

Then('the device details are closed', async function (this: RidrsWorld) {
  await waitFor(() => {
    // Not assert.equal: its diff of a DOM element against null takes minutes.
    assert.ok(within(ui(this)).queryByTestId('details-bar') === null, 'The details are open');
    assert.ok(within(ui(this)).queryAllByTestId('device-row').length > 0, 'No device rows');
  });
});

Then('the rider asked to connect the companion', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(asked(this, bridgeConnectService.id).length, 1));
});

Given(
  '{string} reported the battery of its {string} at {int} %',
  async function (this: RidrsWorld, pluginId: string, kind: string, level: number) {
    testDeviceLink(this, pluginId, deviceKindSchema.parse(kind)).batteryLevel(`${kind}-1`, level);
    await this.flushState();
  },
);

Then('the details card shows the battery {string}', async function (this: RidrsWorld, battery) {
  await waitFor(async () => {
    const header = await cardHeader(this);
    assert.equal(within(header).getByTestId('card-battery').getAttribute('aria-label'), battery);
  });
});

Then('the details card shows no battery', async function (this: RidrsWorld) {
  const header = await cardHeader(this);
  assert.equal(within(header).queryByTestId('card-battery'), null);
});

Then(
  'the device status gives the {string} a battery of {int} %',
  function (this: RidrsWorld, kind: string, level: number) {
    assert.equal(statusOf(this, kind).battery, level);
  },
);

Then('the device status gives the {string} no battery level', function (this: RidrsWorld, kind) {
  assert.equal(statusOf(this, kind).battery, undefined);
});
