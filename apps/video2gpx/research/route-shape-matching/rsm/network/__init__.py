# SPDX-License-Identifier: AGPL-3.0-or-later
"""OSM adapter (Phase 3 proof of concept): area from a video name, road network, candidate paths, turn sequences.

May import osmnx, networkx, pyproj, geopandas (requirements-osm.txt). `rsm.core` must never import this package.
All OSM-derived data stays under work/osm/ (git-ignored; ODbL, experiment-internal). (c) OpenStreetMap contributors.
Entry points: python -m rsm.network.area | graph | enumerate | analyze  (see work/osm/RESULTS.md).
"""
