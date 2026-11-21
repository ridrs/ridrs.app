-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-off start set of the Van Gestel rides (migrations/0007_sources_and_rides.sql): publish every one of them, once, after
-- the first import that brings them into a database that already holds videos: pnpm publish:vangestel [--remote].
-- (On an empty database scripts/publish-initial.sql does it together with the start set of the YouTube videos.)
UPDATE video SET site_published = 1 WHERE hidden = 0 AND source = 'vangestel';
