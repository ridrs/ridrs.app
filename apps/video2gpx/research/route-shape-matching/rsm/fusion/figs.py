# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures: error against time, k(t) with band, anchor gating, error against anchor distance, Amalfi portal errors. python -m rsm.fusion.figs"""
from __future__ import annotations

import pickle

import numpy as np

from rsm.refine import load

from .posterior import RES, WORK

FIGS = WORK / "figs"
COL = {"viterbi": "#7f7f7f", "a_pm": "#e08a00", "old_segment": "#9467bd", "b_post": "#2ca02c", "c_ungated": "#d62728", "d_gated": "#1f5fbf"}
NAMES = {"viterbi": "Viterbi", "a_pm": "(a) posterior mean", "old_segment": "old per-segment", "b_post": "(b) fusion, posterior", "c_ungated": "(c) + ungated anchors", "d_gated": "(d) + gated anchors"}


def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


def G(n):
    return pickle.load(open(RES / f"gps_{n}.pkl", "rb"))


def fig_error_time():
    plt = _plt()
    fig, ax = plt.subplots(3, 1, figsize=(13, 10), sharey=True)
    for a, n in zip(ax, load.GPS_VIDEOS):
        r = G(n); t = r["tt"]
        for k in ("a_pm", "old_segment", "c_ungated", "d_gated"):
            a.plot(t, np.where(r["road"], r["err"][k], np.nan), color=COL[k], lw=0.7, label=NAMES[k], alpha=0.9)
        a.axhspan(-10, 10, color="#cccccc", alpha=0.25, lw=0)
        for x in r["d"]:
            a.plot([x.t], [-95], marker="|", color="k", ms=4, lw=0)
        for x in r["gate_rej"]:
            a.plot([x["anchor"].t], [-85], marker="|", color="#d62728", ms=4, lw=0)
        bad = ~r["road"]
        if bad.any():
            a.fill_between(t, -100, 100, where=bad, color="#d62728", alpha=0.08, lw=0)
        a.set_ylim(-100, 100); a.set_ylabel(f"{n}: along-track error (m)\n(+ = ahead of GPS)", fontsize=8); a.grid(alpha=0.3)
    ax[0].legend(ncol=4, fontsize=8, loc="upper right")
    ax[-1].set_xlabel("video time (s)   [black ticks: gated anchors used in (d); red ticks: rejected by the gate; red shading: wrong road, not scored]")
    fig.suptitle("Along-track error against GPS (lag corrected), development data", fontsize=10)
    fig.tight_layout(); fig.savefig(FIGS / "error_vs_time.png", dpi=110); plt.close(fig)


def fig_k():
    plt = _plt()
    fig, ax = plt.subplots(4, 1, figsize=(13, 11))
    names = list(load.GPS_VIDEOS) + ["Amalfi"]
    for a, n in zip(ax, names):
        r = G(n) if n != "Amalfi" else pickle.load(open(RES / "amalfi.pkl", "rb"))
        fd = r["fd"]; t = fd["t"]
        a.fill_between(t, fd["k"] - 2 * fd["k_sd"], fd["k"] + 2 * fd["k_sd"], color="#1f5fbf", alpha=0.25, lw=0, label="(d) k(t) +- 2 sd")
        a.plot(t, fd["k"], color="#1f5fbf", lw=0.9, label="(d) k(t) = kappa x rho")
        for sg in r["old_segs"]:
            if np.isfinite(sg.k) and sg.flag == "":
                a.plot([sg.t0, sg.t1], [sg.k, sg.k], color="#9467bd", lw=0.8, alpha=0.7)
        a.plot([], [], color="#9467bd", label="old per-segment k_i")
        a.axhline(r["kappa"], color="k", lw=0.6, ls="--", label="HMM kappa")
        lo, hi = np.percentile(fd["k"], [0.5, 99.5])
        a.set_ylim(min(lo, r["kappa"]) * 0.9, max(hi, r["kappa"]) * 1.1)
        a.set_ylabel(f"{n}\nk (map m per nominal m)", fontsize=8); a.grid(alpha=0.3)
    ax[0].legend(ncol=4, fontsize=8, loc="upper right"); ax[-1].set_xlabel("video time (s)")
    fig.suptitle("Distance factor k(t) of the fusion (state of the RTS smoother) against the old per-segment factors", fontsize=10)
    fig.tight_layout(); fig.savefig(FIGS / "k_of_t.png", dpi=110); plt.close(fig)


