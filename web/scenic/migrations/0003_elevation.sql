-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Elevation per route (CLOUDFLARE-KONZEPT.md 2.4), from scripts/elevation.py: Copernicus DEM GLO-30 sampled
-- every 30 m along the OSM route, median over 150 m, tunnels and bridges bridged, ascent with 3 m hysteresis.
ALTER TABLE route ADD COLUMN ascent_m INTEGER;
ALTER TABLE route ADD COLUMN descent_m INTEGER;
ALTER TABLE route ADD COLUMN min_ele_m INTEGER;
ALTER TABLE route ADD COLUMN max_ele_m INTEGER;
ALTER TABLE route ADD COLUMN max_gradient REAL;   -- % over 200 m
ALTER TABLE route ADD COLUMN profile TEXT;        -- JSON [[km, ele], …], at most 200 points
ALTER TABLE route ADD COLUMN ele_source TEXT;     -- copernicus_glo30
