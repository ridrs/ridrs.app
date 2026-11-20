-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Phase 4 "Redaktion" (CLOUDFLARE-KONZEPT.md 3.5, 2.5, 2.7, 2.8, 2.9).
-- New tables carry no FOREIGN KEY on purpose: D1 enforces foreign keys, and the import deletes videos
-- that left the export; manual data (log, provenance, collections, images) must not block that.

-- Every admin write (concept 3.5). old/new are JSON. Undo writes a new row with undo_of and sets undone_by
-- on the original. old_manual = whether the field was manual (manual_field) before the edit.
CREATE TABLE edit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id    TEXT,                 -- null for collection- or channel-level edits
  entity      TEXT NOT NULL,        -- video | route | anchor | localization | collection | collection_item | optout | image
  field       TEXT NOT NULL,
  old         TEXT,
  new         TEXT,
  old_manual  INTEGER,
  who         TEXT NOT NULL,        -- Cloudflare Access e-mail
  at          TEXT NOT NULL,
  undo_of     INTEGER,
  undone_by   INTEGER
);
CREATE INDEX edit_log_video ON edit_log(video_id, id);

-- Per-field provenance: a row here means "set by hand, the import must not overwrite it".
-- field is a video column (place, region, lat, lon, position_exact, country, country_name), or
-- route | localization | sync for the whole route, localization or sync row of the video.
CREATE TABLE manual_field (
  video_id  TEXT NOT NULL,
  field     TEXT NOT NULL,
  who       TEXT,
  at        TEXT,
  PRIMARY KEY (video_id, field)
);

-- Time-synced tracks computed in the worker from manual anchors (concept 2.7), served as /api/sync/<id>.json.
-- Pipeline tracks (video2gpx) stay static assets (sync/<id>.json).
CREATE TABLE sync_track (
  video_id  TEXT PRIMARY KEY,
  json      TEXT NOT NULL,          -- {"v":1,"t":[…],"c":[[lon,lat]…],"e":[…]}
  hash      TEXT,
  built_at  TEXT
);

-- Manual route: the via points the editor set (start, via …, end) as JSON [[lon, lat], …].
ALTER TABLE route ADD COLUMN manual_via TEXT;

-- Editorial lists (concept 2.8).
CREATE TABLE collection (
  collection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  position      INTEGER DEFAULT 0,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE TABLE collection_item (
  collection_id INTEGER NOT NULL,
  video_id      TEXT NOT NULL,
  position      INTEGER NOT NULL,
  note          TEXT,
  PRIMARY KEY (collection_id, video_id)
);
CREATE INDEX collection_item_video ON collection_item(video_id);

-- Preview images (concept 2.9); the original lives in R2 (binding IMAGES) under r2_key.
CREATE TABLE video_image (
  image_id     TEXT PRIMARY KEY,    -- content hash (sha-256, 24 hex)
  video_id     TEXT NOT NULL,
  kind         TEXT,                -- upload | generated | map | frame_own
  r2_key       TEXT,
  mime         TEXT,
  bytes        INTEGER,
  width        INTEGER, height INTEGER,
  rights       TEXT,                -- own | cc0 | cc_by | licensed
  credit       TEXT,
  uploaded_by  TEXT,
  uploaded_at  TEXT,
  is_primary   INTEGER DEFAULT 0
);
CREATE INDEX video_image_video ON video_image(video_id);
