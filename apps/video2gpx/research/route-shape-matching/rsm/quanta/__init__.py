# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn-quanta matching of video turn sequences against OSM turn sequences, scored with GPS ground truth (experiment code).

A quantum is turn, straight, turn: sign and angle of both turns and scale-free length ratios. May import osmnx, pyproj, osmium
(requirements-osm.txt). rsm.core / rsm.odometry / rsm.network are used unchanged. GPS is for scoring and for the GPS upper bound only.
All derived data stays under work/quanta/ (git-ignored). (c) OpenStreetMap contributors, ODbL. GPX: CC BY-NC-SA 4.0 (Van Gestel).
"""
