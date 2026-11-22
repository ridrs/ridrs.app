# SPDX-License-Identifier: AGPL-3.0-or-later
"""Local OSM: .osm.pbf read in place with pyosmium (no network, no osmnx), road-density map, automatic foreign boxes for the decoys, road graph (NetGraph).

The graph is built directly from the ways: edges run between 'split' nodes (way ends, nodes used by two ways or twice by one way), one directed edge per
direction (oneway=yes/true/1/-1/reverse and junction=roundabout are one-way), so every edge has exactly one way id: the same graph osmnx.simplify_graph(edge_attrs_differ=['osmid']) gives.
"""
from __future__ import annotations

import math
import os
import sys
from collections import Counter
from pathlib import Path

import numpy as np

from rsm.network.graph import NetGraph
from . import config as C
from .common import jload, sha, file_sig

TAGS = ("highway", "name", "ref", "oneway", "oneway:bicycle", "junction", "tunnel", "bridge", "access", "area",
        # cross-section for the lane model (graph2, rsm.pipeline.lane)
        "width", "est_width", "lanes", "lanes:forward", "lanes:backward", "lane_markings", "cycleway", "cycleway:right", "cycleway:left", "cycleway:both",
        # bike-path tier (bike_tier)
        "bicycle", "tracktype", "surface")
CELL_DEG = 0.01


def bbox_km(b: dict) -> tuple[float, float]:
    lat = 0.5 * (b["north"] + b["south"])
    return (b["east"] - b["west"]) * 111.195 * math.cos(math.radians(lat)), (b["north"] - b["south"]) * 111.195


def parse_bbox(s: str) -> dict:
    S, W, N, E = (float(x) for x in s.split(","))
    if not (-90 <= S < N <= 90 and -180 <= W < E <= 180):
        raise ValueError(f"bad bbox {s!r}: expected S,W,N,E with S<N and W<E")
    return dict(south=S, west=W, north=N, east=E)


class _FdProgress:
    """fraction of the pbf read, from the file offset of the reader's descriptor (macOS F_GETPATH, Linux /proc); None if not found"""

    def __init__(self, path):
        self.path, self.fd, self.size = str(Path(path).resolve()), None, Path(path).stat().st_size

    def _find(self):
        import fcntl
        for fd in range(3, 128):
            try:
                if hasattr(fcntl, "F_GETPATH"):
                    p = fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0" * 1024)
                    p = p[:p.index(b"\0")].decode()
                else:
                    p = os.readlink(f"/proc/self/fd/{fd}")
            except (OSError, ValueError):
                continue
            if p == self.path:
                self.fd = fd
                return

    def frac(self):
        if self.fd is None:
            self._find()
        if self.fd is None:
            return None
        try:
            return min(1.0, os.lseek(self.fd, 0, os.SEEK_CUR) / self.size)
        except OSError:
            return None


def pbf_info(pbf) -> dict:
    import osmium
    r = osmium.io.Reader(str(pbf))
    h = r.header()
    b = h.box()
    out = dict(timestamp=h.get("osmosis_replication_timestamp"), box=None)
    try:
        if b.valid():
            out["box"] = dict(west=b.bottom_left.lon, south=b.bottom_left.lat, east=b.top_right.lon, north=b.top_right.lat)
    except Exception:  # noqa: BLE001
        pass
    r.close()
    return out


_YES = ("yes", "designated", "permissive")


def _mtb(t) -> float:
    try:
        return float(str(t.get("mtb:scale", "")).split(";")[0].rstrip("+-"))
    except ValueError:
        return 0.0


def rules_token(classes) -> list:
    """cache-key part of the way filter: empty for road-only class sets (keys of motor vehicles unchanged), the rule token when bike-path classes are read"""
    return [C.BIKE_PATH_RULES] if set(classes) & set(C.BIKE_PATH_CLASSES) else []


