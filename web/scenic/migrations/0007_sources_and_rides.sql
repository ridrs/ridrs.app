-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Sources and ride packages: ridrs Scenic lists videos of more than YouTube. The rides of Fred Van Gestel
-- (cycling.vangestel.online, catalog of ridrs_app scripts/fetch-video-catalog.ts in <pipeline>/vangestel) come with a
-- package to ride them in the ridrs app; the app reads them from GET /api/ride/v1/catalog.json
-- (ridrs_app docs/formats/scenic-ride-catalog-v1.md).

-- Who made the videos of a source and under which license; shown with every entry of the source.
CREATE TABLE source (
  source_id     TEXT PRIMARY KEY,   -- youtube | vangestel
  name          TEXT NOT NULL,
  author        TEXT,               -- one author for the whole source; YouTube has channels instead
  url           TEXT,
  license_id    TEXT,               -- SPDX id
  license_name  TEXT,
  license_url   TEXT
);
INSERT INTO source (source_id, name, url) VALUES ('youtube', 'YouTube', 'https://www.youtube.com/');

-- Every existing video is a YouTube video. Ids of other sources carry a prefix (vg-<slug>).
-- (SQLite allows no REFERENCES on a column added with a non-null default; the import writes known sources only.)
ALTER TABLE video ADD COLUMN source TEXT NOT NULL DEFAULT 'youtube';
CREATE INDEX video_source ON video(source);

-- A video that the ridrs app can ride: the package with its video at its source, what the app's cards show, and the
-- files of the package without its video (ADR 0095) and its overlay (ADR 0094), which the build ships as vg/<slug>/….
CREATE TABLE ride_package (
  video_id         TEXT PRIMARY KEY REFERENCES video,
  page_url         TEXT,           -- the route's page at its source
  download_url     TEXT NOT NULL,
  download_format  TEXT NOT NULL,  -- incyclist-gpx-import
  download_size    INTEGER NOT NULL,
  download_etag    TEXT,
  tour_name        TEXT,
  tour_part        INTEGER,
  level            TEXT,           -- the source's difficulty: Easy | Moderate | Hard
  track_type       TEXT,
  bike_type        TEXT,
  distance_m       REAL NOT NULL,  -- as the source's track measures it; the route row may be re-routed in the admin
  ascent_m         REAL NOT NULL,
  sparkline        TEXT NOT NULL,  -- JSON [m, …], evenly spaced from start to end
  climbs           TEXT,           -- JSON [{category, start, end, gain, grade, summit, name?}, …] (ADR 0070)
  thumbnail        TEXT,           -- JSON {path, size, sha256}: vg/<slug>/thumbnail.jpg
  overlay          TEXT,           -- JSON [{path, size, sha256}, …]: vg/<slug>/overlay/<path>
  package          TEXT NOT NULL,  -- JSON [{path, size, sha256}, …]: vg/<slug>/package/<path>
  built_at         TEXT
);
