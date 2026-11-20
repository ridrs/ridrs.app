// SPDX-License-Identifier: AGPL-3.0-or-later
// Pulls every manual field from the admin export (GET /api/admin/export, ndjson) into data/manual.json of the pipeline folder)
// (CLOUDFLARE-KONZEPT.md 4.3: "Vor jedem Import zieht die Pipeline die manuellen Felder aus D1").
//
//   node scripts/pull_manual.mjs                       local dev server (http://localhost:8788, ADMIN_DEV_EMAIL)
//   node scripts/pull_manual.mjs --url https://ridrs.app/scenic  production, behind Cloudflare Access:
//     CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET    an Access service token allowed by the /api/admin policy, or
//     CF_ACCESS_TOKEN                                  a user token (`cloudflared access token -app=https://<site>`)
//   --out <file>                                       other target than data/manual.json of the pipeline
// The file is written atomically (temp file + rename). It stays local: it holds the edit log with e-mail addresses.
import { PIPELINE } from './lib/paths.mjs';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const base = (arg('--url', process.env.SCENIC_URL || 'http://localhost:8788/scenic')).replace(/\/$/, '');
const out = resolve(arg('--out', resolve(PIPELINE, 'data/manual.json')));

const headers = {};
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET ?? '';
}
if (process.env.CF_ACCESS_TOKEN) headers['cf-access-token'] = process.env.CF_ACCESS_TOKEN;

/** ndjson lines of the export -> the manual.json structure. */
export function toManual(lines) {
  const m = { format: 1, exported_at: null, source: null, rules_version: null, videos: {}, routes: {}, localizations: {}, anchors: {}, sync: {},
    collections: [], optout: [], images: [], edit_log: [], localization_log: [] };
  for (const l of lines) {
    const { type, ...x } = l;
    if (type === 'meta') { m.exported_at = x.exported_at; m.rules_version = x.rules_version; }
    else if (type === 'video') m.videos[x.video_id] = { editorial: x.editorial, manual: x.manual, manual_fields: x.manual_fields };
    else if (type === 'route') m.routes[x.video_id] = x;
    else if (type === 'localization') m.localizations[x.video_id] = x;
    else if (type === 'anchor') (m.anchors[x.video_id] ??= []).push({ t: x.t, lon: x.lon, lat: x.lat, source: x.source });
    else if (type === 'sync') m.sync[x.video_id] = x;
    else if (type === 'collection') m.collections.push(x);
    else if (type === 'optout') m.optout.push(x);
    else if (type === 'image') m.images.push(x);
    else if (type === 'edit') m.edit_log.push(x);
    else if (type === 'localization_log') m.localization_log.push(x);
  }
  return m;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await fetch(`${base}/api/admin/export`, { headers, redirect: 'manual' });
  if (!res.ok) {
    console.error(`GET ${base}/api/admin/export: ${res.status}${res.status === 403 || res.status === 302 ? ' (no admin access: see the header of this script)' : ''}`);
    process.exit(1);
  }
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const manual = { ...toManual(lines), source: base };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, JSON.stringify(manual, null, 1) + '\n');
  renameSync(`${out}.tmp`, out);
  const n = (o) => Object.keys(o).length;
  console.log(`${out}: ${n(manual.videos)} videos, ${n(manual.routes)} routes, ${n(manual.localizations)} localizations, ${Object.values(manual.anchors).flat().length} anchors, `
    + `${manual.collections.length} collections, ${manual.optout.length} opt-outs, ${manual.images.length} images, ${manual.edit_log.length} edits`);
}
