<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0097: The Route Map with MapLibre GL and OpenFreeMap Tiles

Status: accepted on 2026-11-15, for the route box of the gauge HUD (`route-box.feature`); the maintainer asked for a real map with network access.

## Context

The route box at the top right of a ride shows the route's map first, tilted a little. Until now it drew only the GPX track on a dark grid. A map with roads, places and terrain needs map data and a renderer. ridrs ships no map data: OpenStreetMap's data is under the ODbL (LICENSING.md, section 6a), and a planet's tiles are far too large to bundle. A tilted map is a perspective camera over the ground, which raster tiles under a CSS transform only imitate (labels lean and blur).

## Decision

- **`maplibre-gl` 6.16.0** (BSD-3-Clause; pure JS, ESM, WebGL) draws the map in the route box with a pitch of about 50°, the camera on the rider and turned to the direction of travel (toward the track 50 m ahead, short enough that a hairpin does not turn the map across the road too early); before the first position the camera stands at the start, facing the way the route begins. The track, the part ridden and the rider are layers of the map (GeoJSON), so they tilt with it. Its dependencies are MIT, ISC and BSD licensed; the licenses screen lists them (ADR 0073).
- **OpenFreeMap** (tiles.openfreemap.org, style `fiord`: dark blue like the ride cards; `dark` was too dark to read during a ride) serves the vector tiles, fonts and sprites: free, with no API key, no registration and no cookies, from OpenStreetMap data through OpenMapTiles. ridrs fetches the tiles at run time and stores none; the box shows the attribution the style asks for: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".
- The library loads only where it can draw: the box imports it lazily once WebGL is there. Without WebGL (the headless UI scenarios), or when the style cannot be loaded (offline), the box draws the track alone as before.
- The native app's CSP allows `https://tiles.openfreemap.org` for `connect-src` and `img-src`, and `blob:` for `worker-src` (MapLibre's worker).
- Rejected: Leaflet with raster tiles under a CSS tilt (the tilt distorts labels; OpenStreetMap's own tile servers do not allow use by apps); a commercial provider with an API key (an account per rider or a shared key in the source); shipping tiles (size, ODbL).

## Consequences

- During a ride on a route the app asks OpenFreeMap for the tiles around the rider: OpenFreeMap sees the device's IP address and the region ridden. Nothing else is sent.
- Offline, or when OpenFreeMap is down, the box falls back to the track alone; the ride is not affected.
- The map adds about 1 MB to the native bundle, in a chunk of its own that loads with the first route box.
- The headless scenarios check the fallback; the map itself is checked by hand in the app.
