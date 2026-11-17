# SPDX-License-Identifier: AGPL-3.0-or-later
"""Beam-search map-matching tracker with micro-corrections, forward or backward from an anchor.

A hypothesis = a position on the road graph (directed edge, offset) plus a Kalman state of the micro-corrections
    x = [b, r, rho, du, eps]   b: heading offset (rad), r: heading drift rate (rad/s), rho: angle scale, du: along-track position error (m),
                               eps: relative error of the distance scale.
The video heading of step k is  psi_k = b + r tau_k + rho theta_k  (theta: vms heading relative to the segment start, tau: s since segment start).
Every step (8 m of vms distance) the hypothesis is advanced by kappa0 (1 + eps_applied) ds along the road (branching into all continuations at
junctions, never U-turning), the road heading phi(u) is compared with psi_k (innovation e) and an EKF (measurement Jacobian [1, tau, theta, -dphi/du, 0])
updates x. The update is applied at once: du is folded into the position (a position snap), eps into the applied scale; so a hypothesis always carries
the micro-corrections it has made. Cost per step:
    w_e ln(1 + (e/sig_e)^2)                     innovation (robust)
  + w_c sum_i (dx_i / sc_i)^2                   the corrections of this step (b, r, rho, du, eps), each in units of a 'micro' size sc_i
  + events (gap snap, unseen junction turns, stop, jump, off-map reconnect).
Gaps (between vms segments): every hypothesis walks the nominal gap distance along the road (the straightest continuations cheapest, unseen junction
turns cost), with the end point varied by +-sigma_snap (>= 20 m) along the road (snap cost); gaps >= stop_min get stationary variants (stop penalty);
gaps >= jump_gap also get relocation hypotheses to junctions around the predicted position (high jump penalty). A dead end reconnects to a road within
off_rad (off-map penalty). Pruning: dedupe on (edge, 6 m cell) keeping the cheaper, then the best `beam` hypotheses.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np
from scipy.spatial import cKDTree

from .graphs import Net
from .vtrack import Seq

F_GAP, F_JUMP, F_OFF, F_UTURN = 1, 2, 4, 8


@dataclass(frozen=True)
class Params:
    beam: int = 96
    sig_h: float = np.radians(6.0)  # heading measurement noise of the EKF
    sig_e: float = np.radians(10.0)  # scale of the robust innovation cost
    w_e: float = 1.0
    w_c: float = 0.3
    ce_cap: float = 1.6  # per-step cap of the innovation cost (stretches where the vms heading is unusable cost the same for every hypothesis)
    cc_cap: float = 1.0
    q_b: float = np.radians(1.5)  # process noise, per sqrt(km)
    q_r: float = np.radians(0.02)  # per sqrt(s)
    q_rho: float = 0.006  # per sqrt(km)
    q_u: float = 2.0  # m per sqrt(100 m)
    q_eps: float = 0.004  # per sqrt(km)
    s_b0: float = np.radians(10.0)  # initial / post-gap sds
    s_r0: float = np.radians(0.3)
    s_rho0: float = 0.04
    s_u0: float = 15.0
    s_u_gap: float = 10.0
    s_eps0: float = 0.03
    rho_dev: float = 0.10  # relative clamp around the per-video start value
    kap_dev: float = 0.12
    r_max: float = np.radians(1.0)
    sc: tuple = (np.radians(0.8), np.radians(0.02), 0.004, 3.0, 0.002)  # 'micro' sizes of the corrections (cost units)
    gammas: tuple = (0.9, 1.0, 1.2, 1.4, 1.6)  # gap distance factors tried (plaus measured prior range 0.5-2, centre 1)
    gam_sd: float = 0.3
    w_gam: float = 1.0
    gap_beam: int = 600
    dedupe_m: float = 6.0
    gap_beam_steps: int = 60
    snap_min: float = 20.0
    snap_rel: float = 0.05
    snap_cap: float = 60.0
    w_snap: float = 1.0
    branch_pen: float = 0.3
    turn_pen: float = 0.7
    branch_cap: float = 3.0
    walk_states: int = 120
    stop_min: float = 8.0
    stop_pen: float = 3.0
    jump_gap: float = 10.0
    jump_pen: float = 25.0
    jump_rad0: float = 150.0
    jump_n_parents: int = 4
    jump_n_nodes: int = 30
    uturn_pen: float | None = 5.0  # U-turn at a standstill (step with dt >= stop_dt and < 1 m/s, or a vms gap >= stop_min) and at dead ends; None = never (v1)
    stop_dt: float = 8.0
    off_pen: float = 12.0
    off_rad: float = 80.0


def rev_of(net: Net) -> np.ndarray:
    """reverse edge (same way, swapped ends) of every edge, -1 when there is none (one-way road)"""
    r = getattr(net, "_rev_of", None)
    if r is None:
        way = np.asarray(net.g.edge_way)
        key = {(int(a), int(b), int(w)): e for e, (a, b, w) in enumerate(zip(net.start, net.end, way))}
        r = np.array([key.get((int(b), int(a), int(w)), -1) for a, b, w in zip(net.start, net.end, way)], np.int64)
        net._rev_of = r
    return r


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


@dataclass
class Ctx:
    fwd: Net
    rev: Net
    snap: object
    node_tree: cKDTree
    kappa0: float
    rho0: float
    prm: Params = field(default_factory=Params)


def make_ctx(fwd, rev, snap, kappa0, rho0, prm=None) -> Ctx:
    return Ctx(fwd, rev, snap, cKDTree(fwd.g.node_xy), kappa0, rho0, prm or Params())


def _walk(net: Net, e0: int, u0: float, dists: list, prm: Params):
    """DFS along the road from (e0, u0). Returns [(dist index, edge, offset, branch cost, edges visited)]."""
    dmax = max(dists)
    out = []
    stack = [(e0, u0, 0.0, 0.0, [e0])]
    n = 0
    while stack and n < prm.walk_states:
        e, u, trav, bc, path = stack.pop()
        n += 1
        rem = float(net.L[e]) - u
        for di, d in enumerate(dists):
            if trav - 1e-9 <= d <= trav + rem + 1e-9:
                out.append((di, e, min(u + (d - trav), float(net.L[e])), bc, path))
        if trav + rem >= dmax:
            continue
        sc = net.succ(e)
        if len(sc) == 0:
            continue
        h_end = net.PH[net.P0[e] + net.NE[e] - 1]
        for x in sc:
            ang = abs(wrap(net.PH[net.P0[x]] - h_end))
            c = bc + (prm.branch_pen + prm.turn_pen * min(ang / np.radians(60), 1.5) if len(sc) > 1 else 0.0)
            if c > prm.branch_cap:
                continue
            stack.append((int(x), 0.0, trav + rem, c, path + [int(x)]))
    return out


class Run:
    """Result of one direction: history of beams; best path extraction."""

    def __init__(self, net, hist, seq):
        self.net, self.hist, self.seq = net, hist, seq

    def best(self):
        h = self.hist[-1]
        return int(np.argmin(h["C"]))

    def path(self, i=None):
        """List of step records from the start (anchor) to the end for hypothesis i of the last beam (default best)."""
        i = self.best() if i is None else i
        rec = []
        for h in self.hist[::-1]:
            rec.append((h, i))
            i = int(h["par"][i])
        return rec[::-1]


def run_direction(ctx: Ctx, rev: bool, seq: Seq, i0: int, k0: int, e0: int, u0: float, prm: Params | None = None) -> Run:
    """Track from step k0 of segment i0 (edge e0 / offset u0 in the view's own direction) to the end of `seq`."""
    prm = prm or ctx.prm
    net = ctx.rev if rev else ctx.fwd
    L = net.L
    sc = np.asarray(prm.sc)
    rho0, kap0 = ctx.rho0, ctx.kappa0
    E = np.array([e0], np.int64); U = np.array([u0], float)
    N = 1
    X = np.zeros((N, 5)); X[:, 2] = rho0
    P = np.zeros((N, 5, 5)); P[:, 0, 0] = prm.s_b0 ** 2; P[:, 1, 1] = prm.s_r0 ** 2; P[:, 2, 2] = prm.s_rho0 ** 2; P[:, 3, 3] = prm.s_u0 ** 2; P[:, 4, 4] = prm.s_eps0 ** 2
    C = np.zeros(N); kap = np.ones(N)
    sg0 = seq.segs[i0]
    X[:, 0] = net.PH[net.idx(E, U)] - rho0 * sg0.th[k0] - 0.0
    flag = np.zeros(N, np.uint8)
    hist = [dict(t=float(sg0.t[k0]), E=E.astype(np.int32), U=U.astype(np.float32), par=np.zeros(N, np.int32), C=C.copy(), comp=np.zeros((N, 8), np.float32),
                 flag=flag.copy(), gapw=None, seg=i0, k=k0, kap=kap.copy(), X=X.copy())]

    def prune(E, U, X, P, C, kap, par, flag, comp, gapw=None, cap=None):
        key = E * 8192 + (U / prm.dedupe_m).astype(np.int64)
        order = np.argsort(C, kind="stable")
        _, first = np.unique(key[order], return_index=True)
        sel = order[np.sort(first)][: (cap or prm.beam)]
        return (E[sel], U[sel], X[sel], P[sel], C[sel], kap[sel], par[sel], flag[sel], comp[sel], None if gapw is None else [gapw[j] for j in sel])

    for si in range(i0, len(seq.segs)):
        sg = seq.segs[si]
        if si > i0:
            # ---------------- gap
            dur, nom = seq.gdur[si - 1], seq.gnom[si - 1]
            rows = []  # (parent, e, u, cost add, flag, edges)
            order = np.argsort(C)
            jump_xy = []
            PE, PU, PC, PI = E, U, C, np.arange(N)
            if prm.uturn_pen is not None and dur >= prm.stop_min:
                ro = rev_of(net)[E]
                k_ = np.flatnonzero(ro >= 0)
                PE = np.concatenate([E, ro[k_]]); PU = np.concatenate([U, L[E[k_]] - U[k_]]); PC = np.concatenate([C, C[k_] + prm.uturn_pen]); PI = np.concatenate([PI, k_])
            for pj in range(len(PE)):
                pi = int(PI[pj])
                Dm = kap0 * kap[pi] * nom
                sig = float(np.clip(max(prm.snap_min, prm.snap_rel * Dm), prm.snap_min, prm.snap_cap))
                gams = (1.0,) if Dm < 1.0 else ((1.0, 1.3) if Dm < 60 else prm.gammas)
                dl, pen = [], []
                for gm in gams:
                    base = Dm * gm
                    sig = float(np.clip(max(prm.snap_min, prm.snap_rel * base), prm.snap_min, prm.snap_cap))
                    offs = [0.0] if base < 1.0 else ([-sig, 0.0, sig] if base < 100 else [-2 * sig, -sig, 0.0, sig, 2 * sig])
                    for o in offs:
                        dl.append(max(base + o, 0.0)); pen.append(prm.w_snap * 0.5 * (o / sig) ** 2 + prm.w_gam * 0.5 * ((gm - 1.0) / prm.gam_sd) ** 2)
                if dur >= prm.stop_min and Dm > 30:
                    dl += [0.0, 0.5 * Dm]; pen += [prm.stop_pen, prm.stop_pen * 0.7]
                for (di, e, u, bc, path) in _walk(net, int(PE[pj]), float(PU[pj]), dl, prm):
                    rows.append((pi, e, u, PC[pj] + pen[di] + bc, F_UTURN if pj >= N else 0, path))
            if dur >= prm.jump_gap:
                for pi in order[: prm.jump_n_parents]:
                    Dm = kap0 * kap[pi] * nom
                    res = _walk(net, int(E[pi]), float(U[pi]), [Dm], prm)
                    if not res:
                        continue
                    _, e, u, _, _ = min(res, key=lambda r: r[3])
                    xy = net.xy(e, u)[0]
                    rad = prm.jump_rad0 + 0.5 * Dm
                    rad = min(rad, 800.0)
                    d, nid = ctx.node_tree.query(xy, k=prm.jump_n_nodes, distance_upper_bound=rad)
                    for dd, n in zip(np.atleast_1d(d), np.atleast_1d(nid)):
                        if not np.isfinite(dd):
                            continue
                        for x in net.out[int(n)]:
                            rows.append((int(pi), int(x), 0.0, C[pi] + prm.jump_pen + 0.5 * (dd / 200.0) ** 2, F_JUMP, [int(x)]))
            if not rows:
                break
            par = np.array([r[0] for r in rows]); E2 = np.array([r[1] for r in rows], np.int64); U2 = np.array([r[2] for r in rows])
            C2 = np.array([r[3] for r in rows]); fl2 = np.array([r[4] for r in rows], np.uint8)
            gapw = [r[5] for r in rows]
            X2 = X[par].copy(); P2 = P[par].copy(); kap2 = kap[par].copy()
            X2[:, 0] = net.PH[net.idx(E2, U2)]  # theta_0 = 0, tau_0 = 0
            X2[:, 3] = 0.0; X2[:, 4] = 0.0
            for a in (0, 3):
                P2[:, a, :] = 0.0; P2[:, :, a] = 0.0
            P2[:, 0, 0] = prm.s_b0 ** 2; P2[:, 3, 3] = prm.s_u_gap ** 2
            P2[:, 1, 1] += (np.radians(0.05)) ** 2 * dur
            comp2 = np.zeros((len(rows), 8), np.float32); comp2[:, 2] = (C2 - C[par])
            (E, U, X, P, C, kap, par2, flag, comp, gapw) = prune(E2, U2, X2, P2, C2, kap2, par, fl2, comp2, gapw, cap=prm.gap_beam)
            since_gap = 0
            N = len(E)
            hist.append(dict(t=float(sg.t[0]), E=E.astype(np.int32), U=U.astype(np.float32), par=par2.astype(np.int32), C=C.copy(), comp=comp, flag=flag.copy(),
                             gapw=gapw, seg=si, k=0, kap=kap.copy(), X=X.copy()))
            kstart = 0
        else:
            kstart = k0
            since_gap = 10 ** 6
        for k in range(kstart + 1, sg.n):
            since_gap += 1
            adv = kap0 * kap * sg.ds[k]
            U = U + adv
            par = np.arange(N)
            flag = np.zeros(N, np.uint8)
            cadd = np.zeros(N)
            # ---------------- junction crossings
            while True:
                over = np.flatnonzero(U > L[E])
                if len(over) == 0:
                    break
                keep = np.ones(len(E), bool); keep[over] = False
                nE = [E[keep]]; nU = [U[keep]]; nrow = [np.flatnonzero(keep)]; nfl = [flag[keep]]; nc = [cadd[keep]]
                for i in over:
                    e = int(E[i]); rem = U[i] - L[e]
                    sc_ = net.succ(e)
                    if len(sc_):
                        nE.append(sc_.astype(np.int64)); nU.append(np.full(len(sc_), rem)); nrow.append(np.full(len(sc_), i))
                        nfl.append(np.full(len(sc_), flag[i], np.uint8)); nc.append(np.full(len(sc_), cadd[i]))
                    else:  # dead end: reconnect to a road close by (off-map stretch) or die
                        node = int(net.end[e])
                        d, nid = ctx.node_tree.query(ctx.fwd.g.node_xy[node], k=12, distance_upper_bound=prm.off_rad)
                        h_end = net.PH[net.P0[e] + net.NE[e] - 1]
                        xs, rs = [], []
                        for dd, n in zip(np.atleast_1d(d), np.atleast_1d(nid)):
                            if not np.isfinite(dd) or int(n) == node:
                                continue
                            for x in net.out[int(n)]:
                                if abs(wrap(net.PH[net.P0[x]] - h_end)) < np.radians(70):
                                    xs.append(int(x)); rs.append(dd)
                        ru = int(rev_of(net)[e]) if prm.uturn_pen is not None else -1
                        if ru >= 0:
                            xs.append(ru); rs.append(0.0)
                        if xs:
                            nE.append(np.array(xs, np.int64)); nU.append(np.full(len(xs), 0.0)); nrow.append(np.full(len(xs), i))
                            nfl.append(np.full(len(xs), F_OFF | flag[i], np.uint8)); nc.append(cadd[i] + prm.off_pen + 0.5 * (np.array(rs) / 40.0) ** 2)
                E = np.concatenate(nE); U = np.concatenate(nU); rows = np.concatenate(nrow); flag = np.concatenate(nfl); cadd = np.concatenate(nc)
                par = par[rows]; X = X[rows]; P = P[rows]; C = C[rows]; kap = kap[rows]; adv = adv[rows]
                if len(E) == 0:
                    break
            if len(E) == 0:
                break
            # ---------------- U-turn at a standstill: reversed copies with a re-synchronised heading offset
            dt = sg.tau[k] - sg.tau[k - 1]
            if prm.uturn_pen is not None and dt >= prm.stop_dt and sg.ds[k] / dt < 1.0:
                ro = rev_of(net)[E]
                k_ = np.flatnonzero(ro >= 0)
                if len(k_):
                    E2 = ro[k_]; U2 = np.clip(L[E[k_]] - U[k_], 0.0, L[E2])
                    X2 = X[k_].copy(); P2_ = P[k_].copy()
                    X2[:, 0] = net.PH[net.idx(E2, U2)] - X2[:, 2] * sg.th[k] - X2[:, 1] * sg.tau[k]
                    P2_[:, 0, :] = 0.0; P2_[:, :, 0] = 0.0; P2_[:, 0, 0] = prm.s_b0 ** 2
                    E = np.concatenate([E, E2]); U = np.concatenate([U, U2]); X = np.concatenate([X, X2]); P = np.concatenate([P, P2_]); C = np.concatenate([C, C[k_]])
                    kap = np.concatenate([kap, kap[k_]]); adv = np.concatenate([adv, adv[k_]]); par = np.concatenate([par, par[k_]])
                    flag = np.concatenate([flag, flag[k_] | F_UTURN]); cadd = np.concatenate([cadd, cadd[k_] + prm.uturn_pen])
            # ---------------- EKF predict
            P2 = P.copy(); P2[:, 3, :] += adv[:, None] * P[:, 4, :]
            P3 = P2.copy(); P3[:, :, 3] += adv[:, None] * P2[:, :, 4]
            km = adv / 1000.0
            P3[:, 0, 0] += prm.q_b ** 2 * km; P3[:, 1, 1] += prm.q_r ** 2 * dt; P3[:, 2, 2] += prm.q_rho ** 2 * km
            P3[:, 3, 3] += prm.q_u ** 2 * adv / 100.0; P3[:, 4, 4] += prm.q_eps ** 2 * km
            # ---------------- measurement
            ix = net.idx(E, U)
            phi = net.PH[ix]; g = net.PG[ix]
            th, tau = sg.th[k], sg.tau[k]
            e = wrap(phi - (X[:, 0] + X[:, 1] * tau + X[:, 2] * th))
            Hm = np.stack([np.ones(len(E)), np.full(len(E), tau), np.full(len(E), th), -g, np.zeros(len(E))], axis=1)
            PHm = np.einsum("nij,nj->ni", P3, Hm)
            S = (Hm * PHm).sum(1) + prm.sig_h ** 2 * (1.0 + (e / (2.5 * prm.sig_h)) ** 2)
            Kg = PHm / S[:, None]
            dx = Kg * e[:, None]
            X = X + dx
            P = P3 - Kg[:, :, None] * PHm[:, None, :]
            ce = np.minimum(prm.w_e * np.log1p((e / prm.sig_e) ** 2), prm.ce_cap)
            cc = np.minimum(prm.w_c * ((dx / sc) ** 2).sum(1), prm.cc_cap)
            # ---------------- fold position and scale corrections
            U = np.clip(U + X[:, 3], 0.0, L[E]); kap = np.clip(kap + X[:, 4], 1 - prm.kap_dev, 1 + prm.kap_dev)
            X[:, 3] = 0.0; X[:, 4] = 0.0
            X[:, 2] = np.clip(X[:, 2], rho0 * (1 - prm.rho_dev), rho0 * (1 + prm.rho_dev))
            X[:, 1] = np.clip(X[:, 1], -prm.r_max, prm.r_max)
            comp = np.concatenate([np.stack([ce, cc, cadd], 1), np.abs(dx)], 1).astype(np.float32)
            C = C + ce + cc + cadd
            cap = int(prm.beam + (prm.gap_beam - prm.beam) * max(0.0, 1.0 - since_gap / prm.gap_beam_steps))
            (E, U, X, P, C, kap, par2, flag, comp, _) = prune(E, U, X, P, C, kap, par, flag, comp, cap=cap)
            N = len(E)
            hist.append(dict(t=float(sg.t[k]), E=E.astype(np.int32), U=U.astype(np.float32), par=par2.astype(np.int32), C=C.copy(), comp=comp, flag=flag.copy(),
                             gapw=None, seg=si, k=k, kap=kap.copy(), X=X.copy()))
        else:
            continue
        break
    return Run(net, hist, seq)
