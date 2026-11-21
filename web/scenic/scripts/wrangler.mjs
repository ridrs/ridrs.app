// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs wrangler with the shared local state (scripts/lib/paths.mjs STATE): `node scripts/wrangler.mjs dev --port 8788`.
// Every local command (dev, d1 migrations, d1 execute) must use the same --persist-to, or it sees an empty database.
import { spawnSync } from 'node:child_process';
import { ROOT, STATE } from './lib/paths.mjs';

const args = process.argv.slice(2);
const local = !args.includes('--remote');
// wrangler d1 takes --persist-to only together with --local (pnpm publish:initial, publish:vangestel).
const d1Local = local && args[0] === 'd1' && !args.includes('--local') ? ['--local'] : [];
const r = spawnSync('npx', ['wrangler', ...args, ...d1Local, ...(local ? ['--persist-to', STATE] : [])], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
