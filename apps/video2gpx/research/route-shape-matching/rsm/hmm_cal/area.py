# SPDX-License-Identifier: AGPL-3.0-or-later
"""Amalfi calibration study (post hoc): a-priori corridor "Amalfi Coast" from the NAME only (bbox lon 14.30-14.80, lat 40.55-40.72: Vietri sul Mare,
the whole Amalfi Coast, Positano, and the Sorrento-side connection), classified roads only (motorway ... unclassified plus links).
Also foreign boxes of the same size (km) from the same `sud` extract for the decoys, and the memory plan (states x steps) that runs BEFORE any allocation."""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np

from rsm.network import pbf as pbfmod
from rsm.network.graph import NetGraph, build
from rsm.network.pbf import read_subset
from rsm.nogps import cfg as ncfg

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "amalfi_cal"
CACHE = WORK / "cache"
PBF = ncfg.PBF
AMALFI_BBOX = dict(west=14.30, east=14.80, south=40.55, north=40.72)
ROAD_HIGHWAYS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified"}
CLASSES = tuple(sorted(ROAD_HIGHWAYS))
# foreign boxes (centre lat, lon) in the same sud extract; same size in km as the Amalfi box. Candidates chosen from geography only, then the 3 of closest density are used.
FOREIGN = {"cilento": (40.20, 15.10), "maratea": (39.95, 15.75), "irpinia": (40.90, 15.10), "matera": (40.60, 16.60), "gargano": (41.85, 16.05), "abruzzo": (42.35, 14.05), "salento": (40.15, 18.00)}
GB_CAP = 4.0


def km_dims(b: dict = AMALFI_BBOX) -> tuple[float, float]:
    lat = 0.5 * (b["north"] + b["south"])
    return (b["east"] - b["west"]) * 111.195 * math.cos(math.radians(lat)), (b["north"] - b["south"]) * 111.195


def foreign_bbox(lat: float, lon: float) -> dict:
    w, h = km_dims()
    dlat = h / 2 / 111.195
    dlon = w / 2 / (111.195 * math.cos(math.radians(lat)))
    return dict(west=lon - dlon, east=lon + dlon, south=lat - dlat, north=lat + dlat)


def build_graph(bbox: dict, tag: str, log=print) -> NetGraph:
    import osmnx as ox
    from osmnx import graph as oxg
    f = CACHE / f"graph_{tag}.npz"
    if f.exists():
        return NetGraph.load(f)
    CACHE.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    pbfmod.ROAD_HIGHWAYS = ROAD_HIGHWAYS  # read_subset looks the set up at call time
    resp = read_subset(PBF, bbox, CACHE / f"pbf_subset_{tag}.json")
    log(f"  {tag}: PBF subset {resp['source']['ways']} ways in {time.time()-t0:.0f}s")
    G = oxg._create_graph([resp], bidirectional=False)
    G = ox.distance.add_edge_lengths(G) if "length" not in next(iter(G.edges(data=True)))[2] else G
    G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
    g = build(ox.project_graph(G))
    g.save(f)
    log(f"  {tag}: graph {g.n_nodes} nodes {g.n_edges} edges {g.edge_len.sum()/1000:.0f} directed km in {time.time()-t0:.0f}s")
    return g


def edges_in_bbox(g: NetGraph, bbox: dict) -> np.ndarray:
    """edges whose geometry midpoint lies inside the lon/lat box (the PBF subset keeps whole ways that touch the box)"""
    mid = np.array([g.geom(e)[len(g.geom(e)) // 2] for e in range(g.n_edges)])
    ll = g.to_wgs84(mid)
    return np.flatnonzero((ll[:, 0] >= bbox["west"]) & (ll[:, 0] <= bbox["east"]) & (ll[:, 1] >= bbox["south"]) & (ll[:, 1] <= bbox["north"]))


def n_cells(g: NetGraph, edges: np.ndarray, h: float) -> int:
    return int(np.maximum(1, np.rint(np.asarray(g.edge_len)[edges] / h)).sum())


def plan(g: NetGraph, edges: np.ndarray, T_of_h, h_choices=(30.0, 40.0), cap_gb: float = GB_CAP) -> dict:
    """memory of the HMM arrays (backpointers + stored forward scores, 3 B per state and step) BEFORE any grid is built; the first h that fits.
    T_of_h(h) -> number of steps for step = h (nominal)."""
    rows = []
    for h in h_choices:
        N, T = n_cells(g, edges, h), T_of_h(h)
        gb = N * T * 3 / 1e9
        rows.append(dict(h=h, N=N, T=T, gb=gb))
        if gb <= cap_gb:
            return dict(h=h, N=N, T=T, gb=gb, tried=rows)
    raise MemoryError(f"HMM arrays above {cap_gb} GB for every grid tried: {rows}")


if __name__ == "__main__":
    import sys
    log = print
    if sys.argv[1] == "amalfi":
        g = build_graph(AMALFI_BBOX, "amalfi_cal", log)
        E = edges_in_bbox(g, AMALFI_BBOX)
        print("edges in box", len(E), "directed km", float(np.asarray(g.edge_len)[E].sum() / 1000), "tunnel edges", int(np.asarray(g.edge_tunnel)[E].sum()))
    else:
        for n in sys.argv[1:]:
            g = build_graph(foreign_bbox(*FOREIGN[n]), f"foreign_{n}", log)
            E = edges_in_bbox(g, foreign_bbox(*FOREIGN[n]))
            print(n, "edges in box", len(E), "directed km", float(np.asarray(g.edge_len)[E].sum() / 1000))
