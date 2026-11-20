-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ridrs Scenic, phase 1 schema (CLOUDFLARE-KONZEPT.md, section 2).
-- Pipeline fields are overwritten by every import; editorial fields (stars, editor_note, editors_pick,
-- hidden) and manual provenance are never touched by the import (scripts/import.mjs).
-- Places/areas (2.4), classification (2.3) and editorial tables come with later migrations.

CREATE TABLE channel (
  channel_id      TEXT PRIMARY KEY,
  name            TEXT,              -- YouTube API, 30-day refresh
  country         TEXT,              -- YouTube API snippet.country
  api_fetched_at  TEXT
);

CREATE TABLE channel_optout (
  channel_id  TEXT PRIMARY KEY,
  requested_at TEXT,
  note        TEXT
);

CREATE TABLE video (
  video_id        TEXT PRIMARY KEY,
  channel_id      TEXT REFERENCES channel,
  -- YouTube API (30-day refresh, worker cron)
  title           TEXT,
  published_at    TEXT,
  duration_s      INTEGER,
  view_count      INTEGER,
  like_count      INTEGER,
  definition      TEXT,
  projection      TEXT,              -- rectangular | 360
  embeddable      INTEGER,
  region_blocked  TEXT,              -- JSON list of ISO codes
  region_allowed  TEXT,
  audio_language  TEXT,
  status          TEXT,              -- public | removed | private | unlisted
  api_fetched_at  TEXT,
  -- Pipeline (own data)
  region          TEXT,              -- macro region (Alps, Southern France …)
  place           TEXT,
  lat             REAL,
  lon             REAL,
  position_exact  INTEGER,
  footage         TEXT DEFAULT 'real', -- real | simulator | game
  footage_source  TEXT,
  vehicle         TEXT,
  topics          TEXT,              -- JSON list
  -- Editorial (never overwritten by the import)
  stars           INTEGER CHECK (stars BETWEEN 1 AND 5),
  editor_note     TEXT,
  editors_pick    INTEGER DEFAULT 0,
  hidden          INTEGER DEFAULT 0,
  added_at        TEXT,
  updated_at      TEXT
);
CREATE INDEX video_region ON video(region);
CREATE INDEX video_views ON video(view_count DESC);

CREATE TABLE video_tech (
  video_id      TEXT PRIMARY KEY REFERENCES video,
  max_height    INTEGER,
  max_width     INTEGER,
  fps           REAL,
  hdr           INTEGER,
  codecs        TEXT,              -- JSON list
  bitrate_kbps  INTEGER,
  aspect        REAL,
  source        TEXT,              -- ytdlp | title | manual
  checked_at    TEXT
);

CREATE TABLE route (
  video_id        TEXT PRIMARY KEY REFERENCES video,
  distance_km     REAL,
  method          TEXT,            -- osrm_waypoints | mapmatched_komoot | routed_mymaps …
  polyline        TEXT,            -- JSON [[lat, lon], …], ~150 points, for map and preview
  gpx_path        TEXT,            -- path of the static GPX asset (gpx/<id>.gpx)
  creator_links   TEXT,            -- JSON list, links only
  check_status    TEXT,            -- ok | warn | fixed | note
  check_note      TEXT,
  built_at        TEXT
);

CREATE TABLE route_sync (
  video_id   TEXT PRIMARY KEY REFERENCES video,
  method     TEXT,                 -- video2gpx | anchors | chapters | speed_model
  t_start_s  INTEGER,
  t_end_s    INTEGER,
  path       TEXT,                 -- static asset sync/<id>.json
  hash       TEXT,
  built_at   TEXT
);

CREATE TABLE sync_anchor (
  video_id  TEXT REFERENCES video,
  video_t_s REAL,
  lon REAL, lat REAL,
  source    TEXT,                  -- manual | chapter | sign_ocr | video2gpx
  PRIMARY KEY (video_id, video_t_s)
);

-- Track accuracy (Lokalisierungsstufe, concept 2.5). 1 = best (verified) … 7 = region only.
CREATE TABLE localization (
  video_id         TEXT PRIMARY KEY REFERENCES video,
  loc_level        INTEGER NOT NULL,
  loc_key          TEXT NOT NULL,   -- verified | anchored | estimated | route | route_rough | point | region
  method           TEXT,
  err_along_med_m  REAL,
  err_along_max_m  REAL,
  err_cross_med_m  REAL,
  anchor_count     INTEGER,
  anchors_manual   INTEGER,
  verified_by      TEXT,
  verified_at      TEXT,
  verified_hash    TEXT,
  check_points     TEXT,
  gates            TEXT,
  rules_version    INTEGER,
  updated_at       TEXT
);
CREATE INDEX localization_level ON localization(loc_level);

CREATE TABLE localization_log (
  video_id   TEXT REFERENCES video,
  at         TEXT,
  from_level INTEGER,
  to_level   INTEGER,
  reason     TEXT,
  PRIMARY KEY (video_id, at)
);

CREATE TABLE import_run (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT,
  source    TEXT,
  videos    INTEGER,
  routes    INTEGER,
  note      TEXT
);

-- Full-text search over title, place, region, channel (rebuilt by the import and the API refresh).
CREATE VIRTUAL TABLE video_fts USING fts5(video_id UNINDEXED, title, place, region, channel, tokenize = 'unicode61 remove_diacritics 2');
