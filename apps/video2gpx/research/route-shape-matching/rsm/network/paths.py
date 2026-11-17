# SPDX-License-Identifier: AGPL-3.0-or-later
"""Candidate directed paths (bounded DFS in metres) and their turn sequences.

A path = sequence of directed edges starting at a NODE, node-simple (no node, hence no edge, repeated; so no U-turn and no loop), with
the first edge that brings the cumulative length to >= L ending the search; the polyline is then cut at exactly L (the last edge is
partial). Paths that dead-end before L are not emitted (counted). A video does not start at a node: the matcher cuts sub-paths
(start offset along the first edge) of these; every sub-path of a longer node-start path is a node-start-path-prefix of another
start (or a suffix of this one), so the node-start set covers all positions up to the first-edge length.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np

from rsm.odometry.turns import Turn, TurnParams, detect_turns

from .graph import NetGraph


class PathLimitExceeded(RuntimeError):
    def __init__(self, msg: str, emitted: int, expansions: int):
        super().__init__(msg)
        self.emitted, self.expansions = emitted, expansions


@dataclass
class PathSet:
    L: float
    edges: np.ndarray  # (sum,) int32 edge ids
    off: np.ndarray  # (n+1,)
    total_len: np.ndarray  # (n,) full length of the edges (>= L)
    expansions: int
    dead_ends: int
    seconds: float
    count: int = 0  # number of paths found (== len(self) unless store=False)

    def __len__(self) -> int:
        return len(self.off) - 1

    def path_edges(self, i: int) -> np.ndarray:
        return self.edges[self.off[i]:self.off[i + 1]]


def enumerate_paths(g: NetGraph, L: float, *, starts=None, max_paths: int = 5_000_000, max_expansions: int = 50_000_000,
                    allow=None, out=None, store: bool = True) -> PathSet:
    """Bounded DFS. `allow(prefix_edges: list[int], length: float) -> bool` (optional) prunes a prefix after each added edge: the hook a
    sequence-driven matcher can use. Raises PathLimitExceeded (never truncates silently) when max_paths/max_expansions is hit."""
    t0 = time.time()
    out = out if out is not None else g.out_edges()
    eu, ev, el = g.edge_u, g.edge_v, g.edge_len
    starts = range(g.n_nodes) if starts is None else starts
    flat: list[int] = []
    off = [0]
    tot: list[float] = []
    expansions = dead = n_found = 0
    for s in starts:
        visited = {int(s)}
        path: list[int] = []
        # stack of iterators over out edges
        lens = [0.0]
        stack = [iter(out[int(s)])]
        while stack:
            try:
                e = next(stack[-1])
            except StopIteration:
                stack.pop()
                if path:
                    visited.discard(int(ev[path.pop()]))
                    lens.pop()
                continue
            v = int(ev[e])
            if v in visited:  # also covers the immediate U-turn
                continue
            expansions += 1
            if expansions > max_expansions:
                raise PathLimitExceeded(f"max_expansions {max_expansions} exceeded at L={L}", n_found, expansions)
            ln = lens[-1] + float(el[e])
            path.append(e)
            if allow is not None and not allow(path, ln):
                path.pop()
                continue
            if ln >= L:
                n_found += 1
                if store:
                    flat.extend(path)
                    off.append(len(flat))
                    tot.append(ln)
                if n_found > max_paths:
                    raise PathLimitExceeded(f"max_paths {max_paths} exceeded at L={L}", n_found, expansions)
                path.pop()
                continue
            nxt = out[v]
            if not any(int(ev[x]) not in visited and int(ev[x]) != v for x in nxt):
                dead += 1
            visited.add(v)
            lens.append(ln)
            stack.append(iter(nxt))
    return PathSet(L, np.array(flat, np.int32), np.array(off, np.int64), np.array(tot), expansions, dead, time.time() - t0, n_found)


# ---- geometry -> heading -> turns -------------------------------------------------------------------------------------------------

def path_polyline(g: NetGraph, edges, L: float | None = None) -> np.ndarray:
    """Concatenated edge geometry (N,2) in the projected CRS, cut at arc length L if given."""
    pts = [g.geom(int(e)) if i == 0 else g.geom(int(e))[1:] for i, e in enumerate(edges)]
    p = np.vstack(pts)
    if L is None:
        return p
    d = np.hypot(*np.diff(p, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    if c[-1] <= L:
        return p
    k = int(np.searchsorted(c, L))
    f = (L - c[k - 1]) / d[k - 1]
    return np.vstack([p[:k], p[k - 1] + f * (p[k] - p[k - 1])])


def densify_smooth(p: np.ndarray, step: float = 5.0, smooth: float = 0.0) -> np.ndarray:
    """Quality check: C2 cubic spline (chord-length parametrised, optional smoothing in m^2) through the vertices, resampled every `step` m."""
    from scipy.interpolate import splev, splprep
    d = np.hypot(*np.diff(p, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    if len(p) < 4:
        return p
    keep = np.concatenate([[True], d > 1e-6])
    tck, _ = splprep([p[keep, 0], p[keep, 1]], u=c[keep], s=smooth * len(p) if smooth else 0, k=3)
    u = np.arange(0, c[-1], step)
    x, y = splev(u, tck)
    return np.column_stack([x, y])


def heading_curve(p: np.ndarray, step: float = 1.0):
    """(s, theta, s_total): theta(s) on a `step`-metre grid, rsm convention (direction (dx,dy) = (-sin th, cos th), left positive),
    unwrapped, piecewise constant per polyline segment (exact geometry, no invented smoothness; detect_turns smooths with its 6 m Gaussian)."""
    d = np.diff(p, axis=0)
    seg = np.hypot(d[:, 0], d[:, 1])
    ok = seg > 1e-9
    d, seg = d[ok], seg[ok]
    th = np.unwrap(np.arctan2(-d[:, 0], d[:, 1]))
    c = np.concatenate([[0.0], np.cumsum(seg)])
    s = np.arange(0.0, c[-1] + 1e-9, step)
    k = np.minimum(np.searchsorted(c, s, side="right") - 1, len(th) - 1)
    return s, th[k], float(c[-1])


def turns_of_polyline(p: np.ndarray, params: TurnParams = TurnParams()) -> list[Turn]:
    s, th, _ = heading_curve(p, params.step_m)
    return detect_turns(s, th, s, params)
