// SPDX-License-Identifier: AGPL-3.0-or-later

// Asserts that the native app bundle (apps/native/dist, from `vite build`) contains neither the
// official Garmin FIT SDK (a test-only devDependency that must never be distributed, ADR 0034)
// nor the Node storage provider (Node-only, excluded at the build layer).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'apps/native/dist');
const FORBIDDEN = [
  ['@garmin/fitsdk', /@garmin\/fitsdk|Garmin International|FIT Protocol License/],
  ['storage-files-node', /storage-files-node|RIDRS_DATA_DIR|env-paths/],
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

let bundle;
try {
  // Source maps quote the bundle's own sources, build-layer exclusion patterns included.
  bundle = files(dist).filter((path) => /\.(js|html|css)$/.test(path));
} catch {
  console.error(`No native bundle in ${relative(root, dist)}: run "pnpm --filter @ridrs/native build"`);
  process.exit(2);
}

const findings = [];
for (const path of bundle) {
  const text = readFileSync(path, 'utf8');
  for (const [name, pattern] of FORBIDDEN) {
    if (pattern.test(text)) {
      findings.push(`${relative(root, path)} contains ${name}`);
    }
  }
}
if (findings.length > 0) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(`native bundle ok: ${bundle.length} files without @garmin/fitsdk or storage-files-node`);
