# SPDX-License-Identifier: AGPL-3.0-or-later
"""Area hints: start / end frames (cell masks for the HMM), route hint files (.gpx / .kml -> polylines), the corridor road filter and the agreement of a route with the hint.
Only geometry is used: timestamps of a hint GPX are ignored, the direction of the hint is not trusted."""
from __future__ import annotations

import hashlib
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

from . import config as C

HINT_MAX_POINTS = 200000


# ------------------------------------------------------------------ parsing
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _gpx(root) -> list[list[tuple[float, float]]]:
    """<trkseg> of every <trk> and every <rte>; waypoints (<wpt>) are not a route"""
    lines = []
    for el in root.iter():
        n = _local(el.tag)
        if n in ("trkseg", "rte"):
            pts = []
            for p in el:
                if _local(p.tag) in ("trkpt", "rtept") and p.get("lat") is not None and p.get("lon") is not None:
                    pts.append((float(p.get("lon")), float(p.get("lat"))))
            lines.append(pts)
    return lines


def _kml(root) -> list[list[tuple[float, float]]]:
    """<LineString><coordinates>lon,lat[,alt] ...</coordinates>, <gx:Track><gx:coord>lon lat alt</gx:coord> (also inside MultiGeometry / MultiTrack / Folder)"""
    lines = []
    for el in root.iter():
        n = _local(el.tag)
        if n == "linestring":
            for c in el:
                if _local(c.tag) == "coordinates" and c.text:
                    pts = []
                    for tok in c.text.split():
                        v = tok.split(",")
                        if len(v) >= 2:
                            pts.append((float(v[0]), float(v[1])))
                    lines.append(pts)
        elif n == "track":
            pts = []
            for c in el:
                if _local(c.tag) == "coord" and c.text:
                    v = c.text.split()
                    if len(v) >= 2:
                        pts.append((float(v[0]), float(v[1])))
            lines.append(pts)
    return lines


def read_hint(path) -> list[list[tuple[float, float]]]:
    """-> list of polylines [(lon, lat), ...] (at least 2 points each). Raises ValueError with a clear message for unreadable files or files without a line."""
    p = Path(path)
    try:
        root = ET.parse(p).getroot()
    except (ET.ParseError, OSError) as e:
        raise ValueError(f"route hint {p.name}: not readable as XML ({e})")
    ext = p.suffix.lower()
    top = _local(root.tag)
    kind = "gpx" if top == "gpx" else "kml" if top == "kml" else None
    if kind is None:
        raise ValueError(f"route hint {p.name}: only .gpx and .kml are supported")
    try:
        lines = _gpx(root) if kind == "gpx" else _kml(root)
    except ValueError as e:
        raise ValueError(f"route hint {p.name}: bad coordinate ({e})")
    lines = [l for l in lines if len(l) >= 2 and all(-180 <= x <= 180 and -90 <= y <= 90 for x, y in l)]
    if not lines:
        raise ValueError(f"route hint {p.name}: no track, route or line string found")
    if sum(len(l) for l in lines) > HINT_MAX_POINTS:
        raise ValueError(f"route hint {p.name}: too many points")
    return lines


def file_hash(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


def lines_bounds(lines) -> tuple[float, float, float, float]:
    a = np.array([p for l in lines for p in l])
    return float(a[:, 1].min()), float(a[:, 0].min()), float(a[:, 1].max()), float(a[:, 0].max())     # S, W, N, E


def project_lines(lines, crs: str):
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, crs, always_xy=True)
    out = []
    for l in lines:
        a = np.asarray(l, float)
        x, y = tr.transform(a[:, 0], a[:, 1])
        out.append(np.column_stack([x, y]))
    return out


# ------------------------------------------------------------------ frames
def expand_bbox(b: dict, m: float) -> dict:
    dlat = m / 111195.0
    dlon = m / (111195.0 * max(0.05, math.cos(math.radians(0.5 * (b["north"] + b["south"])))))
    return dict(south=b["south"] - dlat, north=b["north"] + dlat, west=b["west"] - dlon, east=b["east"] + dlon)


def in_bbox(lon, lat, b: dict):
    lon, lat = np.asarray(lon), np.asarray(lat)
    return (lon >= b["west"]) & (lon <= b["east"]) & (lat >= b["south"]) & (lat <= b["north"])


