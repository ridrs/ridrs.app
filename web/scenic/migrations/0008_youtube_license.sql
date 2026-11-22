-- SPDX-License-Identifier: AGPL-3.0-or-later
-- YouTube videos in the ride catalog of the ridrs app (ridrs_app ADR 0105): each names its channel as its author; the
-- source names the license every YouTube video comes under unless its creator chose Creative Commons.
UPDATE source SET license_name = 'Standard YouTube License', license_url = 'https://www.youtube.com/t/terms'
  WHERE source_id = 'youtube';
