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
    L = np.asarray(g.edge_len)[occ]
    start = np.concatenate([[0.0], np.cumsum(L)])
    # dense polyline of the path (own cumulative length of the geometry, so that arc length and xy agree)
    pts, cum0 = [], 0.0
    for e in occ:
        p = g.geom(int(e))
        pts.append(p if not pts else p[1:])
    P = np.vstack(pts)
    d = np.hypot(*np.diff(P, axis=0).T)
    cp = np.concatenate([[0.0], np.cumsum(d)])
    # edge starts in geometry arc length
    sg_start = [0.0]
    for e in occ:
        sg_start.append(sg_start[-1] + float(np.hypot(*np.diff(g.geom(int(e)), axis=0).T).sum()))
    start = np.array(sg_start)
    sg = np.arange(0.0, cp[-1], 1.0)
    xy = np.column_stack([np.interp(sg, cp, P[:, 0]), np.interp(sg, cp, P[:, 1])])
    seg_h = np.unwrap(np.arctan2(np.diff(P[:, 1]), np.diff(P[:, 0])))
    k = np.clip(np.searchsorted(cp, sg, side="right") - 1, 0, len(seg_h) - 1)
    phi = seg_h[k]
    oi = np.clip(np.searchsorted(start, sg, side="right") - 1, 0, len(occ) - 1)
    tun = np.asarray(g.edge_tunnel)[occ][oi]
    path = Path(g, occ, start, sg, xy, phi, tun, filled)
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
