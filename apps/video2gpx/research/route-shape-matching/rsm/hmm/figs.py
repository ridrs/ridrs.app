# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of the dense HMM. Map data (c) OpenStreetMap contributors, ODbL. GPS only as a thin grey reference line (and for the correctness colours)."""
from __future__ import annotations

import numpy as np

from rsm.track2 import fig as t2fig

ATTR = t2fig.ATTR
C_MAP, C_VID, C_PAIR = t2fig.C_MAP, t2fig.C_VID, t2fig.C_PAIR


def map_fig(video, g, rt, out, title, gps_xy=None, video_key=None, evidence_pts=None):
    """decided route on the OSM network (blue), GPS (thin grey, only if given), quantum dots: orange = map quantum without a match, purple = video quantum without a match,
    green = matched pair (joined)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from matplotlib.lines import Line2D

    m_un, v_un, pairs, cnt = t2fig.dots(rt, video_key or video)
    lo, hi = rt.xy.min(0) - 800, rt.xy.max(0) + 800
    if gps_xy is not None:
        lo = np.minimum(lo, gps_xy.min(0) - 800); hi = np.maximum(hi, gps_xy.max(0) + 800)
    fig, ax = plt.subplots(figsize=(11, 11))
    ax.add_collection(LineCollection(t2fig._net_lines(g, lo, hi), colors="#d9d9d9", linewidths=0.4, zorder=1))
    if gps_xy is not None:
        ax.plot(gps_xy[:, 0], gps_xy[:, 1], color="#8c8c8c", lw=0.8, zorder=2, label="GPS (thin reference line)")
    segs = [rt.xy[i:i + 2] for i in range(len(rt.t) - 1) if np.hypot(*(rt.xy[i + 1] - rt.xy[i])) < 400]
    ax.add_collection(LineCollection(segs, colors="#1f5fbf", linewidths=2.2, alpha=0.85, zorder=3))
    if len(m_un):
        ax.scatter(m_un[:, 0], m_un[:, 1], s=14, c=C_MAP, edgecolors="k", linewidths=0.3, zorder=7)
    if len(v_un):
        ax.scatter(v_un[:, 0], v_un[:, 1], s=14, c=C_VID, edgecolors="k", linewidths=0.3, zorder=8)
    for pm, pv, _ in pairs:
        ax.plot([pm[0], pv[0]], [pm[1], pv[1]], color=C_PAIR, lw=0.6, zorder=8)
        ax.scatter([pm[0], pv[0]], [pm[1], pv[1]], s=16, c=C_PAIR, edgecolors="k", linewidths=0.3, zorder=9)
    if evidence_pts:
        for name, xy in evidence_pts:
            ax.scatter([xy[0]], [xy[1]], marker="*", s=130, c="#d62728", edgecolors="k", linewidths=0.5, zorder=10)
            ax.annotate(name, xy, fontsize=7, xytext=(4, 4), textcoords="offset points", bbox=dict(fc="white", alpha=0.7, lw=0), zorder=11)
    h, _ = ax.get_legend_handles_labels()
    h += [Line2D([0], [0], color="#1f5fbf", lw=2.5, label="decided route (Viterbi path of the HMM)"),
          Line2D([0], [0], marker="o", color="w", markerfacecolor=C_MAP, markeredgecolor="k", ms=7, label=f"map quantum (route turn), no match ({len(m_un)})"),
          Line2D([0], [0], marker="o", color="w", markerfacecolor=C_VID, markeredgecolor="k", ms=7, label=f"video quantum (vms turn), no match ({len(v_un)})"),
          Line2D([0], [0], marker="o", color=C_PAIR, markerfacecolor=C_PAIR, markeredgecolor="k", ms=7, label=f"matched pair, map + video joined ({len(pairs)})")]
    ax.legend(handles=h, loc="upper center", bbox_to_anchor=(0.5, -0.09), ncol=2, fontsize=8, framealpha=0.9)
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_aspect("equal")
    ax.set_xlabel("UTM easting (m)"); ax.set_ylabel("northing (m)"); ax.set_title(title, fontsize=10)
    ax.text(0.995, 0.005, ATTR, transform=ax.transAxes, ha="right", va="bottom", fontsize=7, bbox=dict(fc="white", alpha=0.8, lw=0))
    fig.savefig(out, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return cnt


def confidence_fig(res: dict, out, tol=30.0, title=""):
    """posterior mass of the decoded directed edge over video time; red ticks where the route is more than `tol` m from the GPS, orange where its edge is not on the GPS path."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    c = res["conf"]
    fig, axs = plt.subplots(2, 1, figsize=(11, 5), sharex=True, gridspec_kw=dict(height_ratios=[3, 1]))
    axs[0].plot(c["t"], c["p"], color="#1f5fbf", lw=1)
    axs[0].set_ylabel("posterior of the decoded edge"); axs[0].set_ylim(-0.02, 1.02)
    axs[0].set_title(title, fontsize=9)
    ok30, onedge = c["within30"], c["on_edge"]
    axs[1].fill_between(c["t"], 0, 1, where=~ok30, color="#d62728", alpha=0.8, lw=0, step="mid", label=f"> {tol:.0f} m from the GPS")
    axs[1].fill_between(c["t"], 1, 2, where=~onedge, color="#ff8c00", alpha=0.9, lw=0, step="mid", label="edge not on the GPS path (+-40 s)")
    axs[1].set_ylim(0, 2); axs[1].set_yticks([0.5, 1.5]); axs[1].set_yticklabels(["30 m", "edge"]); axs[1].set_xlabel("video time (s)")
    axs[1].legend(fontsize=7, loc="upper right", ncol=2)
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)


