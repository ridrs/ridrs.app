-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Wishlist for video2gpx (src/wishlist.js): visitors ask on the public site that a video gets a precise track; the editors
-- see the wishes in the admin and work them off as a queue (tab „Warteschlange“, GET /api/admin/queue).
-- No FOREIGN KEY, as in 0005: the import deletes videos that left the export, and a wish must not block that.

-- One row per wished video. votes = how many visitors asked (one per visitor and day); an editor can also queue a video
-- without votes. priority: set by „nach oben“, smaller first, NULL = by votes. status: open | done | dismissed;
-- a video whose track video2gpx secured (route_sync.method = 'video2gpx' or level <= 2) counts as done without a status change.
CREATE TABLE wish (
  video_id   TEXT PRIMARY KEY,
  votes      INTEGER NOT NULL DEFAULT 0,
  first_at   TEXT NOT NULL,
  last_at    TEXT,
  priority   INTEGER,
  status     TEXT NOT NULL DEFAULT 'open',
  status_by  TEXT,
  status_at  TEXT
);
CREATE INDEX wish_status ON wish(status, priority, votes);

-- Today's votes only, to count a visitor once per video and day and to cap the wishes per visitor and day.
-- voter = SHA-256 of day, IP address and the secret WISH_SALT, shortened; no IP address is stored. Rows of earlier
-- days are deleted with the next vote.
CREATE TABLE wish_vote (
  video_id  TEXT NOT NULL,
  voter     TEXT NOT NULL,
  day       TEXT NOT NULL,
  PRIMARY KEY (video_id, voter)
);
CREATE INDEX wish_vote_voter ON wish_vote(voter);
CREATE INDEX wish_vote_day ON wish_vote(day);
