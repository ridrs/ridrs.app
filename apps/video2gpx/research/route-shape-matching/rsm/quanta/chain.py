# SPDX-License-Identifier: AGPL-3.0-or-later
"""Hash index of the map legs and chaining of a window of consecutive video quanta (Viterbi over candidates).

Index: legs are hashed on (sign1, sign2, ln|angle1| bin, ln|angle2| bin); a video quantum looks into its own bins and into a neighbour bin when
its value lies within SOFT of the bin edge. Ratio classes (ln len/straight) are applied as a +- window around the video value on the
candidates (the soft limit of a ratio bin), not as hash dimensions: the measured ratio errors (median 17-27 %) are too large for a hard hash.

Chaining: state = (quantum i, map leg). Transitions
  adjacent  (quantum i-1 -> i): the legs share the turn event (previous leg's second turn = this leg's first turn);
  skip      (k faulty video quanta in between, k <= KF): the next leg's first turn is reachable from the previous leg's second turn through
            <= HOPS legs, and the video distance between the two matched turns / map distance is consistent with the chain's scale;
  scale     ln(video straight / map straight) must stay near the running mean of the chain (tau), prior 0.6 .. 1.5 for the first;
  faulty    a quantum that is skipped costs PF nats, at the window edges too. A quantum with uncertain length (vms gap) has no ratio and no scale term.
Score = sum over matched quanta of (BONUS - 0.5 * sum of capped squared standardised errors) - penalties.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass(frozen=True)
class Params:
    wa: float = 0.30  # ln-angle bin width
    soft_a: float = 0.20  # look into the neighbour bin when within this of its edge (ln units)
    ratio_win: float = 1.0  # candidates keep |ln-ratio difference| <= ratio_win
    sig_a: float = 0.20  # ln-angle error scale
    sig_r: float = 0.50  # ln len/straight error scale
    zcap: float = 3.0  # per-term cap of |z|
    cand_z: float = 3.0  # candidates with any |z_angle| above this are dropped
    bonus: float = 5.0  # nats for a matched quantum
    idf: float = 0.0  # extra weight of ln(N / n_cand)
    pf: float = 1.5  # nats per faulty quantum
    tau: float = 0.35  # scale consistency scale (ln)
    s_lo: float = 0.6
    s_hi: float = 1.5
    tau_skip: float = 0.6
    beam: int = 250
    beam_skip: int = 40
    kf: int = 3  # faulty quanta in a row
    hops: int = 3
    top_chains: int = 5
    ratio_terms: bool = True
    c_s: float = 15.0  # metres of turn-boundary uncertainty: ratio sigma = sqrt(sig_r^2 + (c_s / straight)^2) per side (short straights have unreliable ratios)
    b_r: float = 0.2  # median ln(len/straight) of the video/GPS quantum minus the map's (turn lengths are longer in smoothed GPS/vms headings), measured on DEV


class MapIndex:
    def __init__(self, m: dict, p: Params = Params()):
        q, E = m["q"], m["events"]
        self.p, self.N = p, len(q["sign1"])
        self.ev_mid = E["mid"]
        self.A, self.B = m["leg_a"].astype(np.int64), m["leg_b"].astype(np.int64)
        self.sg1, self.sg2 = q["sign1"] > 0, q["sign2"] > 0
        self.ua1, self.ua2 = np.log(q["ang1"]), np.log(q["ang2"])
        self.lr1, self.lr2, self.straight = q["lr1"], q["lr2"], q["straight"]
        self.dmid = 0.5 * (q["len1"] + q["len2"]) + q["straight"]
        self.u0 = np.log(25.0)
        self.NB = int(np.ceil((np.log(400.0) - self.u0) / p.wa)) + 3
        i1 = np.floor((self.ua1 - self.u0) / p.wa).astype(np.int64) + 1
        i2 = np.floor((self.ua2 - self.u0) / p.wa).astype(np.int64) + 1
        code = ((self.sg1 * 2 + self.sg2).astype(np.int64) * self.NB + np.clip(i1, 0, self.NB - 1)) * self.NB + np.clip(i2, 0, self.NB - 1)
        self.order = np.argsort(code, kind="stable")
        self.codes = code[self.order]
        nE = len(E["sign"])
        o = np.lexsort((self.dmid, self.A))  # out-legs of an event, ascending distance
        self.out_legs = o
        self.out_ptr = np.searchsorted(self.A[o], np.arange(nE + 1))
        self.out_d = self.dmid[o]
        self.out_b = self.B[o]

    def _bins(self, ln_ang: float):
        p = self.p
        x = (ln_ang - self.u0) / p.wa + 1
        b = int(np.floor(x))
        out = [b]
        f = x - b
        m = p.soft_a / p.wa
        if f < m:
            out.append(b - 1)
        if f > 1 - m:
            out.append(b + 1)
        return [min(max(v, 0), self.NB - 1) for v in out]

    def lookup(self, sign1: int, sign2: int, ang1: float, ang2: float) -> np.ndarray:
        sg = (1 if sign1 > 0 else 0) * 2 + (1 if sign2 > 0 else 0)
        res = []
        for b1 in self._bins(np.log(ang1)):
            for b2 in self._bins(np.log(ang2)):
                c = (sg * self.NB + b1) * self.NB + b2
                lo, hi = np.searchsorted(self.codes, c, "left"), np.searchsorted(self.codes, c, "right")
                if hi > lo:
                    res.append(self.order[lo:hi])
        return np.concatenate(res) if res else np.zeros(0, np.int64)

    def reach(self, x: int, dmax: float, hops: int, cap: int = 4000) -> dict:
        """events reachable from event x over 1..hops legs within map distance dmax (mid-to-mid): {event: (dist, hops)} (shortest distance)."""
        best: dict[int, tuple[float, int]] = {}
        frontier = [(x, 0.0)]
        for h in range(1, hops + 1):
            nxt = []
            for ev, d0 in frontier:
                lo, hi = self.out_ptr[ev], self.out_ptr[ev + 1]
                if hi <= lo:
                    continue
                k = lo + int(np.searchsorted(self.out_d[lo:hi], dmax - d0, "right"))
                for j in range(lo, k):
                    y, d = int(self.out_b[j]), d0 + float(self.out_d[j])
                    if y not in best or d < best[y][0]:
                        best[y] = (d, h)
                        nxt.append((y, d))
                if len(best) > cap:
                    return best
            frontier = nxt
        return best


@dataclass
class Chain:
    score: float
    legs: list  # [(quantum index in window, leg id)]
    n_matched: int
    n_faulty: int
    events: frozenset = field(default_factory=frozenset)
    log_scale: float = float("nan")


def _cap2(z, cap):
    return np.minimum(z * z, cap * cap)


def candidates(ix: MapIndex, vq: dict, i: int):
    """Candidate legs of video quantum i with emission and ln-scale estimates (arrays)."""
    p = ix.p
    ids = ix.lookup(int(vq["sign1"][i]), int(vq["sign2"][i]), float(vq["ang1"][i]), float(vq["ang2"][i]))
    if len(ids) == 0:
        return ids, np.zeros(0), np.zeros(0), 0
    za1 = (np.log(vq["ang1"][i]) - ix.ua1[ids]) / p.sig_a
    za2 = (np.log(vq["ang2"][i]) - ix.ua2[ids]) / p.sig_a
    keep = (np.abs(za1) <= p.cand_z) & (np.abs(za2) <= p.cand_z)
    unc = bool(vq["unc"][i])
    use_r = p.ratio_terms and not unc
    if use_r:
        sv = max(float(vq["straight"][i]), 1.0)
        sm = np.maximum(ix.straight[ids], 1.0)
        # boundary uncertainty enters through both the video and the map straight; use the video one for the window, both for the z-score
        sig1 = np.sqrt(p.sig_r ** 2 + (p.c_s / np.minimum(sv, sm)) ** 2)
        dr1, dr2 = vq["lr1"][i] - ix.lr1[ids] - p.b_r, vq["lr2"][i] - ix.lr2[ids] - p.b_r
        keep &= (np.abs(dr1) <= np.maximum(p.ratio_win, 2.5 * sig1)) & (np.abs(dr2) <= np.maximum(p.ratio_win, 2.5 * sig1))
    ids, za1, za2 = ids[keep], za1[keep], za2[keep]
    if len(ids) == 0:
        return ids, np.zeros(0), np.zeros(0), 0
    e = _cap2(za1, p.zcap) + _cap2(za2, p.zcap)
    if use_r:
        e = e + _cap2(dr1[keep] / sig1[keep], p.zcap) + _cap2(dr2[keep] / sig1[keep], p.zcap)
    n_good = int((e <= 4.0).sum())
    bonus = p.bonus + p.idf * float(np.log(ix.N / max(n_good, 1)))
    em = bonus - 0.5 * e
    if unc:
        x = np.full(len(ids), np.nan)
    else:
        x = np.log(max(float(vq["straight"][i]), 1.0) / np.maximum(ix.straight[ids], 1.0))
    top = np.argsort(-em)[: p.beam]
    return ids[top], em[top], x[top], n_good


def _prior_pen(x: float, p: Params) -> float:
    lo, hi = np.log(p.s_lo), np.log(p.s_hi)
    d = max(lo - x, x - hi, 0.0)
    return 0.5 * (d / 0.15) ** 2


def match_window(ix: MapIndex, vq: dict, lo: int, hi: int) -> list[Chain]:
    """Chains for video quanta lo..hi-1; best first, distinct (event overlap < 50 %)."""
    p = ix.p
    L = hi - lo
    dmid_v = 0.5 * (vq["len1"][lo:hi] + vq["len2"][lo:hi]) + vq["straight"][lo:hi]
    unc_v = vq["unc"][lo:hi]
    C = []  # per quantum: dict of arrays
    for i in range(L):
        ids, em, x, ng = candidates(ix, vq, lo + i)
        C.append(dict(ids=ids, em=em, x=x, sc=np.full(len(ids), -np.inf), mu=np.full(len(ids), np.nan), n=np.zeros(len(ids), int),
                      pq=np.full(len(ids), -1), ps=np.full(len(ids), -1)))
    for i in range(L):
        c = C[i]
        ids, em, x = c["ids"], c["em"], c["x"]
        K = len(ids)
        if K == 0:
            continue
        # start (all earlier quanta faulty)
        for s in range(K):
            xs = x[s]
            pen = 0.0 if np.isnan(xs) else _prior_pen(xs, p)
            c["sc"][s] = em[s] - p.pf * i - pen
            c["mu"][s], c["n"][s] = (xs, 1) if not np.isnan(xs) else (np.nan, 0)
        A = ix.A[ids]
        for k in range(0, min(p.kf, i - 1 + 1)):
            i0 = i - 1 - k
            if i0 < 0:
                break
            src = C[i0]
            if len(src["ids"]) == 0:
                continue
            ok = np.flatnonzero(np.isfinite(src["sc"]))
            if len(ok) == 0:
                continue
            if k == 0:
                byB: dict[int, list] = {}
                for s0 in ok:
                    byB.setdefault(int(ix.B[src["ids"][s0]]), []).append(int(s0))
                for s in range(K):
                    lst = byB.get(int(A[s]))
                    if not lst:
                        continue
                    for s0 in lst:
                        mu, n = src["mu"][s0], src["n"][s0]
                        xs = x[s]
                        pen, nmu, nn = 0.0, mu, n
                        if not np.isnan(xs):
                            if n > 0:
                                pen = 0.5 * ((xs - mu) / p.tau) ** 2
                                nmu, nn = (mu * n + xs) / (n + 1), n + 1
                            else:
                                pen = _prior_pen(xs, p)
                                nmu, nn = xs, 1
                        v = src["sc"][s0] + em[s] - pen
                        if v > c["sc"][s]:
                            c["sc"][s], c["mu"][s], c["n"][s], c["pq"][s], c["ps"][s] = v, nmu, nn, i0, s0
            else:
                # skip transitions: k faulty quanta strictly between i0 and i. Video turns i0+1 .. i are matched at the ends.
                best_src = ok[np.argsort(-src["sc"][ok])[: p.beam_skip]]
                dv = float(dmid_v[i0 + 1:i].sum())
                unc_skip = bool(unc_v[i0 + 1:i].any())
                dmax = dv / p.s_lo * 1.2 + 80.0
                tgt: dict[int, list] = {}
                for s in range(K):
                    tgt.setdefault(int(A[s]), []).append(s)
                for s0 in best_src:
                    X = int(ix.B[src["ids"][s0]])
                    r = ix.reach(X, dmax, p.hops)
                    for y, (dm, h) in r.items():
                        ss = tgt.get(y)
                        if not ss:
                            continue
                        xd = np.log(max(dv, 1.0) / max(dm, 1.0))
                        mu, n = src["mu"][s0], src["n"][s0]
                        tol = p.tau_skip * (1.5 if unc_skip else 1.0)
                        pen_skip = 0.5 * ((xd - mu) / tol) ** 2 if n > 0 else _prior_pen(xd, p)
                        pen_skip = min(pen_skip, 8.0) + 0.5 * (h - 1)
                        for s in ss:
                            xs = x[s]
                            pen, nmu, nn = 0.0, mu, n
                            if not np.isnan(xs):
                                if n > 0:
                                    pen = 0.5 * ((xs - mu) / p.tau) ** 2
                                    nmu, nn = (mu * n + xs) / (n + 1), n + 1
                                else:
                                    pen = _prior_pen(xs, p)
                                    nmu, nn = xs, 1
                            v = src["sc"][s0] - p.pf * k - pen_skip + em[s] - pen
                            if v > c["sc"][s]:
                                c["sc"][s], c["mu"][s], c["n"][s], c["pq"][s], c["ps"][s] = v, nmu, nn, i0, s0
    # collect end states
    ends = []
    for i in range(L):
        c = C[i]
        for s in range(len(c["ids"])):
            if np.isfinite(c["sc"][s]):
                ends.append((c["sc"][s] - p.pf * (L - 1 - i), i, s))
    ends.sort(reverse=True)
    chains: list[Chain] = []
    seen_sigs = []
    for tot, i, s in ends[:400]:
        legs, qi, ss = [], i, s
        mu = C[i]["mu"][s]
        while qi >= 0 and ss >= 0:
            legs.append((qi, int(C[qi]["ids"][ss])))
            qi, ss = int(C[qi]["pq"][ss]), int(C[qi]["ps"][ss])
        legs.reverse()
        evs = frozenset(int(e) for _, lg in legs for e in (ix.A[lg], ix.B[lg]))
        dup = False
        for c0 in chains:
            if len(evs & c0.events) >= 0.5 * min(len(evs), len(c0.events)):
                dup = True
                break
        if dup:
            continue
        chains.append(Chain(float(tot), legs, len(legs), L - len(legs), evs, float(mu)))
        if len(chains) >= p.top_chains + 1:
            break
    if not chains:
        chains.append(Chain(-p.pf * L, [], 0, L))
    return chains
