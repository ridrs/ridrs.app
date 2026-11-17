# SPDX-License-Identifier: AGPL-3.0-or-later
"""RTS smoother for the position s(t) along the fixed route.

State x = [s, rho]: s = arc length (m), rho = map metres per nominal vms metre RELATIVE to the HMM's global kappa (rho = 1: the HMM scale), a slowly varying
distance factor. Between two nodes with nominal vms distance dD (dm = kappa dD):  s += rho dm,  rho' = rho + w,  var w = q_rho^2 dm (random walk in distance);
s also gets q_s^2 dm and (gap_rel x gap distance)^2 for stretches whose vms distance is an estimate (gaps). A standstill (dD = 0) moves nothing and adds nothing.
Measurements z = s + e with variance R (posterior mean with its spread, anchors of ANY kind through sig_s, sig_t, quality), made robust by Huber IRLS: every
pass re-runs forward Kalman + RTS backward with R_eff = R / w, w = min(1, c / |r|), r = deleted residual (leave-one-out, from the smoothed variance) in sd.
Output: s(t), rho(t) and their smoothed sd at the requested times.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Meas:
    t: float
    z: float
    R: float            # variance (m^2)
    kind: str


@dataclass
class FuseParams:
    q_rho: float = 2.5e-3       # sd of rho per sqrt(map metre)
    q_s: float = 0.25           # m per sqrt(map metre)
    gap_rel: float = 0.25       # relative sd of the distance inside gaps
    rho0_sd: float = 0.2        # prior sd of rho (relative to kappa)
    huber_c: float = 1.5
    n_irls: int = 4
    w_min: float = 1e-3


def _predict(x, P, dm, dgap, fp: FuseParams):
    F = np.array([[1.0, dm], [0.0, 1.0]])
    qr2 = fp.q_rho ** 2
    Q = np.array([[fp.q_s ** 2 * dm + qr2 * dm ** 3 / 3.0 + (fp.gap_rel * dgap) ** 2, qr2 * dm ** 2 / 2.0], [qr2 * dm ** 2 / 2.0, qr2 * dm]])
    return F @ x, F @ P @ F.T + Q, F


def smooth(times: np.ndarray, dm: np.ndarray, dgap: np.ndarray, meas: list[Meas], s_init: float, fp: FuseParams, weights: np.ndarray | None = None):
    """times: (n,) sorted node times; dm[i] / dgap[i]: map metres (kappa x nominal) / gap metres from node i-1 to i (dm[0] unused). meas at node times (index by t).
    -> xs (n,2), Ps (n,2,2), weights used"""
    n = len(times)
    idx = np.searchsorted(times, [m.t for m in meas])
    by_node = {}
    for j, i in enumerate(idx):
        by_node.setdefault(int(i), []).append(j)
    w = np.ones(len(meas)) if weights is None else weights
    xf = np.zeros((n, 2)); Pf = np.zeros((n, 2, 2)); xp = np.zeros((n, 2)); Pp = np.zeros((n, 2, 2)); Fs = np.zeros((n, 2, 2))
    x = np.array([s_init, 1.0]); P = np.diag([200.0 ** 2, fp.rho0_sd ** 2])
    for i in range(n):
        if i > 0:
            x, P, F = _predict(x, P, float(dm[i]), float(dgap[i]), fp)
            Fs[i] = F
        else:
            Fs[i] = np.eye(2)
        xp[i], Pp[i] = x, P
        for j in by_node.get(i, []):
            R = meas[j].R / max(w[j], fp.w_min)
            S = P[0, 0] + R
            K = P[:, 0] / S
            x = x + K * (meas[j].z - x[0])
            P = P - np.outer(K, P[0, :])
            P = 0.5 * (P + P.T)
        xf[i], Pf[i] = x, P
    xs = xf.copy(); Ps = Pf.copy()
    for i in range(n - 2, -1, -1):
        C = Pf[i] @ Fs[i + 1].T @ np.linalg.inv(Pp[i + 1])
        xs[i] = xf[i] + C @ (xs[i + 1] - xp[i + 1])
        Ps[i] = Pf[i] + C @ (Ps[i + 1] - Pp[i + 1]) @ C.T
    return xs, Ps, idx


def fuse(times, dm, dgap, meas: list[Meas], s_init: float, fp: FuseParams | None = None):
    """robust (Huber IRLS) fusion. -> dict(xs, Ps, w (per measurement), r (deleted standardised residual per measurement))"""
    fp = fp or FuseParams()
    w = np.ones(len(meas))
    r = np.zeros(len(meas))
    for it in range(fp.n_irls + 1):
        xs, Ps, idx = smooth(times, dm, dgap, meas, s_init, fp, w)
        if it == fp.n_irls or not meas:
            break
        for j, m in enumerate(meas):
            i = int(idx[j])
            Reff = m.R / max(w[j], fp.w_min)
            Pw = Ps[i, 0, 0]
            Pwo = 1.0 / max(1.0 / max(Pw, 1e-9) - 1.0 / Reff, 1e-12)            # smoothed variance without this measurement
            e_with = m.z - xs[i, 0]
            e_del = e_with / max(1.0 - Pw / Reff, 1e-6)
            r[j] = e_del / np.sqrt(Pwo + m.R)
            w[j] = min(1.0, fp.huber_c / max(abs(r[j]), 1e-9))
    return dict(xs=xs, Ps=Ps, w=w, r=r, idx=idx)
