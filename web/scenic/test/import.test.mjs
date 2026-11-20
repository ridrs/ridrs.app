// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test test/ — the import SQL (scripts/lib/import-sql.mjs) run against the migrations in node:sqlite:
// pipeline fields are updated, everything set by hand stays ("manual fields always win").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportSql, MANUAL_VIDEO_COLS } from '../scripts/lib/import-sql.mjs';
import { makeD1 } from './d1-shim.mjs';

const video = (id, o = {}) => ({ video_id: id, channel_id: 'UCaaaaaaaaaaaaaaaaaaaaaa', region: 'Alps', place: 'Bormio', lat: 46.5, lon: 10.4,
  position_exact: true, country: 'IT', country_name: 'Italien', footage: 'real', topics: [], tech: null, exported_at: '2026-11-18',
  localization: { level: 4, key: 'route', rules_version: 0 },
  route: { distance_km: 20, method: 'osrm_waypoints', line: [[46.5, 10.4], [46.6, 10.5]], creator_links: [], check: null,
    elevation: { ascent_m: 100, descent_m: 50, profile: [[0, 1200], [20, 1300]], source: 'copernicus_glo30' }, roads: { class_share: { primary: 1 }, surface_share: { asphalt: 1 } } },
  ...o });
const run = (db, videos, sync = new Map()) => {
  const { sql } = buildImportSql({ videos, yt: new Map(), sync, today: '2026-11-18', at: 'x' });
  db.raw.exec(sql.join('\n'));
};
const row = (db, sql, ...a) => db.raw.prepare(sql).get(...a);

