// SPDX-License-Identifier: AGPL-3.0-or-later
// Rows of the full-text index (video_fts): title, place, region and the channel, or for a source with one author
// (Van Gestel, migrations/0007) that author. Shared by the import (scripts/lib/import-sql.mjs), the admin and the YouTube refresh.
export const FTS_INSERT = `INSERT INTO video_fts (video_id, title, place, region, channel) SELECT v.video_id, v.title, v.place, v.region, COALESCE(c.name, s.author)
  FROM video v LEFT JOIN channel c ON c.channel_id = v.channel_id LEFT JOIN source s ON s.source_id = v.source`;
