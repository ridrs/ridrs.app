# SPDX-License-Identifier: AGPL-3.0-or-later
"""Search area and road graph per video, no GPS involved.

AREA RULE (fixed a priori, before any GPS check):
  centre  = Nominatim top hit for a place name derived from the video name (route.json title or a landmark of its notes when the plain
            name is ambiguous; the query used is recorded in the answer cache work/quanta/cache/geocode and never re-requested);
  R       = min(L_vms, R_CAP), L_vms = usable nominal vms length of the video (frozen refined configuration, i.e. what the video itself says
            about its length; the proposal's 2 x L is far too large for the 49 km Rousset video), R_CAP = 20 km;
  area    = square of half-width R around the centre (bbox filter on the PBF: a way is kept if any node is inside, full geometry kept).
Why a cap: map legs are enumerated for every walk in the area, so cost grows with the road length; 20 km half-width is about 1600 km2 and
already covers the 20-26 km routes under the assumption that the named place lies within 20 km of every point of the route.
For a route longer than the area (Rousset) only the inside part is scored.
"""
from __future__ import annotations

import json
import os
import math
import time
from pathlib import Path

import numpy as np

from rsm.network.area import geocode
from rsm.network.graph import NetGraph, build
from rsm.network.pbf import read_subset

WORK = Path(__file__).resolve().parents[2] / "work" / "quanta"
PBF = Path(os.environ.get("RSM_OSM_DIR", "~/rsm-data/osm")).expanduser() / "rhone-alpes.osm.pbf"  # read-only, in place
R_CAP = 20_000.0
QUERIES = {  # a priori; Roanne: the plain name "Vallée de Roanne" geocodes to Roanne (Loire), see RESULTS.md; the notes name a landmark
    "col-de-grimone-1": "Col de Grimone, France",
    "vallee-de-roanne": "Pont d'Espenel, France",
    "col-de-rousset": "Col de Rousset, France",
}


def area_for(video: str, l_vms: float) -> dict:
    q = QUERIES[video]
    rec = geocode(q, cache_dir=WORK / "cache" / "geocode")
    if not rec["results"]:
        raise RuntimeError(f"no Nominatim result for {q}")
    top = rec["results"][0]
    lat, lon = float(top["lat"]), float(top["lon"])
    R = min(l_vms, R_CAP)
    dlat = math.degrees(R / 6371008.8)
    dlon = dlat / math.cos(math.radians(lat))
    return dict(video=video, query=q, centre=dict(lat=lat, lon=lon, display_name=top.get("display_name")), l_vms_m=l_vms, radius_m=R,
                bbox=dict(north=lat + dlat, south=lat - dlat, east=lon + dlon, west=lon - dlon), area_km2=(2 * R / 1000) ** 2)


def build_graph(area: dict, log=print) -> NetGraph:
    """PBF subset -> osmnx graph (same pipeline as rsm.network.graph.from_pbf, cache under work/quanta) -> projected NetGraph."""
    import osmnx as ox
    from osmnx import graph as oxg
    f = WORK / "cache" / f"graph_{area['video']}.npz"
    if f.exists():
        return NetGraph.load(f)
    t0 = time.time()
    resp = read_subset(PBF, area["bbox"], WORK / "cache" / f"pbf_subset_{area['video']}.json")
    log(f"  PBF subset {resp['source']['ways']} ways in {time.time()-t0:.0f}s")
    G = oxg._create_graph([resp], bidirectional=False)
    G = ox.distance.add_edge_lengths(G) if "length" not in next(iter(G.edges(data=True)))[2] else G
    G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
    g = build(ox.project_graph(G))
    g.save(f)
    log(f"  graph {g.n_nodes} nodes {g.n_edges} edges {g.edge_len.sum()/1000:.0f} directed km in {time.time()-t0:.0f}s")
    return g


def inside(area: dict, xy: np.ndarray, crs: str) -> np.ndarray:
    """Is each projected point inside the area's bbox."""
    from pyproj import Transformer
    lon, lat = Transformer.from_crs(crs, 4326, always_xy=True).transform(xy[:, 0], xy[:, 1])
    b = area["bbox"]
    return (np.asarray(lat) >= b["south"]) & (np.asarray(lat) <= b["north"]) & (np.asarray(lon) >= b["west"]) & (np.asarray(lon) <= b["east"])
