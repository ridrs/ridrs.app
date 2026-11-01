// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { execa } from 'execa';
import type { RidrsWorld } from '../support/world.ts';

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

Given('the plugin directory {string}', function (this: RidrsWorld, relativeDir: string) {
  this.headlessPluginsDir = resolve(process.cwd(), relativeDir);
});

When('I start the headless app with that plugin directory', function (this: RidrsWorld) {
  this.headlessOutput = '';
  this.headlessExitCode = null;
  this.headlessExited = false;

  const mainPath = resolve(process.cwd(), 'apps/headless/src/main.ts');
  const subprocess = execa(
    process.execPath,
    ['--import', 'tsx', mainPath, '--plugins', this.headlessPluginsDir],
    {
      cwd: process.cwd(),
      reject: false,
      all: true,
    },
  );

  subprocess.all?.on('data', (chunk: Buffer | string) => {
    this.headlessOutput += chunk.toString();
  });

  void subprocess.then((res) => {
    this.headlessExited = true;
    this.headlessExitCode = res.exitCode ?? null;
  });

  this.headlessProcess = subprocess;
});

When('the app has logged {string}', async function (this: RidrsWorld, expectedText: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (this.headlessOutput.includes(expectedText)) {
      return;
    }
    if (this.headlessExited) {
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(
    `Timed out waiting for headless app to log "${expectedText}". Output so far:\n${this.headlessOutput}`,
  );
});

When('I send the app an interrupt signal', async function (this: RidrsWorld) {
  assert.ok(this.headlessProcess, 'Expected headless process to be running');
  this.headlessProcess.kill('SIGINT');
  const result = await this.headlessProcess;
  if (typeof result.all === 'string' && !this.headlessOutput.includes(result.all)) {
    this.headlessOutput = result.all;
  }
  this.headlessExited = true;
  this.headlessExitCode = result.exitCode ?? null;
});

Then(
  'the app logged that the plugins {string} were started',
  function (this: RidrsWorld, pluginsCsv: string) {
    for (const pluginId of splitCsv(pluginsCsv)) {
      assert.ok(
        this.headlessOutput.includes(pluginId),
        `Expected app output to mention started plugin "${pluginId}", got:\n${this.headlessOutput}`,
      );
    }
    assert.ok(
      this.headlessOutput.includes('host started'),
      `Expected app output to include "host started", got:\n${this.headlessOutput}`,
    );
  },
);

Then(
  'the app logged {string} before {string}',
  function (this: RidrsWorld, firstLog: string, secondLog: string) {
    const firstIdx = this.headlessOutput.indexOf(firstLog);
    const secondIdx = this.headlessOutput.indexOf(secondLog);
    assert.notEqual(
      firstIdx,
      -1,
      `Expected app output to contain "${firstLog}", got:\n${this.headlessOutput}`,
    );
    assert.notEqual(
      secondIdx,
      -1,
      `Expected app output to contain "${secondLog}", got:\n${this.headlessOutput}`,
    );
    assert.ok(
      firstIdx < secondIdx,
      `Expected "${firstLog}" (${firstIdx}) before "${secondLog}" (${secondIdx})`,
    );
  },
);

Then('the app logged {string}', function (this: RidrsWorld, expectedLog: string) {
  assert.ok(
    this.headlessOutput.includes(expectedLog),
    `Expected app output to include "${expectedLog}", got:\n${this.headlessOutput}`,
  );
});

Then('the app logged a(n) {string} problem', function (this: RidrsWorld, problemCode: string) {
  assert.ok(
    this.headlessOutput.includes(problemCode),
    `Expected app output to include diagnostic code "${problemCode}", got:\n${this.headlessOutput}`,
  );
});

Then('the app exited with code {int}', function (this: RidrsWorld, expectedCode: number) {
  assert.equal(this.headlessExitCode, expectedCode);
});
