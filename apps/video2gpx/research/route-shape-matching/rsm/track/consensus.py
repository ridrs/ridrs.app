# SPDX-License-Identifier: AGPL-3.0-or-later
"""Consensus over the whole-video routes of many anchors: local goodness, route similarity, clusters, final decision, stitched route.

good(route, t): the windowed mean step cost around t is at most g_thr (the route fits the vms there without large corrections).
sim(a, b): over the video time where BOTH routes are good, the share where their positions are within `near` m. Two true routes that each break
down somewhere else still agree where both are good; a wrong route agrees with nothing. Leader clustering in order of cost per km; a route joins the
first cluster whose leader it agrees with (sim >= sim_min over at least `min_common_s` common-good seconds), else it starts a new one.
Decision: the cluster with the most distinct anchors (ties: lower mean cost per km). Stitched route: per time grid point, the member that is locally
good with the lowest windowed cost; times where no member is good stay undecided.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import uniform_filter1d

GRID_S = 4.0


@dataclass(frozen=True)
class CParams:
    g_win: int = 15  # steps (about 30 s)
    g_thr: float = 0.45  # windowed mean cost per step
    near: float = 40.0
    sim_min: float = 0.6
    min_common_s: float = 240.0


def local_cost(route, win: int) -> np.ndarray:
    return uniform_filter1d(route.inc, win, mode="nearest")


class Grid:
    """routes resampled on one common time grid"""

    def __init__(self, routes, cp: CParams):
        t0 = min(r.t[0] for r in routes); t1 = max(r.t[-1] for r in routes)
        self.t = np.arange(t0, t1, GRID_S)
        n = len(routes)
        self.x = np.full((n, len(self.t)), np.nan); self.y = np.full_like(self.x, np.nan)
        self.good = np.zeros((n, len(self.t)), bool); self.lc = np.full_like(self.x, np.inf)
        for i, r in enumerate(routes):
            m = (self.t >= r.t[0]) & (self.t <= r.t[-1])
            lc = local_cost(r, cp.g_win)
            self.x[i, m] = np.interp(self.t[m], r.t, r.xy[:, 0]); self.y[i, m] = np.interp(self.t[m], r.t, r.xy[:, 1])
            self.lc[i, m] = np.interp(self.t[m], r.t, lc)
            self.good[i] = m & (self.lc[i] <= cp.g_thr)

    def sim(self, i, j, cp: CParams):
        both = self.good[i] & self.good[j]
        n = int(both.sum())
        if n == 0:
            return 0.0, 0.0
        d = np.hypot(self.x[i, both] - self.x[j, both], self.y[i, both] - self.y[j, both])
        return float((d <= cp.near).mean()), n * GRID_S


def cluster(routes, cp: CParams = CParams()):
    """-> dict(clusters=[[idx...]] sorted by decision rank, grid, order)."""
    grid = Grid(routes, cp)
    cpk = np.array([r.cost_per_km for r in routes])
    order = np.argsort(cpk)
    leaders, members = [], []
    for i in order:
        placed = False
        for ci, ld in enumerate(leaders):
            s, c = grid.sim(i, ld, cp)
            if c >= cp.min_common_s and s >= cp.sim_min:
                members[ci].append(int(i)); placed = True
                break
        if not placed:
            leaders.append(int(i)); members.append([int(i)])
    rank = sorted(range(len(members)), key=lambda c: (-len(members[c]), np.mean(cpk[members[c]])))
    return dict(clusters=[members[c] for c in rank], leaders=[leaders[c] for c in rank], grid=grid, cpk=cpk)


def stitched(routes, members, grid: Grid):
    """positions on the grid chosen from the locally best good member; nan where no member is good."""
    x = np.full(len(grid.t), np.nan); y = np.full(len(grid.t), np.nan); src = -np.ones(len(grid.t), int)
    lc = np.where(grid.good[members], grid.lc[members], np.inf)
    best = np.argmin(lc, axis=0)
    okc = np.isfinite(lc[best, np.arange(len(grid.t))])
    x[okc] = grid.x[np.array(members)[best[okc]], np.flatnonzero(okc)]; y[okc] = grid.y[np.array(members)[best[okc]], np.flatnonzero(okc)]
    src[okc] = np.array(members)[best[okc]]
    return grid.t, x, y, src


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """probability that a random positive (true) has LOWER cost than a random negative (wrong)."""
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    if len(pos) == 0 or len(neg) == 0:
        return np.nan
    return float(((pos[:, None] < neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()))