def scale_fig(results: dict, f_ref: dict, out, f_grid, k_grid):
    """best-path log-likelihood per km against f_eff (one line per kappa) for each video; vertical lines: GPS reference f_eff."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    n = len(results)
    fig, axs = plt.subplots(1, n, figsize=(4.6 * n, 3.8), squeeze=False)
    cols = ["#4c78a8", "#f58518", "#54a24b", "#b279a2"]
    for ax, (name, r) in zip(axs[0], results.items()):
        S = r["scan"] / r["km"]
        for j, k in enumerate(k_grid):
            ax.plot(f_grid, S[:, j], "o-", color=cols[j % 4], ms=4, label=f"kappa {k}")
        if f_ref.get(name):
            ax.axvline(f_ref[name], color="k", ls="--", lw=1)
            ax.text(f_ref[name], ax.get_ylim()[0], " GPS/COLMAP ref", rotation=90, fontsize=7, va="bottom")
        ax.set_title(name, fontsize=9); ax.set_xlabel("f_eff (px at 360 rows)"); ax.set_xscale("log")
        ticks = [270, 340, 430, 540, 600]
        ax.set_xticks(ticks); ax.set_xticklabels([str(t) for t in ticks]); ax.xaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
    axs[0][0].set_ylabel("best-path log-likelihood per km")
    axs[0][0].legend(fontsize=7)
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)


def decoy_fig(ranks: dict, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    n = len(ranks)
    fig, axs = plt.subplots(n, 1, figsize=(9, 2.6 * n), squeeze=False, gridspec_kw=dict(hspace=0.9))
    colr = {"foreign": "#4c78a8", "shuffle": "#f58518", "mirror": "#54a24b", "foreign+shuffle": "#b279a2"}
    for ax, (name, (done, rk)) in zip(axs[:, 0], ranks.items()):
        for fam, c in colr.items():
            v = [x["per_km"] for k, x in done.items() if k != "real" and x["fam"] == fam]
            ax.scatter(v, np.random.default_rng(0).uniform(-0.3, 0.3, len(v)), s=26, c=c, label=fam, alpha=0.85)
        ax.axvline(done["real"]["per_km"], color="#d62728", lw=2)
        ax.set_yticks([]); ax.set_title(f"{name}: rank {rk['rank']} of {rk['n'] + 1}, p = {rk['p']:.2f}; real {rk['real']:.1f}, best decoy {rk['best_decoy']:.1f} ({rk['best_decoy_name']}) log-lik per km", fontsize=8)
    axs[-1, 0].set_xlabel("best-path log-likelihood per km, max over the (f_eff, kappa) grid (red: real)")
    axs[0, 0].legend(fontsize=7, ncol=4, loc="upper left")
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)
