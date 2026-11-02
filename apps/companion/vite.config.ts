// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const host = process.env.TAURI_DEV_HOST;
const workspace = (path: string) => `${repoRoot}${path}`;

// `--mode dummy` (see .env.dummy) builds the developer companion with dummy devices; every other
// mode leaves the simulator out of the bundle (VITE_DUMMY_DEVICES is replaced at build time).
export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@ridrs/ble-bridge': workspace('packages/ble-bridge/src/index.ts'),
      '@ridrs/ble-simulator': workspace('packages/ble-simulator/src/index.ts'),
      '@ridrs/ble-tauri': workspace('packages/ble-tauri/src/index.ts'),
      '@ridrs/contracts': workspace('packages/contracts/src/index.ts'),
    },
  },
  server: {
    port: 1440,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1441 } : undefined,
    fs: { allow: [repoRoot] },
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
