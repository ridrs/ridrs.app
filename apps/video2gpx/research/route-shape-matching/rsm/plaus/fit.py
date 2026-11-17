# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stage B: fit the video heading theta(s) onto a candidate map path with plausible corrections.

Model (all in the map frame, per video sample j of segment m at nominal distance sigma_j from the window start):
    u_j      = u0 + kappa * Phi(sigma_j; lambda)          map arc length; Phi integrates a slow scale change exp(lambda (x - 1/2)), x = sigma/Sigma
    gaps     = gamma_m * (mean speed x gap time) nominal metres between segment m and m+1
    heading  = rho * theta_j + c_m + r_m * tau_j          angle scale, constant offset and linear drift per segment
    residual = heading - phi(u_j)                         robust (Cauchy) loss, scale SIG_H
Priors (hard bounds + Gaussian in log / linear) come from a `Prior`. Cost = 1/2 sum(res^2) in nats (Cauchy: 1/2 log(1+z^2) x W per sample).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, replace

import numpy as np
from scipy.optimize import least_squares

from .data import VWin
from .path import MapPath

SIG_H = 0.15  # rad, heading residual scale
W_SAMPLE = 0.4  # a 4 m sample is worth 0.4 independent 10 m observations
DEG = np.pi / 180.0


@dataclass(frozen=True)
class Prior:
    name: str
    kappa: tuple = (0.6, 1.5)
    rho: tuple = (0.85, 1.25)
    lam_cap: float = 0.4
    lam_sig: float = 0.15
    rate_sig: float = 0.3  # deg/s
    rate_cap: float = 1.0  # deg/s hard
    rate_hard: float = 0.6  # beyond this the penalty is steep
    gamma: tuple = (0.5, 2.0)
    u0_bound: float = 200.0
    kappa_fixed: tuple | None = None  # video-level consistency: (centre, rel_halfwidth)
    rho_fixed: tuple | None = None

    def k_bounds(self):
        if self.kappa_fixed:
            c, w = self.kappa_fixed
            return (max(c * (1 - w), self.kappa[0] * 0.5), c * (1 + w))
        return self.kappa

    def r_bounds(self):
        if self.rho_fixed:
            c, w = self.rho_fixed
            return (c * (1 - w), c * (1 + w))
        return self.rho


PRIORS = {
    "tight": Prior("tight", kappa=(0.85, 1.3), rho=(0.92, 1.08), lam_cap=0.2, lam_sig=0.08, rate_sig=0.15, rate_cap=0.5, rate_hard=0.3, gamma=(0.7, 1.4), u0_bound=80.0),
    "measured": Prior("measured"),
    "loose": Prior("loose", kappa=(0.4, 2.5), rho=(0.7, 1.6), lam_cap=0.8, lam_sig=0.4, rate_sig=0.6, rate_cap=2.0, rate_hard=1.2, gamma=(0.25, 4.0), u0_bound=600.0),
}


@dataclass
class Fit:
    ok: bool
    cost: float = np.inf  # total (data + priors)
    data: float = np.inf
    pen: float = np.inf
    n: int = 0
    kappa: float = np.nan
    rho: float = np.nan
    lam: float = np.nan
    u0: float = np.nan
    gam: np.ndarray = field(default_factory=lambda: np.zeros(0))
    c: np.ndarray = field(default_factory=lambda: np.zeros(0))
    rate: np.ndarray = field(default_factory=lambda: np.zeros(0))  # deg/s
    rms: float = np.nan  # lateral position residual of the dead-reckoned route, m
    maxdev: float = np.nan
    frechet: float = np.nan
    atbound: bool = False
    sec: float = 0.0
    trace: tuple | None = None  # (t, x, y) subsampled map positions
    route: np.ndarray | None = None  # dead-reckoned corrected route (n,2)
    stretch: tuple | None = None  # (u_start, u_end)
    x: np.ndarray | None = None  # fitted parameter vector

    @property
    def snorm(self) -> float:
        return self.cost / max(self.n, 1)


