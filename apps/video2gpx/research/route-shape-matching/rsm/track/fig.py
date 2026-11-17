# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of the whole-video tracker. Map data (c) OpenStreetMap contributors, ODbL. GPS only as a thin grey reference line.

map_<video>.png    decided whole route on the OSM network (blue where the route fits the vms locally, red where it has broken down), GPS reference line,
                   anchors, quantum dots: orange = map quantum (turn of the decided route) without a match, purple = video quantum (vms turn) without a match,
                   green = matched pair (map and video dot joined by a thin line).
cost_<video>.png   windowed step cost over video time: tracks of true anchors against tracks of wrong anchors.
junction_<video>.png  one junction decision, zoomed.
"""
from __future__ import annotations

from dataclasses import replace

import numpy as np
from scipy.ndimage import gaussian_filter1d, uniform_filter1d

from rsm.odometry.turns import TurnParams, detect_turns
from rsm.quanta import video as qvideo

from . import consensus as C

ATTR = "© OpenStreetMap contributors, ODbL"
C_MAP, C_VID, C_PAIR = "#e08a00", "#7b3fb3", "#1a9850"
THR = 45.0
PAIR_M = 60.0


def route_turns(r, win: int, g_thr: float):
    """turns (>= 45 deg) of the route geometry: list of dict(s, xy, sign, t) plus arrays (s, t, xy) of the route resampled at 1 m."""
    xy = r.xy
    d = np.hypot(*np.diff(xy, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(d)])
    keep = np.concatenate([[True], np.diff(s) > 0.5])
    s, xy, t = s[keep], xy[keep], r.t[keep]
    sg = np.arange(0, s[-1], 1.0)
    x = gaussian_filter1d(np.interp(sg, s, xy[:, 0]), 3.0, mode="nearest"); y = gaussian_filter1d(np.interp(sg, s, xy[:, 1]), 3.0, mode="nearest")
    th = np.unwrap(np.arctan2(np.gradient(y), np.gradient(x)))
    tt = np.interp(sg, s, t)
    tr = detect_turns(sg, th, tt, TurnParams(min_angle_deg=THR))
    out = []
    for q in tr:
        sm = 0.5 * (q.s_start + q.s_end)
        i = min(int(sm), len(sg) - 1)
        out.append(dict(s=sm, xy=np.array([x[i], y[i]]), sign=q.sign, t=float(tt[i])))
    return out, sg, x, y, tt


def dots(r, video: str, win=15, g_thr=0.45):
    """-> map turns unmatched, video turns unmatched, pairs [(map xy, video xy)] on the route."""
    mt, sg, x, y, tt = route_turns(r, win, g_thr)
    segs = qvideo.segments(video, "refined")
    vt, _, _ = qvideo.video_turns(segs, THR)
    # video turn position on the route: route position at its mid time (route covers the vms steps; gaps interpolate)
    vpos = []
    for q in vt:
        tm = 0.5 * (q.t0 + q.t1)
        if tm < tt[0] or tm > tt[-1]:
            continue
        i = int(np.argmin(np.abs(tt - tm)))
        vpos.append(dict(s=float(sg[i]), xy=np.array([x[i], y[i]]), sign=q.sign, t=tm))
    used = set(); pairs = []
    for a in vpos:
        best = None
        for j, b in enumerate(mt):
            if j in used or b["sign"] != a["sign"]:
                continue
            ds = abs(b["s"] - a["s"])
            if ds <= PAIR_M and (best is None or ds < best[0]):
                best = (ds, j)
        if best:
            used.add(best[1]); pairs.append((mt[best[1]]["xy"], a["xy"], a))
    matched_v = {id(p[2]) for p in pairs}
    v_un = [a["xy"] for a in vpos if id(a) not in matched_v]
    m_un = [b["xy"] for j, b in enumerate(mt) if j not in used]
    return np.array(m_un).reshape(-1, 2), np.array(v_un).reshape(-1, 2), pairs, dict(n_map=len(mt), n_vid=len(vpos), n_pair=len(pairs))


def _net_lines(g, lo, hi):
    mid = np.array([g.geom(e)[len(g.geom(e)) // 2] for e in range(g.n_edges)])
    near = np.flatnonzero((mid[:, 0] > lo[0]) & (mid[:, 0] < hi[0]) & (mid[:, 1] > lo[1]) & (mid[:, 1] < hi[1]))
    return [g.geom(e) for e in near]


def map_fig(video, g, truth, lead, anchors_true, anchors_wrong, stitched, out, title, cp=C.CParams()):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from matplotlib.lines import Line2D

    m_un, v_un, pairs, cnt = dots(lead, video)
    lc = uniform_filter1d(lead.inc, cp.g_win, mode="nearest")
    bad = lc > cp.g_thr
    pts = np.vstack([lead.xy, truth.gc["x"][:, None].repeat(1, 1)[:0].reshape(0, 2) if False else lead.xy])
    lo, hi = lead.xy.min(0) - 800, lead.xy.max(0) + 800
    gx = np.column_stack([truth.gc["x"], truth.gc["y"]])
    lo = np.minimum(lo, gx.min(0) - 800); hi = np.maximum(hi, gx.max(0) + 800)
    fig, ax = plt.subplots(figsize=(11, 11))
    ax.add_collection(LineCollection(_net_lines(g, lo, hi), colors="#d9d9d9", linewidths=0.4, zorder=1))
    ax.plot(gx[:, 0], gx[:, 1], color="#8c8c8c", lw=0.8, zorder=2, label="GPS truth (thin reference line)")
    # decided route: blue (good) / red (broken down) segments
    segs, cols = [], []
    for i in range(len(lead.t) - 1):
        if np.hypot(*(lead.xy[i + 1] - lead.xy[i])) > 400:
            continue
        segs.append(lead.xy[i:i + 2]); cols.append("#d62728" if bad[i] else "#1f5fbf")
    ax.add_collection(LineCollection(segs, colors=cols, linewidths=2.2, alpha=0.85, zorder=3))
    if anchors_wrong:
        aw = np.array([a["xy"] for a in anchors_wrong])
        ax.scatter(aw[:, 0], aw[:, 1], marker="x", s=22, c="#555555", linewidths=0.8, zorder=5, label="wrong anchors (rank 2-5, control, random)")
    if anchors_true:
        at = np.array([a["xy"] for a in anchors_true])
        ax.scatter(at[:, 0], at[:, 1], marker="^", s=46, c="#111111", edgecolors="w", linewidths=0.6, zorder=6, label="anchors (plaus decisions)")
    if len(m_un):
        ax.scatter(m_un[:, 0], m_un[:, 1], s=14, c=C_MAP, edgecolors="k", linewidths=0.3, zorder=7)
    if len(v_un):
        ax.scatter(v_un[:, 0], v_un[:, 1], s=14, c=C_VID, edgecolors="k", linewidths=0.3, zorder=8)
    for pm, pv, _ in pairs:
        ax.plot([pm[0], pv[0]], [pm[1], pv[1]], color=C_PAIR, lw=0.6, zorder=8)
        ax.scatter([pm[0], pv[0]], [pm[1], pv[1]], s=16, c=C_PAIR, edgecolors="k", linewidths=0.3, zorder=9)
    h, _ = ax.get_legend_handles_labels()
    h += [Line2D([0], [0], color="#1f5fbf", lw=2.5, label="decided route, locally fitting"), Line2D([0], [0], color="#d62728", lw=2.5, label="decided route, broken down (windowed cost high)"),
          Line2D([0], [0], marker="o", color="w", markerfacecolor=C_MAP, markeredgecolor="k", ms=7, label=f"map quantum (route turn), no match ({len(m_un)})"),
          Line2D([0], [0], marker="o", color="w", markerfacecolor=C_VID, markeredgecolor="k", ms=7, label=f"video quantum (vms turn), no match ({len(v_un)})"),
          Line2D([0], [0], marker="o", color=C_PAIR, markerfacecolor=C_PAIR, markeredgecolor="k", ms=7, label=f"matched pair, map + video joined ({len(pairs)})")]
    ax.legend(handles=h, loc="upper center", bbox_to_anchor=(0.5, -0.05), ncol=2, fontsize=8, framealpha=0.9)
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_aspect("equal")
    ax.set_xlabel("UTM 31N easting (m)"); ax.set_ylabel("northing (m)"); ax.set_title(title, fontsize=10)
    ax.text(0.995, 0.005, ATTR, transform=ax.transAxes, ha="right", va="bottom", fontsize=7, bbox=dict(fc="white", alpha=0.8, lw=0))
    fig.savefig(out, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return cnt


def cost_fig(video, groups: dict, gaps, out, title, cp=C.CParams()):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(11, 4.2))
    lab = set()
    for name, col, a in (("rank25", "#9a9a9a", 0.35), ("random", "#c9a3a3", 0.35), ("dec", "#1f5fbf", 0.45)):
        for r in groups.get(name, {}).get("rows", []):
            rt = r["route"]
            y = uniform_filter1d(rt.inc, 31, mode="nearest")
            nm = {"dec": "true anchors (plaus decisions)", "rank25": "wrong anchors: stage-A rank 2-5", "random": "wrong anchors: random road position"}[name]
            ax.plot(rt.t, y, color=col, lw=0.8, alpha=a, label=None if nm in lab else nm); lab.add(nm)
            ax.plot([rt.anchor_t], [0.0], marker="v", color=col, ms=3, alpha=0.8)
    ax.axhline(cp.g_thr, color="k", lw=0.6, ls=":")
    ax.text(0.005, cp.g_thr + 0.03, "locally fitting below this line", fontsize=7, transform=ax.get_yaxis_transform())
    for (a, b) in gaps:
        if b - a > 8:
            ax.axvspan(a, b, color="#f0e0a0", alpha=0.5, lw=0)
    ax.set_ylim(0, 2.8); ax.set_xlabel("video time (s)"); ax.set_ylabel("step cost, 60 s moving mean")
    ax.set_title(title + "  (yellow: vms gaps > 8 s; triangles: anchors)", fontsize=9)
    ax.legend(fontsize=7, loc="upper right")
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)


def junction_fig(video, g, fw, truth, lead, sc, seq, rho0, out, title):
    """zoom on one junction decision of the lead route with >= 3 branches (preferred) that the route took correctly; alternatives dashed, with their turn angles
    against the turn angle that the vms measured over the same distance."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    cand = []
    for i in range(len(lead.t) - 1):
        e0, e1 = int(lead.E[i]), int(lead.E[i + 1])
        if e0 == e1 or lead.flag[i] or lead.flag[i + 1] or abs(lead.t[i + 1] - lead.t[i]) > 6:
            continue
        sc_ = fw.succ(e0)
        if len(sc_) < 2 or e1 not in set(sc_.tolist()):
            continue
        cand.append((len(sc_), i))
    ev = {round(t, 1): k for t, k in sc["junction_events"]} if sc.get("junction_events") else {}
    good = [c for c in cand if ev.get(round(float(lead.t[c[1] + 1]), 1)) == "ok"] or cand
    if not good:
        return False
    nb, i = sorted(good, key=lambda c: (-c[0], c[1]))[len(good) // 2 if False else 0]
    e0, e1 = int(lead.E[i]), int(lead.E[i + 1])
    node = fw.g.node_xy[int(fw.end[e0])]
    R = 260.0
    lo, hi = node - R, node + R
    fig, ax = plt.subplots(figsize=(8, 8))
    ax.add_collection(LineCollection(_net_lines(g, lo, hi), colors="#cccccc", linewidths=0.7, zorder=1))
    gx = np.column_stack([truth.gc["x"], truth.gc["y"]])
    ax.plot(gx[:, 0], gx[:, 1], color="#8c8c8c", lw=0.9, zorder=2, label="GPS truth (thin reference)")
    # vms heading change 25 m before .. 80 m after the junction time
    t_j = float(lead.t[i + 1])
    seg = None
    for sg in seq.segs:
        if sg.t[0] <= t_j <= sg.t[-1]:
            seg = sg
    h_in = fw.phi(e0, max(fw.L[e0] - 25, 0))
    txt = []
    if seg is not None:
        k = int(np.argmin(np.abs(seg.t - t_j)))
        k1 = min(k + 10, len(seg.t) - 1)
        d_vms = np.degrees(rho0 * (seg.th[k1] - seg.th[max(k - 3, 0)]))
        txt.append(f"vms heading change (rho0-scaled), 25 m before to 80 m after: {d_vms:+.0f} deg")
    cols = ["#e08a00", "#7b3fb3", "#1a9850", "#aa3377", "#00a0b0"]
    for j, x in enumerate(fw.succ(e0)):
        p = fw.g.geom(int(x))
        chosen = int(x) == e1
        ax.plot(p[:, 0], p[:, 1], color="#1f5fbf" if chosen else cols[j % len(cols)], lw=3.0 if chosen else 1.8, ls="-" if chosen else "--", alpha=0.9 if chosen else 0.9,
                zorder=4 if chosen else 3, label=None)
        h_out = fw.phi(int(x), min(80.0, fw.L[int(x)]))
        dt = np.degrees(((h_out - h_in) + np.pi) % (2 * np.pi) - np.pi)
        mid = p[min(len(p) - 1, len(p) // 2)]
        ax.annotate(f"{'chosen' if chosen else 'alternative'}: road turn {dt:+.0f} deg", mid, fontsize=8, color="#1f5fbf" if chosen else cols[j % len(cols)], zorder=9,
                    bbox=dict(fc="white", alpha=0.8, lw=0))
    p0 = fw.g.geom(e0)
    ax.plot(p0[:, 0], p0[:, 1], color="#1f5fbf", lw=3.0, zorder=4)
    ax.scatter([node[0]], [node[1]], s=60, c="k", zorder=10)
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_aspect("equal")
    ax.set_title(f"{title}\njunction at video t = {t_j:.0f} s with {nb} continuations; " + "; ".join(txt), fontsize=8)
    ax.text(0.995, 0.005, ATTR + "\nblue: route taken; dashed: alternatives; turn angles: left +", transform=ax.transAxes, ha="right", va="bottom", fontsize=7, bbox=dict(fc="white", alpha=0.8, lw=0))
    ax.legend(loc="upper left", fontsize=7)
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)
    return True
