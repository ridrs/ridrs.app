// SPDX-License-Identifier: AGPL-3.0-or-later

import { createBundledPluginSource, createConsoleLogger } from '@ridrs/core';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { bundledPlugins } from './bundled-plugins.ts';
import { startRidrsApp } from './compose.ts';
import { createKeepAwake, ensureBluetoothPermission } from './platform.ts';
import { loadTransport, saveTransport, type TransportStore } from './transport-choice.ts';

/** Plugins that are bundled but not started in the app (the console output is for headless use). */
const DISABLED_IN_APP = ['output-console'];

/** The rider's choice of BLE transport, in a file the Rust side writes durably. */
const transportStore: TransportStore = {
  // Earlier builds kept the choice in WebView storage: read it until the file exists.
  read: async () =>
    (await invoke<string | null>('ble_transport_get')) ??
    localStorage.getItem('ridrs.bleTransport'),
  write: (transport) => invoke('ble_transport_set', { transport }),
};

async function main(): Promise<void> {
  const logger = createConsoleLogger({ app: 'ridrs-native' });
  const root = document.getElementById('ridrs');
  if (!root) {
    throw new Error('Missing #ridrs root element');
  }

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
    bleTransport: await loadTransport(transportStore),
    // The transport decides which plugins run, so a switch restarts the app's WebView, but only
    // once the choice is safely on disk: a crash in between must not land in a half state.
    onBleTransportRequested: (transport) => {
      void saveTransport(transportStore, transport).then(
        () => app.close().then(() => window.location.reload()),
        (error: unknown) => logger.error({ err: String(error) }, 'BLE transport not switched'),
      );
    },
  });
  window.addEventListener('pagehide', () => {
    void app.close();
  });
}

main().catch((error: unknown) => {
  console.error('ridrs failed to start', error);
});
