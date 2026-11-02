// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { createSilentLogger } from '@ridrs/core';
import { createFileSystemPluginSource } from '@ridrs/core/node';
import { waitFor } from '@testing-library/dom';
import { startRidrsApp } from '../../apps/native/src/compose.ts';
import type { RidrsWorld } from '../support/world.ts';

const quietUiLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Diagnostics that mean a plugin or its UI did not work, as opposed to expected domain reports. */
const LIFECYCLE_PROBLEMS = new Set([
  'entry-load-failure',
  'lifecycle-failure',
  'client-entry-missing',
  'client-load-failure',
  'unknown-extension-point',
]);

When('I start the ridrs app with these options', async function (this: RidrsWorld) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  this.nativeApp = await startRidrsApp({
    sources: this.headlessPluginDirs.map(createFileSystemPluginSource),
    root,
    logger: createSilentLogger(),
    uiLogger: quietUiLogger,
    disabledPlugins: this.headlessDisabled,
    keepAwake: { setKeepAwake: (on) => this.keepAwakeRequests.push(on) },
    bleTransport: this.nativeBleTransport,
    onBleTransportRequested: (transport) => this.bleTransportRequests.push(transport),
    frameSource: this.nativeFrameSource,
  });
  this.uiViews.push({ root, dispose: () => undefined });
});

When('I close the ridrs app', async function (this: RidrsWorld) {
  assert.ok(this.nativeApp, 'Expected the ridrs app to be running');
  await this.nativeApp.close();
});

Then('the app reported no lifecycle problems', function (this: RidrsWorld) {
  assert.ok(this.nativeApp, 'Expected the ridrs app to have run');
  const problems = this.nativeApp.host
    .getDiagnostics()
    .filter((d) => LIFECYCLE_PROBLEMS.has(d.code));
  assert.deepEqual(problems, []);
});

Then('the app keeps the screen awake', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(this.keepAwakeRequests.at(-1), true));
});

Then('the app lets the screen sleep', async function (this: RidrsWorld) {
  await waitFor(() => assert.notEqual(this.keepAwakeRequests.at(-1), true));
});