class Model:
    def __init__(self, vw: VWin, mp: MapPath, pr: Prior):
        self.vw, self.mp, self.pr = vw, mp, pr
        self.M = vw.M
        self.S0 = float(vw.S.sum() + vw.gnom.sum())
        self.nu = 4 + (self.M - 1) + 2 * self.M  # u0, lnk, lnr, lam, lng*(M-1), c*M, r*M(rad/s)
        k0, k1 = pr.k_bounds(); r0, r1 = pr.r_bounds()
        self.mu_k, self.sg_k = 0.5 * np.log(pr.kappa[0] * pr.kappa[1]), np.log(pr.kappa[1] / pr.kappa[0]) / 4
        self.mu_r, self.sg_r = 0.5 * np.log(pr.rho[0] * pr.rho[1]), np.log(pr.rho[1] / pr.rho[0]) / 4
        self.sg_g = np.log(pr.gamma[1] / pr.gamma[0]) / 4
        self.mu_g = 0.5 * np.log(pr.gamma[0] * pr.gamma[1])

    def unpack(self, x):
        M = self.M
        u0, lk, lr, lam = x[0], x[1], x[2], x[3]
        lg = x[4:4 + M - 1]
        c = x[4 + M - 1:4 + M - 1 + M]
        r = x[4 + M - 1 + M:]
        return u0, lk, lr, lam, lg, c, r

    def positions(self, x):
        vw = self.vw
        u0, lk, lr, lam, lg, c, r = self.unpack(x)
        gam = np.exp(lg)
        sg = vw.sigma(gam)
        xx = sg / self.S0
        if abs(lam) < 1e-6:
            Phi = sg
        else:
            Phi = self.S0 * np.exp(-lam / 2) * np.expm1(lam * xx) / lam
        u = u0 + np.exp(lk) * Phi
        hv = np.exp(lr) * vw.th + c[vw.seg] + r[vw.seg] * vw.tau
        return u, hv, gam

    def residuals(self, x):
        pr, vw, mp = self.pr, self.vw, self.mp
        u0, lk, lr, lam, lg, c, r = self.unpack(x)
        u, hv, _ = self.positions(x)
        e = hv - np.interp(u, mp.u, mp.phi)
        z = e / SIG_H
        rj = np.sign(z) * np.sqrt(np.log1p(z * z) * W_SAMPLE)
        rate = r / DEG
        pen = [(lk - self.mu_k) / self.sg_k, (lr - self.mu_r) / self.sg_r, lam / pr.lam_sig, (u0 - self.u_init) / (pr.u0_bound / 2)]
        pen += list((lg - self.mu_g) / self.sg_g)
        pen += list(rate / pr.rate_sig)
        pen += list(np.maximum(np.abs(rate) - pr.rate_hard, 0.0) / 0.05)
        return rj, np.array(pen)

    def fun(self, x):
        rj, pen = self.residuals(x)
        return np.concatenate([rj, pen])


def _init(vw: VWin, mp: MapPath, pr: Prior, anchors, u_init):
    """anchors: list of (video time, map arc length). -> x0 and bounds."""
    M = vw.M
    k0, k1 = pr.k_bounds(); r0, r1 = pr.r_bounds()
    sg = vw.sigma()
    a_t = np.array([a[0] for a in anchors]); a_u = np.array([a[1] for a in anchors])
    a_s = np.interp(a_t, vw.t, sg) if len(a_t) else np.zeros(0)
    kap = 1.0
    if len(a_s) >= 2 and np.ptp(a_s) > 50:
        sl = [(a_u[j] - a_u[i]) / (a_s[j] - a_s[i]) for i in range(len(a_s)) for j in range(i + 1, len(a_s)) if a_s[j] - a_s[i] > 30]
        if sl:
            kap = float(np.median(sl))
    kap = float(np.clip(kap, k0 * 1.02, k1 * 0.98))
    rho = float(np.clip(1.0, r0 * 1.01, r1 * 0.99))
    u0 = float(np.median(a_u - kap * a_s)) if len(a_s) else float(u_init)
    c0 = np.zeros(M)
    for m in range(M):
        k = vw.seg == m
        uu = u0 + kap * sg[k]
        c0[m] = float(np.median(np.interp(uu, mp.u, mp.phi) - rho * vw.th[k]))
    x0 = np.concatenate([[u0, np.log(kap), np.log(rho), 0.0], np.zeros(M - 1), c0, np.zeros(M)])
    lo = np.concatenate([[u_init - pr.u0_bound, np.log(k0), np.log(r0), -pr.lam_cap], np.full(M - 1, np.log(pr.gamma[0])), np.full(M, -50.0), np.full(M, -pr.rate_cap * DEG)])
    hi = np.concatenate([[u_init + pr.u0_bound, np.log(k1), np.log(r1), pr.lam_cap], np.full(M - 1, np.log(pr.gamma[1])), np.full(M, 50.0), np.full(M, pr.rate_cap * DEG)])
    x0 = np.clip(x0, lo + 1e-9, hi - 1e-9)
    return x0, lo, hi, u0


