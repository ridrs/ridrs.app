// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  bytesToHex,
  FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID,
  FTMS_SERVICE_UUID,
  type TrainerControl,
  type TrainerMode,
  trainerControlChangedEvent,
} from '@ridrs/contracts';
import type { SimulatedPeripheral } from '@ridrs/testing';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

/** How long "eventually" waits: the ui profile runs on real time. */
const EVENTUALLY = { timeout: 25_000, interval: 100 } as const;
const EVENTUALLY_STEP = { timeout: 30_000 } as const;

const FIXTURE = Symbol.for('ridrs.fixture.simulated-trainer');

interface SimulatedTrainerControl {
  readonly trainer: () => SimulatedPeripheral | undefined;
  press(button: string): void;
}

function fixture(): SimulatedTrainerControl {
  const control = (globalThis as Record<symbol, unknown>)[FIXTURE] as
    | SimulatedTrainerControl
    | undefined;
  assert.ok(control, 'Expected the simulated-trainer fixture to be running');
  return control;
}

/** What the fixture's trainer received on its control point, as hex. */
function written(): string[] {
  return (
    fixture()
      .trainer()
      ?.getWrites(FTMS_SERVICE_UUID, FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID)
      .map((w) => bytesToHex(w.data)) ?? []
  );
}

function ui(): HTMLElement {
  return document.body;
}

async function widget(kind: string): Promise<HTMLElement> {
  return within(ui()).findByTestId(`widget-${kind}`, {}, EVENTUALLY);
}

// ---- Device details ------------------------------------------------------------------------

Given(
  '{string} reported the control {string} of its trainer in the mode {string}',
  async function (this: RidrsWorld, pluginId: string, control: string, mode: string) {
    const ctx = this.ensureHost().getPluginContext(pluginId);
    assert.ok(ctx, `Expected the plugin "${pluginId}" to be running`);
    // A stand-in for the trainer's device plugin: what it reports enters as an input.
    ctx.inputs.accept(trainerControlChangedEvent, {
      deviceId: 'trainer-1',
      mode: mode as TrainerMode,
      control: control as TrainerControl,
      features: { simulation: true, targetPower: true },
      ...(mode === 'erg' ? { targetPower: 150 } : {}),
    });
    await this.settle();
  },
);

function facts(): Map<string, string> {
  const list = within(ui()).queryByTestId('device-details');
  const shown = new Map<string, string>();
  for (const term of list?.querySelectorAll('dt') ?? []) {
    shown.set(term.textContent ?? '', term.nextElementSibling?.textContent ?? '');
  }
  return shown;
}

Then(
  'the details show the fact {string} {string}',
  async function (this: RidrsWorld, term: string, value: string) {
    await waitFor(() => assert.equal(facts().get(term), value));
  },
);

Then('the details show no fact {string}', async function (this: RidrsWorld, term: string) {
  await within(ui()).findByTestId('details-card');
  assert.equal(facts().has(term), false);
});

// ---- The ride in the app -------------------------------------------------------------------

Then(
  'eventually the simulated trainer received a simulation command',
  EVENTUALLY_STEP,
  async function (this: RidrsWorld) {
    await waitFor(() => assert.ok(written().some((w) => w.startsWith('11'))), EVENTUALLY);
  },
);

Then(
  'eventually the simulated trainer received a target power of {int} W',
  EVENTUALLY_STEP,
  async function (this: RidrsWorld, watts: number) {
    const bytes = new Uint8Array(3);
    new DataView(bytes.buffer).setInt16(1, watts, true);
    bytes[0] = 0x05;
    await waitFor(() => assert.ok(written().includes(bytesToHex(bytes))), EVENTUALLY);
  },
);

Then(
  'eventually the simulated trainer received a simulation command after the target power',
  EVENTUALLY_STEP,
  async function (this: RidrsWorld) {
    await waitFor(() => {
      const writes = written();
      const target = writes.findLastIndex((w) => w.startsWith('05'));
      assert.ok(target >= 0 && writes.slice(target + 1).some((w) => w.startsWith('11')));
    }, EVENTUALLY);
  },
);

When('the simulated controller presses {string}', function (this: RidrsWorld, button: string) {
  fixture().press(button);
});

Then(
  'eventually the virtual gear widget shows {string}',
  EVENTUALLY_STEP,
  async function (this: RidrsWorld, gear: string) {
    const element = await widget('virtual-gear');
    await waitFor(
      () => assert.equal(within(element).getByTestId('value').textContent, gear),
      EVENTUALLY,
    );
  },
);

Then('the target power widget shows {string}', async function (this: RidrsWorld, text: string) {
  const element = await widget('target-power');
  await waitFor(() => assert.equal(within(element).getByTestId('value').textContent, text));
});

Then('the target power widget shows nothing', async function (this: RidrsWorld) {
  const element = await widget('target-power');
  await waitFor(() => assert.equal(within(element).getByTestId('value').textContent, ''));
});

/** Arrow keys alone, as a remote has them: down until the focus is on the element. */
When('I move the focus to {string}', async function (this: RidrsWorld, name: string) {
  const target = await within(ui()).findByRole('button', { name }, EVENTUALLY);
  for (let step = 0; step < 50 && document.activeElement !== target; step += 1) {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' });
  }
  assert.equal(document.activeElement, target, `The arrows never reached "${name}"`);
});
