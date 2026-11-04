// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@tabata-sync/contracts': resolve(import.meta.dirname, 'contracts/src/index.ts'),
      '@tabata-sync/engine': resolve(import.meta.dirname, 'engine/src/index.ts'),
    },
  },
  test: {
    include: ['contracts/**/*.test.ts', 'engine/**/*.test.ts', 'player/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