def cell_mask(g, G, frame: dict | None, tol_m: float = 0.0):
    """bool over the grid cells: cell centre inside the frame (grown by tol_m). None if there is no frame."""
    if frame is None:
        return None
    ll = g.to_wgs84(G.xy)
    return in_bbox(ll[:, 0], ll[:, 1], expand_bbox(frame, tol_m) if tol_m else frame)


# ------------------------------------------------------------------ corridor
def _edge_lines(g, E):
    import shapely
    off = np.asarray(g.edge_off)
    geom = np.asarray(g.edge_geom)
    cnt = off[E + 1] - off[E]
    idx = np.repeat(np.arange(len(E)), cnt)
    pos = np.concatenate([np.arange(off[e], off[e + 1]) for e in E]) if len(E) else np.zeros(0, int)
    return shapely.linestrings(geom[pos], indices=idx)


def _unique_segments(lines_xy):
    """distinct 2-point segments (direction ignored, 0.1 m key) of the polylines: a decoded route that rides the same roads many times has ~10x fewer of them"""
    import shapely
    segs = []
    for l in lines_xy:
        q = np.round(np.asarray(l, float)[:, :2], 1)
        if len(q) < 2:
            continue
        a, b = q[:-1], q[1:]
        sw = (a[:, 0] > b[:, 0]) | ((a[:, 0] == b[:, 0]) & (a[:, 1] > b[:, 1]))
        lo, hi = np.where(sw[:, None], b, a), np.where(sw[:, None], a, b)
        k = np.concatenate([lo, hi], axis=1)
        nz = (lo != hi).any(axis=1)
        segs.append(k[nz] if nz.any() else k[:1])     # a line that never moves stays as one point-like segment (buffer gave a disc there too)
    if not segs:
        return shapely.linestrings(np.zeros((0, 2, 2)))
    return shapely.linestrings(np.unique(np.concatenate(segs), axis=0).reshape(-1, 2, 2))


def near_lines(lines_xy, geoms, dist_m: float) -> np.ndarray:
    """bool per geometry: within dist_m of any of the polylines. Same edges as intersecting shapely.buffer(lines, dist_m), but without the polygon: GEOS
    buffer is super-linear on a self-overlapping line (a back-and-forth route of 114k points took hours, refine stuck at 15 %); this takes seconds."""
    import shapely
    segs = _unique_segments(lines_xy)
    out = np.zeros(len(geoms), bool)
    if len(segs) == 0 or len(geoms) == 0:
        return out
    i_geom, _ = shapely.STRtree(segs).query(geoms, predicate="dwithin", distance=dist_m)
    out[i_geom] = True
    return out


def corridor_edges(g, E, lines_xy, buffer_m: float, bridge_max_m: float | None = None) -> np.ndarray:
    """Edges of E (sorted ids) that touch the buffer of the hint polylines (graph CRS), plus the shortest connections between separate corridor pieces
    (up to bridge_max_m, default max(2 km, 5 buffers)) so that the corridor stays one connected road set where the map allows it."""
    import shapely
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components, dijkstra
    E = np.asarray(E)
    if len(E) == 0:
        return E
    bridge_max_m = bridge_max_m if bridge_max_m is not None else max(2000.0, 5 * buffer_m)
    sel = near_lines(lines_xy, _edge_lines(g, E), buffer_m)
    if not sel.any():
        return E[:0]
    u, v, ln = np.asarray(g.edge_u)[E], np.asarray(g.edge_v)[E], np.asarray(g.edge_len)[E]
    nn = int(max(u.max(), v.max())) + 1
    # connected pieces of the corridor
    A = coo_matrix((np.ones(int(sel.sum())), (u[sel], v[sel])), shape=(nn, nn))
    ncomp, lab = connected_components(A, directed=False)
    used = np.unique(np.concatenate([u[sel], v[sel]]))
    comps = np.unique(lab[used])
    if len(comps) > 1:
        W = coo_matrix((ln, (u, v)), shape=(nn, nn)).tocsr()
        W = W.maximum(W.T)                                              # undirected lengths
        km = {c: float(ln[sel & (lab[u] == c)].sum()) for c in comps}
        main = max(comps, key=lambda c: km[c])
        merged = {main}
        pairs = {}
        for e, (a, b) in enumerate(zip(u, v)):
            pairs.setdefault((int(a), int(b)), []).append(e)
        add = set()
        while True:
            rest = [c for c in comps if c not in merged]
            if not rest:
                break
            src = np.flatnonzero(np.isin(lab, list(merged)) & np.isin(np.arange(nn), used))
            dist, pred, srcs = dijkstra(W, directed=False, indices=src, min_only=True, return_predecessors=True)
            best = None
            for c in rest:
                nodes = np.flatnonzero((lab == c) & np.isin(np.arange(nn), used))
                j = nodes[np.argmin(dist[nodes])]
                if np.isfinite(dist[j]) and (best is None or dist[j] < best[0]):
                    best = (float(dist[j]), c, int(j))
            if best is None or best[0] > bridge_max_m:
                break
            _, c, j = best
            while pred[j] >= 0 and srcs[j] != j:
                a = int(pred[j])
                for key in ((a, j), (j, a)):
                    add.update(pairs.get(key, []))
                j = a
            merged.add(c)
        if add:
            sel = sel.copy()
            sel[list(add)] = True
    return np.sort(E[sel])


