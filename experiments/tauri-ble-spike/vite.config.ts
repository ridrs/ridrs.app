// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// Shared ridrs code is imported read-only from the main workspace: never copied.
export const ridrsAliases = {
  '@ridrs/contracts': `${repoRoot}packages/contracts/src/index.ts`,
  '@ridrs-shared/ftms-parser': `${repoRoot}plugins/device-ftms-trainer/parser.ts`,
  '@ridrs-shared/ftms-trainer-plugin': `${repoRoot}plugins/device-ftms-trainer/index.ts`,
};

export default defineConfig({
  clearScreen: false,
  resolve: { alias: ridrsAliases },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    fs: { allow: [repoRoot] },
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
