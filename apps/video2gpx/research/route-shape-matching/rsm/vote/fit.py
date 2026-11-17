# SPDX-License-Identifier: AGPL-3.0-or-later
"""Idea 3, stage B without bounds on the angle scale rho and the distance scale kappa.

Copy-with-changes of rsm.plaus.fit.fit_candidate (that package is frozen): the Gaussian priors on kappa and rho are removed, the hard bounds are
wide (0.25 .. 4), rho is started from several values (closed-form slope, 1, 0.65, 1.55) and the best two starts are refined. Everything else
(Cauchy loss, drift per segment, offsets, gap bridging, start offset, slow scale change) is the plaus model unchanged. `rho_fixed` / `kappa_fixed`
= (centre, relative half-width) give the tight re-fit.
rho multiplies the video heading: map heading = rho * vms heading, vms integrated with f360 = F, so f_eff = F / rho.
"""
from __future__ import annotations

import time
from dataclasses import replace

import numpy as np
from scipy.optimize import least_squares

from rsm.plaus import fit as pf
from rsm.plaus.data import VWin
from rsm.plaus.path import MapPath

LO, HI = 0.25, 4.0


class FreeModel(pf.Model):
    """plaus Model without the Gaussian priors on log kappa and log rho (hard bounds only)."""

    def residuals(self, x):
        rj, pen = super().residuals(x)
        pen = pen.copy()
        pen[0] = 0.0
        pen[1] = 0.0
        return rj, pen


def closed_form_rho(vw: VWin, mp: MapPath, mod: FreeModel, x) -> float:
    """least-squares slope of the map heading on the video heading, per-segment offsets removed (at the start values of u)."""
    u, _, _ = mod.positions(x)
    ph = np.interp(u, mp.u, mp.phi)
    num = den = 0.0
    for m in range(vw.M):
        k = vw.seg == m
        t = vw.th[k] - vw.th[k].mean()
        p = ph[k] - ph[k].mean()
        num += float(t @ p)
        den += float(t @ t)
    return float(np.clip(num / den, 0.3, 3.5)) if den > 1e-9 else 1.0


def fit_free(vw: VWin, mp: MapPath, anchors, rho_fixed=None, kappa_fixed=None, starts=None) -> pf.Fit:
    t0 = time.time()
    pr = replace(pf.PRIORS["measured"], kappa=(LO, HI), rho=(LO, HI), rho_fixed=rho_fixed, kappa_fixed=kappa_fixed)
    mod = FreeModel(vw, mp, pr)
    x0, lo, hi, u_init = pf._init(vw, mp, pr, anchors, 0.0)
    mod.u_init = u_init
    lo[0], hi[0] = u_init - pr.u0_bound, u_init + pr.u0_bound
    x0[0] = np.clip(x0[0], lo[0] + 1e-9, hi[0] - 1e-9)
    r0, r1 = pr.r_bounds()

    def scan(xs):
        best, bx = np.inf, xs
        for d in np.arange(-pr.u0_bound, pr.u0_bound + 1e-9, max(pr.u0_bound / 8, 10.0)):
            x = xs.copy(); x[0] = np.clip(u_init + d, lo[0] + 1e-9, hi[0] - 1e-9)
            u, hv, _ = mod.positions(x)
            for m in range(vw.M):
                k = vw.seg == m
                x[4 + vw.M - 1 + m] = np.median(np.interp(u[k], mp.u, mp.phi) - np.exp(x[2]) * vw.th[k])
            cst = float(np.sum(mod.fun(x) ** 2))
            if cst < best:
                best, bx = cst, x
        return best, bx

    if starts is None:
        if rho_fixed:
            starts = [rho_fixed[0]]
        else:
            b1, x1 = scan(np.where(np.arange(len(x0)) == 2, 0.0, x0))  # rho = 1
            starts = [closed_form_rho(vw, mp, mod, x1), 1.0, 0.65, 1.55]
    uniq = []
    for s in starts:
        s = float(np.clip(s, r0 * 1.01, r1 * 0.99))
        if all(abs(np.log(s / v)) > 0.08 for v in uniq):
            uniq.append(s)
    cands = []
    for s in uniq:
        xs = x0.copy(); xs[2] = np.log(s)
        cands.append(scan(xs))
    cands.sort(key=lambda c: c[0])
    xscale = np.concatenate([[20, .1, .05, .1], np.full(vw.M - 1, .3), np.full(vw.M, .3), np.full(vw.M, 2e-3)])
    best = None
    for _, bx in cands[:2]:
        try:
            sol = least_squares(mod.fun, bx, bounds=(lo, hi), method="trf", x_scale=xscale, max_nfev=60)
        except Exception:
            continue
        if best is None or sol.cost < best.cost:
            best = sol
    if best is None:
        return pf.Fit(False, sec=time.time() - t0)
    x = best.x
    rj, pen = mod.residuals(x)
    u0, lk, lr, lam, lg, c, r = mod.unpack(x)
    f = pf.Fit(True, cost=0.5 * float(rj @ rj + pen @ pen), data=0.5 * float(rj @ rj), pen=0.5 * float(pen @ pen), n=vw.n, kappa=float(np.exp(lk)), rho=float(np.exp(lr)),
               lam=float(lam), u0=float(u0), gam=np.exp(lg), c=c, rate=r / pf.DEG)
    k0, k1 = pr.k_bounds()
    f.atbound = bool(f.kappa < k0 * 1.02 or f.kappa > k1 / 1.02 or f.rho < r0 * 1.02 or f.rho > r1 / 1.02 or np.any(np.abs(f.rate) > pr.rate_cap * 0.98))
    pf.position_residual(vw, mp, mod, x, f, False)
    f.sec = time.time() - t0
    return f
