# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exact inference of the dense road HMM (numpy only): Viterbi (route), forward score (evidence), forward-backward (posterior per time).

Model. State x_j = cell of the grid at step j. Prior of x_0: uniform (no anchor). Per step j (distance step of rsm.hmm.seq):
  transition   x_{j-1} -> x_j along the road in k = 1..K cells: path length D (centre to centre) ~ Normal(mu_j, sd_j), mu_j = kappa * mu_nom * (1 + b max(v - 3, 0)),
               sd_j = sqrt((rel_j mu_j)^2 + (floor h)^2); a U-turn onto the reverse twin edge costs pen_uturn (nats); at nodes every out-edge is allowed.
  emission     (steps with vms data) a * dth_j  against  dphi = road heading change over the same path, residual r ~ Student-t(nu) with
               scale sd_e = sqrt(sig0^2 + (beta dphi)^2). INCREMENTS, so a slow heading offset or drift costs almost nothing.
  gap steps    no emission, wider advance window.
Nothing is pruned: every cell is alive at every step.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from rsm.hmm.grid import Grid, check_budget
from rsm.hmm.seq import Steps

NEG = np.float32(-np.inf)
STEP_OK_HOOK = None   # callable(grid, st, step_ok) -> step_ok with the user anchors merged in (rsm.pipeline.anchors.activate); None: off
FRAME_PRIOR_HOOK = None   # callable(grid) -> (start log prior, end log prior) per cell, each or None (rsm.pipeline.hints.activate_frame_cost, A30); None: off


@dataclass
class Par:
    a_ang: float = 1.0      # multiplies the vms heading increments (= 449 / f_eff for the stored tracks)
    kappa: float = 1.0      # nominal -> map distance
    b_speed: float = 0.0    # speed slope of the distance scale (v3)
    sig0: float = np.radians(2.5)
    beta: float = 0.2
    nu: float = 3.0
    floor_frac: float = 0.25  # distance noise floor as a fraction of the grid size
    rel: float = 0.2
    sv: float = np.radians(4.5)         # vms increment noise (rad), scaled by a_ang in the emission scale: sd_e^2 = (a sv)^2 + sig0^2 + (beta dphi)^2
    slot_bits: int = 10  # COPY of rsm.hmm.dp: 16-bit backpointers (group << 10 | slot) because K = 7 gives in-degrees above 63


class Prepared:
    """per-group static terms of the emission (scale and normalisation) for given (sig0, beta, nu)"""

    def __init__(self, grid: Grid, par: Par):
        self.grid, self.par = grid, par
        self.ls, self.is2, self.loc = [], [], []
        for gr in grid.groups:
            sd = np.sqrt((par.a_ang * par.sv) ** 2 + par.sig0 ** 2 + (par.beta * gr.dphi.astype(np.float64)) ** 2)
            self.ls.append((-np.log(sd)).astype(np.float32))
            self.is2.append((1.0 / (sd ** 2 * par.nu)).astype(np.float32))
            if len(gr.starts):
                loc = np.arange(gr.n) - gr.starts[gr.blk]
                if loc.max() >= (1 << par.slot_bits) - 1:
                    raise MemoryError(f"in-degree {loc.max()+1} > {1<<par.slot_bits}: backpointer slot does not fit")
                self.loc.append(loc.astype(np.uint16))
            else:
                self.loc.append(np.zeros(0, np.uint16))
        self.c1 = np.float32((par.nu + 1) / 2)
        sd = np.sqrt(par.sig0 ** 2)
        self.floor = par.floor_frac * grid.h


def _step_terms(pre: Prepared, st: Steps, j: int):
    par = pre.par
    mu = par.kappa * st.mu[j] * (1.0 + par.b_speed * max(st.v[j] - 3.0, 0.0))
    sd = np.sqrt((max(par.rel, st.rel[j]) * mu) ** 2 + pre.floor ** 2)
    dth = None if np.isnan(st.dth[j]) else np.float32(par.a_ang * st.dth[j])
    return mu, sd, dth


def _cand(pre: Prepared, gi: int, mu: float, sd: float, dth, a_src: np.ndarray, view: str = "f"):
    """log-weight of the entries of group gi (forward view: aligned with gr.src; backward: b_ arrays), WITHOUT the state score"""
    gr = pre.grid.groups[gi]
    D, dp, w = (gr.D, gr.dphi, gr.w) if view == "f" else (gr.b_D, gr.b_dphi, gr.b_w)
    z = (D - np.float32(mu)) / np.float32(sd)
    lt = -0.5 * z * z - np.float32(np.log(sd))
    lt += w
    if dth is not None:
        ls, is2 = pre.ls[gi], pre.is2[gi]
        if view != "f":
            ls, is2 = pre.b_ls[gi], pre.b_is2[gi]
        r = dth - dp
        lt += ls - pre.c1 * np.log1p(r * r * is2)
    return lt


