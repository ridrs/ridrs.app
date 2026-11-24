# SPDX-License-Identifier: AGPL-3.0-or-later
"""Forward-backward of the dense HMM (copy of rsm.hmm.dp.forward_backward, which only keeps edge-level summaries) with a callback on the full cell posterior of
every step: used for the posterior-mean position along the fixed path. `dpm` is rsm.hmm.dp or rsm.hmm_cal.dp (same private helpers)."""
from __future__ import annotations

import numpy as np

from rsm.hmm.grid import check_budget


def forward_backward_cb(dpm, pre, st, cb, cap_gb: float = 4.0):
    """cb(j, p) with p the normalised posterior over cells at step j (float32, length N). Returns {j: cb(j, p)} as an array/list in step order."""
    grid = pre.grid
    N, T = grid.N, st.T
    check_budget(N, T, bp_bytes=0, alpha_bytes=2, cap_gb=cap_gb)
    NEG = dpm.NEG
    if not hasattr(pre, "_border"):
        dpm._prep_border(pre)
    al = np.empty((T, N), np.float16)
    a = np.full(N, -np.log(N), np.float32)
    al[0] = a
    is_jump = getattr(st, "jump", None)
    for j in range(1, T):
        if is_jump is not None and is_jump[j]:
            new = np.full(N, np.float32(-np.log(N)) if np.isfinite(a.max()) else NEG, np.float32)
        else:
            mu, sd, dth = dpm._step_terms(pre, st, j)
            new = np.full(N, NEG, np.float32)
            for gi, gr in enumerate(grid.groups):
                if dpm._skip(gr, mu, sd):
                    continue
                cand = a[gr.src] + dpm._cand(pre, gi, mu, sd, dth, a)
                lse, ok = dpm._lse_reduce(cand, gr.starts, gr.blk)
                lse = np.where(ok, lse, NEG)
                tmp = np.full(N, NEG, np.float32)
                tmp[gr.ud] = lse
                new = np.logaddexp(new, tmp)
        mx = new.max()
        a = new - (mx + np.log(np.exp(new - mx).sum()))
        al[j] = np.maximum(a, -60000).astype(np.float16)
    out = [None] * T
    beta = np.zeros(N, np.float32)
    for j in range(T - 1, -1, -1):
        g_ = al[j].astype(np.float32) + beta
        p = np.exp(g_ - g_.max())
        p /= p.sum()
        out[j] = cb(j, p)
        if j == 0:
            break
        if is_jump is not None and is_jump[j]:
            beta = np.zeros(N, np.float32) if np.isfinite(beta.max()) else np.full(N, NEG, np.float32)
            continue
        mu, sd, dth = dpm._step_terms(pre, st, j)
        nb = np.full(N, NEG, np.float32)
        for gi, gr in enumerate(grid.groups):
            if dpm._skip(gr, mu, sd):
                continue
            cand = beta[gr.b_dst] + dpm._cand(pre, gi, mu, sd, dth, None, view="b")
            lse, ok = dpm._lse_reduce(cand, gr.b_starts, gr.b_blk)
            lse = np.where(ok, lse, NEG)
            tmp = np.full(N, NEG, np.float32)
            tmp[gr.b_us] = lse
            nb = np.logaddexp(nb, tmp)
        beta = nb - nb.max()
    return out


class PathMean:
    """callback: posterior mean arc length along the path (cells on path edges only, renormalised) and the posterior mass on the path.
    Cells of an edge that the path visits several times take the occurrence nearest to the Viterbi arc of that step."""

    def __init__(self, path, cell_edge, cell_off, s_ref_by_step: np.ndarray):
        occ = path.occ
        scale = np.asarray(path.g.edge_len)[occ] / np.maximum(path.start[1:] - path.start[:-1], 1e-9)
        cells, arcs = [], []
        by_edge = {}
        for o, e in enumerate(occ):
            by_edge.setdefault(int(e), []).append(o)
        order = np.argsort(cell_edge, kind="stable")
        ce = cell_edge[order]
        for e, os_ in by_edge.items():
            lo, hi = np.searchsorted(ce, [e, e + 1])
            cs = order[lo:hi]
            for o in os_:
                cells.append(cs); arcs.append(path.start[o] + cell_off[cs] / scale[o])
        cells = np.concatenate(cells); arcs = np.concatenate(arcs)
        o2 = np.lexsort((arcs, cells))
        self.cells, self.arcs = cells[o2], arcs[o2]
        self.first = np.concatenate([[0], np.flatnonzero(np.diff(self.cells)) + 1])
        self.multi = len(self.first) != len(self.cells)
        self.s_ref = s_ref_by_step

    def __call__(self, j, p):
        w = p[self.cells].astype(np.float64)
        arcs = self.arcs
        if self.multi:
            d = np.abs(arcs - self.s_ref[j])
            gm = np.minimum.reduceat(d, self.first)
            grp = np.repeat(np.arange(len(self.first)), np.diff(np.concatenate([self.first, [len(arcs)]])))
            w = w * (d <= gm[grp] + 1e-9)
        m = w.sum()
        return (float((w * arcs).sum() / m) if m > 1e-12 else np.nan), float(m)
