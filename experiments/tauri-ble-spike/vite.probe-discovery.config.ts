// SPDX-License-Identifier: AGPL-3.0-or-later

/** Builds `probe-discovery.html`: bundled discovery via import.meta.glob for a browser target. */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { ridrsAliases } from './vite.config.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  base: './',
  resolve: { alias: ridrsAliases },
  server: { fs: { allow: [repoRoot] } },
  build: {
    outDir: 'dist-probe/discovery',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: `${here}probe-discovery.html` },
  },
});