def _skip(gr, mu, sd) -> bool:
    if gr.n == 0:
        return True
    return bool(gr.D.max() < mu - 6 * sd or gr.D.min() > mu + 6 * sd)


def _prep_border(pre: Prepared):
    """permutation from the dst-sorted view to the src-sorted view for every group"""
    pre._border = []
    pre.b_ls, pre.b_is2 = [], []
    for gi, gr in enumerate(pre.grid.groups):
        o = gr.border
        pre._border.append(o)
        pre.b_ls.append(pre.ls[gi][o]); pre.b_is2.append(pre.is2[gi][o])


def viterbi(pre: Prepared, st: Steps, backptr: bool = False, log_every: int = 0, start_ok=None, end_ok=None, step_ok: dict | None = None):
    """-> dict(score = best total log score, cell_path (T,) or None). Score has no initial prior constant.
    start_ok / end_ok (optional bool arrays over the cells): the path must start in / end in these cells (area hints). If no path satisfies them, score = -inf and cell_path None.
    step_ok (optional {step j: bool array over the cells}): the path must be in these cells at step j (anchors inside the video; j = 0 acts like start_ok)."""
    grid = pre.grid
    if STEP_OK_HOOK is not None:
        step_ok = STEP_OK_HOOK(grid, st, step_ok)
    N = grid.N
    a = np.zeros(N, np.float32) if start_ok is None else np.where(start_ok, np.float32(0), NEG).astype(np.float32)
    if step_ok and 0 in step_ok:
        a = np.where(step_ok[0], a, NEG).astype(np.float32)
    s_lp, e_lp = FRAME_PRIOR_HOOK(grid) if FRAME_PRIOR_HOOK is not None else (None, None)
    if s_lp is not None:
        a = (a + s_lp).astype(np.float32)
    bps = [] if backptr else None
    if backptr:
        check_budget(N, st.T, bp_bytes=2, forward_backward=False)
    for j in range(1, st.T):
        mu, sd, dth = _step_terms(pre, st, j)
        new = np.full(N, NEG, np.float32)
        code = np.full(N, 65535, np.uint16) if backptr else None
        for gi, gr in enumerate(grid.groups):
            if _skip(gr, mu, sd):
                continue
            cand = a[gr.src] + _cand(pre, gi, mu, sd, dth, a)
            m = np.maximum.reduceat(cand, gr.starts)
            if backptr:
                eq = cand == m[gr.blk]
                slot = np.minimum.reduceat(np.where(eq, pre.loc[gi], np.uint16(65535)), gr.starts)
                better = m > new[gr.ud]
                bu = gr.ud[better]
                code[bu] = (np.uint16(gi) << np.uint16(pre.par.slot_bits)) | slot[better]
                new[bu] = m[better]
            else:
                new[gr.ud] = np.maximum(new[gr.ud], m)
        if step_ok and j in step_ok:
            new = np.where(step_ok[j], new, NEG).astype(np.float32)
        a = new
        if backptr:
            bps.append(code)
    if end_ok is not None:
        a = np.where(end_ok, a, NEG).astype(np.float32)
    if e_lp is not None:
        a = (a + e_lp).astype(np.float32)
    c = int(np.argmax(a))
    if not np.isfinite(a[c]):
        return dict(score=float("-inf"), final_cell=-1, cell_path=None)
    # Jacobian: the data are the vms increments dth, the residual is a * dth - dphi, so every emitting step adds log a to the density of the data
    jac = float(np.count_nonzero(~np.isnan(st.dth[1:])) * np.log(pre.par.a_ang))
    out = dict(score=float(a[c]) + jac, final_cell=c, cell_path=None)
    if backptr:
        path = np.empty(st.T, np.int64)
        path[-1] = c
        mask = (1 << pre.par.slot_bits) - 1
        for j in range(st.T - 1, 0, -1):
            cd = int(bps[j - 1][c])
            if cd == 65535:
                path[:j] = -1
                break
            gr = grid.groups[cd >> pre.par.slot_bits]
            c = int(gr.src[gr.starts[gr.first[c]] + (cd & mask)])
            path[j - 1] = c
        out["cell_path"] = path
    return out


def _lse_reduce(cand, starts, blk):
    m = np.maximum.reduceat(cand, starts)
    ms = np.where(np.isfinite(m), m, np.float32(0))
    s = np.add.reduceat(np.exp(cand - ms[blk]), starts)
    return ms + np.log(np.maximum(s, np.float32(1e-38))), np.isfinite(m)


