-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-off start set (migrations/0006_site_published.sql): publish every video at Lokalisierungsstufe 1 or 2 (video2gpx).
-- Run once after the first import into an empty database: pnpm publish:initial (local) or pnpm publish:initial --remote.
UPDATE video SET site_published = 1
  WHERE hidden = 0 AND video_id IN (SELECT video_id FROM localization WHERE loc_level <= 2);
-- And every Van Gestel ride (migrations/0007): its creator's track at level 3, rideable in the ridrs app.
-- For a database that had videos before the rides came, scripts/publish-vangestel.sql does this part alone.
UPDATE video SET site_published = 1 WHERE hidden = 0 AND source = 'vangestel';
