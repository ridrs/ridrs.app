# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of work/fable2: (f_eff, kappa) clouds with true / wrong candidates, the vote peak and the decoy peaks."""
from __future__ import annotations

import pickle

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Rectangle

from . import analyze, cfg, stage, vote

OUT = cfg.WORK / "figs"


def _panel(ax, P, title, decs, real_pk, ref=None, ref_label="", label_truth=True, wmin=0.0):
    ok = P[:, 5] < .5
    lf = P[:, 0] / P[:, 2]; kp = P[:, 3]
    w = vote.weights(P[:, 4])
    tr = (P[:, 7] > .5) & ok
    wr = (P[:, 7] < .5) & ok
    if not label_truth:
        ax.scatter(lf[ok], kp[ok], s=4 + 40 * w[ok], c="#888", alpha=.35, lw=0, label=f"fits (n={ok.sum()}; size ~ weight)")
    else:
        ax.scatter(lf[wr], kp[wr], s=4 + 40 * w[wr], c="#888", alpha=.35, lw=0, label=f"wrong (n={wr.sum()})")
        ax.scatter(lf[tr], kp[tr], s=8 + 40 * w[tr], c="#1b9e77", alpha=.9, lw=0, label=f"true (n={tr.sum()})")
    if decs:
        ax.scatter([d["f_eff"] for d in decs], [d["kappa"] for d in decs], marker="x", c="#d95f02", s=[20 + 6 * d["mass"] for d in decs], lw=1.2, label=f"decoy peaks (n={len(decs)})")
    ax.add_patch(Rectangle((real_pk["f_eff"] / 1.05, real_pk["kappa"] / 1.05), real_pk["f_eff"] * (1.05 - 1 / 1.05), real_pk["kappa"] * (1.05 - 1 / 1.05), fill=False, ec="k", lw=1.5))
    if ref:
        ax.axvline(ref, c="#7570b3", ls="--", lw=1, label=ref_label)
    ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlim(120, 2400); ax.set_ylim(0.3, 3.4)
    ax.set_xlabel("f_eff = F / rho (px)"); ax.set_ylabel("kappa")
    ax.set_title(title + f"\npeak mass {real_pk['mass']:.1f} at f {real_pk['f_eff']:.0f}, kappa {real_pk['kappa']:.2f}", fontsize=9)
    ax.legend(fontsize=6, loc="upper right"); ax.grid(alpha=.2, which="both")


def cloud_figs():
    OUT.mkdir(parents=True, exist_ok=True)
    for mode in ("stored", "f449", "pooled"):
        fig, axs = plt.subplots(2, 2, figsize=(11, 8.5)) if mode != "stored" else plt.subplots(1, 3, figsize=(15, 4.8))
        axs = np.atleast_1d(axs).ravel()
        for ax, v in zip(axs, cfg.VIDEOS if mode != "stored" else cfg.VIDEOS[:3]):
            ref = cfg.GPS_REF.get(v, cfg.AMALFI_COLMAP); rl = "GPS f_eff" if v in cfg.GPS_REF else "COLMAP f_eff"
            if mode == "stored":
                A = pickle.load(open(cfg.RES / f"stored_{v}.pkl", "rb"))["rows"][:, :8]
                _panel(ax, A, cfg.SHORT[v] + " - stored candidates (masked windows), unbounded refit", [], vote.peak(vote.select(A)), ref, rl)
            elif mode == "f449":
                P = stage.points(analyze.load_run(v, cfg.F_REF, "real", 0)["recs"])
                e = analyze.exp1(v)
                _panel(ax, P, cfg.SHORT[v] + " - F=449, all windows", e["decoys"], e["real"], ref, rl, label_truth=v != "amalfi")
            else:
                Fs = cfg.hypotheses(v)
                P = np.vstack([stage.points(analyze.load_run(v, F, "real", 0)["recs"]) for F in Fs])
                e = analyze.exp2(v)
                _panel(ax, P, cfg.SHORT[v] + f" - pooled over F={[int(f) for f in Fs]}", e["decoys"], e["real"], ref, rl, label_truth=v != "amalfi")
        fig.tight_layout()
        fig.savefig(OUT / f"cloud_{mode}.png", dpi=130)
        plt.close(fig)


if __name__ == "__main__":
    cloud_figs()
