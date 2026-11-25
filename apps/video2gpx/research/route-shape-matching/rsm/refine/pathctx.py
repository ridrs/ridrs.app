# SPDX-License-Identifier: AGPL-3.0-or-later
"""The decoded HMM route as a path (sequence of directed edges, arc length s in metres) plus the video-side ruler D(t) (cumulative nominal vms distance) and the
baseline positions: Viterbi path and posterior mean, both as arc length at the step times."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from rsm.network.graph import NetGraph


def cell_layout(g: NetGraph, edges: np.ndarray | None, h: float):
    """(cell_edge graph ids, off = offset of the cell centre along its edge) exactly as rsm.hmm.grid.build (no transition tables)"""
    edges = np.arange(g.n_edges) if edges is None else np.asarray(edges, np.int64)
    L = np.asarray(g.edge_len)[edges]
    n = np.maximum(1, np.rint(L / h).astype(np.int64))
    ce = np.repeat(np.arange(len(edges)), n)
    estart = np.concatenate([[0], np.cumsum(n)])
    ci = np.arange(int(estart[-1])) - estart[ce]
    return edges[ce], (ci + 0.5) * (L / n)[ce]


def step_index(st_t: np.ndarray, step_t, atol: float = 0.01) -> np.ndarray:
    """Indices into the step times st_t of a stored route's step times (rsm.pipeline.steps_b.decode_route, rsm.hmm.route.decode). Those carry a tie-break of
    1e-6 s x the route step number, removed here first: it reaches the tolerance atol at 10,000 steps, and a longer route (the local pass of a 2 h video
    with 15 m steps) then matched the next step and failed."""
    tt = np.asarray(step_t, float)
    tt = tt - 1e-6 * np.arange(len(tt))
    idx = np.clip(np.searchsorted(st_t, tt - atol), 0, len(st_t) - 1)
    if not np.allclose(st_t[idx], tt, atol=atol, rtol=0.0):
        raise AssertionError("stored route and rebuilt steps differ")
    return idx


def _connect(g: NetGraph, out, e_from: int, e_to: int, depth: int = 5) -> list[int] | None:
    """shortest chain of edges strictly between e_from and e_to (BFS by length), [] if adjacent, None if not reachable"""
    tgt = int(g.edge_u[e_to])
    if int(g.edge_v[e_from]) == tgt:
        return []
    best = {int(g.edge_v[e_from]): (0.0, [])}
    front = [int(g.edge_v[e_from])]
    for _ in range(depth):
        nxt = []
        for n in front:
            for e in out[n]:
                v = int(g.edge_v[e]); c = best[n][0] + float(g.edge_len[e])
                if v not in best or c < best[v][0]:
                    best[v] = (c, best[n][1] + [e]); nxt.append(v)
        front = nxt
    return best[tgt][1] if tgt in best else None


@dataclass
class Path:
    g: NetGraph
    occ: np.ndarray          # (M,) graph edge id of every occurrence along the path
    start: np.ndarray        # (M+1,) arc length at the start of every occurrence
    sg: np.ndarray           # 1 m grid of arc length
    xy: np.ndarray           # (n,2) point on the OSM polyline
    phi: np.ndarray          # (n,) heading of the OSM polyline segment, unwrapped (rad, left +)
    tunnel: np.ndarray       # (n,) bool, OSM tunnel edge
    filled: int = 0          # edges inserted to connect steps that skipped over a short edge
    breaks: tuple[float, ...] = ()   # arc lengths (m) where consecutive edges are disconnected (free cut jumps)

    @property
    def length(self) -> float:
        return float(self.start[-1])

    def xy_at(self, s) -> np.ndarray:
        s = np.clip(np.asarray(s, float), 0, self.sg[-1])
        return np.column_stack([np.interp(s, self.sg, self.xy[:, 0]), np.interp(s, self.sg, self.xy[:, 1])])

    def heading_at(self, s, half: float = 10.0) -> np.ndarray:
        """compass heading (deg, clockwise from north) of the direction of travel, from the chord s-half .. s+half"""
        a, b = self.xy_at(np.asarray(s, float) - half), self.xy_at(np.asarray(s, float) + half)
        d = b - a
        return (np.degrees(np.arctan2(d[:, 0], d[:, 1])) + 360.0) % 360.0

    def tunnel_runs(self) -> list[tuple[float, float]]:
        """[(s_entry, s_exit)] of the maximal runs of OSM tunnel edges"""
        out, i, M = [], 0, len(self.occ)
        tun = np.asarray(self.g.edge_tunnel)[self.occ]
        while i < M:
            if tun[i]:
                j = i
                while j + 1 < M and tun[j + 1]:
                    j += 1
                out.append((float(self.start[i]), float(self.start[j + 1]))); i = j + 1
            else:
                i += 1
        return out


def build_path(g: NetGraph, step_edge: np.ndarray, step_off: np.ndarray) -> tuple[Path, np.ndarray]:
    """step_edge / step_off: graph edge id and offset along it of the decoded cell at every valid step. -> (Path, arc length of every step)"""
    out = g.out_edges()
    occ = [int(step_edge[0])]; pend = []  # (index of step, occurrence index)
    occ_of = np.zeros(len(step_edge), np.int64)
    filled = 0
    for j in range(1, len(step_edge)):
        e = int(step_edge[j])
        if e != occ[-1]:
            mid = _connect(g, out, occ[-1], e)
            if mid is None:
                mid = []  # not connected within 5 edges: leave the jump (arc length continues from the end of the previous edge)
            else:
                filled += len(mid)
            occ.extend(mid); occ.append(e)
        occ_of[j] = len(occ) - 1
    occ = np.array(occ, np.int64)
    # split occ into connected pieces (consecutive edges with edge_v[prev] != edge_u[e] are a disconnected cut jump: never insert a straight flight line)
    cut_oi = [i for i in range(1, len(occ)) if int(g.edge_v[occ[i - 1]]) != int(g.edge_u[occ[i]])]
    piece_bounds = [0] + cut_oi + [len(occ)]
    sg_start = [0.0]
    sg_parts, xy_parts, phi_parts, tun_parts, breaks = [], [], [], [], []
    for pa, pb in zip(piece_bounds[:-1], piece_bounds[1:]):
        if sg_parts:
            breaks.append(sg_start[-1])
        pts = []
        base_s = sg_start[-1]
        for o in range(pa, pb):
            p = g.geom(int(occ[o]))
            sg_start.append(sg_start[-1] + float(np.hypot(*np.diff(p, axis=0).T).sum()))
            pts.append(p if not pts else p[1:])
        P = np.vstack(pts)
        d = np.hypot(*np.diff(P, axis=0).T)
        cp = np.concatenate([[0.0], np.cumsum(d)])
        L_p = float(cp[-1])
        sg_p = np.arange(0.0, L_p, 1.0) if L_p > 0 else np.zeros(1)
        xy_p = np.column_stack([np.interp(sg_p, cp, P[:, 0]), np.interp(sg_p, cp, P[:, 1])])
        seg_h = np.unwrap(np.arctan2(np.diff(P[:, 1]), np.diff(P[:, 0])))
        k = np.clip(np.searchsorted(cp, sg_p, side="right") - 1, 0, len(seg_h) - 1)
        phi_p = seg_h[k]
        p_starts = np.array(sg_start[pa:pb + 1]) - base_s
        oi_p = np.clip(np.searchsorted(p_starts, sg_p, side="right") - 1, 0, pb - pa - 1)
        tun_p = np.asarray(g.edge_tunnel)[occ[pa:pb]][oi_p]
        sg_parts.append(base_s + sg_p)
        xy_parts.append(xy_p)
        phi_parts.append(phi_p)
        tun_parts.append(tun_p)
    start = np.array(sg_start)
    sg = np.concatenate(sg_parts)
    xy = np.vstack(xy_parts)
    phi = np.concatenate(phi_parts)
    tun = np.concatenate(tun_parts)
    path = Path(g, occ, start, sg, xy, phi, tun, filled, tuple(breaks))
    # arc length of every step: edge start + offset (edge length of the cell layout is the graph edge_len; geometry length differs by < 1 %)
    scale = np.asarray(g.edge_len)[occ] / np.maximum(start[1:] - start[:-1], 1e-9)
    s = start[occ_of] + np.asarray(step_off, float) / scale[occ_of]
    s = np.maximum.accumulate(s)
    return path, s


@dataclass
class RouteCtx:
    """everything a producer / the correction step needs about one video's route"""
    name: str
    path: Path
    st: object                 # rsm.hmm.seq.Steps
    ok: np.ndarray             # (T,) bool: steps with a decoded cell
    t_step: np.ndarray         # (Tv,) times of the valid steps
    s_vit: np.ndarray          # (Tv,) Viterbi arc
    s_pm: np.ndarray | None    # (Tv,) posterior mean arc (None until computed)
    step_edge: np.ndarray
    kappa: float
    a_ang: float
    tracks: list               # vms tracks {t, s, th}
    Dcum: np.ndarray = None
    tt: np.ndarray = None
    extra: dict = field(default_factory=dict)

    def __post_init__(self):
        self.Dcum = np.concatenate([[0.0], np.cumsum(self.st.mu[1:])])
        self.tt = self.st.t + 1e-6 * np.arange(len(self.st.t))
        gapmu = np.concatenate([[0.0], np.cumsum(np.where(self.st.gap[1:], self.st.mu[1:], 0.0))])
        self._gapcum = gapmu

    def D(self, t):
        return np.interp(t, self.tt, self.Dcum)

    def gapfrac(self, t0: float, t1: float) -> float:
        a, b = float(self.D(t0)), float(self.D(t1))
        if b - a < 1e-6:
            return 0.0
        return float((np.interp(t1, self.tt, self._gapcum) - np.interp(t0, self.tt, self._gapcum)) / (b - a))

    def s_baseline(self, t, which: str = "vit"):
        s = self.s_vit if which == "vit" else self.s_pm
        return np.interp(t, self.t_step + 1e-6 * np.arange(len(self.t_step)), s)
