# SPDX-License-Identifier: AGPL-3.0-or-later
"""Map path of a candidate chain: the edges of its legs (skipped quanta bridged through <= 3 legs), extended at both ends along the straightest road.

Heading phi(u) of the path (rad, left +, unwrapped, 2 m grid, 6 m Gaussian) is what the video heading is fitted to.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree

from rsm.network.paths import heading_curve

GRID = 2.0
EXT_M = 300.0


@dataclass
class MapPath:
    edges: list
    xy: np.ndarray  # dense (m,2) at GRID spacing
    u: np.ndarray  # arc length of xy
    phi: np.ndarray  # heading at u
    ev_u: np.ndarray  # arc length of the matched event positions (b of each chain leg, a of the first)
    ev_xy: np.ndarray
    tree: cKDTree
    n_jump: int  # edge joins that were not connected in the graph

    @property
    def U(self) -> float:
        return float(self.u[-1])

    def at(self, u):
        u = np.clip(np.asarray(u, float), 0, self.U)
        return np.column_stack([np.interp(u, self.u, self.xy[:, 0]), np.interp(u, self.u, self.xy[:, 1])])


class GraphIdx:
    def __init__(self, g):
        self.g = g
        self.out = g.out_edges()
        self.inn = [[] for _ in range(g.n_nodes)]
        for e, v in enumerate(g.edge_v):
            self.inn[int(v)].append(e)

    def edge_heading(self, e, end):
        p = self.g.geom(e)
        d = (p[-1] - p[-2]) if end else (p[1] - p[0])
        return np.arctan2(d[1], d[0])

    def extend_fwd(self, edges, m=EXT_M):
        g, tot, e = self.g, 0.0, edges[-1]
        for _ in range(8):
            if tot >= m:
                break
            nxt = [x for x in self.out[int(g.edge_v[e])] if int(g.edge_v[x]) != int(g.edge_u[e]) and x not in edges]
            if not nxt:
                break
            h0 = self.edge_heading(e, True)
            x = min(nxt, key=lambda x: abs((self.edge_heading(x, False) - h0 + np.pi) % (2 * np.pi) - np.pi))
            edges.append(int(x)); tot += float(g.edge_len[x]); e = x
        return edges

    def extend_bwd(self, edges, m=EXT_M):
        g, tot, e = self.g, 0.0, edges[0]
        for _ in range(8):
            if tot >= m:
                break
            prv = [x for x in self.inn[int(g.edge_u[e])] if int(g.edge_u[x]) != int(g.edge_v[e]) and x not in edges]
            if not prv:
                break
            h0 = self.edge_heading(e, False)
            x = min(prv, key=lambda x: abs((self.edge_heading(x, True) - h0 + np.pi) % (2 * np.pi) - np.pi))
            edges.insert(0, int(x)); tot += float(g.edge_len[x]); e = x
        return edges


def _bridge(ix, a: int, b: int, hops: int = 3):
    """shortest sequence of leg ids from event a to event b (<= hops legs) or None."""
    if a == b:
        return []
    best = {a: (0.0, None)}
    frontier = [a]
    for _ in range(hops):
        nxt = []
        for ev in frontier:
            lo, hi = ix.out_ptr[ev], ix.out_ptr[ev + 1]
            for j in range(lo, hi):
                y, d = int(ix.out_b[j]), best[ev][0] + float(ix.out_d[j])
                if y not in best or d < best[y][0]:
                    best[y] = (d, (ev, int(ix.out_legs[j])))
                    nxt.append(y)
        frontier = nxt
    if b not in best:
        return None
    seq, cur = [], b
    while best[cur][1] is not None:
        ev, lg = best[cur][1]
        seq.append(lg); cur = ev
    return seq[::-1]


def chain_edges(m: dict, ix, chain_legs) -> tuple[list, int]:
    """edges of the chain's legs in order; the matched legs are marked by returning also their positions"""
    le, lo = m["leg_edges"], m["leg_edges_off"]
    seq = []
    miss = 0
    prev_b = None
    for _, lg in chain_legs:
        a = int(ix.A[lg])
        if prev_b is not None and prev_b != a:
            br = _bridge(ix, prev_b, a)
            if br is None:
                miss += 1
            else:
                seq.extend(br)
        seq.append(int(lg))
        prev_b = int(ix.B[lg])
    edges = []
    for lg in seq:
        for e in le[lo[lg]:lo[lg + 1]]:
            if not edges or edges[-1] != e:
                edges.append(int(e))
    return edges, miss


def build_path(m, ix, gi: GraphIdx, chain_legs, ext: float = EXT_M) -> MapPath | None:
    if not chain_legs:
        return None
    g = gi.g
    edges, miss = chain_edges(m, ix, chain_legs)
    if not edges:
        return None
    # connect disconnected joins by the shortest 1-3 edge path, else count as jump
    full, nj = [edges[0]], miss
    for e in edges[1:]:
        last = full[-1]
        if int(g.edge_v[last]) != int(g.edge_u[e]):
            fill = None
            for x in gi.out[int(g.edge_v[last])]:
                if int(g.edge_v[x]) == int(g.edge_u[e]):
                    fill = [x]; break
            if fill is None:
                nj += 1
            else:
                full.extend(fill)
        full.append(e)
    full = gi.extend_bwd(gi.extend_fwd(full, ext), ext)
    parts = [g.geom(e) if i == 0 else g.geom(e)[1:] for i, e in enumerate(full)]
    pts = np.vstack(parts)
    s, th, tot = heading_curve(pts, GRID)
    th = gaussian_filter1d(th, 6.0 / GRID, mode="nearest")
    d = np.hypot(*np.diff(pts, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    xy = np.column_stack([np.interp(s, c, pts[:, 0]), np.interp(s, c, pts[:, 1])])
    tree = cKDTree(xy)
    evs = [int(ix.A[chain_legs[0][1]])] + [int(ix.B[lg]) for _, lg in chain_legs]
    evxy = ix.ev_mid[evs]
    _, ii = tree.query(evxy)
    evu = np.maximum.accumulate(s[ii])
    return MapPath(full, xy, s, th, evu, evxy, tree, nj)


def path_from_xy(pts: np.ndarray, edges=(), ev_xy=None) -> MapPath:
    """MapPath from a polyline (used by tests and figures)."""
    s, th, tot = heading_curve(pts, GRID)
    th = gaussian_filter1d(th, 6.0 / GRID, mode="nearest")
    d = np.hypot(*np.diff(pts, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    xy = np.column_stack([np.interp(s, c, pts[:, 0]), np.interp(s, c, pts[:, 1])])
    return MapPath(list(edges), xy, s, th, np.zeros(0), np.zeros((0, 2)), cKDTree(xy), 0)
