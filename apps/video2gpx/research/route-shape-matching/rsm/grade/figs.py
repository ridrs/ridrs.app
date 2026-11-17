# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of Experiment 2 from work/fable1/grade.json / grade_arrays.npz.  python -m rsm.grade.figs"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

OUT = Path(__file__).resolve().parents[2] / "work" / "fable1"
V = ("vallee-de-roanne", "col-de-rousset", "col-de-grimone-1")
COL = {"climb": "#c1440e", "flat": "#7a7a7a", "descent": "#1f6fb4"}


def main():
    d = json.loads((OUT / "grade.json").read_text()); a = np.load(OUT / "grade_arrays.npz")
    fig, ax = plt.subplots(1, 3, figsize=(13, 4.2), sharey=True)
    for k, v in enumerate(V):
        g, lv = a[f"{v}__g"] * 100, a[f"{v}__lv"]
        m = np.isfinite(lv)
        for name, sel in (("climb", g > 2), ("flat", np.abs(g) <= 2), ("descent", g < -2)):
            ax[k].scatter(g[m & sel], lv[m & sel], s=6, alpha=0.5, color=COL[name], label=f"{name} (n={int((m & sel).sum())})", lw=0)
        r = d[v]["windows"]["300"]["r_vms"]
        ax[k].set_title(f"{v}: Spearman r = {r:.2f}", fontsize=10); ax[k].set_xlabel("gradient over 300 m (%)")
        ax[k].legend(fontsize=7, frameon=False)
    ax[0].set_ylabel("mean log vms relative speed")
    fig.tight_layout(); fig.savefig(OUT / "fig_speed_gradient_scatter.png", dpi=130); plt.close(fig)

    fig, ax = plt.subplots(1, 3, figsize=(13, 3.8), sharey=True)
    for k, v in enumerate(V):
        sh, r = a[f"{v}__curve_shift"] / 1000, a[f"{v}__curve_r"]
        ax[k].plot(sh, r, color="#1f6fb4", lw=1.6)
        ax[k].axvline(0, color="#999", lw=0.8); ax[k].axvspan(-2, 2, color="#ddd", alpha=0.5, lw=0)
        nul = d[v]["windows"]["300"]["null"]
        ax[k].axhline(-nul["p95_abs"], color="#c1440e", ls="--", lw=1); ax[k].axhline(nul["p95_abs"], color="#c1440e", ls="--", lw=1, label="95 % of |r| at shifts >= 2 km")
        ax[k].set_title(v, fontsize=10); ax[k].set_xlabel("shift of the speed series along the route (km)")
        ax[k].legend(fontsize=7, frameon=False, loc="lower right")
    ax[0].set_ylabel("Spearman r (gradient 300 m)")
    fig.tight_layout(); fig.savefig(OUT / "fig_correlation_vs_shift.png", dpi=130); plt.close(fig)

    fig, ax = plt.subplots(figsize=(6.5, 3.8))
    for L, c in (("1000", "#bbbbbb"), ("2000", "#7a9cc6"), ("3000", "#3d6fa8"), ("5000", "#1b3f6e")):
        ys = [d["discrimination"][L][v]["share_rank1"] for v in V]
        ax.bar(np.arange(3) + (["1000", "2000", "3000", "5000"].index(L) - 1.5) * 0.2, ys, 0.19, color=c, label=f"{int(L)/1000:g} km stretches")
    ax.set_xticks(range(3)); ax.set_xticklabels(V, fontsize=8); ax.set_ylabel("share of stretches where the true gradient ranks 1 of 51")
    ax.axhline(1 / 51, color="#c1440e", ls="--", lw=1); ax.legend(fontsize=7, frameon=False); fig.tight_layout(); fig.savefig(OUT / "fig_gradient_discrimination.png", dpi=130); plt.close(fig)


if __name__ == "__main__":
    main()
