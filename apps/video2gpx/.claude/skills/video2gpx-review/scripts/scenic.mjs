#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// ridrs Scenic side of the video2gpx-review skill: wishlist → job → headless run → payload → upload → publish.
//
//   node scenic.mjs pick    [--n 5] [--retry]   first wishlist videos that fit a headless run (queue order), with skip reasons
//   node scenic.mjs prepare <id>                 job + route GPX into <id>/scenic/, prints the video2gpx-yt.sh options
//   node scenic.mjs payload <id>                 <id>/scenic/<id>.scenic.json from run/ + review/, checked like the server checks it
//   node scenic.mjs upload  <id>                 POST the payload (Lokalisierungsstufe 2), response in <id>/scenic/upload.json
//   node scenic.mjs publish <id>                 site_published = true (refused for hidden videos and opted-out channels)
//   node scenic.mjs state   <id> <status> [note] record the outcome in _wishlist/state.json (picked|running|published|rejected|failed|skipped)
//
// Server: always the online Scenic https://ridrs.app/scenic and its live database (user decision 2026-11-24): the local
// `pnpm dev` database has no wishes. There is no override to localhost.
// Auth (Cloudflare Access): the service token "video2gpx-review" from the macOS keychain (see KEYCHAIN below), or from the
// environment: CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET, or CF_ACCESS_TOKEN (`cloudflared access token -app=…`).
//
// The payload is built by the app's own code (apps/video2gpx/src/atlas.ts: qcChecks, buildPayload) and checked by the Scenic's own
// validateResult (web/scenic/src/video2gpx.js), both imported from the ridrs_app checkout, so the contract (VIDEO2GPX-INTEGRATION.md
// section 8) has one implementation. Node ≥ 23.6 strips the TypeScript types.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// This skill lives in the ridrs_app repo (apps/video2gpx/.claude/skills/<skill>/scripts): APP is the checkout it is in (main or a
// worktree), so payload builder and validator come from the same commit as the skill. The run data stay outside the repo in
// Ridrs/video2gpx-runs (the first folder above the checkout that has it; V2G_RIDRS overrides).
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const RIDRS = process.env.V2G_RIDRS ? resolve(process.env.V2G_RIDRS) : (() => {
  for (let d = dirname(APP); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, 'video2gpx-runs'))) return d;
  console.error(`error: no Ridrs folder with video2gpx-runs/ above ${APP}; set V2G_RIDRS`); process.exit(1);
})();
const RUNS = join(RIDRS, 'video2gpx-runs');
const RUNNER = join(RIDRS, 'ridrs_app-worktrees/video2gpx-runner');
const BASE = 'https://ridrs.app/scenic';
const STATE = join(RUNS, '_wishlist/state.json');
const MAX_DURATION_S = 4 * 3600; // the Scenic takes at most 14,400 points
const ID = /^[\w-]{11}$/;

const atlas = await import(join(APP, 'apps/video2gpx/src/atlas.ts'));
const scenic = await import(join(APP, 'web/scenic/src/video2gpx.js'));

const die = (msg, code = 1) => { console.error(`error: ${msg}`); process.exit(code); };
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const out = (x) => console.log(JSON.stringify(x, null, 2));
const dir = (id) => { const d = join(RUNS, id, 'scenic'); mkdirSync(d, { recursive: true }); return d; };

