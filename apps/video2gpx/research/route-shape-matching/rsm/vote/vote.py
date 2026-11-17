# SPDX-License-Identifier: AGPL-3.0-or-later
"""The vote: weighted 2-D histogram of (log f_eff, log kappa) over all fitted candidates of a video.

f_eff = F / rho (F = the f360 the vms heading was integrated with; rho = fitted angle scale). Points at a bound of the fit and failed fits are
excluded (a bound is not an estimate). Weight w = exp(-snorm / TAU) with TAU = the frozen plaus acceptance threshold of the normalised cost (0.1207).
Decision statistic: the largest weight mass inside a box of +-5 % in f_eff and +-5 % in kappa (primary), and the peak of a Gaussian kernel density
(sigma 5 %) as the second statistic. Chosen before the decoy numbers existed; not tuned.
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter, uniform_filter

TAU = 0.12073349670766514
BIN = 0.01  # log units
HALF = 5  # +-5 bins = +-5 %
LF = (np.log(120.0), np.log(2400.0))
LK = (np.log(0.3), np.log(3.4))


def weights(snorm, tau=TAU):
    return np.exp(-np.asarray(snorm, float) / tau)


def select(P: np.ndarray, per_window_top: int | None = None) -> np.ndarray:
    """P = stage.points(): columns F, rank, rho, kappa, snorm, atbound, nm, correct. -> rows that vote (not at a bound)"""
    return P[P[:, 5] < 0.5]


def coords(P):
    return np.log(P[:, 0] / P[:, 2]), np.log(P[:, 3])


def hist(P: np.ndarray, w: np.ndarray | None = None):
    lf, lk = coords(P)
    w = weights(P[:, 4]) if w is None else w
    nf = int(round((LF[1] - LF[0]) / BIN)); nk = int(round((LK[1] - LK[0]) / BIN))
    H, _, _ = np.histogram2d(lf, lk, bins=[nf, nk], range=[LF, LK], weights=w)
    return H


def peak(P: np.ndarray, w: np.ndarray | None = None) -> dict:
    """strongest box (+-5 %) and strongest kernel peak. -> dict(mass, f_eff, kappa, kde, kde_f, kde_kappa, n_votes, total)"""
    if len(P) == 0:
        return dict(mass=0.0, f_eff=np.nan, kappa=np.nan, kde=0.0, kde_f=np.nan, kde_kappa=np.nan, n_votes=0, total=0.0)
    H = hist(P, w)
    B = uniform_filter(H, size=2 * HALF + 1, mode="constant") * (2 * HALF + 1) ** 2
    i, j = np.unravel_index(np.argmax(B), B.shape)
    K = gaussian_filter(H, sigma=HALF, mode="constant")
    a, b = np.unravel_index(np.argmax(K), K.shape)
    c = lambda i, j: (float(np.exp(LF[0] + (i + 0.5) * BIN)), float(np.exp(LK[0] + (j + 0.5) * BIN)))
    return dict(mass=float(B[i, j]), f_eff=c(i, j)[0], kappa=c(i, j)[1], kde=float(K[a, b]) / BIN ** 2, kde_f=c(a, b)[0], kde_kappa=c(a, b)[1],
                n_votes=int(len(P)), total=float(H.sum()))


def top_per_window(recs_pts: np.ndarray, keys: np.ndarray, n: int) -> np.ndarray:
    """variant: only the n lowest-cost candidates per window vote. keys = window id per row."""
    keep = np.zeros(len(recs_pts), bool)
    for k in np.unique(keys):
        idx = np.flatnonzero(keys == k)
        keep[idx[np.argsort(recs_pts[idx, 4])[:n]]] = True
    return recs_pts[keep]


def with_windows(recs) -> tuple[np.ndarray, np.ndarray]:
    """like stage.points() plus a window id per row (L, lo)"""
    from .stage import points
    P, ids = [], []
    for k, r in enumerate(recs):
        p = points([r])
        P.append(p); ids += [k] * len(p)
    return (np.vstack(P) if P else np.zeros((0, 8))), np.array(ids)


def points_tl(recs) -> np.ndarray:
    """stage.points() rows plus two columns: window start time (s) and window length L (quanta)"""
    from .stage import points
    out = []
    for r in recs:
        p = points([r])
        if len(p):
            out.append(np.column_stack([p, np.full(len(p), r["t0"]), np.full(len(p), r["L"])]))
    return np.vstack(out) if out else np.zeros((0, 10))


def variants(P: np.ndarray, bin_s: float = 300.0) -> dict:
    """POST HOC variants of the decision statistic (P = select(points_tl)): purity, independent time support, best-candidate-only mass.
    Each is evaluated at the peak box of its own histogram (the box is not re-optimised for the support)."""
    if len(P) == 0:
        return dict(purity=0.0, bins=0, mass_top1=0.0)
    base = peak(P)
    out = dict(purity=base["mass"] / base["total"] if base["total"] > 0 else 0.0)
    lf, lk = coords(P)
    inbox = (np.abs(lf - np.log(base["f_eff"])) < np.log(1.055)) & (np.abs(lk - np.log(base["kappa"])) < np.log(1.055))
    w = weights(P[:, 4])
    sel = inbox & (w >= 0.3)
    out["bins"] = int(len(set((P[sel, 8] // bin_s).astype(int))))
    key = P[:, 8] * 100 + P[:, 9]  # window id (start time, L)
    keep = np.zeros(len(P), bool)
    for k in np.unique(key):
        idx = np.flatnonzero(key == k)
        keep[idx[np.argmin(P[idx, 4])]] = True
    out["mass_top1"] = peak(P[keep])["mass"]
    return out
