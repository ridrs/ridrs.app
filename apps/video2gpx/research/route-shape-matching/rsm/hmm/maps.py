# SPDX-License-Identifier: AGPL-3.0-or-later
"""Foreign maps for the decoys: same road classes and the same pipeline as rsm.track2.graphs.load_graph, other places of the same Rhone-Alpes extract
that do not overlap the areas of Grimone / Roanne / Rousset (lon 4.97-5.99, lat 44.45-45.15)."""
from __future__ import annotations

import math
import time
from pathlib import Path

from rsm.network.graph import NetGraph, build
from rsm.network.pbf import read_subset
from rsm.quanta import area as qarea

WORK = Path(__file__).resolve().parents[2] / "work" / "fable3"
FOREIGN = {"savoie": (45.40, 6.55), "loire": (45.75, 4.15), "ardeche": (44.75, 4.30)}
R_FOREIGN = 34_300.0


def bbox(lat, lon, R):
    dlat = math.degrees(R / 6371008.8)
    dlon = dlat / math.cos(math.radians(lat))
    return dict(north=lat + dlat, south=lat - dlat, east=lon + dlon, west=lon - dlon)


def load_foreign(name: str, log=print) -> NetGraph:
    f = WORK / "cache" / f"graph_foreign_{name}.npz"
    (WORK / "cache").mkdir(parents=True, exist_ok=True)
    if f.exists():
        return NetGraph.load(f)
    import osmnx as ox
    from osmnx import graph as oxg
    lat, lon = FOREIGN[name]
    t0 = time.time()
    resp = read_subset(qarea.PBF, bbox(lat, lon, R_FOREIGN), WORK / "cache" / f"pbf_subset_foreign_{name}.json")
    log(f"  foreign {name}: PBF subset {resp['source']['ways']} ways in {time.time()-t0:.0f}s")
    G = oxg._create_graph([resp], bidirectional=False)
    G = ox.distance.add_edge_lengths(G) if "length" not in next(iter(G.edges(data=True)))[2] else G
    G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
    g = build(ox.project_graph(G))
    g.save(f)
    log(f"  foreign {name}: {g.n_nodes} nodes {g.n_edges} edges {g.edge_len.sum()/1000:.0f} directed km in {time.time()-t0:.0f}s")
    return g


if __name__ == "__main__":
    for n in FOREIGN:
        load_foreign(n)


def edges_in_box(g: NetGraph, name: str, half_width_m: float):
    """edges of the foreign graph whose midpoint lies within a square of the given half width around the foreign centre (same area as the video's own)"""
    import numpy as np
    from pyproj import Transformer
    lat, lon = FOREIGN[name]
    cx, cy = Transformer.from_crs(4326, g.crs, always_xy=True).transform(lon, lat)
    mid = np.array([g.geom(e)[len(g.geom(e)) // 2] for e in range(g.n_edges)])
    return np.flatnonzero((np.abs(mid[:, 0] - cx) <= half_width_m) & (np.abs(mid[:, 1] - cy) <= half_width_m))
