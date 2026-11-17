# SPDX-License-Identifier: AGPL-3.0-or-later
"""Decoded HMM path -> a route object that rsm.track2.score and rsm.track2.fig.dots understand (t, xy, E, flag), and scoring helpers."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from rsm.network.graph import NetGraph
from rsm.track2 import score
from rsm.track2.graphs import WORK as T2WORK

from .grid import Grid
from .seq import Steps


@dataclass
class Route:
    t: np.ndarray
    xy: np.ndarray
    E: np.ndarray
    flag: np.ndarray
    step_t: np.ndarray = None
    step_cell: np.ndarray = None
    km: float = 0.0
    cost_per_km: float = 0.0


class SuccOnly:
    """the part of rsm.track2.graphs.Net that score.junctions needs (succ), without building the 2 m profiles"""

    def __init__(self, g: NetGraph):
        self.g = g
        self.start = np.asarray(g.edge_u).astype(np.int64); self.end = np.asarray(g.edge_v).astype(np.int64)
        out = [[] for _ in range(g.n_nodes)]
        for e in range(g.n_edges):
            out[int(self.start[e])].append(e)
        self.out = [np.array(o, np.int64) for o in out]

    def succ(self, e: int) -> np.ndarray:
        o = self.out[int(self.end[e])]
        return o[self.end[o] != self.start[e]] if len(o) else o


def decode(grid: Grid, st: Steps, path: np.ndarray, dt: float = 1.0) -> Route:
    ok = path >= 0
    t = st.t[ok]; c = path[ok]
    t = t + 1e-6 * np.arange(len(t))
    tt = np.arange(t[0], t[-1], dt)
    x = np.interp(tt, t, grid.xy[c, 0]); y = np.interp(tt, t, grid.xy[c, 1])
    idx = np.clip(np.searchsorted(t, tt), 0, len(t) - 1)
    near = np.where(np.abs(t[np.clip(idx - 1, 0, None)] - tt) < np.abs(t[idx] - tt), np.clip(idx - 1, 0, None), idx)
    return Route(tt, np.column_stack([x, y]), grid.cell_edge[c[near]].astype(np.int64), np.zeros(len(tt), bool), t, c, float(st.km))


def correct_flags(route: Route, truth: score.Truth, tol: float = 30.0):
    """per route sample: (within tol of the GPS, on a directed edge of the map-matched GPS path within +-40 s)"""
    d = truth.dist(route.t, route.xy)
    mm = truth.mm
    on = np.zeros(len(route.t), bool)
    for i in range(len(route.t)):
        lo, hi = np.searchsorted(mm["t"], [route.t[i] - 40, route.t[i] + 40])
        on[i] = bool((mm["edge"][lo:hi] == route.E[i]).any())
    return d <= tol, on, d


def edges_near(g: NetGraph, xy: np.ndarray, radius: float, thin: float = 50.0) -> np.ndarray:
    """edge ids with any geometry vertex within `radius` m of the polyline xy (thinned)"""
    from scipy.spatial import cKDTree
    d = np.hypot(*np.diff(xy, axis=0).T)
    s = np.concatenate([[0], np.cumsum(d)])
    keep = np.unique(np.searchsorted(s, np.arange(0, s[-1], thin)))
    tree = cKDTree(xy[keep])
    dist, _ = tree.query(g.edge_geom)
    m = np.minimum.reduceat(dist, g.edge_off[:-1])
    return np.flatnonzero(m <= radius)
