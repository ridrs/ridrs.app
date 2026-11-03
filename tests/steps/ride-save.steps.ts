// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';
import { decodeFit, runHeadless } from './fit.steps.ts';

function dataDir(world: RidrsWorld): string {
  assert.ok(world.dataDir, 'Expected a data directory');
  return world.dataDir;
}

function appRoot(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs app to be shown');
  return view.root;
}

/** The file a "Ride saved" field names, in the app's data directory. */
function savedFile(world: RidrsWorld, testId: string): string {
  const name = within(appRoot(world)).getByTestId(testId).textContent ?? '';
  assert.ok(name.length > 0, `"${testId}" names no file`);
  return join(dataDir(world), 'recordings', name);
}

Given(
  'the app stores its files in a fresh temporary data directory',
  async function (this: RidrsWorld) {
    this.dataDir = await mkdtemp(join(tmpdir(), 'ridrs-data-'));
    this.setEnv('RIDRS_DATA_DIR', this.dataDir);
    // Files in a directory of this machine: the Node provider, not the app container's.
    this.headlessDisabled.push('storage-files-tauri');
  },
);

When('{int} seconds pass in real time', async function (this: RidrsWorld, seconds: number) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
});

Then(
  'eventually the {string} panel shows a recording file and a FIT file',
  async function (this: RidrsWorld, panel: string) {
    const root = appRoot(this);
    await waitFor(
      () => {
        within(root).getByTestId(panel);
        assert.match(within(root).getByTestId(`${panel}-recording`).textContent ?? '', /\.ridrs$/);
        assert.match(within(root).getByTestId(`${panel}-fit`).textContent ?? '', /\.fit$/);
      },
      { timeout: 10_000 },
    );
  },
);

Then(
  'the saved FIT file is valid according to the official FIT SDK',
  async function (this: RidrsWorld) {
    decodeFit(new Uint8Array(await readFile(savedFile(this, 'ride-saved-fit'))));
  },
);

Then(
  'the saved FIT file has at least {int} records with a power of {int} W',
  async function (this: RidrsWorld, count: number, power: number) {
    const messages = decodeFit(new Uint8Array(await readFile(savedFile(this, 'ride-saved-fit'))));
    const records = (messages.recordMesgs ?? []).filter((r) => r.power === power);
    assert.ok(records.length >= count, `${records.length} records with ${power} W`);
  },
);

When('I run {string} on the saved recording', async function (this: RidrsWorld, command: string) {
  const [program, group, subcommand] = command.split(' ');
  assert.equal(`${program} ${group}`, 'ridrs-headless recording');
  assert.ok(subcommand);
  this.cliResult = await runHeadless([
    'recording',
    subcommand,
    savedFile(this, 'ride-saved-recording'),
  ]);
});

Then(
  'the command exits with {int} and reports {string}',
  function (this: RidrsWorld, code: number, text: string) {
    assert.ok(this.cliResult, 'Expected a command to have run');
    assert.equal(this.cliResult.exitCode, code, this.cliResult.stdout + this.cliResult.stderr);
    assert.match(this.cliResult.stdout, new RegExp(`^${text}$`, 'm'));
  },
);

Then(
  'the command exits with {int} and lists the plugin {string}',
  function (this: RidrsWorld, code: number, pluginId: string) {
    assert.ok(this.cliResult, 'Expected a command to have run');
    assert.equal(this.cliResult.exitCode, code, this.cliResult.stdout + this.cliResult.stderr);
    assert.match(this.cliResult.stdout, new RegExp(`^ {2}${pluginId} `, 'm'));
  },
);
