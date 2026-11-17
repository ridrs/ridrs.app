# SPDX-License-Identifier: AGPL-3.0-or-later
"""Residuals of the vms heading increments against the map along a decoded path: post-decode angle-scale estimates and the noise model.
python -m rsm.hmm.resid <video> [b]"""
from __future__ import annotations

import pickle
import sys

import numpy as np

from . import exp, grid
from .grid import wrap


def along_path(G, st, cell_path, win: int = 1):
    c = np.asarray(cell_path)
    ok = (~np.isnan(st.dth))[1:] & (c[1:] >= 0) & (c[:-1] >= 0)
    dphi = wrap(G.phi[c[1:]] - G.phi[np.maximum(c[:-1], 0)])
    dth = st.dth[1:]
    if win > 1:
        k = np.ones(win)
        n = len(dth) // win * win
        dphi = np.array([wrap(dphi[i:i + win]).sum() for i in range(0, n, win)]); dth = np.nansum(dth[:n].reshape(-1, win), 1)
        ok = np.array([ok[i:i + win].all() for i in range(0, n, win)])
    return dphi[ok], dth[ok]


def scale_estimates(dphi, dth, min_deg=10.0):
    """a such that a * dth ~ dphi. ols: slope of dphi on dth (attenuated by noise in dth); rev: dphi^2 / (dphi dth) (inflated by noise in dphi); geo: sqrt(sum dphi^2 / sum dth^2);
    med: median ratio on steps with |dphi| > min_deg"""
    m = np.abs(dphi) > np.radians(min_deg)
    ols = float((dphi * dth).sum() / (dth ** 2).sum())
    rev = float((dphi ** 2).sum() / (dphi * dth).sum())
    geo = float(np.sqrt((dphi ** 2).sum() / (dth ** 2).sum()))
    med = float(np.median(dphi[m] / dth[m])) if m.sum() > 3 else float("nan")
    return dict(ols=ols, rev=rev, geo=geo, med=med, n=int(len(dphi)), n_turn=int(m.sum()))


if __name__ == "__main__":
    for v in (exp.VIDEOS if sys.argv[1] == "all" else [sys.argv[1]]):
        r = pickle.load(open(exp.WORK / "res" / f"vms_{exp.SHORT[v]}_b0.0.pkl", "rb"))
        g, truth = exp.load(v)
        G = grid.build(g, None, h=30.0)
        st = exp.vms_steps(v)
        for win in (1, 3):
            dphi, dth = along_path(G, st, r["route"].step_cell, win)
            e = scale_estimates(dphi, dth)
            print(exp.SHORT[v], "win", win, {k: (round(449 / x, 0) if k in ("ols", "rev", "geo", "med") else x) for k, x in e.items()}, "(f_eff)")
        dphi, dth = along_path(G, st, r["route"].step_cell, 1)
        for lo, hi in ((0, 5), (5, 15), (15, 30), (30, 60), (60, 180)):
            m = (np.abs(np.degrees(dphi)) >= lo) & (np.abs(np.degrees(dphi)) < hi)
            res = np.degrees(dth[m] * 0 + dphi[m] - dth[m] * 1.0)
            print(f"   |dphi| {lo}-{hi} deg: n {m.sum()}, mean dth/dphi {np.mean(np.degrees(dth[m])/np.maximum(np.degrees(dphi[m]),1e-9)*np.sign(np.degrees(dphi[m]))):.2f}, sd of dth {np.degrees(dth[m]).std():.1f}, sd of dphi {np.degrees(dphi[m]).std():.1f}, MAD(dphi - 1.0*dth) {1.4826*np.median(np.abs(res-np.median(res))):.1f}")


def speed_slope(G, st, cell_path, win_m: float = 320.0, v0: float = 3.0):
    """b of the speed-dependent distance scale, fitted on the model's own decoded route (no GPS): map arc / (kappa-free nominal length) of 320 m windows against the mean
    excess speed max(v - 3, 0). Returns dict(a, b_over_a, b, n): ratio = a (1 + (b/a) * excess)."""
    c = np.asarray(cell_path)
    ok = (c >= 0)
    xy = G.xy[np.maximum(c, 0)]
    seg = np.hypot(*np.diff(xy, axis=0).T)
    mu = st.mu[1:]
    good = ok[1:] & ok[:-1] & (~st.gap[1:])
    nw = int(win_m // st.d0)
    rat, ex = [], []
    for i in range(0, len(seg) - nw, nw):
        sl = slice(i, i + nw)
        if not good[sl].all():
            continue
        rat.append(seg[sl].sum() / mu[sl].sum()); ex.append(np.mean(np.maximum(st.v[1:][sl] - v0, 0.0)))
    rat, ex = np.array(rat), np.array(ex)
    if len(rat) < 8:
        return dict(a=np.nan, b_over_a=0.0, b=0.0, n=len(rat))
    keep = (rat > 0.5) & (rat < 2.0)
    A = np.polyfit(ex[keep], rat[keep], 1)
    return dict(a=float(A[1]), b_over_a=float(A[0] / A[1]), b=float(A[0] / A[1]), n=int(keep.sum()))