def way_ok(t) -> bool:
    """RULE. Access of a way whose class was requested. Roads (classes outside C.BIKE_PATH_CLASSES): everything except access=private, as before.
    Bike-path classes (requested for a bike only, C.CLASSES_BIKE): never bicycle=no/dismount/use_sidepath, never vehicle=no/private or access=private/no
    without a bicycle permission (bicycle=yes/designated/permissive). cycleway: yes. path: with a permission, or untagged when not signed foot-only
    (foot=designated) and not rough (mtb:scale > C.BIKE_MTB_MAX or a surface of C.BIKE_BAD_SURFACE). track: with a permission, or tracktype in C.BIKE_TRACK_GRADES
    and not rough. service (F3, C.BIKE_SERVICE_UNTAGGED): also without a permission unless a car-park aisle, drive-through, driveway or emergency lane
    (C.BIKE_SERVICE_EXCLUDED); agricultural / forestry service ways are legal for bikes. footway, pedestrian, bridleway: only with a permission. steps are never
    requested. The road set never holds `service`, so this changes the path maps only."""
    hw = t.get("highway")
    if hw not in C.BIKE_PATH_CLASSES:
        return t.get("access") != "private"
    g = lambda k: str(t.get(k, "")).strip().lower()
    perm = g("bicycle") in _YES
    if g("bicycle") in ("no", "dismount", "use_sidepath"):
        return False
    if not perm and (g("vehicle") in ("no", "private") or g("access") in ("private", "no")):
        return False
    if hw == "cycleway" or perm:
        return True
    rough = _mtb(t) > C.BIKE_MTB_MAX or g("surface") in C.BIKE_BAD_SURFACE
    if hw == "path":
        return g("foot") != "designated" and not rough
    if hw == "track":
        return g("tracktype") in C.BIKE_TRACK_GRADES and not rough
    if hw == "service" and C.BIKE_SERVICE_UNTAGGED:
        return g("service") not in C.BIKE_SERVICE_EXCLUDED
    return False                                                     # footway, pedestrian, bridleway (and service without F3) without a bicycle permission


def bike_tier(t) -> int:
    """RULE. Order in which the bike-path ways are given up when the bike map would exceed the HMM memory cap (rsm.pipeline.steps_b.map_step): 0 roads, cycleways
    and anything signed bicycle=designated (never dropped); 1 bicycle=yes/permissive; 2 tracks of C.BIKE_TIER_GRADES; 3 a surface of C.BIKE_TIER_SURFACE;
    4 the other ways way_ok lets through (untagged paths and grade3 / untagged tracks). Dev evidence (Mittenwald '5 Lakes', komoot reference within 15 m):
    tiers <= 0/1/2/3/4 cover 41/55/92/93/96 % of the route with 1.2/1.7/3.0/3.2/5.0 x the road length of the roads alone (FINDINGS "Bike paths")."""
    hw = t.get("highway")
    bic = str(t.get("bicycle", "")).strip().lower()
    if hw not in C.BIKE_PATH_CLASSES or hw == "cycleway" or bic == "designated":
        return 0
    if bic in _YES:
        return 1
    if hw == "track" and str(t.get("tracktype", "")).strip().lower() in C.BIKE_TIER_GRADES:
        return 2
    if str(t.get("surface", "")).strip().lower() in C.BIKE_TIER_SURFACE:
        return 3
    return 4


def edge_tiers(g, ways) -> np.ndarray:
    """bike_tier per edge of a graph built from `ways` (int8; all 0 for road-only class sets). The ways carry the TAGS subset, which holds the keys bike_tier reads."""
    tm = {wid: bike_tier(tags) for wid, tags, _ in ways}
    return np.array([tm[int(w)] for w in np.asarray(g.edge_way)], np.int8)


def _ways(pbf, classes, progress=None, way_filter=None):
    """yield (way_id, tags dict, [(ref, lat, lon)]) of the road ways of the given classes"""
    import osmium
    cls = set(classes)
    ok_fn = way_ok if way_filter is None else way_filter
    prog = _FdProgress(pbf)
    fp = osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations().with_filter(osmium.filter.KeyFilter("highway"))
    n = 0
    for w in fp:
        if not w.is_way():
            continue
        n += 1
        if progress and n % 20000 == 0:
            f = prog.frac()
            if f is not None:
                progress(f)
        t = w.tags
        if t.get("highway") not in cls or t.get("area") == "yes" or not ok_fn(t):
            continue
        try:
            pts = [(nd.ref, nd.lat, nd.lon) for nd in w.nodes]
        except osmium.InvalidLocationError:
            continue
        if len(pts) >= 2:
            yield w.id, {k: t[k] for k in TAGS if k in t}, pts
    if progress:
        progress(1.0)


