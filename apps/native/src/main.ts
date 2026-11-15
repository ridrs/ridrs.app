// SPDX-License-Identifier: AGPL-3.0-or-later

import { createBundledPluginSource, createConsoleLogger } from '@ridrs/core';
import { getVersion } from '@tauri-apps/api/app';
import { suppressBrowserChrome } from './browser-chrome.ts';
import { bundledPlugins } from './bundled-plugins.ts';
import { startRidrsApp } from './compose.ts';
import { androidBackButton, createKeepAwake, ensureBluetoothPermission } from './platform.ts';
import { enableOverlayTitleBar } from './title-bar.ts';

/**
 * Plugins that are bundled but not started in the app: the console output is for headless use;
 * the gauge HUD (`ui-hud-gauges`) takes the place of the plain HUD and shows power, heart rate,
 * cadence, speed and distance itself, so the plain HUD and those widgets would only repeat it.
 */
const DISABLED_IN_APP = [
  'output-console',
  'ui-hud',
  'ui-widget-power',
  'ui-widget-heart-rate',
  'ui-widget-cadence',
  'ui-widget-virtual-speed',
  'ui-widget-virtual-distance',
];

async function main(): Promise<void> {
  const logger = createConsoleLogger({ app: 'ridrs-native' });
  const root = document.getElementById('ridrs');
  if (!root) {
    throw new Error('Missing #ridrs root element');
  }
  suppressBrowserChrome(document.documentElement, { allowInspect: import.meta.env.DEV });
  enableOverlayTitleBar(document.documentElement);

  // Before any plugin scans: without the grant Android finds no trainer.
  const granted = await ensureBluetoothPermission().catch((error: unknown) => {
    logger.warn({ err: String(error) }, 'Bluetooth permission check failed');
    return false;
  });
  if (!granted) {
    logger.warn('Bluetooth permission not granted; no trainer can be found');
  }

  const appVersion = await getVersion().catch(() => '0.0.0');
  const app = await startRidrsApp({
    sources: [createBundledPluginSource(bundledPlugins)],
    root,
    logger,
    disabledPlugins: DISABLED_IN_APP,
    platform: {
      ridrsVersion: __RIDRS_VERSION__,
      runtime: 'tauri',
      os: navigator.platform || navigator.userAgent,
      appVersion,
    },
    keepAwake: createKeepAwake(),
    backButton: androidBackButton,
  });
  window.addEventListener('pagehide', () => {
    void app.close();
  });
}

main().catch((error: unknown) => {
  console.error('ridrs failed to start', error);
});
