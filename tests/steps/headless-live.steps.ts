// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { execa } from 'execa';
import type { RidrsWorld } from '../support/world.ts';

type LogLine = Record<string, unknown>;

function logLines(world: RidrsWorld): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of world.headlessOutput.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        lines.push(parsed as LogLine);
      }
    } catch {
      // not a JSON log line
    }
  }
  return lines;
}

function connectionStates(world: RidrsWorld): string[] {
  return logLines(world)
    .filter((l) => typeof l.state === 'string' && typeof l.deviceName === 'string')
    .map((l) => l.state as string);
}

async function waitForLiveLine(
  world: RidrsWorld,
  matches: (line: LogLine) => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const lines = logLines(world);
    // Lines must appear in the order the steps are written.
    for (let i = world.headlessCursor; i < lines.length; i++) {
      const line = lines[i];
      if (line && line.msg === 'live' && matches(line)) {
        world.headlessCursor = i + 1;
        return;
      }
    }
    if (world.headlessExited) {
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(
    `Timed out waiting for a live line with ${description}. Output:\n${world.headlessOutput}`,
  );
}

Given('the plugin directories {string}', function (this: RidrsWorld, dirsCsv: string) {
  this.headlessPluginDirs = dirsCsv.split(',').map((d) => resolve(process.cwd(), d.trim()));
});

Given('the plugin {string} is disabled', function (this: RidrsWorld, pluginId: string) {
  this.headlessDisabled.push(pluginId);
});

Given('the BLE transport cannot be loaded', function (this: RidrsWorld) {
  this.headlessEnv.RIDRS_BLE_NOBLE_FAIL_LOAD = '1';
});

When('I start the headless app with these options', function (this: RidrsWorld) {
  this.headlessOutput = '';
  this.headlessExitCode = null;
  this.headlessExited = false;
  this.headlessCursor = 0;

  const args = [
    '--import',
    'tsx',
    resolve(process.cwd(), 'apps/headless/src/main.ts'),
    ...this.headlessPluginDirs.flatMap((dir) => ['--plugins', dir]),
    ...this.headlessDisabled.flatMap((id) => ['--disable', id]),
  ];
  const subprocess = execa(process.execPath, args, {
    cwd: process.cwd(),
    env: this.headlessEnv,
    reject: false,
    all: true,
  });
  subprocess.all?.on('data', (chunk: Buffer | string) => {
    this.headlessOutput += chunk.toString();
  });
  void subprocess.then((res) => {
    this.headlessExited = true;
    this.headlessExitCode = res.exitCode ?? null;
  });
  this.headlessProcess = subprocess;
});

When(
  'the app has logged a live line with power {int} and cadence {int}',
  async function (this: RidrsWorld, power: number, cadence: number) {
    await waitForLiveLine(
      this,
      (l) => l.power === power && l.cadence === cadence,
      `power ${power} and cadence ${cadence}`,
    );
  },
);

When(
  /^the app (?:has )?logged a live line with power unavailable because of "([^"]*)"$/,
  async function (this: RidrsWorld, reason: string) {
    await waitForLiveLine(
      this,
      (l) => l.power === null && l.powerStatus === reason,
      `power unavailable because of "${reason}"`,
    );
  },
);

Then(
  'the app logged the connection states {string} for {string}',
  function (this: RidrsWorld, expectedCsv: string, deviceName: string) {
    // The searching state is logged before a device name is known, so all states are compared.
    assert.ok(
      logLines(this).some((l) => l.deviceName === deviceName),
      `Expected log lines for "${deviceName}"`,
    );
    assert.deepEqual(
      connectionStates(this),
      expectedCsv.split(',').map((s) => s.trim()),
    );
  },
);

Then(
  'the app logged no live line with power 0 while the trainer was disconnected',
  function (this: RidrsWorld) {
    let disconnected = false;
    for (const line of logLines(this)) {
      if (typeof line.state === 'string' && typeof line.deviceName === 'string') {
        disconnected = line.state === 'reconnecting';
      } else if (disconnected && line.msg === 'live') {
        assert.notEqual(line.power, 0, 'Power must not be reported as 0 while disconnected');
      }
    }
  },
);

Then(
  'the app logged an {string} problem for plugin {string}',
  function (this: RidrsWorld, code: string, pluginId: string) {
    assert.ok(
      logLines(this).some((l) => l.code === code && l.pluginId === pluginId),
      `Expected a "${code}" problem for "${pluginId}". Output:\n${this.headlessOutput}`,
    );
  },
);

Then(
  'the app logged that the plugin {string} is {string}',
  function (this: RidrsWorld, pluginId: string, state: string) {
    assert.ok(
      logLines(this).some((l) => l.pluginId === pluginId && l.state === state),
      `Expected plugin "${pluginId}" to be ${state}. Output:\n${this.headlessOutput}`,
    );
  },
);