def density(pbf, classes, cache_dir: Path, progress=None) -> dict:
    """road length (undirected km) of the classes per 0.01 degree cell, cached in the data dir; -> dict(lat0, lon0, km (rows lat, cols lon))"""
    key = sha(file_sig(pbf), sorted(classes), CELL_DEG, "dens1", *rules_token(classes))
    f = cache_dir / f"density_{key}.npz"
    if f.exists():
        z = np.load(f)
        return dict(lat0=float(z["lat0"]), lon0=float(z["lon0"]), km=z["km"])
    la, lo, ln = [], [], []
    for _, _, pts in _ways(pbf, classes, progress):
        a = np.array([(p[1], p[2]) for p in pts])
        d = np.hypot(np.diff(a[:, 0]) * 111.195, np.diff(a[:, 1]) * 111.195 * math.cos(math.radians(a[:, 0].mean())))
        m = len(a) // 2
        la.append(a[m, 0]); lo.append(a[m, 1]); ln.append(d.sum())
    la, lo, ln = np.array(la), np.array(lo), np.array(ln)
    lat0, lon0 = math.floor(la.min() / CELL_DEG) * CELL_DEG, math.floor(lo.min() / CELL_DEG) * CELL_DEG
    ny, nx = int((la.max() - lat0) / CELL_DEG) + 1, int((lo.max() - lon0) / CELL_DEG) + 1
    km = np.zeros((ny, nx))
    np.add.at(km, (((la - lat0) / CELL_DEG).astype(int), ((lo - lon0) / CELL_DEG).astype(int)), ln)
    np.savez_compressed(f, lat0=lat0, lon0=lon0, km=km)
    return dict(lat0=lat0, lon0=lon0, km=km)


def _box_km(D: dict, b: dict) -> float:
    y0, y1 = int(round((b["south"] - D["lat0"]) / CELL_DEG)), int(round((b["north"] - D["lat0"]) / CELL_DEG))
    x0, x1 = int(round((b["west"] - D["lon0"]) / CELL_DEG)), int(round((b["east"] - D["lon0"]) / CELL_DEG))
    k = D["km"]
    if y0 < 0 or x0 < 0 or y1 > k.shape[0] or x1 > k.shape[1]:
        return float("nan")
    return float(k[y0:y1, x0:x1].sum())


def foreign_boxes(D: dict, bbox: dict, info_box: dict | None, n: int = C.N_FOREIGN) -> list[dict]:
    """RULE. Boxes of the SAME size in km as the user's bbox, taken from the same .pbf: candidate centres on a lattice of half a box size; a candidate must lie
    inside the extract (header box, else the density grid), keep GAP_BOXES box sizes away from the user's bbox, and have a road length (same classes) within
    DENSITY_WINDOW x that of the user's box (widened once to DENSITY_RELAX). The n boxes closest in ln(density ratio) that do not overlap each other are taken
    (ties: south-west first). Deterministic."""
    w_km, h_km = bbox_km(bbox)
    lat_c = 0.5 * (bbox["north"] + bbox["south"])
    dlat = h_km / 111.195
    real = _box_km(D, bbox)
    if not np.isfinite(real) or real <= 0:
        return []
    clat = D["lat0"] + np.arange(D["km"].shape[0]) * CELL_DEG
    cand = []
    lat = D["lat0"] + dlat / 2
    while lat + dlat / 2 <= D["lat0"] + D["km"].shape[0] * CELL_DEG:
        dlon = w_km / (111.195 * math.cos(math.radians(lat)))
        lon = D["lon0"] + dlon / 2
        while lon + dlon / 2 <= D["lon0"] + D["km"].shape[1] * CELL_DEG:
            b = dict(south=lat - dlat / 2, north=lat + dlat / 2, west=lon - dlon / 2, east=lon + dlon / 2)
            ok = True
            if info_box:
                ok = b["west"] >= info_box["west"] and b["east"] <= info_box["east"] and b["south"] >= info_box["south"] and b["north"] <= info_box["north"]
            gl, go = GAP = C.GAP_BOXES * dlat, C.GAP_BOXES * (bbox["east"] - bbox["west"])
            if ok and not (b["west"] > bbox["east"] + go or b["east"] < bbox["west"] - go or b["south"] > bbox["north"] + gl or b["north"] < bbox["south"] - gl):
                ok = False
            if ok:
                km = _box_km(D, b)
                if np.isfinite(km) and km > 0:
                    cand.append((abs(math.log(km / real)), km / real, b["south"], b["west"], b))
            lon += dlon / 2
        lat += dlat / 2
    out = []
    for lo_, hi_ in (C.DENSITY_WINDOW, C.DENSITY_RELAX):
        pool = sorted((c for c in cand if lo_ <= c[1] <= hi_), key=lambda c: c[:4])
        out = []
        for c in pool:
            b = c[4]
            if all(b["west"] >= o["west"] + (o["east"] - o["west"]) or b["east"] <= o["west"] or b["south"] >= o["north"] or b["north"] <= o["south"] for o in [x["bbox"] for x in out]):
                out.append(dict(bbox=b, km=float(_box_km(D, b)), ratio=float(c[1])))
            if len(out) >= n:
                break
        if len(out) >= n:
            break
    for i, o in enumerate(out):
        o["name"] = f"f{i}"
    return out


