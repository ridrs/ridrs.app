// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ridrs/contracts': resolve(import.meta.dirname, 'packages/contracts/src/index.ts'),
      '@ridrs/core/node': resolve(import.meta.dirname, 'packages/core/src/node/index.ts'),
      '@ridrs/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'plugins/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
