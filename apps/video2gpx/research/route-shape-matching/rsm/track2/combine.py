# SPDX-License-Identifier: AGPL-3.0-or-later
"""One route per video from the routes of many anchors, also when each anchor is right in a different part of the video (v3).

Pieces: the stretches where a route fits locally (windowed cost <= g_thr, at least min_piece_s). A dynamic programme over the 4 s time grid picks, at each
time, one piece (or none = undecided) and maximises the summed fit  4 s (1 - lc / g_thr)  with these connections:
  * stay in a piece: free;
  * switch between two pieces that are active at the same time: only where their positions agree (<= snap_m), small penalty;
  * undecided -> a piece that starts later: the piece must be connected to the last decided position: a road path from the last position of the previous
    piece to the first position of the new one whose length matches the nominal vms distance in between (+-30 % +-100 m, the snap and gap rules) costs
    reach_pen; a piece that is not connected costs disc_pen (the chain may restart, but it must pay for it);
  * the first piece is free.
Wrong anchors cannot be attached cheaply: their pieces are short and are not connected to the chain; so the chain follows the consistent long pieces.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass

import numpy as np

from .consensus import GRID_S, CParams, Grid


@dataclass(frozen=True)
class KParams:
    min_piece_s: float = 45.0
    merge_s: float = 12.0
    snap_m: float = 60.0
    sw_pen: float = 8.0  # seconds-equivalents
    reach_pen: float = 6.0
    disc_pen: float = 200.0
    tol_rel: float = 0.3
    tol_abs: float = 100.0
    max_pieces: int = 150  # keep the pieces with the largest summed fit


def road_dist(net, e1, u1, e2, u2, dmax):
    """shortest directed road distance from (e1, u1) to (e2, u2), inf above dmax"""
    L = net.L
    if e1 == e2 and u2 >= u1:
        return u2 - u1
    best = np.inf
    h = [(L[e1] - u1, int(e1))]
    seen = {}
    while h:
        d, e = heapq.heappop(h)
        if d > dmax or d >= best:
            break
        for x in net.succ(e):
            x = int(x)
            if x == e2:
                best = min(best, d + u2)
            nd = d + float(L[x])
            if nd <= dmax and seen.get(x, np.inf) > nd:
                seen[x] = nd
                heapq.heappush(h, (nd, x))
    return best


def cum_nominal(S, kappa):
    """(t, cumulative nominal metres incl. gaps) on the vms steps"""
    sf = S["sf"]
    T, Cm = [], []
    c = 0.0
    for i, sg in enumerate(sf.segs):
        for t, ds in zip(sg.t, sg.ds):
            c += ds
            T.append(t); Cm.append(c)
        if i < len(sf.gnom):
            c += sf.gnom[i]
    return np.array(T), np.array(Cm) * kappa


def combine(routes, S, cp: CParams = CParams(), kp: KParams = KParams(), kappa=None, grid=None):
    grid = grid or Grid(routes, cp)
    fw = S["fw"]
    kappa = kappa or S["ctx"].kappa0
    tc, cc = cum_nominal(S, kappa)
    nt = len(grid.t)
    from scipy.ndimage import uniform_filter1d  # noqa: F401
    pieces = []
    for i in range(len(routes)):
        g = grid.good[i].copy()
        # merge short breaks
        idx = np.flatnonzero(g)
        if len(idx) == 0:
            continue
        runs = []
        a = idx[0]; b = idx[0]
        for j in idx[1:]:
            if (j - b) * GRID_S <= kp.merge_s:
                b = j
            else:
                runs.append((a, b)); a = b = j
        runs.append((a, b))
        for a, b in runs:
            if (b - a + 1) * GRID_S >= kp.min_piece_s:
                pieces.append((i, int(a), int(b)))
    if len(pieces) > kp.max_pieces:
        def _val(pc):
            i, a, b = pc
            lc = np.where(np.isfinite(grid.lc[i, a:b + 1]), grid.lc[i, a:b + 1], cp.g_thr)
            return float(np.maximum(1.0 - lc / cp.g_thr, 0).sum())
        pieces = sorted(sorted(pieces, key=_val, reverse=True)[: kp.max_pieces], key=lambda p: (p[1], p[0]))
    P = len(pieces)
    if P == 0:
        return dict(t=grid.t, x=np.full(nt, np.nan), y=np.full(nt, np.nan), src=-np.ones(nt, int), decided=np.zeros(nt, bool), pieces=[], chosen=[])
    pa = np.array([p[1] for p in pieces]); pb = np.array([p[2] for p in pieces]); pr = np.array([p[0] for p in pieces])
    rew = np.zeros((P, nt))
    for q, (i, a, b) in enumerate(pieces):
        lc = np.where(np.isfinite(grid.lc[i, a:b + 1]), grid.lc[i, a:b + 1], cp.g_thr)
        rew[q, a:b + 1] = np.maximum(GRID_S * (1.0 - lc / cp.g_thr), 0.0)
    cache = {}

    def reach_pen(p, q):
        k = (p, q)
        if k in cache:
            return cache[k]
        i, ib = pieces[p][0], pieces[p][2]; j, ja = pieces[q][0], pieces[q][1]
        r1, r2 = routes[i], routes[j]
        t1, t2 = grid.t[ib], grid.t[ja]
        v = kp.disc_pen
        if t2 > t1:
            dn = float(np.interp(t2, tc, cc) - np.interp(t1, tc, cc))
            a_ = int(np.argmin(np.abs(r1.t - t1))); b_ = int(np.argmin(np.abs(r2.t - t2)))
            eu = float(np.hypot(*(r1.xy[a_] - r2.xy[b_])))
            if eu <= dn * (1 + kp.tol_rel) + kp.tol_abs:
                d = road_dist(fw, int(r1.E[a_]), float(r1.U[a_]), int(r2.E[b_]), float(r2.U[b_]), dn * (1 + kp.tol_rel) + kp.tol_abs)
                if np.isfinite(d) and dn * (1 - kp.tol_rel) - kp.tol_abs <= d <= dn * (1 + kp.tol_rel) + kp.tol_abs:
                    v = kp.reach_pen
        cache[k] = v
        return v

    active_at = [[] for _ in range(nt)]
    for q in range(P):
        for t in range(pa[q], pb[q] + 1):
            active_at[t].append(q)
    # states: ('p', q) piece, ('i', q) idle after piece q, ('i', -1) idle before anything
    val_prev = {('i', -1): 0.0}
    bp = []  # per time: dict state -> prev state
    for t in range(nt):
        val = {}; back = {}
        act = active_at[t]
        # idle
        for s, v in val_prev.items():
            if s[0] == 'i':
                if s not in val or v > val[s]:
                    val[s] = v; back[s] = s
            else:
                q = s[1]
                if pb[q] == t - 1:  # piece ended: may become idle
                    k = ('i', q)
                    if k not in val or v > val[k]:
                        val[k] = v; back[k] = s
        # pieces
        if act:
            xs = np.array([grid.x[pr[q], t] for q in act]); ys = np.array([grid.y[pr[q], t] for q in act])
        for ai, q in enumerate(act):
            best = -np.inf; bs = None
            s = ('p', q)
            if s in val_prev:
                best, bs = val_prev[s], s
            for aj, p in enumerate(act):
                if p == q or ('p', p) not in val_prev:
                    continue
                if np.hypot(xs[ai] - xs[aj], ys[ai] - ys[aj]) <= kp.snap_m:
                    v = val_prev[('p', p)] - kp.sw_pen
                    if v > best:
                        best, bs = v, ('p', p)
            if pa[q] == t:
                for s2, v in val_prev.items():
                    if s2[0] != 'i':
                        continue
                    pen = 0.0 if s2[1] == -1 else reach_pen(s2[1], q)
                    if v - pen > best:
                        best, bs = v - pen, s2
            if bs is not None:
                val[('p', q)] = best + rew[q, t]; back[('p', q)] = bs
        # (a chain that has not started stays at 0 in ('i',-1), carried above)
        ib = max([v for k, v in val.items() if k[0] == 'i'], default=None)
        if ib is not None:
            for k in [k for k, v in val.items() if k[0] == 'i' and v < ib - kp.disc_pen]:
                del val[k]
        bp.append(back); val_prev = val
    # backtrack
    s = max(val_prev, key=lambda k: val_prev[k])
    total = val_prev[s]
    src = -np.ones(nt, int); sel = []
    for t in range(nt - 1, -1, -1):
        if s[0] == 'p':
            src[t] = pr[s[1]]
            if not sel or sel[-1] != s[1]:
                sel.append(s[1])
        s = bp[t][s]
    sel = sel[::-1]
    x = np.full(nt, np.nan); y = np.full(nt, np.nan)
    m = src >= 0
    x[m] = grid.x[src[m], np.flatnonzero(m)]; y[m] = grid.y[src[m], np.flatnonzero(m)]
    return dict(t=grid.t, x=x, y=y, src=src, decided=m, pieces=pieces, chosen=sel, value=total, n_pieces=P, grid=grid)


def fill(res, routes):
    """positions at all grid times: decided pieces as chosen; undecided times continue the nearest decided piece's route (its own positions)"""
    t = res["t"]; x = res["x"].copy(); y = res["y"].copy(); src = res["src"].copy()
    dec = np.flatnonzero(res["decided"])
    if len(dec) == 0:
        return x, y, src
    for k in np.flatnonzero(~res["decided"]):
        j = dec[np.argmin(np.abs(dec - k))]
        r = routes[src[j]]
        if r.t[0] <= t[k] <= r.t[-1]:
            x[k] = np.interp(t[k], r.t, r.xy[:, 0]); y[k] = np.interp(t[k], r.t, r.xy[:, 1]); src[k] = src[j]
    return x, y, src