def fig_gating():
    plt = _plt()
    fig, ax = plt.subplots(4, 1, figsize=(13, 11))
    names = list(load.GPS_VIDEOS) + ["Amalfi"]
    from rsm.fusion import gate
    for a, n in zip(ax, names):
        r = G(n) if n != "Amalfi" else pickle.load(open(RES / "amalfi.pkl", "rb"))
        d = r["d"]; rej = r["gate_rej"]; mrej = r["merge_rej_d"]
        a.scatter([x.t for x in d], [x.sig_s for x in d], s=7, color="#1f5fbf", label=f"accepted ({len(d)}), sig_s from the gate")
        reasons = {"sigma": ("#d62728", "x"), "margin": ("#ff7f0e", "+"), "inlier": ("#8c564b", "v")}
        for why, (c, m) in reasons.items():
            xs = [x["anchor"].t for x in rej if x["reason"] == why]
            ys = [min(gate.sigma(x["feats"], gate.GateParams())[0], 100) if why == "sigma" else 100 for x in rej if x["reason"] == why]
            if xs:
                a.scatter(xs, ys, s=12, color=c, marker=m, label=f"gate-rejected: {why} ({len(xs)})")
        if mrej:
            a.scatter([x["anchor"].t for x in mrej], [x["anchor"].sig_s for x in mrej], s=22, facecolors="none", edgecolors="k", label=f"dropped by the merge ({len(mrej)})")
        a.set_yscale("log"); a.set_ylim(3, 120); a.set_ylabel(f"{n}\nsig_s (m)", fontsize=8); a.grid(alpha=0.3, which="both")
        a.legend(ncol=5, fontsize=7, loc="upper right")
    ax[-1].set_xlabel("video time (s)   [rejected: sigma/margin shown at the would-be sigma, capped at 100 m]")
    fig.suptitle("Anchor gating by yaw quality: accepted and rejected curve anchors over time (mapping fixed on the bikes, unchanged for Amalfi)", fontsize=10)
    fig.tight_layout(); fig.savefig(FIGS / "anchor_gating.png", dpi=110); plt.close(fig)


def fig_dist():
    plt = _plt()
    fig, ax = plt.subplots(1, 3, figsize=(14, 4), sharey=True)
    labels = ["0-50", "50-150", "150-300", ">300"]
    ks = ["viterbi", "a_pm", "old_segment", "b_post", "c_ungated", "d_gated"]
    for a, n in zip(ax, load.GPS_VIDEOS):
        r = G(n); e = r["err"]; dist = r["dist"]; road = r["road"]
        bins = [(0, 50), (50, 150), (150, 300), (300, 1e9)]
        w = 0.13
        for i, k in enumerate(ks):
            v = [np.abs(e[k][road & (dist >= lo) & (dist < hi)]).mean() if (road & (dist >= lo) & (dist < hi)).any() else np.nan for lo, hi in bins]
            a.bar(np.arange(4) + (i - 2.5) * w, v, w, color=COL[k], label=NAMES[k])
        a.set_xticks(range(4)); a.set_xticklabels(labels); a.set_title(n); a.set_xlabel("distance to nearest curve anchor (m)"); a.grid(alpha=0.3, axis="y")
    ax[0].set_ylabel("abs mean along-track error (m)"); ax[0].legend(fontsize=7)
    fig.tight_layout(); fig.savefig(FIGS / "error_vs_anchor_distance.png", dpi=110); plt.close(fig)


def fig_portals():
    plt = _plt()
    r = pickle.load(open(RES / "amalfi.pkl", "rb"))
    err = r["err"]; P = r["P"]
    ks = ["viterbi", "a_pm", "old_segment", "b_post", "c_ungated", "d_gated", "e_tunnels_LOO"]
    fig, ax = plt.subplots(figsize=(13, 4.5))
    w = 0.12
    for i, k in enumerate(ks):
        ax.bar(np.arange(len(P)) + (i - 3) * w, err[k], w, color=COL.get(k, "#17becf"), label=NAMES.get(k, "(e) + tunnel portals, leave-one-out"))
    ax.set_xticks(range(len(P))); ax.set_xticklabels([f"T{p['tunnel']}{p['portal'][0]}" for p in P], fontsize=7)
    ax.axhline(0, color="k", lw=0.5); ax.grid(alpha=0.3, axis="y"); ax.set_ylabel("along-track error at the portal (m)"); ax.legend(ncol=4, fontsize=7)
    ax.set_title("Amalfi, post hoc: error at the 18 tunnel portals (truth: luminance time + OSM portal arc)")
    fig.tight_layout(); fig.savefig(FIGS / "amalfi_portal_errors.png", dpi=110); plt.close(fig)


if __name__ == "__main__":
    FIGS.mkdir(parents=True, exist_ok=True)
    fig_error_time(); fig_k(); fig_gating(); fig_dist(); fig_portals()