def extract(pbf, classes, boxes: dict[str, dict], progress=None, way_filter=None) -> dict:
    """one pass; ways touching a box (any node inside), full geometry. -> {name: (ways, nodes)}"""
    res = {k: ([], {}) for k in boxes}
    for wid, tags, pts in _ways(pbf, classes, progress, way_filter=way_filter):
        for k, b in boxes.items():
            if any(b["south"] <= la <= b["north"] and b["west"] <= lo <= b["east"] for _, la, lo in pts):
                ws, nd = res[k]
                ws.append((wid, tags, [p[0] for p in pts]))
                for r, la, lo in pts:
                    nd[r] = (la, lo)
    return res


def subset(ways, nodes, classes):
    """the ways of `classes` from an extract made with a larger class set, with only their nodes: build_graph then gives the same graph as an extract of `classes`"""
    cls = set(classes)
    ws = [w for w in ways if w[1].get("highway") in cls]
    refs = {r for w in ws for r in w[2]}
    return ws, {r: ll for r, ll in nodes.items() if r in refs}


def _oneway(tags, allow_contraflow_bike: bool = False) -> tuple[bool, bool]:
    ow = str(tags.get("oneway", "")).lower()
    fwd = ow in ("yes", "true", "1") or tags.get("junction") == "roundabout"
    rev = ow in ("-1", "reverse")
    if allow_contraflow_bike and (fwd or rev) and tags.get("junction") != "roundabout":
        if str(tags.get("oneway:bicycle", "")).strip().lower() == "no":
            return False, False
        for k in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both"):
            if str(tags.get(k, "")).strip().lower().startswith("opposite"):
                return False, False
    return fwd or rev, rev


def _width(tags) -> float:
    """carriageway width in m from width / est_width ("6", "6.5 m", "6,5"); NaN if untagged or implausible (> 40 m, feet, ...)"""
    for k in ("width", "est_width"):
        v = str(tags.get(k, "")).strip().lower().replace(",", ".")
        if v.endswith("m"):
            v = v[:-1].strip()
        try:
            w = float(v)
        except ValueError:
            continue
        if 1.0 <= w <= 40.0:
            return w
    return float("nan")


def _int_tag(tags, k) -> int:
    try:
        n = int(float(str(tags.get(k, "")).split(";")[0]))
    except ValueError:
        return 0
    return n if 0 < n <= 12 else 0


def _cycle(tags, direction: int) -> int:
    """cycleway on the side a vehicle travelling along the edge rides on: 1 lane on the carriageway, 2 separate track, 0 none / unknown (right-hand traffic sides)"""
    side = "right" if direction == 1 else "left"
    v = str(tags.get(f"cycleway:{side}") or tags.get("cycleway:both") or tags.get("cycleway") or "").lower()
    return 1 if v in ("lane", "shared_lane", "shoulder") else 2 if v in ("track", "separate") else 0


