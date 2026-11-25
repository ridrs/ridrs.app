-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Routes the editors upload as GPX in the admin (tab „Routen“, src/tracks.js), not tied to a video: e.g. a planned ride or a
-- classic climb. The public map draws the published ones in their own colour above the video lines (GET /api/tracks).
-- Named track, because the table route already holds the route of a video.
CREATE TABLE track (
  track_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  color        TEXT NOT NULL,          -- #rrggbb
  published    INTEGER NOT NULL DEFAULT 0,
  line         TEXT NOT NULL,          -- JSON [[lon, lat], …], 5 decimals, simplified to at most MAX_POINTS (src/tracks.js)
  distance_km  REAL,
  points_in    INTEGER,                -- track points in the uploaded GPX, before simplification
  file_name    TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX track_published ON track(published);
