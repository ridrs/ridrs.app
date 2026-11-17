# SPDX-License-Identifier: AGPL-3.0-or-later
"""Road network for whole-video tracking: area rule, graph, per-edge heading profiles, forward and reversed view, nearest-edge snapping.

AREA RULE (a priori, no GPS): centre = the geocoded place of rsm.quanta.area (same query, cached answers reused), half-width
R = max(20 km, L_vms) (L_vms: usable nominal vms length of the video). The quanta rule capped R at 20 km; a tracker needs the WHOLE
route inside the box (Rousset: GPS leaves the 20 km box at km 47.5, vms length 34 km, so R becomes 34 km).

Net: a directed edge graph in a local metric CRS. `Net.build(g, reverse)` gives the forward view or the view with every edge reversed
(travelling the road backwards, used to track backward in video time). Edge e keeps the same id in both views.
Per edge a profile on an (almost) 2 m grid (n_e = ceil(L/2)+1 samples, step L/(n_e-1)): heading phi (rad, 6 m Gaussian on the unwrapped heading,
wrapped to (-pi, pi]), its gradient dphi/du (rad/m), and x, y.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree

from rsm.network.graph import NetGraph, build
from rsm.network.pbf import read_subset
from rsm.quanta import area as qarea

WORK = Path(__file__).resolve().parents[2] / "work" / "track"
R_MIN = 20_000.0
GRID = 2.0
SM_M = 6.0


def area_for(video: str) -> dict:
    qa = json.loads((qarea.WORK / f"area_{video}.json").read_text())
    R = max(R_MIN, float(qa["l_vms_m"]))
    lat, lon = qa["centre"]["lat"], qa["centre"]["lon"]
    dlat = math.degrees(R / 6371008.8)
    dlon = dlat / math.cos(math.radians(lat))
    return dict(video=video, query=qa["query"], centre=qa["centre"], l_vms_m=qa["l_vms_m"], radius_m=R,
                bbox=dict(north=lat + dlat, south=lat - dlat, east=lon + dlon, west=lon - dlon), area_km2=(2 * R / 1000) ** 2)


def load_graph(video: str, log=print) -> tuple[NetGraph, dict]:
    """Graph of the tracking area (PBF read in place, subset cached under work/track/cache). Same pipeline as rsm.quanta.area.build_graph
    (copied because that one caches inside work/quanta)."""
    a = area_for(video)
    f = WORK / "cache" / f"graph_{video}.npz"
    (WORK / "cache").mkdir(parents=True, exist_ok=True)
    (WORK / f"area_{video}.json").write_text(json.dumps(a, indent=1))
    if f.exists():
        return NetGraph.load(f), a
    import osmnx as ox
    from osmnx import graph as oxg
    t0 = time.time()
    resp = read_subset(qarea.PBF, a["bbox"], WORK / "cache" / f"pbf_subset_{video}.json")
    log(f"  PBF subset {resp['source']['ways']} ways in {time.time()-t0:.0f}s")
    G = oxg._create_graph([resp], bidirectional=False)
    G = ox.distance.add_edge_lengths(G) if "length" not in next(iter(G.edges(data=True)))[2] else G
    G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
    g = build(ox.project_graph(G))
    g.save(f)
    log(f"  graph {g.n_nodes} nodes {g.n_edges} edges {g.edge_len.sum()/1000:.0f} directed km in {time.time()-t0:.0f}s")
    return g, a


def _profiles(g: NetGraph):
    """Forward profile arrays (flat), per-edge start index P0, count NE, step H."""
    E = g.n_edges
    L = np.asarray(g.edge_len, float)
    NE = np.maximum(np.ceil(L / GRID).astype(np.int64) + 1, 3)
    P0 = np.concatenate([[0], np.cumsum(NE)])
    X = np.empty(P0[-1]); Y = np.empty(P0[-1]); PH = np.empty(P0[-1]); PG = np.empty(P0[-1])
    H = np.empty(E)
    for e in range(E):
        p = g.geom(e)
        d = np.hypot(*np.diff(p, axis=0).T)
        c = np.concatenate([[0.0], np.cumsum(d)])
        n = int(NE[e])
        Le = c[-1] if c[-1] > 0 else 1e-6
        u = np.linspace(0.0, Le, n)
        x = np.interp(u, c, p[:, 0]); y = np.interp(u, c, p[:, 1])
        k = np.clip(np.searchsorted(c, u, side="right") - 1, 0, len(d) - 1)
        dx, dy = p[k + 1, 0] - p[k, 0], p[k + 1, 1] - p[k, 1]
        h = np.unwrap(np.arctan2(dy, dx))
        hs = gaussian_filter1d(h, SM_M / (Le / (n - 1)), mode="nearest")
        a, b = P0[e], P0[e + 1]
        X[a:b], Y[a:b] = x, y
        PH[a:b] = hs
        PG[a:b] = np.gradient(hs, u)
        H[e] = Le / (n - 1)
    return L, NE, P0, X, Y, PH, PG, H


class Net:
    """Forward or reversed view of a NetGraph with profile arrays."""

    def __init__(self, g: NetGraph, reverse: bool, base=None):
        self.g, self.reverse = g, reverse
        if base is None:
            f = WORK / "cache" / "profiles.tmp"
            self.L, self.NE, self.P0, self.X, self.Y, self.PHraw, self.PGraw, self.Hs = _profiles(g)
            self.PH = self.PHraw.copy(); self.PG = self.PGraw.copy()
        else:
            self.L, self.NE, self.P0, self.Hs = base.L, base.NE, base.P0, base.Hs
            self.X, self.Y, self.PHraw, self.PGraw = base.X, base.Y, base.PHraw, base.PGraw
            # reverse every edge slice: index j -> n-1-j
            idx = np.empty(len(self.X), np.int64)
            e_of = np.repeat(np.arange(g.n_edges), self.NE)
            j = np.arange(len(self.X)) - self.P0[e_of]
            idx = self.P0[e_of] + (self.NE[e_of] - 1 - j)
            self.PH = self.PHraw[idx] + np.pi
            self.PH = (self.PH + np.pi) % (2 * np.pi) - np.pi
            self.PG = -self.PGraw[idx]
            self.X, self.Y = base.X[idx], base.Y[idx]
        self.PH = ((self.PH + np.pi) % (2 * np.pi) - np.pi)
        self.start = (np.asarray(g.edge_v) if reverse else np.asarray(g.edge_u)).astype(np.int64)
        self.end = (np.asarray(g.edge_u) if reverse else np.asarray(g.edge_v)).astype(np.int64)
        out = [[] for _ in range(g.n_nodes)]
        for e in range(g.n_edges):
            out[int(self.start[e])].append(e)
        self.out = [np.array(o, np.int64) for o in out]

    @staticmethod
    def build(g: NetGraph):
        fwd = Net(g, False)
        return fwd, Net(g, True, base=fwd)

    def succ(self, e: int) -> np.ndarray:
        o = self.out[int(self.end[e])]
        return o[self.end[o] != self.start[e]] if len(o) else o

    def idx(self, e, u):
        j = np.clip(np.rint(np.asarray(u) / self.Hs[e]).astype(np.int64), 0, self.NE[e] - 1)
        return self.P0[e] + j

    def phi(self, e, u):
        return self.PH[self.idx(e, u)]

    def xy(self, e, u) -> np.ndarray:
        i = self.idx(e, u)
        return np.column_stack([self.X[i], self.Y[i]])


class Snap:
    """KD-tree over every 3rd profile sample (6 m) of the forward net: nearest directed edges to a point (optionally with heading)."""

    def __init__(self, fwd: Net):
        e_of = np.repeat(np.arange(fwd.g.n_edges), fwd.NE)
        j = np.arange(len(fwd.X)) - fwd.P0[e_of]
        keep = (j % 3 == 0) | (j == fwd.NE[e_of] - 1)
        self.sel = np.flatnonzero(keep)
        self.eid = e_of[self.sel]
        self.off = j[self.sel] * fwd.Hs[self.eid]
        self.hd = fwd.PH[self.sel]
        self.pts = np.column_stack([fwd.X[self.sel], fwd.Y[self.sel]])
        self.tree = cKDTree(self.pts)

    def near(self, xy, radius, heading=None, max_deg=60.0, k=None):
        """[(edge, offset, dist)] best per edge within radius of xy, forward direction within max_deg of heading if given."""
        idx = self.tree.query_ball_point(np.asarray(xy, float), radius)
        best = {}
        for i in idx:
            if heading is not None:
                dh = abs((self.hd[i] - heading + np.pi) % (2 * np.pi) - np.pi)
                if math.degrees(dh) > max_deg:
                    continue
            d = float(np.hypot(*(self.pts[i] - xy)))
            e = int(self.eid[i])
            if e not in best or d < best[e][2]:
                best[e] = (e, float(self.off[i]), d)
        out = sorted(best.values(), key=lambda r: r[2])
        return out[:k] if k else out