def build_graph(ways, nodes, *, allow_contraflow_bike: bool = False) -> NetGraph:
    from pyproj import Transformer
    ids = np.array(list(nodes.keys()), np.int64)
    ll = np.array([nodes[i] for i in ids])
    lat0, lon0 = float(ll[:, 0].mean()), float(ll[:, 1].mean())
    zone = int((lon0 + 180) // 6) + 1
    crs = f"EPSG:{(32600 if lat0 >= 0 else 32700) + zone}"
    x, y = Transformer.from_crs(4326, crs, always_xy=True).transform(ll[:, 1], ll[:, 0])
    xy_of = {int(i): (a, b) for i, a, b in zip(ids, x, y)}
    use = Counter()
    for _, _, refs in ways:
        use.update(refs)
    node_ix, nxy, nosm = {}, [], []
    eu, ev, way, off, geoms, ln, nm, rf, hw, tu, br, ow_ = [], [], [], [0], [], [], [], [], [], [], [], []
    wd, nl, nlf, rb, mk, cy = [], [], [], [], [], []

    def ix(r):
        if r not in node_ix:
            node_ix[r] = len(nxy); nxy.append(xy_of[r]); nosm.append(r)
        return node_ix[r]

    for wid, tags, refs in ways:
        split = [i for i, r in enumerate(refs) if i == 0 or i == len(refs) - 1 or use[r] > 1]
        one, rev = _oneway(tags, allow_contraflow_bike=allow_contraflow_bike)
        w_, n_, lf_, lb_ = _width(tags), _int_tag(tags, "lanes"), _int_tag(tags, "lanes:forward"), _int_tag(tags, "lanes:backward")
        lm = str(tags.get("lane_markings", "")).lower()
        mk_ = 0 if lm == "no" else 1 if lm == "yes" else -1
        for a, b in zip(split[:-1], split[1:]):
            seg = refs[a:b + 1]
            pts = np.array([xy_of[r] for r in seg])
            pts = pts[np.concatenate([[True], np.hypot(*np.diff(pts, axis=0).T) > 1e-6])]
            if len(pts) < 2 or (seg[0] == seg[-1] and len(pts) < 3):
                continue
            for direction in ((-1,) if rev else (1,)) if one else (1, -1):
                s, p = (seg, pts) if direction == 1 else (seg[::-1], pts[::-1])
                eu.append(ix(s[0])); ev.append(ix(s[-1])); way.append(wid)
                geoms.append(p); off.append(off[-1] + len(p))
                ln.append(float(np.hypot(*np.diff(p, axis=0).T).sum()))
                nm.append(str(tags.get("name", ""))); rf.append(str(tags.get("ref", ""))); hw.append(str(tags.get("highway", "")))
                tu.append(str(tags.get("tunnel", "")) not in ("", "no")); br.append(str(tags.get("bridge", "")) not in ("", "no")); ow_.append(one)
                wd.append(w_); nl.append(n_); rb.append(tags.get("junction") in ("roundabout", "circular")); mk.append(mk_)
                fw = (lf_ if direction == 1 else lb_) or ((n_ if one else n_ // 2 if n_ % 2 == 0 else 0) if n_ else 0)
                nlf.append(fw); cy.append(_cycle(tags, direction))
    if not eu:
        raise RuntimeError("no road ways in the area")
    return NetGraph(crs=crs, node_xy=np.array(nxy, float), node_osm=np.array(nosm, np.int64), edge_u=np.array(eu, np.int32), edge_v=np.array(ev, np.int32),
                    edge_len=np.array(ln), edge_way=np.array(way, np.int64), edge_off=np.array(off, np.int64), edge_geom=np.vstack(geoms),
                    edge_name=np.array(nm), edge_ref=np.array(rf), edge_highway=np.array(hw), edge_tunnel=np.array(tu), edge_bridge=np.array(br), edge_oneway=np.array(ow_),
                    edge_width=np.array(wd, np.float32), edge_lanes=np.array(nl, np.int8), edge_lanes_fwd=np.array(nlf, np.int8), edge_roundabout=np.array(rb, bool),
                    edge_marked=np.array(mk, np.int8), edge_cycle=np.array(cy, np.int8))


def edges_in_bbox(g: NetGraph, b: dict) -> np.ndarray:
    """edges whose middle vertex lies inside the lon/lat box (whole ways touching the box were read)"""
    mid = np.array([g.geom(e)[len(g.geom(e)) // 2] for e in range(g.n_edges)])
    ll = g.to_wgs84(mid)
    return np.flatnonzero((ll[:, 0] >= b["west"]) & (ll[:, 0] <= b["east"]) & (ll[:, 1] >= b["south"]) & (ll[:, 1] <= b["north"]))


def n_cells(g: NetGraph, edges, h: float) -> int:
    return int(np.maximum(1, np.rint(np.asarray(g.edge_len)[edges] / h)).sum())


def memory_plan(g: NetGraph, edges, T: int, cap_gb: float = C.HMM_CAP_GB) -> dict:
    """worst case over the scan (kappa_min, cell h = 30 kappa_min): backpointers 2 B + stored forward scores 2 B per state and step. Raises MemoryError above the cap."""
    h = C.H * C.K_GRID[0]
    N = n_cells(g, edges, h)
    gb = N * T * 4 / 1e9
    p = dict(N=N, T=T, h=h, gb=gb, cap_gb=cap_gb)
    if gb > cap_gb:
        raise MemoryError(f"HMM arrays would need {gb:.2f} GB ({N} states x {T} steps) > {cap_gb} GB: use a smaller area")
    return p
