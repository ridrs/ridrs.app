-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Country per video (FILTER-PLAN.md): ISO 3166-1 alpha-2 from point in polygon of lat/lon against
-- Natural Earth admin-0 (data/geo/countries.geojson of the pipeline, public domain), set by scripts/export_public.py.
-- Null for points at sea more than 25 km from any country. The German name travels in country_name.
ALTER TABLE video ADD COLUMN country TEXT;
ALTER TABLE video ADD COLUMN country_name TEXT;
CREATE INDEX video_country ON video(country);
