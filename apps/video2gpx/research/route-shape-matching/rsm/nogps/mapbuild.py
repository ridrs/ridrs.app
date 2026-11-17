# SPDX-License-Identifier: AGPL-3.0-or-later
"""Area, road graph and map quanta of the no-GPS video.

AREA RULE (a priori, video-only evidence): centre = Nominatim top hit of the video name ("Amalfi Coast", cached); half-width R = max(20 km, L_vms),
L_vms = usable nominal vms length of the video (as rsm.track.graphs.area_for); square bbox. One area for the graph, the map quanta and the tracker.
"""
from __future__ import annotations

import json
import math
import time

from rsm.network import pbf as pbfmod
from rsm.network.area import geocode
from rsm.network.graph import NetGraph, build
from rsm.network.pbf import read_subset
from rsm.quanta import legs, video

from . import cfg


# JUDGEMENT CALL (a priori, after the first full-network map build exhausted the Mac's memory): a car on a scenic coastal through-route stays on the classified
# network. residential, living_street (and, as in rsm.network.pbf, service/track/path/...) are dropped; motorway and trunk are kept.
ROAD_HIGHWAYS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified"}


def l_vms(label: str = "refined") -> float:
    return video.total_length(video.segments(cfg.VIDEO, label))


def make_area(label: str = "refined", r_cap: float | None = None) -> dict:
    rec = geocode(cfg.NAME_QUERY, cache_dir=cfg.WORK / "cache" / "geocode")
    top = rec["results"][0]
    lat, lon = float(top["lat"]), float(top["lon"])
    L = l_vms(label)
    R = max(cfg.R_MIN, L)
    if r_cap is not None:
        R = min(R, r_cap)
    dlat = math.degrees(R / 6371008.8)
    dlon = dlat / math.cos(math.radians(lat))
    a = dict(video=cfg.VIDEO, query=cfg.NAME_QUERY, r_cap_m=r_cap, centre=dict(lat=lat, lon=lon, display_name=top.get("display_name")), l_vms_m=L, radius_m=R,
             bbox=dict(north=lat + dlat, south=lat - dlat, east=lon + dlon, west=lon - dlon), area_km2=(2 * R / 1000) ** 2)
    (cfg.WORK / "area_amalfi.json").write_text(json.dumps(a, indent=1))
    return a


def load_area() -> dict:
    return json.loads((cfg.WORK / "area_amalfi.json").read_text())


def build_graph(area: dict, log=print, tag: str = "amalfi") -> NetGraph:
    """PBF subset -> osmnx graph -> projected NetGraph (copy of rsm.quanta.area.build_graph with this package's PBF and cache)."""
    import osmnx as ox
    from osmnx import graph as oxg
    f = cfg.WORK / "cache" / f"graph_{tag}.npz"
    if f.exists():
        return NetGraph.load(f)
    t0 = time.time()
    pbfmod.ROAD_HIGHWAYS = ROAD_HIGHWAYS  # read_subset looks the set up at call time
    resp = read_subset(cfg.PBF, area["bbox"], cfg.WORK / "cache" / f"pbf_subset_{tag}.json")
    log(f"  PBF subset {resp['source']['ways']} ways in {time.time()-t0:.0f}s")
    G = oxg._create_graph([resp], bidirectional=False)
    G = ox.distance.add_edge_lengths(G) if "length" not in next(iter(G.edges(data=True)))[2] else G
    G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
    g = build(ox.project_graph(G))
    g.save(f)
    log(f"  graph {g.n_nodes} nodes {g.n_edges} edges {g.edge_len.sum()/1000:.0f} directed km in {time.time()-t0:.0f}s")
    return g


def build_map(g: NetGraph, workers: int = 4, log=print, tag: str = "amalfi", straight_max: float = 2000.0) -> dict:
    f = cfg.WORK / f"map_{tag}_{int(cfg.THR)}.npz"
    if f.exists():
        return legs.load(f)
    t0 = time.time()
    m = legs.build_legs(g, cfg.THR, straight_max, workers)
    legs.save(f, m)
    log(f"  map quanta {len(m['q']['sign1'])} legs, {len(m['events']['sign'])} events in {time.time()-t0:.0f}s")
    return m


class Ctx:
    """duck type of rsm.quanta.evalrun.Ctx without GPS (what rsm.plaus.pipeline.prep / fit_cand read: .m and .g)."""

    def __init__(self, area, g, m):
        self.area, self.g, self.m, self.video, self.thr = area, g, m, cfg.VIDEO, cfg.THR


def load_ctx(log=print) -> Ctx:
    a = load_area()
    g = build_graph(a, log)
    return Ctx(a, g, build_map(g, log=log))


def sub_area(area: dict, r_m: float) -> dict:
    """a smaller square around the same centre (test builds: measure time and memory before the full map)."""
    lat, lon = area["centre"]["lat"], area["centre"]["lon"]
    dlat = math.degrees(r_m / 6371008.8)
    dlon = dlat / math.cos(math.radians(lat))
    return dict(area, radius_m=r_m, bbox=dict(north=lat + dlat, south=lat - dlat, east=lon + dlon, west=lon - dlon), area_km2=(2 * r_m / 1000) ** 2)
