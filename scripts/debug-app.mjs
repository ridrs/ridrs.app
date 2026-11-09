// SPDX-License-Identifier: AGPL-3.0-or-later

// Talks to the debug bridge of the running dev app (apps/native/debug-bridge/plugin.ts):
//   node scripts/debug-app.mjs status
//   node scripts/debug-app.mjs eval "return document.title"     (or the code on stdin)
//   node scripts/debug-app.mjs logs [since]
//   node scripts/debug-app.mjs layout [selector]   geometry facts judged: cut-off text, overflow, overlap, tiny targets, contrast
//   node scripts/debug-app.mjs screenshot [out.png] [width]   native snapshot of the web view (Mac, debug build), 800 pt wide
//   node scripts/debug-app.mjs a11y [selector]     roles and names, as a screen reader finds them
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../node_modules/.cache/ridrs-debug.json', import.meta.url));
let bridge;
try {
  bridge = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.error('No debug bridge: start the app with `pnpm --filter @ridrs/native tauri dev` first.');
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const call = async (method, path, body) => {
  const response = await fetch(`http://localhost:${bridge.port}/__debug${path}`, {
    method,
    headers: { 'x-ridrs-debug-token': bridge.token },
    ...(body === undefined ? {} : { body }),
  });
  return response.json();
};

let result;
if (command === 'status') {
  result = await call('GET', '/status');
} else if (command === 'logs') {
  result = await call('GET', `/logs?since=${rest[0] ?? 0}`);
} else if (command === 'layout' || command === 'a11y') {
  const query = rest[0] ? `?selector=${encodeURIComponent(rest[0])}` : '';
  result = await call('GET', `/${command}${query}`);
} else if (command === 'screenshot') {
  const out = resolve(rest[0] ?? `${tmpdir()}/ridrs-debug-screenshot.png`);
  result = await call('GET', `/screenshot?path=${encodeURIComponent(out)}&width=${rest[1] ?? 800}`);
} else if (command === 'eval') {
  const code = rest.join(' ') || readFileSync(0, 'utf8');
  result = await call('POST', '/eval', code);
} else {
  console.error('usage: debug-app.mjs status | logs [since] | layout [selector] | a11y [selector] | screenshot [out.png] [width] | eval <code>');
  process.exit(2);
}
console.log(JSON.stringify(result, null, 2));