def agreement(xy: np.ndarray, lines_xy, buffer_m: float) -> float:
    """share of the points (graph CRS) within buffer_m of the hint"""
    import shapely
    if len(xy) == 0:
        return 0.0
    hint = shapely.multilinestrings([shapely.linestrings(l) for l in lines_xy if len(l) >= 2])
    d = shapely.distance(shapely.points(np.asarray(xy, float)), hint)
    return float(np.mean(d <= buffer_m))


# ------------------------------------------------------------------ the distance cost (A28)
_COST: dict = {}         # the active hint: crs, segments, STRtree, key


def cost_per_m(d) -> np.ndarray:
    """nats per metre travelled at distance d (m) from the hint: 0 up to C.HINT_COST_FREE_M, then C.HINT_COST_NATS_PER_KM_PER_M per km and metre, at most
    C.HINT_COST_MAX_NATS_PER_KM"""
    d = np.asarray(d, float)
    return np.minimum(C.HINT_COST_MAX_NATS_PER_KM, C.HINT_COST_NATS_PER_KM_PER_M * np.maximum(0.0, d - C.HINT_COST_FREE_M)) / 1000.0


def cell_cost(g, xy) -> np.ndarray | None:
    """the grid hook (rsm.hmm.grid.CELL_COST_HOOK): the cost per metre of every cell centre xy of a grid on g; None for a graph in another CRS"""
    import shapely
    if not _COST or str(g.crs) != _COST["crs"]:
        return None
    pts = shapely.points(np.asarray(xy, float))
    i = _COST["tree"].nearest(pts)
    return cost_per_m(shapely.distance(pts, _COST["segs"][i]))


def activate_cost(lines_xy, crs: str | None = None):
    """put the distance cost of the hint polylines (in crs) in effect for every grid this process builds; None switches it off"""
    import shapely
    from rsm.hmm import grid
    _COST.clear()
    if lines_xy is None or crs is None:
        grid.CELL_COST_HOOK = None
        return
    segs = _unique_segments(lines_xy)
    if len(segs) == 0:
        grid.CELL_COST_HOOK = None
        return
    key = hashlib.sha256(np.ascontiguousarray(shapely.get_coordinates(segs)).tobytes() + repr((crs, C.HINT_COST_FREE_M, C.HINT_COST_NATS_PER_KM_PER_M,
                                                                                                 C.HINT_COST_MAX_NATS_PER_KM)).encode()).hexdigest()[:16]
    _COST.update(crs=str(crs), segs=segs, tree=shapely.STRtree(segs), key=key)
    grid.CELL_COST_HOOK = cell_cost


def start_cost(P: dict, crs: str):
    """route_search / refine: the distance cost of the run's hint in effect (off without a hint)"""
    activate_cost(project_lines(read_hint(P["hint"]), crs) if P.get("hint") else None, crs)


def cost_key() -> str:
    """for cache keys of scores (steps_b._memo_key); "" when off"""
    return _COST.get("key", "")


def cost_hash_part(P: dict) -> list:
    """the distance cost in the hashes of route_search onward ([] without a hint: old hashes unchanged)"""
    return [["hint_cost1", C.HINT_COST_FREE_M, C.HINT_COST_NATS_PER_KM_PER_M, C.HINT_COST_MAX_NATS_PER_KM]] if P.get("hint") else []
