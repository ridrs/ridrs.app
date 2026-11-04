// SPDX-License-Identifier: AGPL-3.0-or-later

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { downloadArtifact } = require('@electron/get');

async function ensureElectronBinary() {
  const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
  const pathTxt = path.join(electronDir, 'path.txt');
  const distDir = path.join(electronDir, 'dist');
  const platformPath = 'Electron.app/Contents/MacOS/Electron';

  if (
    fs.existsSync(pathTxt) &&
    fs.existsSync(path.join(distDir, platformPath))
  ) {
    return;
  }

  const { version } = require(path.join(electronDir, 'package.json'));
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
  });

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  execFileSync('ditto', ['-x', '-k', zipPath, distDir]);

  const dtsSrc = path.join(distDir, 'electron.d.ts');
  if (fs.existsSync(dtsSrc)) {
    fs.renameSync(dtsSrc, path.join(electronDir, 'electron.d.ts'));
  }

  fs.writeFileSync(pathTxt, platformPath, 'utf-8');
}

ensureElectronBinary().catch((err) => {
  console.error('Failed to ensure Electron binary:', err);
  process.exit(1);
});
