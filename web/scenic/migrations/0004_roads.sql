-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Road class and surface per route (CLOUDFLARE-KONZEPT.md 2.4 route_road), from scripts/road_attrs.py:
-- the OSM edges the route lies on, via Valhalla trace_attributes. Shares of the route length.
CREATE TABLE route_road (
  video_id  TEXT REFERENCES video,
  dim       TEXT,          -- class | surface
  value     TEXT,          -- class: motorway | trunk | primary | secondary | minor | residential | track | path
                           -- surface: asphalt | paved_other | gravel | unpaved | unknown
  share     REAL,
  source    TEXT,          -- valhalla_osm
  PRIMARY KEY (video_id, dim, value)
);
ALTER TABLE route ADD COLUMN main_road_class TEXT;
ALTER TABLE route ADD COLUMN unpaved_share REAL;
ALTER TABLE route ADD COLUMN tunnel_km REAL;
ALTER TABLE route ADD COLUMN bridge_km REAL;
