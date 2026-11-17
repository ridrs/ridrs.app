# SPDX-License-Identifier: AGPL-3.0-or-later
"""One far-feature pair with its x^2 curvature, for the figure. vms venv (cv2) + matplotlib.

python -m rsm.angle.example <video> -> work/angle/figs/example_flow_<video>.png
"""
from __future__ import annotations

import pickle
import sys

import numpy as np

from . import farfeat, rotflow, videos


def main(name: str):
    import cv2
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    res = pickle.load(open(videos.WORK / f"a_{name}_base.pkl", "rb"))
    pool = farfeat.pool_f(res)
    f_hat = pool["f"]
    p = farfeat.Params(**{**res["params"], "k1_grid": tuple(res["params"]["k1_grid"])})
    fg = farfeat.f_grid(p)
    i_hat = int(np.argmin(np.abs(np.log(fg) - np.log(f_hat))))
    best = max(((abs(q["A"][i_hat, 0]), q, s) for s in res["stretches"] for q in s["pairs"] if q["n_inl"] >= 120), key=lambda r: r[0])
    q, s = best[1], best[2]
    v = videos.VIDEOS[name]
    info = farfeat.probe(str(v["video"]))
    H = p.height
    W = round(info["width"] * H / info["height"] / 2) * 2
    k = s["k"]
    frames = [fr for _, fr in farfeat.read_frames(str(v["video"]), info, H, q["ta"], (k + 1.5) / info["fps"])]
    mask, band_end = farfeat.make_mask(cv2, H, W, res["horizon"], p)
    q0, fl = farfeat.track_pair(cv2, mask, frames[0], frames[k], p, H / 360)
    x, y = q0[:, 0] - W / 2, q0[:, 1] - H / 2
    rng = np.random.default_rng(0)
    fit = rotflow.fit_pair(x, y, fl, fg, np.array([0.0]), 449.0, rng=rng, min_inl=p.min_inl)
    n = len(x)
    b = np.concatenate([fl[:, 0], fl[:, 1]])
    inl = fit.inl
    rows = np.concatenate([inl, inl])

    def solve(f):
        M = rotflow.design(x, y, f, 0.0)
        par, *_ = np.linalg.lstsq(M[rows], b[rows], rcond=None)
        return M, par

    M, par = solve(f_hat)
    A, B, C, e = par
    dx_adj = fl[:, 0] - (M[:n, 1:] @ par[1:])  # remove pitch, roll and expansion: what remains of dx is A (1 + x^2/f^2)
    # no-curvature alternative: constant + linear terms only (f -> infinity)
    M_inf = rotflow.design(x, y, 1e6, 0.0)
    p_inf, *_ = np.linalg.lstsq(M_inf[rows], b[rows], rcond=None)
    r_inf = b - M_inf @ p_inf
    r_hat = b - M @ par
    xs = np.linspace(x.min(), x.max(), 200)
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    ax[0].scatter(x[~inl], dx_adj[~inl], s=9, c="#b0b0b0", label=f"rejected ({(~inl).sum()}): parallax, near objects")
    ax[0].scatter(x[inl], dx_adj[inl], s=11, c="#1f77b4", label=f"far features ({inl.sum()})")
    ax[0].plot(xs, A * (1 + xs**2 / f_hat**2), c="#d62728", lw=2, label=f"A (1 + x²/f²), f = {f_hat:.0f} px")
    ax[0].plot(xs, np.full_like(xs, A), c="k", ls="--", lw=1.2, label="constant only (no curvature)")
    ax[0].set_xlabel("x from image centre (px at 360 rows)")
    ax[0].set_ylabel(f"horizontal flow over {k} frames (px),\nminus pitch, roll and expansion terms")
    ax[0].set_title(f"{name}: {q['ta']:.1f} s, yaw A = {A:.1f} px")
    ax[0].legend(fontsize=8, loc="upper center")
    chi = fit.chi2[:, 0]
    ax[1].plot(fg, chi - chi.min(), c="#1f77b4", label="this pair")
    tot = pool["chi2"][:, 0]
    ax[1].set_xscale("log"); ax[1].set_yscale("symlog", linthresh=10)
    ax[1].axvline(f_hat, c="#d62728", ls=":", label=f"pooled over the video: {f_hat:.0f}")
    ax[1].set_xlabel("f (px at 360 rows)"); ax[1].set_ylabel("chi² − min")
    ax[1].set_title(f"fit residual rms: {np.sqrt(np.mean(r_hat[rows]**2)):.2f} px with curvature, {np.sqrt(np.mean(r_inf[rows]**2)):.2f} px without")
    ax[1].legend(fontsize=8)
    fig.tight_layout()
    out = videos.WORK / "figs"
    out.mkdir(exist_ok=True)
    fig.savefig(out / f"example_flow_{name}.png", dpi=130)
    print("saved", out / f"example_flow_{name}.png", dict(A=A, f=f_hat, n_inl=int(inl.sum()), rms_with=float(np.sqrt(np.mean(r_hat[rows]**2))), rms_without=float(np.sqrt(np.mean(r_inf[rows]**2)))))


if __name__ == "__main__":
    main(sys.argv[1])
