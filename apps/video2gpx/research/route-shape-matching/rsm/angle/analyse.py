# SPDX-License-Identifier: AGPL-3.0-or-later
"""Direct checks of the far-feature yaw: sum of A (px) per stretch against the GPS or COLMAP heading change over the same time (numpy only)."""
from __future__ import annotations

import numpy as np

from . import farfeat, refs


def stretch_A(res: dict, f_hat: float, k1: float = 0.0, min_pairs: int = 3):
    p = farfeat.Params(**{**res["params"], "k1_grid": tuple(res["params"]["k1_grid"])})
    fg, kg = farfeat.f_grid(p), np.array(p.k1_grid)
    i = int(np.argmin(np.abs(np.log(fg) - np.log(f_hat))))
    j = int(np.argmin(np.abs(kg - k1)))
    out = []
    for s in res["stretches"]:
        run = []
        for q in s["pairs"] + [None]:
            if q is not None and run and abs(q["ta"] - run[-1]["tb"]) < 1e-6:
                run.append(q)
                continue
            if len(run) >= min_pairs and all(np.isfinite(r["vms_yaw"]) for r in run):  # contiguous runs only: a missing pair would undercount both sums
                out.append(dict(t0=run[0]["ta"], t1=run[-1]["tb"], A=float(sum(r["A"][i, j] for r in run)), vms=float(sum(r["vms_yaw"] for r in run)), n=len(run)))
            run = [q] if q is not None else []
    return out


def f_direct(res: dict, f_hat: float, k1: float, theta_fn, n_boot: int = 400, seed: int = 3):
    """f_direct = slope of sum A (px) on the reference heading change (rad) over each stretch; theta_fn(t array) -> heading rad (reference).
    Also the same for the vms yaw (f_eff on exactly these stretches)."""
    S = stretch_A(res, f_hat, k1)
    X = np.array([theta_fn(np.array([s["t0"], s["t1"]]))[1] - theta_fn(np.array([s["t0"], s["t1"]]))[0] for s in S])
    Ya = np.array([s["A"] for s in S]); Yv = np.array([s["vms"] for s in S])
    fa, fv = refs.robust_slope(X, Ya), refs.robust_slope(X, Yv)
    rng = np.random.default_rng(seed)
    ba, bv = [], []
    for _ in range(n_boot):
        k = rng.integers(0, len(S), len(S))
        ba.append(refs.robust_slope(X[k], Ya[k])); bv.append(refs.robust_slope(X[k], Yv[k]))
    q = lambda b: (float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5)))
    return dict(f_direct_A=fa, A_ci=q(ba), f_eff_vms_same=fv, vms_ci=q(bv), n=len(S), net_deg=float(np.degrees(np.abs(X)).sum()), X=X, YA=Ya, YV=Yv)


def summarize(res: dict, fix_k: int | None = None, n_boot: int = 300) -> dict:
    """f_A (curvature, with bootstrap over stretches), g (vms yaw over far-feature yaw), f_eff_A = f_A * g with a joint bootstrap."""
    pool = farfeat.pool_f(res, fix_k=fix_k)
    if pool is None:
        return {}
    p = farfeat.Params(**{**res["params"], "k1_grid": tuple(res["params"]["k1_grid"])})
    fg, kg = farfeat.f_grid(p), np.array(p.k1_grid)
    S = [s for s in res["stretches"] if len(s["pairs"]) >= 3]
    tr = farfeat.transfer_ratio(res, pool["f"], pool["k1"], n_boot=10)
    # joint bootstrap over stretches: f_A from the resampled chi2 sum, g from the resampled pairs (A taken at the pooled f_A)
    rows = {r["si"]: r for r in tr["rows"]}
    keys = [i for i, s in enumerate(res["stretches"]) if len(s["pairs"]) >= 3]
    C = np.stack([res["stretches"][i]["chi2"] for i in keys])
    rng = np.random.default_rng(5)
    fe, fa, gg = [], [], []
    for _ in range(n_boot):
        pick = rng.integers(0, len(keys), len(keys))
        f = rotflow_argmin(C[pick].sum(0), fg, kg, fix_k)
        rs = [rows[keys[q]] for q in pick if keys[q] in rows]
        num = sum(float(np.nansum(r["vms"] * r["A"])) for r in rs)
        den = sum(float(np.nansum(np.where(np.isfinite(r["vms"]), r["A"] ** 2, 0.0))) for r in rs)
        g = num / den if den > 0 else np.nan
        fa.append(f); gg.append(g); fe.append(f * g)
    q = lambda b: (float(np.nanpercentile(b, 2.5)), float(np.nanpercentile(b, 97.5)))
    npairs = sum(len(res["stretches"][i]["pairs"]) for i in keys)
    return dict(f_A=pool["f"], f_A_ci=q(fa), k1=pool["k1"], g=tr["g"], g_ci=q(gg), f_eff_A=pool["f"] * tr["g"], f_eff_A_ci=q(fe),
                n_stretch=len(keys), n_pairs=int(npairs), n_try=int(sum(s["n_try"] for s in res["stretches"])), seconds=res.get("seconds"))


def rotflow_argmin(chi2, fg, kg, fix_k):
    from . import rotflow
    return rotflow.pooled_argmin(chi2, fg, kg, fix_k)[0]
