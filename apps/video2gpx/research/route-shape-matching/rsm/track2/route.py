# SPDX-License-Identifier: AGPL-3.0-or-later
"""One anchor -> whole-video route: forward and backward run combined into a Route (arrays over video time) with cost profile and summaries.

v3: the summed along-track snaps of a straight (tracker) are spread evenly over the straight at extraction (constant scale factor from turn to turn) and the
stretch cost is spread evenly over its steps, so that neither position nor cost has a spike at the end of the straight.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .tracker import COMP, Ctx, F_GAP, F_JUMP, F_OFF, F_UTURN, run_direction
from .vtrack import Seq

ICOMP = {n: i for i, n in enumerate(COMP)}


@dataclass
class Route:
    t: np.ndarray
    E: np.ndarray  # forward edge ids
    U: np.ndarray  # forward offsets
    xy: np.ndarray
    inc: np.ndarray  # cost increment of the step (outward from the anchor)
    comp: np.ndarray  # (n, 11) see tracker.COMP; row i belongs to inc[i]
    flag: np.ndarray
    seg: np.ndarray
    dirn: np.ndarray  # +1 forward of the anchor, -1 backward, 0 anchor
    km: float  # tracked map km (steps)
    anchor_t: float
    gap_edges: list = field(default_factory=list)  # [(t, [edges])] walked through vms gaps
    cost_f: float = 0.0
    cost_b: float = 0.0
    seconds: float = 0.0
    ok: bool = True
    xy_live: np.ndarray | None = None  # positions before the even spreading of the straight stretches
    stid: np.ndarray | None = None  # straight id of every step (-1 outside straights); a stretch is spread inside one id
    stretch: list = field(default_factory=list)  # [(t0, t1, factor, cost)] per straight

    @property
    def cost(self) -> float:
        return self.cost_f + self.cost_b

    @property
    def cost_per_km(self) -> float:
        return self.cost / max(self.km, 1e-6)

    @property
    def n_jumps(self) -> int:
        return int(((self.flag & F_JUMP) > 0).sum())

    @property
    def n_off(self) -> int:
        return int(((self.flag & F_OFF) > 0).sum())

    def comp_sum(self) -> dict:
        """summed cost per component (whole route)"""
        c = self.comp.sum(0)
        return {n: float(c[i]) for n, i in ICOMP.items()}

    def edges(self) -> list:
        """edge ids in video order (consecutive duplicates removed), including edges walked through gaps"""
        out = []
        gi = {round(t, 3): w for t, w in self.gap_edges}
        for t, e in zip(self.t, self.E):
            for x in gi.get(round(float(t), 3), []):
                if not out or out[-1] != x:
                    out.append(int(x))
            if not out or out[-1] != int(e):
                out.append(int(e))
        return out


def _spread(net, E, U, adv, du, st, flag, comp, stretch, str_max=0.15):
    """Even spreading of the summed snaps over every straight (in the run's own direction).
    Returns new (E, U), comp with the stretch cost spread evenly, and [(i0, i1, factor, cost)] per straight."""
    n = len(E)
    E = E.copy(); U = U.astype(float).copy(); comp = comp.copy()
    info = []
    if n == 0:
        return E, U, comp, info
    # groups: same straight id, a flagged step (gap, jump, U-turn, off-map reconnect) starts a new group
    cut = np.ones(n, bool)
    cut[1:] = (st[1:] != st[:-1]) | (flag[1:] != 0)
    starts = np.flatnonzero(cut)
    ends = np.append(starts[1:], n)
    L = net.L
    for a, b in zip(starts, ends):
        if b - a < 2:
            continue
        adv_g = adv[a:b].copy(); du_g = du[a:b].copy()
        fl_start = flag[a] != 0  # the first record was placed by an event (reversal, gap, jump): its own step is no part of the straight
        if fl_start:
            adv_g[0] = 0.0; du_g[0] = 0.0
        D = float(adv_g.sum())
        cs = comp[a:b, ICOMP["stretch"]].sum()
        if D < 1.0:
            continue
        # live arc positions relative to the start of the straight (start = end of the previous step)
        A = np.cumsum(adv_g + du_g)  # A_j - A_start
        # chain knots: arc of the start of every edge visited; absolute arc of record j is A_j and the edge start of record j is A_j - U_j
        pe = a - 1
        knots_e, knots_s = [], []
        if a > 0 and not fl_start:  # the previous record (end of the previous straight) sits at arc 0
            knots_e.append(int(E[pe])); knots_s.append(-U[pe])
        for j in range(a, b):
            es = A[j - a] - U[j]
            if not knots_e or knots_e[-1] != int(E[j]):
                knots_e.append(int(E[j])); knots_s.append(es)
        knots_s = np.array(knots_s)
        sigma = (A[-1]) / D  # (A_end - A_start) / D
        if abs(sigma - 1.0) > str_max:
            info.append((int(a), int(b), float(sigma), float(cs)))
            continue
        Dcum = np.cumsum(adv_g)
        Anew = sigma * Dcum
        # position (edge, offset) of arc Anew: last knot with start <= Anew
        idx = np.clip(np.searchsorted(knots_s, Anew, side="right") - 1, 0, len(knots_s) - 1)
        e_new = np.array(knots_e)[idx]
        u_new = np.clip(Anew - knots_s[idx], 0.0, L[e_new])
        E[a:b] = e_new; U[a:b] = u_new
        if stretch:
            comp[a:b, ICOMP["stretch"]] = cs / (b - a)
        info.append((int(a), int(b), float(sigma), float(cs)))
    return E, U, comp, info


def _extract(run, net, fwd_net, reverse, prm):
    rec = run.path()
    t = np.array([h["t"] for h, i in rec]); E = np.array([h["E"][i] for h, i in rec], np.int64); U = np.array([h["U"][i] for h, i in rec], float)
    C = np.array([h["C"][i] for h, i in rec]); comp = np.array([h["comp"][i] for h, i in rec]); flag = np.array([h["flag"][i] for h, i in rec])
    seg = np.array([h["seg"] for h, i in rec]); kap = np.array([h["kap"][i] for h, i in rec])
    adv = np.array([h["adv"][i] for h, i in rec], float); du = np.array([h["du"][i] for h, i in rec], float); st = np.array([h["st"] for h, i in rec])
    gaps = [(h["t"], h["gapw"][i]) for h, i in rec if h["gapw"] is not None]
    inc = np.diff(np.concatenate([[0.0], C]))
    xy_live = net.xy(E, U) if len(E) else np.zeros((0, 2))
    info = []
    if prm.stretch:
        E2, U2, comp2, info = _spread(net, E, U, adv, du, st, flag, comp, True, prm.str_max)
        inc = inc + (comp2[:, ICOMP["stretch"]] - comp[:, ICOMP["stretch"]])
        E, U, comp = E2, U2, comp2
    stid = st.copy()
    xy_new = net.xy(E, U) if len(E) else np.zeros((0, 2))
    if reverse:
        U = fwd_net.L[E] - U
    return t, E, U, inc, comp, flag, seg, kap, gaps, float(C[-1]), xy_live, xy_new, stid, info


def track_anchor(ctx: Ctx, sf: Seq, sb: Seq, t_a: float, e0: int, u0: float, prm=None) -> Route:
    import time
    t0 = time.time()
    prm = prm or ctx.prm
    fw, rv = ctx.fwd, ctx.rev
    i0, k0, _ = sf.locate(t_a)
    run_f = run_direction(ctx, False, sf, i0, k0, e0, u0, prm)
    j0, m0, _ = sb.locate(t_a)
    run_b = run_direction(ctx, True, sb, j0, m0, e0, float(fw.L[e0] - u0), prm)
    tf, Ef, Uf, incf, cf, flf, sgf, kpf, gf, Cf, lvf, nwf, stf, inff = _extract(run_f, fw, fw, False, prm)
    tb, Eb, Ub, incb, cb, flb, sgb, kpb, gb, Cb, lvb, nwb, stb, infb = _extract(run_b, rv, fw, True, prm)
    # video order: backward reversed (excluding the anchor step), then forward
    t = np.concatenate([tb[:0:-1], tf]); E = np.concatenate([Eb[:0:-1], Ef]); U = np.concatenate([Ub[:0:-1], Uf])
    inc = np.concatenate([incb[:0:-1], incf]); comp = np.concatenate([cb[:0:-1], cf]); flag = np.concatenate([flb[:0:-1], flf])
    seg = np.concatenate([sgb[:0:-1] * 0 - 1, sgf]); dirn = np.concatenate([-np.ones(len(tb) - 1, int), [0], np.ones(len(tf) - 1, int)])
    xy = np.concatenate([nwb[:0:-1], nwf]) if len(E) else np.zeros((0, 2))
    xy_live = np.concatenate([lvb[:0:-1], lvf]) if len(E) else np.zeros((0, 2))
    stid = np.concatenate([-(stb[:0:-1] + 1), stf + 10 ** 9])
    kap0 = ctx.kappa0 * (1.0 + prm.speed_a)
    ds_f, sv_f = [], []
    for h, i in run_f.path():
        sgx = sf.segs[h["seg"]]; ds_f.append(sgx.ds[h["k"]]); sv_f.append(_sv(prm, sgx.vs[h["k"]]) if sgx.vs is not None else 1.0)
    ds_b, sv_b = [], []
    for h, i in run_b.path():
        sgx = sb.segs[h["seg"]]; ds_b.append(sgx.ds[h["k"]]); sv_b.append(_sv(prm, sgx.vs[h["k"]]) if sgx.vs is not None else 1.0)
    km = (kap0 * (np.sum(np.array(ds_f) * np.array(sv_f) * kpf) + np.sum(np.array(ds_b) * np.array(sv_b) * kpb))) / 1000.0
    gaps = [(tt, w) for tt, w in gf] + [(tt, w) for tt, w in gb]
    stretch = [(float(tf[a]), float(tf[b - 1]), s, c) for a, b, s, c in inff] + [(float(tb[b - 1]), float(tb[a]), s, c) for a, b, s, c in infb]
    r = Route(t, E, U, xy, inc, comp, flag, seg, dirn, km, t_a, gaps, Cf, Cb, time.time() - t0, True, xy_live, stid, stretch)
    return r


def _sv(prm, v):
    return float(min(1.0 + prm.speed_b * max(float(v) - prm.speed_knee, 0.0), 1.4)) if prm.speed_b else 1.0
