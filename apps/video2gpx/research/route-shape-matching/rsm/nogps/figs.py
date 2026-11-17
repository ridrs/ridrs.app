# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of the no-GPS run. Map data (c) OpenStreetMap contributors, ODbL. No GPS, no video imagery."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter1d

from rsm.track import consensus as C
from rsm.track.fig import ATTR, C_MAP, C_PAIR, C_VID, _net_lines, dots

C_TUN, C_SIGN = "#d62728", "#0b7a75"


def map_fig(g, lead, anchors, evidence, out, title, t_range=None, cp=C.CParams(), label_pts=True):
    """decided route (blue = locally fitting, red = windowed cost above the threshold), anchors, quantum dots (3 colours), tunnel and sign evidence points.
    evidence: dict(tunnels=[(t0, t1, xy or None)], signs=[(t, text, xy or None)])"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from matplotlib.lines import Line2D

    sel = np.ones(len(lead.t), bool) if t_range is None else (lead.t >= t_range[0]) & (lead.t <= t_range[1])
    xy = lead.xy[sel]
    lo, hi = xy.min(0) - 600, xy.max(0) + 600
    m_un, v_un, pairs, cnt = dots(lead, "amalfi")
    inb = lambda p: (p[:, 0] > lo[0]) & (p[:, 0] < hi[0]) & (p[:, 1] > lo[1]) & (p[:, 1] < hi[1])
    lc = uniform_filter1d(lead.inc, cp.g_win, mode="nearest")
    bad = lc > cp.g_thr
    span = max(hi[0] - lo[0], hi[1] - lo[1])
    fig, ax = plt.subplots(figsize=(11, 11 * (hi[1] - lo[1]) / max(hi[0] - lo[0], 1) if (hi[1] - lo[1]) < (hi[0] - lo[0]) else 11))
    ax.add_collection(LineCollection(_net_lines(g, lo, hi), colors="#d0d0d0", linewidths=0.35, zorder=1))
    segs, cols = [], []
    idx = np.flatnonzero(sel)
    for i in idx[:-1]:
        if np.hypot(*(lead.xy[i + 1] - lead.xy[i])) > 400:
            continue
        segs.append(lead.xy[i:i + 2]); cols.append("#d62728" if bad[i] else "#1f5fbf")
    ax.add_collection(LineCollection(segs, colors=cols, linewidths=1.8, alpha=0.85, zorder=3))
    ms = 9 if span < 15000 else 5
    if len(m_un):
        k = inb(m_un); ax.scatter(m_un[k, 0], m_un[k, 1], s=ms * 1.6, c=C_MAP, edgecolors="k", linewidths=0.25, zorder=7)
    if len(v_un):
        k = inb(v_un); ax.scatter(v_un[k, 0], v_un[k, 1], s=ms * 1.6, c=C_VID, edgecolors="k", linewidths=0.25, zorder=8)
    npair = 0
    for pm, pv, _ in pairs:
        if inb(np.array([pm]))[0]:
            ax.plot([pm[0], pv[0]], [pm[1], pv[1]], color=C_PAIR, lw=0.6, zorder=8)
            ax.scatter([pm[0], pv[0]], [pm[1], pv[1]], s=ms * 1.8, c=C_PAIR, edgecolors="k", linewidths=0.25, zorder=9); npair += 1
    if anchors:
        at = np.array([a["xy"] for a in anchors]); k = inb(at)
        ax.scatter(at[k, 0], at[k, 1], marker="^", s=50, c="#111111", edgecolors="w", linewidths=0.6, zorder=10)
    for (t0, t1, p, nm) in evidence.get("tunnels", []):
        if p is not None and inb(np.array([p]))[0]:
            ax.scatter([p[0]], [p[1]], marker="s", s=70, c="none", edgecolors=C_TUN, linewidths=1.8, zorder=11)
            if label_pts:
                ax.annotate(f"{t0:.0f}s", p, fontsize=6, color=C_TUN, xytext=(3, 3), textcoords="offset points", zorder=12)
    for (t, txt, p) in evidence.get("signs", []):
        if p is not None and inb(np.array([p]))[0]:
            ax.scatter([p[0]], [p[1]], marker="*", s=170, c=C_SIGN, edgecolors="k", linewidths=0.6, zorder=12)
            ax.annotate(f"{txt} ({t:.0f}s)", p, fontsize=7, color=C_SIGN, xytext=(5, 5), textcoords="offset points", zorder=13, bbox=dict(fc="white", alpha=0.7, lw=0))
    h = [Line2D([0], [0], color="#1f5fbf", lw=2.5, label="decided route, locally fitting"), Line2D([0], [0], color="#d62728", lw=2.5, label="decided route, windowed cost above threshold"),
         Line2D([0], [0], marker="^", color="w", markerfacecolor="#111111", markeredgecolor="w", ms=9, label="anchors (plausibility decisions)"),
         Line2D([0], [0], marker="o", color="w", markerfacecolor=C_MAP, markeredgecolor="k", ms=7, label=f"map quantum (route turn), no match ({int(inb(m_un).sum()) if len(m_un) else 0})"),
         Line2D([0], [0], marker="o", color="w", markerfacecolor=C_VID, markeredgecolor="k", ms=7, label=f"video quantum (vms turn), no match ({int(inb(v_un).sum()) if len(v_un) else 0})"),
         Line2D([0], [0], marker="o", color=C_PAIR, markerfacecolor=C_PAIR, markeredgecolor="k", ms=7, label=f"matched pair, map + video joined ({npair})"),
         Line2D([0], [0], marker="s", color="w", markerfacecolor="none", markeredgecolor=C_TUN, ms=9, label="dark video interval (tunnel evidence), at the route position"),
         Line2D([0], [0], marker="*", color="w", markerfacecolor=C_SIGN, markeredgecolor="k", ms=12, label="legible sign (video time), at the route position")]
    ax.legend(handles=h, loc="upper center", bbox_to_anchor=(0.5, -0.05), ncol=2, fontsize=7.5, framealpha=0.9)
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_aspect("equal")
    ax.set_xlabel("easting (m, UTM)"); ax.set_ylabel("northing (m)"); ax.set_title(title, fontsize=10)
    ax.text(0.995, 0.005, ATTR, transform=ax.transAxes, ha="right", va="bottom", fontsize=7, bbox=dict(fc="white", alpha=0.8, lw=0))
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)
    return cnt


def cost_fig(res, out, title, tunnels=(), cp=C.CParams()):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 4.4))
    dec = res["routes"]; lead = res["decision"]["lead"]; top = set(res["decision"]["clusters"][0]["members"])
    lab = set()
    for grp, cols, a, nm in ((res.get("random_routes", []), "#c9a3a3", 0.35, "random anchors"), (res.get("mirror_routes", []), "#9a9a9a", 0.45, "mirrored video, true anchors")):
        for r in grp:
            y = uniform_filter1d(r.inc, 31, mode="nearest")
            ax.plot(r.t, y, color=cols, lw=0.7, alpha=a, label=None if nm in lab else nm); lab.add(nm)
    for i, r in enumerate(dec):
        y = uniform_filter1d(r.inc, 31, mode="nearest")
        nm = "anchors in the best cluster" if i in top else "anchors outside the best cluster"
        ax.plot(r.t, y, color="#1f5fbf" if i in top else "#e08a00", lw=0.8 if i != lead else 1.8, alpha=0.5 if i != lead else 1.0, label=None if nm in lab else nm); lab.add(nm)
    for (a, b) in tunnels:
        ax.axvspan(a, b, color="#f2b6b6", alpha=0.7, lw=0)
    ax.axhline(cp.g_thr, color="k", lw=0.6, ls=":")
    ax.set_ylim(0, 2.8); ax.set_xlabel("video time (s)"); ax.set_ylabel("step cost, 60 s moving mean")
    ax.set_title(title + "  (red bands: dark video intervals)", fontsize=9)
    ax.legend(fontsize=7, loc="upper right", ncol=2)
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)
