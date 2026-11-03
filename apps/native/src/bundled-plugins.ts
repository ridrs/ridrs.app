// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BundledPluginSet } from '@ridrs/core';

// The plugin set is fixed at build time. Patterns must be literals; plugins that cannot run in a
// WebView (Node BLE, Node files) are excluded here (build layer) - the runtime layer is
// `disabledPlugins` in main.ts. scripts/check-native-bundle.mjs checks the result.
const manifests = import.meta.glob<string>(
  [
    '../../../plugins/*/manifest.json',
    '!../../../plugins/transport-ble-noble/**',
    '!../../../plugins/storage-files-node/**',
  ],
  { query: '?raw', import: 'default', eager: true },
);

// Server entries and client modules, each its own lazy chunk.
const modules = import.meta.glob([
  '../../../plugins/*/index.ts',
  '../../../plugins/*/client/index.tsx',
  '!../../../plugins/transport-ble-noble/**',
  '!../../../plugins/storage-files-node/**',
]);

export const bundledPlugins: BundledPluginSet = { manifests, modules };
