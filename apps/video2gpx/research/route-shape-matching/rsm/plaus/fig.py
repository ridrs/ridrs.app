# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures: map path, vms route before / after correction, quanta dots. Map data (c) OpenStreetMap contributors, ODbL.

Dots (three colours): map quantum (turn) without a match = orange, video quantum (turn) without a match = purple, matched pair = green
(map dot and video dot joined by a thin line, numbered). GPS is drawn only as a thin reference line.
"""
from __future__ import annotations

import numpy as np

from . import decide as D
from . import fit as fitmod
from . import pipeline as P

ATTR = "© OpenStreetMap contributors, ODbL"
C_MAP, C_VID, C_PAIR = "#e08a00", "#7b3fb3", "#1a9850"


def raw_route(vw, mp, prior, f):
    mod = fitmod.Model(vw, mp, prior)
    x = f.x.copy()
    M = vw.M
    x[1] = 0.0  # kappa 1
    x[2] = 0.0  # rho 1
    x[3] = 0.0  # lambda 0
    x[4:4 + M - 1] = 0.0  # gaps nominal
    x[4 + M - 1 + M:] = 0.0  # no drift
    pts, _ = fitmod.dead_reckon(vw, mp, mod, x)
    return pts


def at_time(vw, route, t):
    return np.array([np.interp(t, vw.t, route[:, 0]), np.interp(t, vw.t, route[:, 1])])


def draw(src, rec, rank, setting, prior, title, out, ctx_pad=250.0):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    c = rec["cands"][rank]
    c = dict(c, fits={})
    lo = rec["lo"]
    vw, mp, anc = P.fit_cand(src, c, lo, rec["t1"] - rec["t0"], [setting], {setting: prior}, shuffle=(src.ctl == "shuffle"), with_route=True)
    f = c["fits"][setting]
    g = src.mctx.g
    raw = raw_route(vw, mp, prior, f)
    # window quanta: video turns
    q = src.q
    qs = range(lo, rec["hi"])
    tms = []  # (time, matched?, pair index)
    matched_q = {lo + qi: lg for qi, lg in c["legs"]}
    pair_events = {}
    for k in qs:
        for tt, which in ((q["tm1"][k], "A"), (q["tm2"][k], "B")):
            tms.append((float(tt), k, which))
    vt_unm, vt_m = [], []
    k_pair = {}
    for tt, k, which in tms:
        if vw.t[0] - 2 <= tt <= vw.t[-1] + 2:
            if k in matched_q:
                ev_id = int(src.ix.A[matched_q[k]] if which == "A" else src.ix.B[matched_q[k]])
                k_pair.setdefault(ev_id, tt)
            else:
                vt_unm.append(tt)
    # a video turn shared by two matched quanta is one dot
    ua, ub = f.stretch
    xy_all = np.vstack([mp.at(np.linspace(max(ua - 150, 0), min(ub + 150, mp.U), 60)), f.route, raw])
    lo_xy, hi_xy = xy_all.min(0) - ctx_pad, xy_all.max(0) + ctx_pad
    fig, ax = plt.subplots(figsize=(9, 9))
    # context roads
    mid = np.array([g.geom(e)[len(g.geom(e)) // 2] for e in range(g.n_edges)])
    near = np.flatnonzero((mid[:, 0] > lo_xy[0]) & (mid[:, 0] < hi_xy[0]) & (mid[:, 1] > lo_xy[1]) & (mid[:, 1] < hi_xy[1]))
    ax.add_collection(LineCollection([g.geom(e) for e in near], colors="#c8c8c8", linewidths=0.6, zorder=1))
    gc = src.ctx.gc
    kk = (gc["t"] >= vw.t[0]) & (gc["t"] <= vw.t[-1])
    if kk.any():
        ax.plot(gc["x"][kk], gc["y"][kk], color="black", lw=0.8, alpha=0.8, label="GPS truth (thin reference line)", zorder=3)
    ax.plot(mp.xy[:, 0], mp.xy[:, 1], color="#1f5fbf", lw=3.0, alpha=0.55, label="candidate map path", zorder=2)
    ax.plot(raw[:, 0], raw[:, 1], color="#d62728", lw=1.4, ls="--", label="vms route before correction (rho=1, kappa=1, no drift)", zorder=4)
    ax.plot(f.route[:, 0], f.route[:, 1], color="#009e73", lw=1.8, label=f"vms route after correction (rho={f.rho:.2f}, kappa={f.kappa:.2f})", zorder=5)
    # map quanta: events near the path
    ev_xy = src.ix.ev_mid
    d, _ = mp.tree.query(ev_xy)
    nearev = np.flatnonzero(d < 25.0)
    nearev = [e for e in nearev if lo_xy[0] < ev_xy[e, 0] < hi_xy[0] and lo_xy[1] < ev_xy[e, 1] < hi_xy[1]]
    matched_ids = set(k_pair)
    m_un = [e for e in nearev if e not in matched_ids]
    ax.scatter(ev_xy[m_un, 0], ev_xy[m_un, 1], s=38, c=C_MAP, edgecolors="k", linewidths=0.5, zorder=7, label="map quantum, no match")
    # unmatched video quanta, on the corrected and the raw route
    if vt_unm:
        pc = np.array([at_time(vw, f.route, t) for t in vt_unm]); pr = np.array([at_time(vw, raw, t) for t in vt_unm])
        ax.scatter(pc[:, 0], pc[:, 1], s=38, c=C_VID, edgecolors="k", linewidths=0.5, zorder=8, label="video quantum, no match")
        ax.scatter(pr[:, 0], pr[:, 1], s=26, c=C_VID, marker="s", edgecolors="k", linewidths=0.4, zorder=8)
    n = 0
    for ev_id, tt in sorted(k_pair.items(), key=lambda kv: kv[1]):
        n += 1
        pm = ev_xy[ev_id]; pv = at_time(vw, f.route, tt); pr = at_time(vw, raw, tt)
        ax.plot([pm[0], pv[0]], [pm[1], pv[1]], color=C_PAIR, lw=0.7, zorder=6)
        ax.scatter([pm[0], pv[0]], [pm[1], pv[1]], s=44, c=C_PAIR, edgecolors="k", linewidths=0.6, zorder=9, label="matched pair (map + video quantum)" if n == 1 else None)
        ax.scatter([pr[0]], [pr[1]], s=28, c=C_PAIR, marker="s", edgecolors="k", linewidths=0.5, zorder=9)
        ax.annotate(str(n), pm, textcoords="offset points", xytext=(4, 4), fontsize=8, zorder=10)
    ax.set_xlim(lo_xy[0], hi_xy[0]); ax.set_ylim(lo_xy[1], hi_xy[1]); ax.set_aspect("equal")
    ax.set_xlabel("UTM 31N easting (m)"); ax.set_ylabel("northing (m)")
    ax.set_title(title + f"\nsnorm={f.snorm:.3f}, rms={f.rms:.0f} m, Frechet={f.frechet:.0f} m, max dev={f.maxdev:.0f} m ({'correct' if c['correct'] else 'wrong'} by GPS)", fontsize=9)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.09), ncol=2, fontsize=7, framealpha=0.9)
    ax.text(0.995, 0.005, ATTR + "\ncircles: corrected route / map; squares: raw route", transform=ax.transAxes, ha="right", va="bottom", fontsize=7, bbox=dict(fc="white", alpha=0.8, lw=0))
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)
    return f


def pick_examples(recs, cal_s, st):
    """(accepted true, rejected wrong, wrongly accepted or the closest wrong accepted candidate) as (rec, rank)."""
    tau, m = cal_s[st]["tau"], cal_s[st]["m"]
    acc_true = rej_wrong = wrong_acc = None
    for r in recs:
        d = D.decide(r, st, tau, m)
        if d is not None and d[0]["correct"]:
            if acc_true is None or r["L"] > acc_true[0]["L"]:
                acc_true = (r, d[0]["rank"])
        if d is not None and not d[0]["correct"] and wrong_acc is None:
            wrong_acc = (r, d[0]["rank"])
        if rej_wrong is None or True:
            top = [(c["scoreA"], c, f) for c, f in D.fits_of(r, st) if not c["correct"] and f["snorm"] > tau]
            if top and r["L"] >= 10 and rej_wrong is None:
                top.sort(key=lambda x: -x[0])
                rej_wrong = (r, top[0][1]["rank"])
    if wrong_acc is None:  # no wrong decision: show the best wrong accepted candidate instead
        best = None
        for r in recs:
            for c, f in D.fits_of(r, st):
                if not c["correct"] and f["snorm"] <= tau and (best is None or f["snorm"] < best[2]):
                    best = (r, c["rank"], f["snorm"])
        wrong_acc = best[:2] if best else None
    return acc_true, rej_wrong, wrong_acc
