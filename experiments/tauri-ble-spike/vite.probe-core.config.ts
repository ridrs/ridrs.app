// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stage 3 of the portability probe: bundle `@ridrs/core` for a browser/WebView target.
 *
 * PROBE_SHIMS=0 (default) builds the core exactly as it is and reports the blockers.
 * PROBE_SHIMS=1 adds measuring-only shims so the remaining blockers become visible.
 * Neither mode is a fix; the host adapter the core needs is sketched in FINDINGS.md.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { ridrsAliases } from './vite.config.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const withShims = process.env.PROBE_SHIMS === '1';

// The workspace install does not link these into packages/core/node_modules (see FINDINGS.md),
// so the probe points them at the spike's own copies (same versions as packages/core/package.json).
const coreDependencyAliases = {
  rxjs: `${here}node_modules/rxjs`,
  'dependency-graph': `${here}node_modules/dependency-graph`,
  tinyglobby: `${here}node_modules/tinyglobby`,
  pino: `${here}node_modules/pino`,
};

const shimAliases = {
  'node:crypto': `${here}src/probe/shims/node-crypto.ts`,
  'node:url': `${here}src/probe/shims/node-url.ts`,
  'node:path': `${here}src/probe/shims/unavailable.ts`,
  'node:fs/promises': `${here}src/probe/shims/unavailable.ts`,
  tinyglobby: `${here}src/probe/shims/unavailable.ts`,
};

export default defineConfig({
  base: './',
  resolve: {
    alias: { ...ridrsAliases, '@ridrs/core': `${repoRoot}packages/core/src/index.ts`, ...coreDependencyAliases, ...(withShims ? shimAliases : {}) },
  },
  build: {
    outDir: withShims ? 'dist-probe/shimmed' : 'dist-probe/plain',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: `${here}probe-core.html` },
  },
});
