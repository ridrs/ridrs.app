# SPDX-License-Identifier: AGPL-3.0-or-later
"""State space of the dense HMM: cells of ~h metres along the directed edges of a NetGraph, and the sparse advance structure.

Cell = (directed edge, index along it). An edge of length L gets n = max(1, round(L / h)) cells of length L / n. Per cell: centre xy, road heading
(Gaussian-smoothed along its own edge, sigma `sm` m, on the unwrapped heading), cell length.
Advance entries (k = 1..K): src -> dst reached after k cells along the road. At the last cell of an edge the walk continues onto EVERY out-edge of the
end node; the reverse twin edge (a U-turn, same way, returning to the start node) carries a penalty `pen_uturn` (nats). With `uturn_deg` set, every other
node transition whose bearing reverses (end bearing of the incoming edge vs start bearing of the outgoing edge, each over the last / first `uturn_span` m of
the geometry, differ by more than `uturn_deg`) is a U-turn as well and carries the same penalty: a reversal onto the opposite one-way carriageway, a link or
through a junction triangle is otherwise free. An entry carries
  D     metres from src centre to dst centre along the path
  dphi  road heading change src -> dst (sum of the wrapped one-cell increments, so hairpins above 180 deg survive)
  w     path penalty (U-turns)
  ut    the path contains a U-turn (twin edge, or a node reversal with `uturn_deg`): rsm.hmm_cal.dp can add a per-step cost when the video does not turn
Entries of one k are stored twice: sorted by dst (forward pass / Viterbi) and sorted by src (backward pass).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.network.graph import NetGraph

PROF = 2.0  # m, heading profile grid inside an edge
CELL_COST_HOOK = None  # callable(graph, cell xy) -> nats per metre per cell, or None (rsm.pipeline.hints.activate_cost: the route hint's distance cost); None: off


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


@dataclass
class Group:
    """entries with the same advance k, sorted by dst (forward) and by src (backward)"""
    k: int
    src: np.ndarray      # int32, sorted by dst
    dst: np.ndarray      # int32
    D: np.ndarray        # float32
    dphi: np.ndarray     # float32
    w: np.ndarray        # float32
    starts: np.ndarray   # int64 start of every dst block
    ud: np.ndarray       # int32 unique dst, one per block
    blk: np.ndarray      # int32 block index of every entry
    # backward view, sorted by src
    b_src: np.ndarray = None
    b_dst: np.ndarray = None
    b_D: np.ndarray = None
    b_dphi: np.ndarray = None
    b_w: np.ndarray = None
    b_starts: np.ndarray = None
    b_us: np.ndarray = None
    b_blk: np.ndarray = None
    border: np.ndarray = None  # permutation dst-sorted -> src-sorted
    first: np.ndarray = None  # (n_cells,) index of the dst block of every cell in `starts` or -1
    ut: np.ndarray = None      # bool, the entry's path contains a U-turn (dst-sorted)
    b_ut: np.ndarray = None    # the same, src-sorted
    d_min: float = 0.0
    d_max: float = 0.0

    def __post_init__(self):
        if len(self.D):
            self.d_min = float(self.D.min())
            self.d_max = float(self.D.max())

    @property
    def n(self) -> int:
        return len(self.src)


@dataclass
class Grid:
    h: float
    edges: np.ndarray      # (Ee,) graph edge ids in the grid
    cell_edge: np.ndarray  # (N,) graph edge id of every cell
    cell_ei: np.ndarray    # (N,) local edge index (0..Ee-1)
    cell_i: np.ndarray     # index along the edge
    ell: np.ndarray        # (N,) cell length m
    off: np.ndarray        # (N,) offset of the cell centre along its edge
    xy: np.ndarray         # (N,2)
    phi: np.ndarray        # (N,) heading rad
    estart: np.ndarray     # (Ee+1,) first cell of every local edge
    groups: list = field(default_factory=list)
    g: NetGraph = None

    @property
    def N(self) -> int:
        return len(self.cell_edge)


def _edge_cells(g: NetGraph, e: int, n: int, sm: float):
    p = g.geom(e)
    d = np.hypot(*np.diff(p, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    L = c[-1]
    m = max(int(np.ceil(L / PROF)) + 1, 3)
    u = np.linspace(0.0, L, m)
    k = np.clip(np.searchsorted(c, u, side="right") - 1, 0, len(d) - 1)
    h = np.unwrap(np.arctan2(p[k + 1, 1] - p[k, 1], p[k + 1, 0] - p[k, 0]))
    hs = gaussian_filter1d(h, sm / (L / (m - 1)), mode="nearest")
    uc = (np.arange(n) + 0.5) * (L / n)
    x = np.interp(uc, c, p[:, 0]); y = np.interp(uc, c, p[:, 1])
    return uc, x, y, np.interp(uc, u, hs)


def _join(a_src, a_dst, a_D, a_dp, a_w, a_ut, e1, n_cells):
    """extend level-k entries by one level-1 step (CSR join on dst == src)"""
    s1, d1, D1, dp1, w1, ut1 = e1
    indptr = np.concatenate([[0], np.cumsum(np.bincount(s1, minlength=n_cells))])
    cnt = indptr[a_dst + 1] - indptr[a_dst]
    rep = np.repeat(np.arange(len(a_src)), cnt)
    if len(rep) == 0:
        return (np.zeros(0, np.int32),) * 2 + (np.zeros(0, np.float32),) * 3 + (np.zeros(0, bool),)
    pos = np.arange(len(rep)) - np.repeat(np.cumsum(cnt) - cnt, cnt) + indptr[a_dst[rep]]
    return (a_src[rep], d1[pos], (a_D[rep] + D1[pos]).astype(np.float32), (a_dp[rep] + dp1[pos]).astype(np.float32), (a_w[rep] + w1[pos]).astype(np.float32), a_ut[rep] | ut1[pos])


def _prune(e, dmax):
    m = e[2] <= dmax
    return tuple(a[m] for a in e)


def _group(k, src, dst, D, dp, w, ut, n_cells) -> Group:
    o = np.lexsort((src, dst))
    src, dst, D, dp, w, ut = src[o], dst[o], D[o], dp[o], w[o], ut[o]
    ch = np.flatnonzero(np.diff(dst) != 0) + 1
    starts = np.concatenate([[0], ch]).astype(np.int64) if len(dst) else np.zeros(0, np.int64)
    blk = (np.cumsum(np.isin(np.arange(len(dst)), starts)) - 1).astype(np.int32) if len(dst) else np.zeros(0, np.int32)
    ud = dst[starts].astype(np.int32) if len(dst) else np.zeros(0, np.int32)
    first = np.full(n_cells, -1, np.int32)
    first[ud] = np.arange(len(ud), dtype=np.int32)
    o2 = np.lexsort((dst, src))
    bs, bd, bD, bdp, bw = src[o2], dst[o2], D[o2], dp[o2], w[o2]
    ch2 = np.flatnonzero(np.diff(bs) != 0) + 1
    st2 = np.concatenate([[0], ch2]).astype(np.int64) if len(bs) else np.zeros(0, np.int64)
    blk2 = (np.cumsum(np.isin(np.arange(len(bs)), st2)) - 1).astype(np.int32) if len(bs) else np.zeros(0, np.int32)
    return Group(k, src.astype(np.int32), dst.astype(np.int32), D.astype(np.float32), dp.astype(np.float32), w.astype(np.float32), starts, ud, blk,
                 bs.astype(np.int32), bd.astype(np.int32), bD.astype(np.float32), bdp.astype(np.float32), bw.astype(np.float32), st2,
                 bs[st2].astype(np.int32) if len(bs) else np.zeros(0, np.int32), blk2, o2, first, ut.astype(bool), ut[o2].astype(bool))


def end_bearings(g: NetGraph, edges: np.ndarray, span: float):
    """-> (b0, b1) rad: bearing of the first `span` m of every edge (start -> point at span) and of its last `span` m (point at L - span -> end); short edges: chord"""
    b0 = np.empty(len(edges)); b1 = np.empty(len(edges))
    for j, e in enumerate(edges):
        p = g.geom(int(e))
        c = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
        L = c[-1]
        a = min(span, L)
        x0, y0 = np.interp(a, c, p[:, 0]), np.interp(a, c, p[:, 1])
        x1, y1 = np.interp(L - a, c, p[:, 0]), np.interp(L - a, c, p[:, 1])
        b0[j] = np.arctan2(y0 - p[0, 1], x0 - p[0, 0])
        b1[j] = np.arctan2(p[-1, 1] - y1, p[-1, 0] - x1)
    return b0, b1


def build(g: NetGraph, edges: np.ndarray | None = None, h: float = 30.0, sm: float = 10.0, K: int = 3, pen_uturn: float = 7.0, uturns: bool = True, zero: bool = True, dmax: float | None = None,
          edge_cost: np.ndarray | None = None, uturn_deg: float | None = None, uturn_span: float = 12.0) -> Grid:
    """edge_cost (optional, one value per entry of `edges`): log cost in nats per metre of entering / moving along a cell of that edge (a road-class prior).
    CELL_COST_HOOK (when set): a cost per cell in nats per metre on top of it (the distance to the route hint).
    uturn_deg (optional): node transitions that reverse the bearing by more than this are U-turns (pen_uturn, or dropped with uturns=False); None = twin only"""
    edges = np.arange(g.n_edges) if edges is None else np.asarray(edges, np.int64)
    Ee = len(edges)
    L = np.asarray(g.edge_len)[edges]
    n = np.maximum(1, np.rint(L / h).astype(np.int64))
    estart = np.concatenate([[0], np.cumsum(n)])
    N = int(estart[-1])
    cell_ei = np.repeat(np.arange(Ee), n)
    cell_i = np.arange(N) - estart[cell_ei]
    ell = (L / n)[cell_ei]
    off = (cell_i + 0.5) * ell
    xy = np.empty((N, 2)); phi = np.empty(N)
    for j, e in enumerate(edges):
        a, b = estart[j], estart[j + 1]
        _, x, y, hh = _edge_cells(g, int(e), int(n[j]), sm)
        xy[a:b, 0], xy[a:b, 1], phi[a:b] = x, y, hh
    phi = wrap(phi)
    # level-1 entries
    s_l, d_l, D_l, dp_l, w_l = [], [], [], [], []
    inner = np.flatnonzero(cell_i < n[cell_ei] - 1)
    s_l.append(inner); d_l.append(inner + 1); u_l = [np.zeros(len(inner), bool)]
    D_l.append(0.5 * (ell[inner] + ell[inner + 1])); dp_l.append(wrap(phi[inner + 1] - phi[inner])); w_l.append(np.zeros(len(inner)))
    # edge ends
    node_start = {}
    eu = np.asarray(g.edge_u)[edges]; ev = np.asarray(g.edge_v)[edges]; way = np.asarray(g.edge_way)[edges]
    order = np.argsort(eu, kind="stable")
    nodes_sorted = eu[order]
    last = estart[1:] - 1
    first_cell = estart[:-1]
    ss, dd, ww, uu = [], [], [], []
    if uturn_deg is not None:
        b0, b1 = end_bearings(g, edges, uturn_span)
        rev_cos = np.cos(np.deg2rad(uturn_deg))
    for j in range(Ee):
        lo, hi = np.searchsorted(nodes_sorted, [ev[j], ev[j] + 1])
        for jj in order[lo:hi]:
            twin = (ev[jj] == eu[j]) and (way[jj] == way[j])
            if not twin and uturn_deg is not None:
                twin = np.cos(b0[jj] - b1[j]) < rev_cos  # bearing reverses through the node
            if twin and not uturns:
                continue
            ss.append(last[j]); dd.append(first_cell[jj]); ww.append(-pen_uturn if twin else 0.0); uu.append(bool(twin))
    ss = np.array(ss, np.int64); dd = np.array(dd, np.int64)
    s_l.append(ss); d_l.append(dd)
    D_l.append(0.5 * (ell[ss] + ell[dd])); dp_l.append(wrap(phi[dd] - phi[ss])); w_l.append(np.array(ww, float)); u_l.append(np.array(uu, bool))
    e1 = (np.concatenate(s_l).astype(np.int32), np.concatenate(d_l).astype(np.int32), np.concatenate(D_l).astype(np.float32),
          np.concatenate(dp_l).astype(np.float32), np.concatenate(w_l).astype(np.float32), np.concatenate(u_l).astype(bool))
    cell_cost = CELL_COST_HOOK(g, xy) if CELL_COST_HOOK is not None else None
    if edge_cost is not None or cell_cost is not None:
        c = np.zeros(N) if edge_cost is None else np.asarray(edge_cost, np.float64)[cell_ei]
        if cell_cost is not None:
            c = c + np.asarray(cell_cost, np.float64)
        e1 = e1[:4] + ((e1[4] - c[e1[1]] * e1[2]).astype(np.float32),) + e1[5:]
    o = np.argsort(e1[0], kind="stable")  # CSR join needs level-1 entries sorted by src
    e1 = tuple(a[o] for a in e1)
    G = Grid(h, edges, edges[cell_ei], cell_ei, cell_i, ell, off, xy, phi, estart, [], g)
    if zero:  # k = 0: stay in the cell (stops in gap steps, advance slower than one cell per step)
        ar = np.arange(N, dtype=np.int32)
        G.groups.append(_group(0, ar, ar, np.zeros(N, np.float32), np.zeros(N, np.float32), np.zeros(N, np.float32), np.zeros(N, bool), N))
    dmax = 2.4 * h if dmax is None else dmax  # entries longer than this never matter for steps of about h metres (6 sd away): static pruning, not beam pruning
    e1 = _prune(e1, dmax)  # stays sorted by src
    cur = e1
    for k in range(1, K + 1):
        G.groups.append(_group(k, *cur, N))
        if k < K:
            # the walk through a node already added its centre-to-centre D; chaining two entries adds D of the second = centre(dst1)->centre(dst2): correct
            cur = _prune(_join(*cur, e1, N), dmax)
    return G


def twin_edges(g: NetGraph) -> np.ndarray:
    """(E,) the reverse twin edge id of every edge (same way, endpoints swapped) or -1"""
    key = {}
    for e in range(g.n_edges):
        key.setdefault((int(g.edge_u[e]), int(g.edge_v[e]), int(g.edge_way[e])), e)
    return np.array([key.get((int(g.edge_v[e]), int(g.edge_u[e]), int(g.edge_way[e])), -1) for e in range(g.n_edges)])


def memory_estimate(N: int, T: int, bp_bytes: int = 1, alpha_bytes: int = 2, forward_backward: bool = True) -> dict:
    """bytes of the big arrays of a full run (backpointers N x T, stored forward scores N x T for the posterior)"""
    bp = N * T * bp_bytes
    al = N * T * alpha_bytes if forward_backward else 0
    return dict(N=N, T=T, backpointers=bp, alphas=al, total=bp + al, total_gb=(bp + al) / 1e9)


def check_budget(N: int, T: int, cap_gb: float = 4.0, **kw) -> dict:
    est = memory_estimate(N, T, **kw)
    if est["total_gb"] > cap_gb:
        raise MemoryError(f"HMM arrays would need {est['total_gb']:.2f} GB (states {N} x steps {T}) > cap {cap_gb} GB; use a corridor, a coarser grid or fewer outputs")
    return est
