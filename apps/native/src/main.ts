// SPDX-License-Identifier: AGPL-3.0-or-later

import { createBundledPluginSource, createConsoleLogger } from '@ridrs/core';
import { getVersion } from '@tauri-apps/api/app';
import { suppressBrowserChrome } from './browser-chrome.ts';
import { bundledPlugins } from './bundled-plugins.ts';
import { startRidrsApp } from './compose.ts';
import { createInstalledPluginSource, readPluginChoices } from './installed-plugins.ts';
import {
  androidBackButton,
  createKeepAwake,
  createNativeFullscreen,
  ensureBluetoothPermission,
} from './platform.ts';
import { enableOverlayTitleBar, hasOverlayTitleBar } from './title-bar.ts';

/**
 * Plugins that are bundled but not started in the app: the console output is for headless use;
 * the gauge HUD (`ui-hud-gauges`) takes the place of the plain HUD and shows power, heart rate,
 * cadence, speed, distance and the gradient itself, so the plain HUD and those widgets would
 * only repeat it. It also shows the virtual gear in its cadence gauge and shifts with the keys, in
 * place of the gear widget, and takes the ERG target's keys; the target power is not shown (the
 * dispatching widget that shows the gear or the target is not started; the target power plugin
 * still gives the ERG button), nor is the power-to-heart-rate ratio.
 */
const DISABLED_IN_APP = [
  'output-console',
  'ui-hud',
  'ui-widget-power',
  'ui-widget-heart-rate',
  'ui-widget-cadence',
  'ui-widget-virtual-speed',
  'ui-widget-virtual-distance',
  'ui-widget-gradient',
  'ui-widget-virtual-gear',
  'ui-widget-erg-dispatch',
  'ui-widget-power-heart-rate-ratio',
];

/**
 * The rider's screenshot of a ride takes the native snapshot of the web view, which only the Mac
 * app has so far (ADR 0102): elsewhere neither the button nor its service is started. The Mac
 * desktop app is the one with the overlay title bar.
 */
const SCREENSHOTS = ['screenshot-tauri', 'ui-ride-screenshot'];

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
  // The plugins the rider switched off and the ones installed (ADR 0106), for this start.
  const choices = await readPluginChoices();
  const app = await startRidrsApp({
    sources: [createBundledPluginSource(bundledPlugins), createInstalledPluginSource()],
    root,
    logger,
    disabledPlugins: [
      ...(hasOverlayTitleBar() ? DISABLED_IN_APP : [...DISABLED_IN_APP, ...SCREENSHOTS]),
      ...choices.disabled,
    ],
    platform: {
      ridrsVersion: __RIDRS_VERSION__,
      runtime: 'tauri',
      os: navigator.platform || navigator.userAgent,
      appVersion,
    },
    keepAwake: createKeepAwake(),
    backButton: androidBackButton,
    fullscreen: createNativeFullscreen(),
  });
  window.addEventListener('pagehide', () => {
    void app.close();
  });
}

main().catch((error: unknown) => {
  console.error('ridrs failed to start', error);
});
