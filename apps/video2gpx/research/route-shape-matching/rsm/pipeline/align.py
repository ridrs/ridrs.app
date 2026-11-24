# SPDX-License-Identifier: AGPL-3.0-or-later
"""Dense heading alignment on the fixed path (refine step).

Once the streets are fixed (route search + local pass), only the timing along the path is open. The HMM gives it in cells of 40-80 m and with a node kink:
the map heading of a junction turn sits in one transition while the video spreads the turn over 20-30 m, so a hairpin split by a junction node is passed
late and then taken in 3 s; a roundabout passed straight nets zero inside one step; between curve anchors the smoother falls back to the global distance scale.

Here every 4 m nominal video sample is aligned to the path on a 2 m grid by a monotone Viterbi: advance ~ Normal(4 kappa, rel), emission Student-t of the video
heading increment against the path heading change over the advance, with the path heading smoothed ALONG THE PATH (across nodes, so a junction turn is a
curve like in the video). Gaps between tracks advance by their measured distance (standstills) or anything up to vmax x duration.
Prototype: work/fable_timing/dp1d.py (FINDINGS "Timing in town").
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter1d

from . import config as C


def meas_mode(P: dict) -> str:
    """the alignment measurement mode of a run: `--align-mode` (params key `align_mode`), else the config default"""
    m = P.get("align_mode")
    return m if m in C.ALIGN_MEAS_MODES else C.ALIGN_MEAS_MODE


def path_heading(xy: np.ndarray, smooth_m: float) -> np.ndarray:
    """heading (rad, counter-clockwise, unwrapped) of a path sampled every 1 m, smoothed along each connected piece (never across a disconnected cut jump)"""
    xy = np.asarray(xy, float)
    n = len(xy)
    if n < 2:
        return np.zeros(n)
    br = np.flatnonzero(np.hypot(*np.diff(xy, axis=0).T) > 5.0) + 1
    if len(br) > 0:
        edges = [0] + [int(x) for x in br] + [n]
        return np.concatenate([path_heading(xy[a:b], smooth_m) for a, b in zip(edges[:-1], edges[1:])])
    phi = np.unwrap(np.arctan2(np.gradient(xy[:, 1]), np.gradient(xy[:, 0])))
    return gaussian_filter1d(phi, smooth_m, mode="nearest")


def _tlog(r, s, nu):
    return -(nu + 1) / 2 * np.log1p((r / s) ** 2 / nu) - np.log(s)


def observations(tracks, a_ang: float, gap_nom: list | None):
    """-> list of (t, dth or None, gap seconds, measured gap nominal metres or None); dth None marks the jump over a gap (also before the first track)"""
    obs = []
    prev_t = None
    for i, k in enumerate(tracks):
        t, th = np.asarray(k["t"], float), a_ang * np.asarray(k["th"], float)
        g = gap_nom[i] if gap_nom is not None and i < len(gap_nom) else None
        obs.append((float(t[0]), None, 0.0 if prev_t is None else float(t[0] - prev_t), g))
        dth = np.diff(th)
        obs.extend((float(a), float(b), 0.0, None) for a, b in zip(t[1:], dth))
        prev_t = float(t[-1])
    return obs


def align(sg: np.ndarray, xy: np.ndarray, tracks, kappa: float, a_ang: float, s_prior_t, s_prior_s, gap_nom=None, ds_nom: float = 4.0) -> dict | None:
    """-> dict(t, s) per video sample (monotone in s) or None. sg / xy: path on a 1 m arc grid; s_prior_*: a rough s(t) (the HMM route) for the start only."""
    if not tracks:
        return None
    ph_full = path_heading(xy, C.ALIGN_SMOOTH_M)
    DS = C.ALIGN_DS
    grid = np.arange(0.0, sg[-1], DS)
    N = len(grid)
    if N < 10:
        return None
    ph = np.interp(grid, sg, ph_full)
    obs = observations(tracks, a_ang, gap_nom)
    step = ds_nom * kappa
    amax = int(np.ceil(step * 2.2 / DS))
    if amax > 250:
        return None
    adv = np.arange(amax + 1)
    lp = -0.5 * ((adv * DS - step) / (C.ALIGN_REL * step)) ** 2
    v_med = float(np.median(np.concatenate([np.diff(k["s"]) / np.maximum(np.diff(k["t"]), 1e-3) for k in tracks]))) * kappa
    vmax = max(C.ALIGN_VMAX, 2.5 * v_med)
    sig0, beta, nu = np.radians(C.ALIGN_SIG0_DEG), C.ALIGN_BETA, C.ALIGN_NU
    s0 = float(np.interp(obs[0][0], s_prior_t, s_prior_s))
    a = -0.5 * ((grid - s0) / 60.0) ** 2
    NEG = -1e18
    bp = np.zeros((len(obs), N), np.uint8)
    bp_gap = {}
    # path heading change for every advance, once
    dphi = [np.zeros(N)] + [np.concatenate([np.zeros(d), ph[d:] - ph[:-d]]) for d in adv[1:]]
    sd = [sig0 + beta * np.abs(x) for x in dphi]
    for j in range(1, len(obs)):
        tj, dth, gap, gmeas = obs[j]
        best = np.full(N, NEG)
        if dth is None:
            arg = np.zeros(N, np.int32)
            if gmeas is not None:                       # measured gap (standstill): advance ~ Normal(kappa x measured, 30 % + 10 m)
                mu = gmeas * kappa
                sdg = 0.3 * mu + 10.0
                W = int(np.ceil((mu + 4 * sdg) / DS))
                for d in range(W + 1):
                    c = np.full(N, NEG)
                    c[d:] = a[:N - d] - 0.5 * ((d * DS - mu) / sdg) ** 2
                    u = c > best; best[u] = c[u]; arg[u] = d
            else:                                       # unmeasured: anything up to vmax x duration
                W = int(np.ceil(gap * vmax / DS)) + 1
                best, arg = _window_max(a, W)
            bp_gap[j] = arg
            a = best
            continue
        arg = np.zeros(N, np.uint8)
        for i, d in enumerate(adv):
            c = np.full(N, NEG)
            c[d:] = a[:N - d] + lp[i] + _tlog(dth - dphi[i][d:], sd[i][d:], nu)
            u = c > best; best[u] = c[u]; arg[u] = d
        a = best - best.max()
        bp[j] = arg
    c = int(np.argmax(a))
    path = np.zeros(len(obs), np.int64)
    path[-1] = c
    for j in range(len(obs) - 1, 0, -1):
        d = bp_gap[j][path[j]] if j in bp_gap else bp[j][path[j]]
        path[j - 1] = path[j] - int(d)
    out = dict(t=np.array([o[0] for o in obs]), s=grid[path], n_obs=len(obs), n_gaps=len(bp_gap), n_gaps_measured=int(sum(o[3] is not None for o in obs)))
    if C.ALIGN_POST_BAND_M > 0:
        a0 = -0.5 * ((grid - s0) / 60.0) ** 2
        out["s_mean"], out["s_sd"] = band_posterior(ph, obs, path, a0, DS, step, kappa, vmax, amax, sig0, beta, nu, int(round(C.ALIGN_POST_BAND_M / DS)))
    return out


def band_posterior(ph, obs, path, a0, DS, step, kappa, vmax, amax, sig0, beta, nu, B):
    """How sure the alignment is at each sample: forward-backward on the same lattice as align(), restricted to +-B grid cells around the Viterbi path.
    In a curve the heading pins the position (narrow posterior); on a straight every shift fits about equally well and the posterior widens to what the advance
    prior allows between the curves on both sides. -> (mean m, sd m) per observation. Mass beyond the band is cut off, so the sd is at most about B x DS / 2."""
    N, J = len(ph), len(obs)
    off = np.arange(-B, B + 1)
    idx = path[:, None] + off[None, :]
    valid = (idx >= 0) & (idx < N)
    idc = np.clip(idx, 0, N - 1)

    def trans(j):
        _, dth, gap, gmeas = obs[j]
        d = idx[j][:, None] - idx[j - 1][None, :]                       # advance in cells, target i x source k
        if dth is None:
            if gmeas is not None:
                mu = gmeas * kappa
                L = -0.5 * ((d * DS - mu) / (0.3 * mu + 10.0)) ** 2
            else:
                L = np.where(d <= int(np.ceil(gap * vmax / DS)) + 1, 0.0, -np.inf)
            L = np.where(d >= 0, L, -np.inf)
        else:
            dp = ph[idc[j]][:, None] - ph[idc[j - 1]][None, :]
            L = -0.5 * ((d * DS - step) / (C.ALIGN_REL * step)) ** 2 + _tlog(dth - dp, sig0 + beta * np.abs(dp), nu)
            L = np.where((d >= 0) & (d <= amax), L, -np.inf)
        L[~valid[j], :] = -np.inf
        L[:, ~valid[j - 1]] = -np.inf
        return L

    def lse(M, axis):
        m = M.max(axis=axis, keepdims=True)
        m = np.where(np.isfinite(m), m, 0.0)
        with np.errstate(divide="ignore"):
            return (np.log(np.exp(M - m).sum(axis=axis, keepdims=True)) + m).squeeze(axis)

    fa = np.empty((J, len(off)))
    fa[0] = np.where(valid[0], a0[idc[0]], -np.inf)
    fa[0] -= fa[0].max()
    for j in range(1, J):
        f = lse(trans(j) + fa[j - 1][None, :], 1)
        mx = f.max()
        fa[j] = f - mx if np.isfinite(mx) else np.where(valid[j], 0.0, -np.inf)    # band lost the path (should not happen): restart flat
    mean, sd = np.empty(J), np.empty(J)
    bk = np.where(valid[J - 1], 0.0, -np.inf)
    for j in range(J - 1, -1, -1):
        lp = fa[j] + bk
        lp = lp - lp.max() if np.isfinite(lp.max()) else np.where(valid[j], 0.0, -np.inf)
        w = np.exp(lp)
        w /= w.sum()
        x = idx[j] * DS
        mean[j] = float((w * x).sum())
        sd[j] = float(np.sqrt(max((w * (x - mean[j]) ** 2).sum(), 0.0)))
        if j > 0:
            b = lse(trans(j) + bk[:, None], 0)
            mx = b.max()
            bk = b - mx if np.isfinite(mx) else np.where(valid[j - 1], 0.0, -np.inf)
    return mean, sd


def _window_max(a: np.ndarray, W: int):
    """best[i] = max(a[i-W .. i]), arg[i] = i - argmax position (the advance), exact, O(N log W)"""
    N = len(a)
    val, pos = a.copy(), np.arange(N)
    span = 1
    while span <= W:
        sh = min(span, W + 1 - span)
        if sh <= 0:
            break
        v2 = np.full(N, -np.inf); p2 = np.zeros(N, np.int64)
        v2[sh:] = val[:-sh]; p2[sh:] = pos[:-sh]
        u = v2 > val
        val = np.where(u, v2, val); pos = np.where(u, p2, pos)
        span += sh
    return val, (np.arange(N) - pos).astype(np.int32)
