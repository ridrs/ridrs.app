// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const host = process.env.TAURI_DEV_HOST;
const workspace = (path: string) => `${repoRoot}${path}`;

export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@ridrs/ble-bridge': workspace('packages/ble-bridge/src/index.ts'),
      '@ridrs/ble-tauri': workspace('packages/ble-tauri/src/index.ts'),
      '@ridrs/contracts': workspace('packages/contracts/src/index.ts'),
      '@ridrs/core': workspace('packages/core/src/index.ts'),
      '@ridrs/presentation': workspace('packages/presentation/src/index.ts'),
      '@ridrs/ui-bridge': workspace('packages/ui-bridge/src/index.ts'),
      '@ridrs/ui-sdk': workspace('packages/ui-sdk/src/index.ts'),
      '@ridrs/ui-shell': workspace('packages/ui-shell/src/index.ts'),
    },
    // One React for the shell's plugins, wherever their package resolves it from.
    dedupe: ['react', 'react-dom'],
  },
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
});
