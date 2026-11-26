// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — the daily YouTube refresh (src/worker.js refresh) keeps the full-text index current by re-indexing only
// the videos whose title changed and the videos of a renamed channel, not by rebuilding video_fts (D1 counts every row written).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { refresh } from '../src/worker.js';
import { buildImportSql } from '../scripts/lib/import-sql.mjs';
import { makeD1 } from './d1-shim.mjs';

const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa', CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const SAME = 'SAMESAMESA1', RENAMED = 'RENAMEDREN1', OTHER = 'OTHEROTHER1', GONE = 'GONEGONEGO1';
const vid = (id, channel) => ({ video_id: id, channel_id: channel, region: 'Alps', place: 'Test', lat: 45, lon: 7, position_exact: false,
  country: 'IT', country_name: 'Italien', footage: 'real', topics: [], tech: null, exported_at: '2026-11-19',
  localization: { level: 7, key: 'region', rules_version: 0 }, route: null });
const snap = (id, channel, title) => ({ video_id: id, channel_id: channel, title, status: 'public', fetched_at: '2026-01-01' });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** YouTube Data API stand-in: `videos` and `channels` answer from the given maps. */
function fakeYoutube({ titles, channels }) {
  globalThis.fetch = async (url) => {
    const u = new URL(url), ids = u.searchParams.get('id').split(',');
    const items = u.pathname.endsWith('/videos')
      ? ids.filter((id) => titles.has(id)).map((id) => ({ id,
        snippet: { channelId: titles.get(id)[0], title: titles.get(id)[1], publishedAt: '2026-01-01T00:00:00Z' },
        contentDetails: { duration: 'PT1H', definition: 'hd', projection: 'rectangular' }, statistics: { viewCount: '10' },
        status: { embeddable: true, privacyStatus: 'public' } }))
      : ids.filter((id) => channels.has(id)).map((id) => ({ id, snippet: { title: channels.get(id) } }));
    return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
  };
}

function setup() {
  const DB = makeD1();
  const videos = [vid(SAME, CH_A), vid(RENAMED, CH_A), vid(OTHER, CH_B), vid(GONE, CH_B)];
  const yt = new Map([snap(SAME, CH_A, 'Old same'), snap(RENAMED, CH_A, 'Old title'), snap(OTHER, CH_B, 'Other drive'), snap(GONE, CH_B, 'Gone drive')]
    .map((r) => [r.video_id, r]));
  DB.raw.exec(buildImportSql({ videos, yt, sync: new Map(), today: '2026-01-01', at: 'x' }).sql.join('\n'));
  DB.raw.exec(`UPDATE video SET api_fetched_at = '2026-01-01'; UPDATE channel SET name = CASE channel_id WHEN '${CH_A}' THEN 'Channel A' ELSE 'Channel B' END, api_fetched_at = '2026-01-01';
    DELETE FROM video_fts; INSERT INTO video_fts (video_id, title, place, region, channel) SELECT v.video_id, v.title, v.place, v.region, c.name FROM video v LEFT JOIN channel c USING (channel_id)
    ORDER BY v.rowid DESC;`); // the reverse of a rebuild's order, so a full rebuild would show up as changed rowids
  return { DB, env: { DB, YOUTUBE_API_KEY: 'test' } };
}
const fts = (DB) => new Map(DB.raw.prepare('SELECT rowid, video_id, title, channel FROM video_fts').all().map((r) => [r.video_id, { ...r }]));
const search = (DB, q) => DB.raw.prepare('SELECT video_id FROM video_fts WHERE video_fts MATCH ? ORDER BY video_id').all(q).map((r) => r.video_id);

test('refresh re-indexes only videos whose title changed and keeps the other index rows', async () => {
  const { DB, env } = setup();
  const before = fts(DB);
  fakeYoutube({ titles: new Map([[SAME, [CH_A, 'Old same']], [RENAMED, [CH_A, 'Stelvio drive']], [OTHER, [CH_B, 'Other drive']]]), channels: new Map() });
  const r = await refresh(env);
  assert.equal(r.updated, 3);
  assert.equal(r.removed, 1);
  const after = fts(DB);
  assert.equal(after.size, 4, 'one index row per video, none lost or doubled');
  assert.equal(after.get(SAME).rowid, before.get(SAME).rowid, 'unchanged title: index row not rewritten');
  assert.equal(after.get(OTHER).rowid, before.get(OTHER).rowid, 'unchanged title: index row not rewritten');
  assert.equal(after.get(RENAMED).title, 'Stelvio drive');
  assert.equal(after.get(GONE).title, null, 'a removed video loses its title in the index too');
  assert.deepEqual(search(DB, 'stelvio'), [RENAMED]);
  assert.deepEqual(search(DB, 'gone'), []);
  assert.equal(r.reindexed, 2);
});

test('refresh re-indexes the videos of a renamed channel', async () => {
  const { DB, env } = setup();
  DB.raw.exec(`UPDATE channel SET api_fetched_at = NULL`);
  const before = fts(DB);
  fakeYoutube({ titles: new Map([[SAME, [CH_A, 'Old same']], [RENAMED, [CH_A, 'Old title']], [OTHER, [CH_B, 'Other drive']], [GONE, [CH_B, 'Gone drive']]]),
    channels: new Map([[CH_A, 'Alpine Roads'], [CH_B, 'Channel B']]) });
  const r = await refresh(env);
  const after = fts(DB);
  assert.equal(after.size, 4);
  assert.equal(after.get(SAME).channel, 'Alpine Roads');
  assert.equal(after.get(RENAMED).channel, 'Alpine Roads');
  assert.equal(after.get(OTHER).rowid, before.get(OTHER).rowid, 'channel name unchanged: its videos are not re-indexed');
  assert.deepEqual(search(DB, 'alpine'), [RENAMED, SAME]);
  assert.equal(r.reindexed, 2);
});

test('refresh re-indexes a video that moved to another channel under the same title', async () => {
  const { DB, env } = setup();
  const before = fts(DB);
  fakeYoutube({ titles: new Map([[SAME, [CH_B, 'Old same']], [RENAMED, [CH_A, 'Old title']], [OTHER, [CH_B, 'Other drive']], [GONE, [CH_B, 'Gone drive']]]), channels: new Map() });
  const r = await refresh(env);
  assert.equal(r.reindexed, 1);
  assert.equal(fts(DB).get(SAME).channel, 'Channel B');
  assert.equal(fts(DB).get(OTHER).rowid, before.get(OTHER).rowid);
});

test('refresh with nothing changed writes nothing to the index', async () => {
  const { DB, env } = setup();
  const before = fts(DB);
  fakeYoutube({ titles: new Map([[SAME, [CH_A, 'Old same']], [RENAMED, [CH_A, 'Old title']], [OTHER, [CH_B, 'Other drive']], [GONE, [CH_B, 'Gone drive']]]), channels: new Map() });
  const r = await refresh(env);
  assert.equal(r.reindexed, 0);
  assert.deepEqual([...fts(DB)].map(([k, v]) => [k, v.rowid]), [...before].map(([k, v]) => [k, v.rowid]));
});