def fit_candidate(vw: VWin, mp: MapPath, pr: Prior, anchors, with_route: bool = False) -> Fit:
    t0 = time.time()
    mod = Model(vw, mp, pr)
    # start offset prior centre: the anchors' own estimate of u0 (the map path fixes where the video window starts)
    x0, lo, hi, u_init = _init(vw, mp, pr, anchors, 0.0)
    mod.u_init = u_init
    lo[0], hi[0] = u_init - pr.u0_bound, u_init + pr.u0_bound
    x0[0] = np.clip(x0[0], lo[0] + 1e-9, hi[0] - 1e-9)
    # coarse scan of the start offset (data cost only), then local least squares
    best, bx = np.inf, x0
    for d in np.arange(-pr.u0_bound, pr.u0_bound + 1e-9, max(pr.u0_bound / 8, 10.0)):
        x = x0.copy(); x[0] = np.clip(u_init + d, lo[0] + 1e-9, hi[0] - 1e-9)
        # recentre the segment offsets for this u0
        u, hv, _ = mod.positions(x)
        for m in range(vw.M):
            k = vw.seg == m
            x[4 + vw.M - 1 + m] = np.median(np.interp(u[k], mp.u, mp.phi) - np.exp(x[2]) * vw.th[k])
        cst = float(np.sum(mod.fun(x) ** 2))
        if cst < best:
            best, bx = cst, x
    try:
        sol = least_squares(mod.fun, bx, bounds=(lo, hi), method="trf", x_scale=np.concatenate([[20, .1, .05, .1], np.full(vw.M - 1, .3), np.full(vw.M, .3), np.full(vw.M, 2e-3)]), max_nfev=60)
    except Exception:
        return Fit(False, sec=time.time() - t0)
    x = sol.x
    rj, pen = mod.residuals(x)
    u0, lk, lr, lam, lg, c, r = mod.unpack(x)
    f = Fit(True, cost=0.5 * float(rj @ rj + pen @ pen), data=0.5 * float(rj @ rj), pen=0.5 * float(pen @ pen), n=vw.n, kappa=float(np.exp(lk)), rho=float(np.exp(lr)), lam=float(lam),
            u0=float(u0), gam=np.exp(lg), c=c, rate=r / DEG)
    k0, k1 = pr.k_bounds(); r0, r1 = pr.r_bounds()
    f.atbound = bool(f.kappa < k0 * 1.01 or f.kappa > k1 / 1.01 or f.rho < r0 * 1.005 or f.rho > r1 / 1.005 or np.any(np.abs(f.rate) > pr.rate_cap * 0.98))
    f.x = x if with_route else None
    position_residual(vw, mp, mod, x, f, with_route)
    f.sec = time.time() - t0
    return f


def dead_reckon(vw: VWin, mp: MapPath, mod: Model, x):
    """corrected video route in the map frame: start on the path at u(first sample); steps kappa-scaled; gaps bridged with gamma x gap length along the mean heading."""
    u, hv, gam = mod.positions(x)
    u0, lk, lr, lam, lg, c, r = mod.unpack(x)
    kap = np.exp(lk)
    pts = np.zeros((vw.n, 2))
    start = mp.at(u[0])[0]
    pos = start.copy()
    prev_end = None
    for m in range(vw.M):
        k = np.flatnonzero(vw.seg == m)
        if m > 0:
            hm = 0.5 * (hv[k[0]] + hv[prev_end])
            L = gam[m - 1] * vw.gnom[m - 1] * kap
            pos = pos + L * np.array([-np.sin(hm), np.cos(hm)])
        ds = np.diff(np.concatenate([[0.0], u[k]])) if True else None
        # map-metre step lengths along the fitted u (kappa and its slow change included)
        ds = np.diff(u[k], prepend=u[k][0])
        hmid = hv[k]
        step = np.column_stack([-ds * np.sin(hmid), ds * np.cos(hmid)])
        seg = pos + np.cumsum(step, axis=0)
        pts[k] = seg
        pos = seg[-1]
        prev_end = k[-1]
    return pts, u


def position_residual(vw, mp, mod, x, f: Fit, with_route: bool):
    from rsm.core.metrics import frechet
    pts, u = dead_reckon(vw, mp, mod, x)
    d, _ = mp.tree.query(pts)
    f.rms, f.maxdev = float(np.sqrt(np.mean(d ** 2))), float(d.max())
    ua, ub = float(np.clip(u.min(), 0, mp.U)), float(np.clip(u.max(), 0, mp.U))
    f.stretch = (ua, ub)
    k = max(1, int(round(20.0 / 4.0)))
    ref = mp.at(np.linspace(ua, ub, max(int((ub - ua) / 20), 2)))
    try:
        f.frechet = frechet(pts[::k] if len(pts[::k]) > 1 else pts, ref)
    except Exception:
        f.frechet = float("nan")
    j = np.arange(0, vw.n, 5)
    f.trace = (vw.t[j].copy(), mp.at(u[j]))
    if with_route:
        f.route = pts