def forward_backward(pre: Prepared, st: Steps, cell_path: np.ndarray, cap_gb: float = 4.0, start_ok=None, end_ok=None, step_ok: dict | None = None):
    """posterior per step. Returns dict(logev = log evidence (no prior constant), p_vit (mass of the Viterbi cell's directed edge), p_max (largest edge mass),
    e_max (edge with the largest mass, graph edge id), p_twin (mass on the Viterbi edge or its direction-reversed edges is NOT computed here), ent (edge entropy, nats))."""
    grid = pre.grid
    if STEP_OK_HOOK is not None:
        step_ok = STEP_OK_HOOK(grid, st, step_ok)
    N, T = grid.N, st.T
    check_budget(N, T, bp_bytes=0, alpha_bytes=2, cap_gb=cap_gb)
    if not hasattr(pre, "_border"):
        _prep_border(pre)
    al = np.empty((T, N), np.float16)
    a = np.full(N, -np.log(N), np.float32) if start_ok is None else _log_uniform(start_ok)
    if step_ok and 0 in step_ok:
        a = _log_uniform(step_ok[0] if start_ok is None else (step_ok[0] & start_ok))
    a = start_prior(grid, a)
    al[0] = a
    logev = 0.0
    for j in range(1, T):
        mu, sd, dth = _step_terms(pre, st, j)
        new = np.full(N, NEG, np.float32)
        for gi, gr in enumerate(grid.groups):
            if _skip(gr, mu, sd):
                continue
            cand = a[gr.src] + _cand(pre, gi, mu, sd, dth, a)
            lse, ok = _lse_reduce(cand, gr.starts, gr.blk)
            lse = np.where(ok, lse, NEG)
            tmp = np.full(N, NEG, np.float32)
            tmp[gr.ud] = lse
            new = np.logaddexp(new, tmp)
        if step_ok and j in step_ok:
            new = np.where(step_ok[j], new, NEG).astype(np.float32)
        mx = new.max()
        c = mx + np.log(np.exp(new - mx).sum())
        logev += float(c)
        a = new - c
        al[j] = np.maximum(a, -60000).astype(np.float16)
    logev += float(np.count_nonzero(~np.isnan(st.dth[1:])) * np.log(pre.par.a_ang))
    ne = len(grid.edges)
    es = grid.estart[:-1]
    p_vit = np.full(T, np.nan); p_max = np.zeros(T); e_max = np.zeros(T, np.int64); ent = np.zeros(T)
    beta = np.zeros(N, np.float32) if end_ok is None else np.where(end_ok, np.float32(0), NEG).astype(np.float32)
    e_lp = end_prior(grid)
    if e_lp is not None:
        beta = (beta + e_lp).astype(np.float32)
    for j in range(T - 1, -1, -1):
        if step_ok and j in step_ok:
            beta = np.where(step_ok[j], beta, NEG).astype(np.float32)
        g_ = al[j].astype(np.float32) + beta
        mx = g_.max()
        p = np.exp(g_ - mx)
        p /= p.sum()
        em = np.add.reduceat(p, es)
        p_max[j] = em.max(); e_max[j] = grid.edges[int(np.argmax(em))]
        nz = em[em > 1e-12]
        ent[j] = float(-(nz * np.log(nz)).sum())
        if cell_path is not None and cell_path[j] >= 0:
            p_vit[j] = float(em[grid.cell_ei[cell_path[j]]])
        if j == 0:
            break
        mu, sd, dth = _step_terms(pre, st, j)
        nb = np.full(N, NEG, np.float32)
        for gi, gr in enumerate(grid.groups):
            if _skip(gr, mu, sd):
                continue
            cand = beta[gr.b_dst] + _cand(pre, gi, mu, sd, dth, None, view="b")
            lse, ok = _lse_reduce(cand, gr.b_starts, gr.b_blk)
            lse = np.where(ok, lse, NEG)
            tmp = np.full(N, NEG, np.float32)
            tmp[gr.b_us] = lse
            nb = np.logaddexp(nb, tmp)
        mx = nb.max()
        beta = nb - mx
    return dict(logev=logev, p_vit=p_vit, p_max=p_max, e_max=e_max, ent=ent)


def start_prior(grid, a: np.ndarray) -> np.ndarray:
    """the normalised log weight of the first cell: `a` plus the start frame cost (FRAME_PRIOR_HOOK, A30); `a` unchanged without it"""
    s_lp = FRAME_PRIOR_HOOK(grid)[0] if FRAME_PRIOR_HOOK is not None else None
    if s_lp is None:
        return a
    a = a + s_lp
    fin = np.isfinite(a)
    mx = a[fin].max()
    return np.where(fin, a - (mx + np.log(np.exp(a[fin] - mx).sum())), NEG).astype(np.float32)


def end_prior(grid):
    """the end frame cost (FRAME_PRIOR_HOOK, A30) or None"""
    return FRAME_PRIOR_HOOK(grid)[1] if FRAME_PRIOR_HOOK is not None else None


def _log_uniform(ok) -> np.ndarray:
    """log of the uniform distribution on the cells where ok (NEG elsewhere); the whole grid if ok is None"""
    n = int(np.count_nonzero(ok))
    return np.where(ok, np.float32(-np.log(max(n, 1))), NEG).astype(np.float32)


def prepare(grid: Grid, par: Par) -> Prepared:
    pre = Prepared(grid, par)
    _prep_border(pre)
    return pre