test('import keeps manual fields, editorial fields, manual routes and localizations', () => {
  const db = makeD1();
  run(db, [video('AAAAAAAAAAA'), video('BBBBBBBBBBB'), video('CCCCCCCCCCC'), video('DDDDDDDDDDD')]);
  assert.equal(row(db, 'SELECT count(*) n FROM video').n, 4);
  // Edits as the admin makes them (src/admin.js): values plus manual_field rows.
  db.raw.exec(`
    UPDATE video SET stars = 5, editors_pick = 1, editor_note = 'Top', hidden = 1, place = 'Passo dello Stelvio', lat = 46.53, lon = 10.45, position_exact = 1
      WHERE video_id = 'AAAAAAAAAAA';
    INSERT INTO manual_field (video_id, field) VALUES ('AAAAAAAAAAA', 'place'), ('AAAAAAAAAAA', 'lat'), ('AAAAAAAAAAA', 'lon'), ('AAAAAAAAAAA', 'position_exact');
    UPDATE route SET polyline = '[[1,1],[2,2]]', method = 'manual_osrm' WHERE video_id = 'AAAAAAAAAAA';
    INSERT INTO manual_field (video_id, field) VALUES ('AAAAAAAAAAA', 'route');
    UPDATE localization SET loc_level = 2, loc_key = 'anchored', method = 'anchors_manual' WHERE video_id = 'AAAAAAAAAAA';
    INSERT INTO manual_field (video_id, field) VALUES ('AAAAAAAAAAA', 'localization');
    INSERT INTO sync_anchor (video_id, video_t_s, lon, lat, source) VALUES ('AAAAAAAAAAA', 12, 10.4, 46.5, 'manual');
    DELETE FROM route_road WHERE video_id = 'BBBBBBBBBBB'; DELETE FROM route WHERE video_id = 'BBBBBBBBBBB';
    INSERT INTO manual_field (video_id, field) VALUES ('BBBBBBBBBBB', 'route');
    UPDATE localization SET loc_level = 1, loc_key = 'verified', verified_at = '2026-11-18' WHERE video_id = 'CCCCCCCCCCC';
  `);
  // The pipeline changes place, pin, route and level of every video.
  const changed = (id) => video(id, { place: 'Neu', lat: 47, lon: 11, region: 'Italy', localization: { level: 5, key: 'route_rough', rules_version: 1 },
    route: { ...video(id).route, method: 'routed_mymaps', line: [[47, 11], [47.1, 11.1]], distance_km: 33 } });
  run(db, ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC', 'DDDDDDDDDDD'].map(changed));

  const a = row(db, "SELECT * FROM video WHERE video_id = 'AAAAAAAAAAA'");
  assert.equal(a.place, 'Passo dello Stelvio');
  assert.equal(a.lat, 46.53);
  assert.equal(a.lon, 10.45);
  assert.equal(a.region, 'Italy', 'region is not manual here, so the pipeline value comes through');
  assert.deepEqual([a.stars, a.editors_pick, a.editor_note, a.hidden], [5, 1, 'Top', 1]);
  assert.equal(row(db, "SELECT method FROM route WHERE video_id = 'AAAAAAAAAAA'").method, 'manual_osrm');
  assert.equal(row(db, "SELECT loc_level FROM localization WHERE video_id = 'AAAAAAAAAAA'").loc_level, 2);
  assert.equal(row(db, "SELECT count(*) n FROM sync_anchor WHERE video_id = 'AAAAAAAAAAA'").n, 1);
  // Discarded route stays discarded (no row, no road shares).
  assert.equal(row(db, "SELECT count(*) n FROM route WHERE video_id = 'BBBBBBBBBBB'").n, 0);
  assert.equal(row(db, "SELECT count(*) n FROM route_road WHERE video_id = 'BBBBBBBBBBB'").n, 0);
  // Verified stays verified.
  assert.equal(row(db, "SELECT loc_level FROM localization WHERE video_id = 'CCCCCCCCCCC'").loc_level, 1);
  // Without manual fields everything follows the pipeline.
  const d = row(db, "SELECT v.place, v.lat, r.method, l.loc_level FROM video v JOIN route r USING (video_id) JOIN localization l USING (video_id) WHERE video_id = 'DDDDDDDDDDD'");
  assert.deepEqual({ ...d }, { place: 'Neu', lat: 47, method: 'routed_mymaps', loc_level: 5 });
  assert.equal(row(db, "SELECT count(*) n FROM video_fts WHERE video_fts MATCH 'Stelvio'").n, 1);
});

test('import removes videos that left the export, including their anchors (foreign keys), but keeps the edit log', () => {
  const db = makeD1();
  run(db, [video('AAAAAAAAAAA'), video('BBBBBBBBBBB')]);
  db.raw.exec(`INSERT INTO sync_anchor VALUES ('BBBBBBBBBBB', 5, 10, 46, 'manual');
    INSERT INTO localization_log VALUES ('BBBBBBBBBBB', 'now', 4, 3, 'anchors_added');
    INSERT INTO edit_log (video_id, entity, field, who, at) VALUES ('BBBBBBBBBBB', 'anchor', '5', 'a@b', 'now');`);
  run(db, [video('AAAAAAAAAAA')]);
  assert.equal(row(db, "SELECT count(*) n FROM video WHERE video_id = 'BBBBBBBBBBB'").n, 0);
  assert.equal(row(db, 'SELECT count(*) n FROM edit_log').n, 1);
});

test('every manual video column is protected', () => {
  assert.deepEqual(MANUAL_VIDEO_COLS, ['place', 'region', 'lat', 'lon', 'position_exact', 'country', 'country_name']);
  const db = makeD1();
  run(db, [video('AAAAAAAAAAA')]);
  db.raw.exec(`UPDATE video SET region = 'X', country = 'CH', country_name = 'Schweiz' WHERE video_id = 'AAAAAAAAAAA';
    INSERT INTO manual_field (video_id, field) VALUES ('AAAAAAAAAAA', 'region'), ('AAAAAAAAAAA', 'country'), ('AAAAAAAAAAA', 'country_name');`);
  run(db, [video('AAAAAAAAAAA', { region: 'Y', country: 'AT', country_name: 'Österreich' })]);
  const a = row(db, "SELECT region, country, country_name FROM video WHERE video_id = 'AAAAAAAAAAA'");
  assert.deepEqual({ ...a }, { region: 'X', country: 'CH', country_name: 'Schweiz' });
});
