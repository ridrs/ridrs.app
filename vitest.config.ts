// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ridrs/ble-bridge': resolve(import.meta.dirname, 'packages/ble-bridge/src/index.ts'),
      '@ridrs/ble-peripheral': resolve(import.meta.dirname, 'packages/ble-peripheral/src/index.ts'),
      '@ridrs/ble-simulator': resolve(import.meta.dirname, 'packages/ble-simulator/src/index.ts'),
      '@ridrs/ble-tauri': resolve(import.meta.dirname, 'packages/ble-tauri/src/index.ts'),
      '@ridrs/contracts': resolve(import.meta.dirname, 'packages/contracts/src/index.ts'),
      '@ridrs/core/node': resolve(import.meta.dirname, 'packages/core/src/node/index.ts'),
      '@ridrs/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@ridrs/metric-source': resolve(import.meta.dirname, 'packages/metric-source/src/index.ts'),
      '@ridrs/presentation': resolve(import.meta.dirname, 'packages/presentation/src/index.ts'),
      '@ridrs/temporal': resolve(import.meta.dirname, 'packages/temporal/src/index.ts'),
      '@ridrs/ui-sdk': resolve(import.meta.dirname, 'packages/ui-sdk/src/index.ts'),
      '@ridrs/ui-shell': resolve(import.meta.dirname, 'packages/ui-shell/src/index.ts'),
    },
  },
  test: {
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'plugins/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/src-tauri/**'],
    environment: 'node',
  },
});
