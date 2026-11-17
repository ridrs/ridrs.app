# SPDX-License-Identifier: AGPL-3.0-or-later
"""Speed-dependent distance scale of the vms, estimated per video from the tracker's own good routes (NO GPS).

For stretches of 40 consecutive steps (about 320 m, no gap, no event, windowed cost low) of the routes of the best cluster, the ratio
R = (map arc length of the route) / (kappa0 x nominal vms length) is computed and regressed on x = mean max(v - knee, 0):  R - 1 = a + b x.
The map arc length is what the tracker realised with its snaps, scale state and (v3) stretches, so (a, b) say how the vms distance has to be
scaled on this video. Pass 2 of the tracker uses  step = kappa0 (1 + a) ds (1 + b max(v - knee, 0)).  The intercept a is the low-speed
(below the knee) offset of kappa0.
"""
from __future__ import annotations

import numpy as np

WIN = 40


def window_ratios(routes, S, knee=3.0, max_cost=0.35, kappa=None):
    sf = S["sf"]; fw = S["fw"]; L = fw.L
    kap = kappa if kappa is not None else S["ctx"].kappa0
    key = {}
    for sgi in sf.segs:
        for t, ds, v in zip(sgi.t, sgi.ds, sgi.vs):
            key[round(float(t), 3)] = (ds, v)
    X, R, W = [], [], []
    for r in routes:
        n = len(r.t)
        arc = np.zeros(n); okp = np.zeros(n, bool)
        for i in range(1, n):
            e0, e1 = int(r.E[i - 1]), int(r.E[i])
            if r.flag[i] or r.flag[i - 1] or r.t[i] - r.t[i - 1] > 6.0:
                continue
            if e0 == e1:
                arc[i] = r.U[i] - r.U[i - 1]
            elif e1 in set(fw.succ(e0).tolist()):
                arc[i] = L[e0] - r.U[i - 1] + r.U[i]
            else:
                continue
            okp[i] = arc[i] >= -1.0
        ds = np.zeros(n); vv = np.zeros(n); hv = np.zeros(n, bool)
        for i in range(n):
            q = key.get(round(float(r.t[i]), 3))
            if q is not None:
                ds[i], vv[i] = q; hv[i] = True
        for a in range(1, n - WIN, WIN // 2):
            b = a + WIN
            sl = slice(a, b)
            if not (okp[sl].all() and hv[sl].all()) or r.inc[sl].mean() > max_cost:
                continue
            nom = kap * ds[sl].sum()
            if nom < 100:
                continue
            X.append(float(np.maximum(vv[sl] - knee, 0).mean())); R.append(arc[sl].sum() / nom - 1.0); W.append(nom)
    return np.array(X), np.array(R), np.array(W)


def fit(X, R, W, nbins=6):
    """robust: median ratio in quantile bins of x, weighted least squares through the bin medians -> (a, b, n windows, bin table)"""
    if len(X) < 12:
        return 0.0, 0.0, len(X), []
    q = np.unique(np.quantile(X, np.linspace(0, 1, nbins + 1)))
    idx = np.clip(np.searchsorted(q, X, side="right") - 1, 0, len(q) - 2)
    bx, br, bw, tab = [], [], [], []
    for j in range(len(q) - 1):
        m = idx == j
        if m.sum() < 4:
            continue
        bx.append(float(np.median(X[m]))); br.append(float(np.median(R[m]))); bw.append(float(np.sqrt(m.sum())))
        tab.append((bx[-1], br[-1], int(m.sum())))
    if len(bx) < 2 or np.ptp(bx) < 0.3:
        return float(np.median(R)), 0.0, len(X), tab
    A = np.vstack([np.ones(len(bx)), bx]).T * np.array(bw)[:, None]
    a, b = np.linalg.lstsq(A, np.array(br) * np.array(bw), rcond=None)[0]
    return float(a), float(b), len(X), tab
