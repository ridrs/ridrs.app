# SPDX-License-Identifier: AGPL-3.0-or-later
"""Road network of one area: Overpass download via osmnx (cached), simplification that keeps way ids, UTM projection, array form.

Decisions (see work/osm/RESULTS.md):
  * Road filter ROAD_FILTER: trunk, primary, secondary, tertiary (+ _link), unclassified, residential, living_street; NOT motorway
    (cyclists cannot be on it; a car video on a pass road is not either), NOT service/track/path/footway/cycleway/steps, no
    access=private. Tunnels and bridges are KEPT and flagged (dropping a tunnel would cut the road in two and invent a gap).
  * One-way tags are respected (osmnx default for a custom filter), i.e. no wrong-way riding.
  * simplify_graph(edge_attrs_differ=["osmid"]): only degree-2 nodes inside ONE way are merged, so every edge has exactly one way id
    (PROPOSAL 7) and keeps its curved geometry.
  * retain_all=True (no silent drop of small components).
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .area import USER_AGENT, WORK

ROAD_FILTER = ('["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|'
               'unclassified|residential|living_street)$"]["area"!~"yes"]["access"!~"private"]')
OVERPASS_MAIN = "https://overpass-api.de/api"
OVERPASS_MIRROR = "https://overpass.kumi.systems/api"  # the single allowed mirror
BACKOFF_S = (20, 60, 120, 240)


def download(area: dict, log=print):
    """One Overpass query for the area (osmnx caches the response in work/osm/cache; a rerun does not hit the server).
    Retries with backoff on the main instance, then the same retries once on ONE mirror. Returns the simplified, unprojected graph."""
    import osmnx as ox
    ox.settings.cache_folder = str(WORK / "cache")
    ox.settings.use_cache = True
    ox.settings.log_console = False
    ox.settings.requests_headers = {"User-Agent": USER_AGENT}
    ox.settings.requests_timeout = 300
    ox.settings.max_query_area_size = 1e11  # keep it ONE Overpass query (default 2.5e9 m2 would split Cayolle in two)
    b = area["bbox"]
    last = None
    for base in (OVERPASS_MAIN, OVERPASS_MIRROR):
        ox.settings.overpass_url = base
        for i, wait in enumerate((0,) + BACKOFF_S):
            if wait:
                log(f"  retry {i} in {wait}s ({base}) after: {last}")
                time.sleep(wait)
            try:
                t0 = time.time()
                G = ox.graph_from_bbox((b["west"], b["south"], b["east"], b["north"]), custom_filter=ROAD_FILTER, simplify=False, retain_all=True)
                log(f"  downloaded from {base} (or cache) in {time.time()-t0:.1f}s: {len(G)} nodes, {G.number_of_edges()} edges unsimplified")
                G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
                G.graph["overpass_base"] = base
                return G
            except Exception as e:  # noqa: BLE001  (osmnx raises ResponseStatusCodeError, InsufficientResponseError, requests errors)
                last = f"{type(e).__name__}: {str(e)[:200]}"
    raise RuntimeError(f"Overpass failed on {OVERPASS_MAIN} and {OVERPASS_MIRROR}; last error: {last}")


_ROUTY = os.path.expanduser(os.environ.get("RSM_OSM_DIR", "~/rsm-data/osm")) + "/paca-latest.osm.pbf"  # read-only, in place, never copied
PBF = {"cayolle-pass": _ROUTY,
       "gotthard-pass": str(WORK / "cache" / "switzerland-latest.osm.pbf")}  # Geofabrik switzerland-261108, downloaded once (user-approved)


def from_pbf(area: dict, pbf: str, log=print):
    """Same graph construction as osmnx.graph_from_xml, from a read-only PBF subset. No network access."""
    import osmnx as ox
    from osmnx import graph as oxg
    from .pbf import read_subset
    t0 = time.time()
    resp = read_subset(Path(pbf), area["bbox"], WORK / "cache" / f"pbf_subset_{area['slug']}.json")
    log(f"  PBF subset: {resp['source']} in {time.time()-t0:.1f}s")
    G = oxg._create_graph([resp], bidirectional=False)
    if "length" not in next(iter(G.edges(data=True)))[2]:
        G = ox.distance.add_edge_lengths(G)
    G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
    G.graph["overpass_base"] = None
    G.graph["source"] = resp["source"]
    return G


def _s(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        return ";".join(str(x) for x in v)
    return str(v)


@dataclass
class NetGraph:
    """Directed road graph in a local metric CRS (UTM). Edge e runs node edge_u[e] -> edge_v[e]; edge_geom[off[e]:off[e+1]] is its polyline."""
    crs: str
    node_xy: np.ndarray  # (N,2) m
    node_osm: np.ndarray  # (N,) int64 OSM node id
    edge_u: np.ndarray
    edge_v: np.ndarray
    edge_len: np.ndarray  # m, polyline length in the projected CRS
    edge_way: np.ndarray  # (E,) int64 OSM way id (exactly one)
    edge_off: np.ndarray  # (E+1,)
    edge_geom: np.ndarray  # (P,2)
    edge_name: np.ndarray  # str
    edge_ref: np.ndarray
    edge_highway: np.ndarray
    edge_tunnel: np.ndarray  # bool
    edge_bridge: np.ndarray  # bool
    edge_oneway: np.ndarray  # bool (as tagged)
    # cross-section tags for the lane model (rsm.pipeline.lane); None in graphs built before graph2 and by osmnx: then the lane model uses class defaults
    edge_width: np.ndarray | None = None       # float32 m, NaN = untagged
    edge_lanes: np.ndarray | None = None       # int8 lanes of the carriageway, 0 = unknown
    edge_lanes_fwd: np.ndarray | None = None   # int8 lanes in the direction of this edge, 0 = unknown
    edge_roundabout: np.ndarray | None = None  # bool junction=roundabout / circular
    edge_marked: np.ndarray | None = None      # int8 lane_markings: -1 unknown, 0 no, 1 yes
    edge_cycle: np.ndarray | None = None       # int8 cycleway on this side: 0 none / unknown, 1 lane on the carriageway, 2 separate track

    @property
    def n_nodes(self) -> int:
        return len(self.node_xy)

    @property
    def n_edges(self) -> int:
        return len(self.edge_u)

    def geom(self, e: int) -> np.ndarray:
        return self.edge_geom[self.edge_off[e]:self.edge_off[e + 1]]

    def out_edges(self) -> list[list[int]]:
        out: list[list[int]] = [[] for _ in range(self.n_nodes)]
        for e, u in enumerate(self.edge_u):
            out[int(u)].append(e)
        return out

    def save(self, path: Path) -> None:
        np.savez_compressed(path, crs=np.array(self.crs), **{k: v for k, v in self.__dict__.items() if k != "crs" and v is not None})

    @staticmethod
    def load(path: Path) -> "NetGraph":
        """tolerant: optional arrays missing in older files stay None, unknown arrays are ignored"""
        from dataclasses import fields
        known = {f.name for f in fields(NetGraph)}
        z = np.load(path, allow_pickle=False)
        return NetGraph(crs=str(z["crs"]), **{k: z[k] for k in z.files if k != "crs" and k in known})

    def to_wgs84(self, xy: np.ndarray) -> np.ndarray:
        from pyproj import Transformer
        tr = Transformer.from_crs(self.crs, "EPSG:4326", always_xy=True)
        lon, lat = tr.transform(xy[:, 0], xy[:, 1])
        return np.column_stack([lon, lat])


def build(G_proj) -> NetGraph:
    """From a projected, simplified osmnx MultiDiGraph."""
    nodes = list(G_proj.nodes)
    idx = {n: i for i, n in enumerate(nodes)}
    nxy = np.array([[G_proj.nodes[n]["x"], G_proj.nodes[n]["y"]] for n in nodes], float)
    eu, ev, way, off, geoms, ln, nm, rf, hw, tu, br, ow = [], [], [], [0], [], [], [], [], [], [], [], []
    for u, v, k, d in G_proj.edges(keys=True, data=True):
        pu, pv = nxy[idx[u]], nxy[idx[v]]
        g = d.get("geometry")
        pts = np.array(g.coords, float)[:, :2] if g is not None else np.array([pu, pv])
        if np.hypot(*(pts[0] - pu)) > np.hypot(*(pts[-1] - pu)):  # stored against the edge direction
            pts = pts[::-1]
        pts[0], pts[-1] = pu, pv
        keep = np.concatenate([[True], np.hypot(*np.diff(pts, axis=0).T) > 1e-6])  # drop duplicate points
        pts = pts[keep]
        if len(pts) < 2 or u == v and len(pts) < 3:
            continue
        osm = d["osmid"]
        if isinstance(osm, (list, tuple)):
            raise RuntimeError(f"edge {u}->{v} carries several way ids {osm}: simplification must use edge_attrs_differ=['osmid']")
        eu.append(idx[u]); ev.append(idx[v]); way.append(int(osm))
        geoms.append(pts); off.append(off[-1] + len(pts))
        ln.append(float(np.hypot(*np.diff(pts, axis=0).T).sum()))
        nm.append(_s(d.get("name"))); rf.append(_s(d.get("ref"))); hw.append(_s(d.get("highway")))
        tu.append(_s(d.get("tunnel")) not in ("", "no")); br.append(_s(d.get("bridge")) not in ("", "no"))
        ow.append(bool(d.get("oneway")))
    return NetGraph(crs=G_proj.graph["crs"].to_string() if hasattr(G_proj.graph["crs"], "to_string") else str(G_proj.graph["crs"]),
                    node_xy=nxy, node_osm=np.array(nodes, np.int64), edge_u=np.array(eu, np.int32), edge_v=np.array(ev, np.int32),
                    edge_len=np.array(ln), edge_way=np.array(way, np.int64), edge_off=np.array(off, np.int64), edge_geom=np.vstack(geoms),
                    edge_name=np.array(nm), edge_ref=np.array(rf), edge_highway=np.array(hw), edge_tunnel=np.array(tu), edge_bridge=np.array(br),
                    edge_oneway=np.array(ow))


def stats(g: NetGraph, G_unproj=None) -> dict:
    deg_out = np.bincount(g.edge_u, minlength=g.n_nodes)
    deg_in = np.bincount(g.edge_v, minlength=g.n_nodes)
    # undirected road length: pair opposite edges of the same way (same u,v swapped, same way) once
    pairs = {}
    for e in range(g.n_edges):
        key = (min(int(g.edge_u[e]), int(g.edge_v[e])), max(int(g.edge_u[e]), int(g.edge_v[e])), int(g.edge_way[e]), round(float(g.edge_len[e]), 0))
        pairs.setdefault(key, e)
    und_len = sum(g.edge_len[e] for e in pairs.values())
    by_hw: dict[str, float] = {}
    for e in pairs.values():
        by_hw[g.edge_highway[e]] = by_hw.get(g.edge_highway[e], 0.0) + float(g.edge_len[e])
    el = g.edge_len
    return {"nodes": g.n_nodes, "directed_edges": g.n_edges, "undirected_edges": len(pairs), "road_km_undirected": und_len / 1000,
            "directed_km": float(el.sum()) / 1000, "ways": int(len(np.unique(g.edge_way))),
            "edge_len_m_percentiles_5_25_50_75_95_max": [float(x) for x in np.percentile(el, [5, 25, 50, 75, 95, 100])],
            "km_by_highway": {k: round(v / 1000, 2) for k, v in sorted(by_hw.items(), key=lambda kv: -kv[1])},
            "tunnel_km": float(sum(g.edge_len[e] for e in pairs.values() if g.edge_tunnel[e])) / 1000,
            "bridge_km": float(sum(g.edge_len[e] for e in pairs.values() if g.edge_bridge[e])) / 1000,
            "out_degree_hist": {int(k): int(v) for k, v in zip(*np.unique(deg_out, return_counts=True))},
            "dead_end_nodes(out=0)": int((deg_out == 0).sum()), "sources(in=0)": int((deg_in == 0).sum()),
            "oneway_edges": int(g.edge_oneway.sum())}


def main(slug_: str | None = None) -> None:
    import osmnx as ox
    areas = json.loads((WORK / "areas.json").read_text())
    for sl, a in areas.items():
        if slug_ and sl != slug_:
            continue
        out = WORK / sl
        out.mkdir(parents=True, exist_ok=True)
        print(f"[{sl}] bbox {a['bbox']} area {a['area_km2']:.0f} km2")
        t0 = time.time()
        G = from_pbf(a, PBF[sl]) if sl in PBF else download(a)  # download(): Overpass, kept only as a cross-check path
        Gp = ox.project_graph(G)
        g = build(Gp)
        g.save(out / "network.npz")
        ox.save_graphml(G, out / "graph_wgs84.graphml")
        st = stats(g)
        st.update({"crs": g.crs, "overpass_base": G.graph.get("overpass_base"), "pbf": G.graph.get("source"), "seconds": round(time.time() - t0, 1), "road_filter": ROAD_FILTER})
        (out / "network_stats.json").write_text(json.dumps(st, indent=1))
        print(json.dumps(st, indent=1))


if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else None)
