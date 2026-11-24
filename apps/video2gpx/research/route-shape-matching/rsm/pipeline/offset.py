# SPDX-License-Identifier: AGPL-3.0-or-later
"""Driving line: the decoded centre-line path shifted sideways by a fixed offset (v1 approximation of the camera's lane position).

The path is on a 1 m grid. The tangent angle psi(s) is the unwrapped polyline heading smoothed with a Gaussian (OFFSET_SMOOTH_M), so vertex kinks vanish; the point is
P(s) + delta(s) n(psi(s)) with n the right-hand normal. The offset curve's length element is g = 1 + delta kappa (kappa = d psi / d s, left positive, delta positive to the
right): g < 1 on the inner side of a bend, g <= 0 would be a loop. delta is therefore limited to OFFSET_MAX_FRAC / |kappa| where it is on the inner side (g >= 0.4), then
smoothed again; one-way stretches get 0 m, with a smooth ramp."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter1d

from . import config as C


def _piece_bounds(xy: np.ndarray, step: float = 1.0) -> list[tuple[int, int]]:
    """connected slices [a, b) of a `step`-m polyline, split at any disconnected cut jump (> max(5 m, 5*step))"""
    n = len(xy)
    if n < 2:
        return [(0, n)]
    br = np.flatnonzero(np.hypot(*np.diff(xy, axis=0).T) > max(5.0, 5.0 * step)) + 1
    if len(br) == 0:
        return [(0, n)]
    edges = [0] + [int(x) for x in br] + [n]
    return list(zip(edges[:-1], edges[1:]))


def driving_line(xy: np.ndarray, delta_m: float, side: str = "right", oneway: np.ndarray | None = None, step: float = 1.0, smooth_m: float = C.OFFSET_SMOOTH_M,
                 max_frac: float = C.OFFSET_MAX_FRAC):
    """xy (n,2) metres on a grid of `step` m. -> (P (n,2), delta (n,) signed right-positive, g (n,) length element of the offset curve)"""
    xy = np.asarray(xy, float)
    n = len(xy)
    if n < 3:
        return xy.copy(), np.zeros(n), np.ones(n)
    pieces = _piece_bounds(xy, step)
    if len(pieces) > 1:
        ow = None if oneway is None else np.asarray(oneway)
        dm_arr = np.asarray(delta_m)
        Ps, dls, gs = [], [], []
        for a, b in pieces:
            d_sub = dm_arr[a:b] if dm_arr.ndim > 0 else delta_m
            P_, dl_, g_ = driving_line(xy[a:b], d_sub, side, None if ow is None else ow[a:b], step, smooth_m, max_frac)
            Ps.append(P_); dls.append(dl_); gs.append(g_)
        return np.vstack(Ps), np.concatenate(dls), np.concatenate(gs)
    d = np.diff(xy, axis=0)
    phi = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
    phi = np.concatenate([phi, phi[-1:]])                     # heading of the segment starting at each point
    psi = gaussian_filter1d(phi, smooth_m / step, mode="nearest")
    kap = np.gradient(psi, step)
    sgn = 1.0 if side == "right" else -1.0
    w = np.ones(n) if oneway is None else 1.0 - gaussian_filter1d(np.asarray(oneway, float), 8.0 / step, mode="nearest")
    dl = sgn * delta_m * w
    for _ in range(2):
        inner = dl * kap < 0
        lim = np.where(inner, max_frac / np.maximum(np.abs(kap), 1e-9), np.inf)
        dl = np.sign(dl) * np.minimum(np.abs(dl), lim)
        dl = gaussian_filter1d(dl, 3.0 / step, mode="nearest")
    nrm = np.column_stack([np.sin(psi), -np.cos(psi)])         # right-hand normal of the direction (cos psi, sin psi)
    P = xy + dl[:, None] * nrm
    g = 1.0 + dl * kap
    return P, dl, g


def has_loops(P: np.ndarray, xy: np.ndarray) -> bool:
    """an offset curve reversing against the centre line (dot product of the steps <= 0) or crossing itself"""
    from shapely.geometry import LineString
    pieces = _piece_bounds(np.asarray(xy, float))
    if len(pieces) > 1:
        return any(has_loops(P[a:b], xy[a:b]) for a, b in pieces if b - a >= 2)
    dp_ = np.einsum("ij,ij->i", np.diff(P, axis=0), np.diff(xy, axis=0))
    return bool((dp_ <= 0).any()) or not LineString(P).is_simple


def compass(P: np.ndarray, half: int = 5) -> np.ndarray:
    P = np.asarray(P, float)
    pieces = _piece_bounds(P)
    if len(pieces) > 1:
        return np.concatenate([compass(P[a:b], half) for a, b in pieces])
    n = len(P)
    a, b = np.clip(np.arange(n) - half, 0, n - 1), np.clip(np.arange(n) + half, 0, n - 1)
    dd = P[b] - P[a]
    return (np.degrees(np.arctan2(dd[:, 0], dd[:, 1])) + 360.0) % 360.0


def path_curvature(xy: np.ndarray, step: float = 1.0, smooth_m: float = C.OFFSET_SMOOTH_M) -> np.ndarray:
    """1/m, left positive: derivative of the smoothed unwrapped heading (as in driving_line)"""
    xy = np.asarray(xy, float)
    pieces = _piece_bounds(xy, step)
    if len(pieces) > 1:
        return np.concatenate([path_curvature(xy[a:b], step, smooth_m) for a, b in pieces])
    if len(xy) < 2:
        return np.zeros(len(xy))
    d = np.diff(xy, axis=0)
    phi = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
    psi = gaussian_filter1d(np.concatenate([phi, phi[-1:]]), smooth_m / step, mode="nearest")
    return np.gradient(psi, step)


def speed_on_path(t: np.ndarray, s: np.ndarray, sg: np.ndarray, smooth_s: float = 5.0) -> np.ndarray:
    """m/s per path metre from the fused s(t) of refine (one value per second), smoothed over smooth_s seconds"""
    t, s = np.asarray(t, float), np.asarray(s, float)
    if len(t) < 3:
        return np.zeros(len(sg))
    v = gaussian_filter1d(np.clip(np.gradient(s, t), 0.0, 40.0), smooth_s, mode="nearest")
    o = np.argsort(s, kind="stable")
    return np.interp(sg, s[o], v[o])


def solve_line(xy: np.ndarray, d_pref: np.ndarray, lo: np.ndarray, hi: np.ndarray, v: np.ndarray, side: str = "right", roundabout: np.ndarray | None = None,
               step: float = 1.0) -> np.ndarray:
    """driving line layer L2: the lateral position d (m to the driving side) that minimises
        sum w_a (k_c - sgn d'')^2 + sum w_p (d - d_pref)^2 + LINE_W_D1 sum d'^2,   lo <= d <= hi,
    w_a = (v^2 / LINE_A_REF)^2 (a fast vehicle flattens bends inside the corridor, a slow one keeps its lane position), w_p = LINE_W_P, lowered near junction kinks
    and 0 on roundabouts. k_c - d'' is the curvature of the right-offset line to first order. A box-constrained QP with a pentadiagonal Hessian, solved exactly
    by ADMM on the whole path (one sparse LU; an iterative bounded least squares did not converge in 200 iterations on a synthetic bend)."""
    from scipy import sparse
    xy = np.asarray(xy, float)
    pieces = _piece_bounds(xy, step)
    if len(pieces) > 1:
        rb = None if roundabout is None else np.asarray(roundabout)
        return np.concatenate([solve_line(xy[a:b], np.asarray(d_pref)[a:b], np.asarray(lo)[a:b], np.asarray(hi)[a:b], np.asarray(v)[a:b],
                                          side, None if rb is None else rb[a:b], step) for a, b in pieces])
    n = len(xy)
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    dp = np.clip(np.asarray(d_pref, float), lo, hi)
    if n < 5:
        return dp
    sgn = 1.0 if side == "right" else -1.0
    k = path_curvature(xy, step)
    wa2 = (np.asarray(v, float) ** 2 / C.LINE_A_REF) ** 2
    psi = np.cumsum(k) * step
    hw = int(C.LINE_KINK_HALF_M / step)
    i = np.arange(n)
    kink = np.degrees(np.abs(psi[np.minimum(i + hw, n - 1)] - psi[np.maximum(i - hw, 0)])) >= C.LINE_KINK_DEG
    wp = np.where(kink, C.LINE_W_P * C.LINE_KINK_WP_FACTOR, C.LINE_W_P)
    if roundabout is not None:
        wp = np.where(np.asarray(roundabout, bool), 0.0, wp)
    D2 = sparse.diags([1.0, -2.0, 1.0], [0, 1, 2], shape=(n - 2, n)) / step ** 2
    D1 = sparse.diags([-1.0, 1.0], [0, 1], shape=(n - 1, n)) / step
    H = (D2.T @ sparse.diags(wa2[1:-1]) @ D2 + sparse.diags(wp + 1e-9) + C.LINE_W_D1 * (D1.T @ D1)).tocsr()
    b = sgn * (D2.T @ (wa2[1:-1] * k[1:-1])) + wp * dp
    # ADMM for the box: x = argmin 1/2 x'Hx - b'x + rho/2 |x - z + u|^2 (one sparse LU, reused), z = clip(x + u), u += x - z
    from scipy.sparse.linalg import splu
    rho = C.LINE_ADMM_RHO
    lu = splu((H + rho * sparse.identity(n)).tocsc())
    z, u = dp.copy(), np.zeros(n)
    for _ in range(C.LINE_MAX_ITER):
        x = lu.solve(b + rho * (z - u))
        z_old = z
        z = np.clip(x + u, lo, hi)
        u += x - z
        if max(np.abs(x - z).max(), np.abs(z - z_old).max()) < C.LINE_TOL_M:
            break
    return z