// The service token "video2gpx-review" lives in the macOS keychain (services KEYCHAIN.id / KEYCHAIN.secret), put there by the user
// with `security add-generic-password -a video2gpx-review -s <service> -w`. The environment variables win when set.
const KEYCHAIN = { id: 'ridrs-scenic-cf-access-client-id', secret: 'ridrs-scenic-cf-access-client-secret' };
function keychain(service) {
  try { return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}
let creds;
function credentials() {
  if (creds) return creds;
  const env = process.env;
  if (env.CF_ACCESS_CLIENT_ID) creds = { id: env.CF_ACCESS_CLIENT_ID, secret: env.CF_ACCESS_CLIENT_SECRET ?? '' };
  else if (env.CF_ACCESS_TOKEN) creds = { token: env.CF_ACCESS_TOKEN };
  else {
    const id = keychain(KEYCHAIN.id), secret = id && keychain(KEYCHAIN.secret);
    if (id && secret) creds = { id, secret };
  }
  if (!creds) die(`no Cloudflare Access credentials for ${BASE}: put the service token in the keychain (${KEYCHAIN.id}, ${KEYCHAIN.secret}) or set CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET or CF_ACCESS_TOKEN`);
  return creds;
}

function headers(write) {
  const c = credentials();
  const h = { accept: 'application/json' };
  if (c.id) {
    h['CF-Access-Client-Id'] = c.id;
    h['CF-Access-Client-Secret'] = c.secret;
  }
  if (c.token) h['cf-access-token'] = c.token;
  // The CSRF guard (src/auth.js sameOriginWrite) wants this site's own Origin on writes. It protects browsers that carry the
  // Access cookie; this client carries none, so it states the origin it writes to.
  if (write) { h.origin = new URL(BASE).origin; h['content-type'] = 'application/json'; }
  return h;
}
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/admin/${path}`, { method, headers: headers(method !== 'GET'), redirect: 'manual', body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  // Access answers a token it does not accept with a redirect to its login page (an HTML page with status 200 if followed).
  if (res.status >= 300 && res.status < 400 || /text\/html/.test(res.headers.get('content-type') ?? ''))
    die(`${method} ${path}: Cloudflare Access did not accept the service token (HTTP ${res.status} → login page). Check that the /api/admin application has a policy with action "Service Auth" that includes this token.`);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { const e = new Error(`${method} ${path}: HTTP ${res.status} ${typeof data === 'object' ? data.error ?? '' : String(data).slice(0, 200)}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

const loadState = () => (existsSync(STATE) ? readJ(STATE) : {});
function setState(id, status, note) {
  const s = loadState();
  s[id] = { ...(s[id] ?? {}), status, note: note ?? null, at: new Date().toISOString(), base: BASE };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
}

// ------------------------------------------------------------------ pick

async function pick(args) {
  const n = +(args[args.indexOf('--n') + 1] || 0) || 1, retry = args.includes('--retry');
  const q = await api('GET', 'queue'), st = loadState(), picks = [], skipped = [];
  for (const w of q) {
    if (picks.length >= n) break;
    const id = w.video_id, why = (reason) => skipped.push({ id, title: w.title, reason });
    const prev = st[id];
    // picked / running: an interrupted earlier attempt, taken up again (the run script resumes finished steps)
    if (prev && !retry && !['picked', 'running'].includes(prev.status)) { why(`already ${prev.status} on ${prev.at.slice(0, 10)}${prev.note ? `: ${prev.note}` : ''}`); continue; }
    if (w.duration_s && w.duration_s > MAX_DURATION_S) { why(`longer than 4 h (${Math.round(w.duration_s / 60)} min)`); continue; }
    const v = await api('GET', `videos/${id}`);
    if (v.hidden) { why('hidden in the admin'); continue; }
    if (v.channel?.optout) { why('channel opted out'); continue; }
    const job = atlas.parseJob(JSON.stringify(await api('GET', `videos/${id}/video2gpx-job.json`)));
    if (!job.bbox) { why('job has no search area (no route, no pin)'); continue; }
    picks.push({ id, position: w.position, votes: w.votes, priority: w.priority, title: w.title, channel: w.channel, place: w.place, country: w.country,
      duration_min: w.duration_s ? Math.round(w.duration_s / 60) : null, route_level: job.route_level, loc_level: w.loc_level });
  }
  out({ base: BASE, queue_open: q.length, picks, skipped });
}

// ------------------------------------------------------------------ prepare

const box = (b) => (b ? b.join(',') : null);
async function prepare(id) {
  const d = dir(id);
  const job = await api('GET', `videos/${id}/video2gpx-job.json`);
  writeFileSync(join(d, 'job.json'), JSON.stringify(job, null, 2) + '\n');
  const plan = atlas.jobPlan(atlas.parseJob(JSON.stringify(job)));
  const opts = [];
  if (!plan.bbox) die('the job has no search area: ask the user for one, or skip the video');
  opts.push('--bbox', box(plan.bbox));
  if (plan.start_frame) opts.push('--start-bbox', box(plan.start_frame));
  if (plan.end_frame) opts.push('--end-bbox', box(plan.end_frame));
  if (plan.hint) {
    const res = await fetch(plan.hint.url, { headers: headers(false) });
    if (!res.ok) die(`route GPX ${plan.hint.url}: HTTP ${res.status}`);
    writeFileSync(join(d, 'route.gpx'), await res.text());
    opts.push('--hint', join(d, 'route.gpx'), '--hint-buffer-m', String(plan.hint.buffer_m));
  } else opts.push('--no-hint');
  opts.push('--vehicle', plan.vehicle);
  if (job.country) opts.push('--country', job.country);
  out({ id, url: job.url, title: job.title, duration_s: job.duration_s, route_level: job.route_level, job: join(d, 'job.json'), options: opts,
    command: ['./video2gpx-yt.sh', id, ...opts].map((x) => (/[\s,]/.test(x) && !/^[\d.,-]+$/.test(x) ? `"${x}"` : x)).join(' ') });
}

// ------------------------------------------------------------------ payload

function gpxLines(text) {
  const lines = [];
  for (const seg of text.split(/<\/?(?:trkseg|rte)\b[^>]*>/)) {
    const pts = [...seg.matchAll(/<(?:trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"|<(?:trkpt|rtept)\b[^>]*?\blon="([-\d.]+)"[^>]*?\blat="([-\d.]+)"/g)]
      .map((m) => (m[1] ? [+m[1], +m[2]] : [+m[4], +m[3]]));
    if (pts.length > 1) lines.push(pts);
  }
  return lines;
}

async function payload(id) {
  const d = dir(id), run = join(RUNS, id, 'run'), rev = join(RUNS, id, 'review');
  for (const f of [join(d, 'job.json'), join(run, 'route_points.json'), join(run, 'project.json'), join(rev, 'verdicts.json'), join(rev, 'scenic-qc.json')])
    if (!existsSync(f)) die(`missing ${f}`);
  const jobText = readFileSync(join(d, 'job.json'), 'utf8'), job = atlas.parseJob(jobText), rawJob = JSON.parse(jobText);
  const rp = readJ(join(run, 'route_points.json')), pj = readJ(join(run, 'project.json'));
  const verdicts = readJ(join(rev, 'verdicts.json')), sq = readJ(join(rev, 'scenic-qc.json'));

  // the skill's success gate: nothing the frames proved wrong, no override of a blocking check
  const problems = [];
  if (rp.verdict !== 'confident') problems.push(`pipeline verdict is ${rp.verdict} (${rp.verdict_basis}), not confident`);
  const wrong = verdicts.filter((v) => v.verdict === 'wrong');
  if (wrong.length) problems.push(`spots judged wrong: ${wrong.map((v) => v.spot).join(', ')}`);
  const controls = verdicts.filter((v) => /^K/.test(v.spot)), okControls = controls.filter((v) => v.verdict === 'correct');
  if (!okControls.length) problems.push('no control spot judged correct');
  const unchecked = verdicts.filter((v) => !['wrong', 'correct', 'correct_uncertain', 'unclear'].includes(v.verdict));
  if (unchecked.length) problems.push(`spots not judged yet: ${unchecked.map((v) => v.spot).join(', ')}`);

  const points = rp.points, standstills = (rp.standstills ?? []).map((s) => (Array.isArray(s) ? s : [s.t0, s.t1]));
  const cutTimes = rp.cuts?.times ?? [], introEnd = rp.cuts?.intro_end ?? null;
  const span = atlas.defaultSpan(points, introEnd);
  const v = sq.viewed ?? {};
  const state = { result: 'headless', t_start: sq.t_start ?? span.t_start, t_end: sq.t_end ?? span.t_end, overrides: {},
    cuts_checked: sq.cuts_checked ?? [], viewed: { start: !!v.start, turn: !!v.turn, end: !!v.end },
    note: [sq.note, `Headless (video2gpx-yt.sh) und Frame-Review (Skill video2gpx-review). Angesehen: Anfang ${v.start || '–'}; Kehre/Kreuzung ${v.turn || '–'}; Ende ${v.end || '–'}.`].filter(Boolean).join(' ') };
  const hintLines = existsSync(join(d, 'route.gpx')) ? gpxLines(readFileSync(join(d, 'route.gpx'), 'utf8')) : null;
  const items = atlas.qcChecks({ verdict: rp.verdict, points, standstills, cutTimes, hintLines, hasRoute: !!job.route_gpx, state });
  const table = items.map((i) => ({ id: i.id, ok: i.ok, blocking: i.blocking, detail: i.detail }));
  for (const i of items) if (i.blocking && !i.ok) problems.push(`QC ${i.id}: ${i.detail}`);
  if (problems.length) { out({ id, ready: false, problems, qc: table }); process.exit(2); }

  let commit = 'unknown';
  try { commit = execFileSync('git', ['-C', RUNNER, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  const p = atlas.buildPayload({ job, verdict: rp.verdict, verdict_basis: rp.verdict_basis, points, standstills, cutTimes,
    pipeline_hash: String(pj.pipeline_hash ?? pj.code_hash ?? ''), vehicle: String(pj.effective?.vehicle ?? 'auto'),
    offset_m: typeof pj.effective?.offset_m === 'number' ? pj.effective.offset_m : null, app_version: `video2gpx-yt.sh@${commit}`,
    state, items, eleAt: null });
  // the server's own check (bbox, speeds, cuts, size); a point outside the job's frame is never overridden here
  let checked;
  try { checked = scenic.validateResult(p, rawJob, { durationS: rawJob.duration_s }); }
  catch (e) { out({ id, ready: false, problems: [`Scenic would refuse it: ${e.message}`], extra: e.extra ?? null, qc: table }); process.exit(2); }
  const text = JSON.stringify(p);
  if (text.length > scenic.MAX_RESULT_BYTES) { out({ id, ready: false, problems: ['payload larger than 1.5 MB'] }); process.exit(2); }
  const file = join(d, atlas.payloadName(job));
  writeFileSync(file, text);
  const agree = items.find((i) => i.id === 'route_agreement')?.value ?? null;
  out({ id, ready: true, file, points: p.t.length, t_start: p.t_start, t_end: p.t_end, route_km: p.route_km, coverage: p.coverage,
    confidence_mean: p.confidence_mean, route_agreement: agree, route_offer: !agree || agree.median_m > scenic.ROUTE_OFFER_M, qc: table,
    outside_bbox: checked.outside });
}

// ------------------------------------------------------------------ upload / publish

async function upload(id) {
  const d = dir(id), job = atlas.parseJob(readFileSync(join(d, 'job.json'), 'utf8')), file = join(d, atlas.payloadName(job));
  if (!existsSync(file)) die(`missing ${file}: run "payload ${id}" first`);
  const r = await api('POST', `videos/${id}/video2gpx`, readFileSync(file, 'utf8'));
  writeFileSync(join(d, 'upload.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), response: r }, null, 2) + '\n');
  out({ id, base: BASE, response: r });
}

async function publish(id) {
  const v = await api('GET', `videos/${id}`);
  if (v.hidden) die('the video is hidden in the admin: not published');
  if (v.channel?.optout) die('the channel opted out: not published');
  const loc = v.localization?.loc_level ?? v.loc_level ?? null;
  if (loc != null && loc > 2) die(`Lokalisierungsstufe is ${loc}, not 2 or 1: upload first`);
  if (v.site_published) { out({ id, site_published: true, changed: false }); return; }
  const r = await api('PATCH', `videos/${id}`, { site_published: true });
  out({ id, base: BASE, site_published: true, changed: true, response: r, public: `${BASE}/#v=${id}` });
}

// ------------------------------------------------------------------ main

const [cmd, id, ...rest] = process.argv.slice(2);
const needId = () => { if (!ID.test(id || '')) die('a YouTube id (11 characters) is needed'); };
try {
  if (cmd === 'pick') await pick([id, ...rest].filter(Boolean));
  else if (cmd === 'prepare') { needId(); await prepare(id); }
  else if (cmd === 'payload') { needId(); await payload(id); }
  else if (cmd === 'upload') { needId(); await upload(id); }
  else if (cmd === 'publish') { needId(); await publish(id); }
  else if (cmd === 'state') { needId(); if (!rest[0]) die('status missing'); setState(id, rest[0], rest.slice(1).join(' ') || null); out(loadState()[id]); }
  else die('usage: scenic.mjs pick|prepare|payload|upload|publish|state …');
} catch (e) {
  if (e.cause?.code === 'ECONNREFUSED') die(`Scenic not reachable at ${BASE}: check the network and stop; do not fall back to a local server`);
  die(e.data ? `${e.message}\n${JSON.stringify(e.data)}` : e.message);
}
