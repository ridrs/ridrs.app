-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Route editor (admin, src/tracks.js and site/admin/route-editor.js): the elevation profile of a route uploaded as GPX, and which
-- video plays along it from where, so the whole route can later be played with a fitting video at every point.

-- [[km, ele], …], at most 1000 points; km along the stored (simplified) line, as site/lib/route-sync.js kmAlong measures it.
ALTER TABLE track ADD COLUMN profile TEXT;
ALTER TABLE track ADD COLUMN ele_source TEXT;   -- gpx (the uploaded file's <ele>) | open_meteo (looked up for files without heights)

-- A video holds from from_km to the next row's from_km (or the route's end); video_id null = no video from here.
-- t_from_s / t_to_s: the video seconds at both ends, when the video has a synced track (route_sync), else null.
-- No foreign key to video: the import deletes videos that left the export, and an assignment must not block that.
CREATE TABLE track_video (
  track_id    INTEGER NOT NULL REFERENCES track(track_id) ON DELETE CASCADE,
  from_km     REAL NOT NULL,
  video_id    TEXT,
  t_from_s    REAL,
  t_to_s      REAL,
  PRIMARY KEY (track_id, from_km)
);
CREATE INDEX track_video_video ON track_video(video_id);
