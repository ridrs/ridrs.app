-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Publication on ridrs Scenic: the public site shows a video (point, route line, GPX, sync track, API) only when the
-- editors set site_published in the admin. New videos from the import start unpublished (DEFAULT 0); the import
-- never writes this column. Not to be confused with published_at, the YouTube upload date.
ALTER TABLE video ADD COLUMN site_published INTEGER NOT NULL DEFAULT 0;
CREATE INDEX video_site_published ON video(site_published);
-- Start: publish the videos whose track video2gpx secured (Lokalisierungsstufe 2, and 1 = verified on top of it).
-- scripts/publish-initial.sql repeats this for a database that is filled only after the migration (first deploy).
UPDATE video SET site_published = 1
  WHERE hidden = 0 AND video_id IN (SELECT video_id FROM localization WHERE loc_level <= 2);
