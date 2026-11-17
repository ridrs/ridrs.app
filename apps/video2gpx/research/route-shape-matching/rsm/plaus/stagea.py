# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage A: top-K distinct chains of a window of video quanta.

COPY of rsm.quanta.chain.match_window (that file is frozen and not edited) with two changes: the number of end states looked at (400 there) is
`max_ends`, and the number of returned distinct chains is `K` instead of top_chains + 1. The DP is identical; `tests/test_plaus.py` checks that the
first 6 chains equal chain.match_window's.
"""
from __future__ import annotations

import numpy as np

from rsm.quanta.chain import Chain, candidates, _prior_pen


def match_window_k(ix, vq, lo, hi, K=50, max_ends=3000):
    p = ix.p
    L = hi - lo
    dmid_v = 0.5 * (vq["len1"][lo:hi] + vq["len2"][lo:hi]) + vq["straight"][lo:hi]
    unc_v = vq["unc"][lo:hi]
    C = []
    for i in range(L):
        ids, em, x, ng = candidates(ix, vq, lo + i)
        C.append(dict(ids=ids, em=em, x=x, sc=np.full(len(ids), -np.inf), mu=np.full(len(ids), np.nan), n=np.zeros(len(ids), int),
                      pq=np.full(len(ids), -1), ps=np.full(len(ids), -1)))
    for i in range(L):
        c = C[i]
        ids, em, x = c["ids"], c["em"], c["x"]
        Kc = len(ids)
        if Kc == 0:
            continue
        for s in range(Kc):
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
                for s in range(Kc):
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
                best_src = ok[np.argsort(-src["sc"][ok])[: p.beam_skip]]
                dv = float(dmid_v[i0 + 1:i].sum())
                unc_skip = bool(unc_v[i0 + 1:i].any())
                dmax = dv / p.s_lo * 1.2 + 80.0
                tgt: dict[int, list] = {}
                for s in range(Kc):
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
    ends = []
    for i in range(L):
        c = C[i]
        for s in range(len(c["ids"])):
            if np.isfinite(c["sc"][s]):
                ends.append((c["sc"][s] - p.pf * (L - 1 - i), i, s))
    ends.sort(reverse=True)
    chains: list[Chain] = []
    for tot, i, s in ends[:max_ends]:
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
        if len(chains) >= K:
            break
    if not chains:
        chains.append(Chain(-p.pf * L, [], 0, L))
    return chains
