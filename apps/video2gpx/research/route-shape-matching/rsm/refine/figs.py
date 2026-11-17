# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of the refinement. Map data (c) OpenStreetMap contributors, ODbL. GPS only as scoring truth (thin grey line).
python -m rsm.refine.figs"""
from __future__ import annotations

import pickle

import numpy as np

from rsm.hmm import exp
from rsm.odometry.turns import TurnParams, detect_turns
from rsm.track2 import fig as t2fig

from . import analyse, evaluate, load

FIGS = load.WORK / "figs"
COL = {"viterbi": "#7f7f7f", "posterior_mean": "#e08a00", "step2": "#9467bd", "step2+3": "#1f5fbf"}
NAMES = {"viterbi": "baseline (Viterbi)", "posterior_mean": "posterior mean", "step2": "step 2 alone", "step2+3": "steps 2+3"}


def _plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


def load_all():
    return {n: pickle.load(open(load.RES / f"analysis_{n}.pkl", "rb")) for n in load.GPS_VIDEOS}


def fig_error_time(R):
    plt = _plt()
    fig, ax = plt.subplots(3, 1, figsize=(12, 9), sharey=True)
    for a, (n, r) in zip(ax, R.items()):
        t = r["tt"]
        bad = ~r["road"]
        for k in ("viterbi", "posterior_mean", "step2+3"):
            e = np.where(r["road"], r["err"][k], np.nan)
            a.plot(t, e, color=COL[k], lw=0.9 if k != "posterior_mean" else 0.6, alpha=1 if k != "posterior_mean" else 0.8, label=NAMES[k])
        a.axhspan(-10, 10, color="#cccccc", alpha=0.25, lw=0)
        for x in r["anchors"]:
            a.plot([x.t], [-95], marker="|", color="k", ms=4, lw=0)
        if bad.any():
            a.fill_between(t, -100, 100, where=bad, color="#d62728", alpha=0.10, lw=0, label="route not on the correct road (not scored)")
        a.set_ylim(-100, 100); a.set_ylabel(f"{n}: along-track error (m)\n(+ = ahead of GPS)", fontsize=8)
        a.grid(alpha=0.3)
    ax[0].legend(ncol=4, fontsize=8, loc="upper right")
    ax[-1].set_xlabel("video time (s)   [black ticks: accepted curve anchors; grey band +-10 m]")
    fig.suptitle("Along-track error against GPS (lag corrected), before (Viterbi) and after (steps 2+3). Development data.", fontsize=10)
    fig.tight_layout()
    fig.savefig(FIGS / "error_vs_time.png", dpi=120); plt.close(fig)


def fig_error_dist(R):
    plt = _plt()
    fig, ax = plt.subplots(1, 4, figsize=(15, 4), sharey=True)
    labels = ["0-50", "50-150", "150-300", ">300"]
    keys = [k for k in ("viterbi", "posterior_mean", "step2", "step2+3")]
    for a, (n, r) in zip(ax, list(R.items()) + [("all three", None)]):
        for i, k in enumerate(keys):
            if r is not None:
                v = [b["abs_mean"] for b in r["metrics"][k]["by_anchor_dist"]]; cnt = [b["n"] for b in r["metrics"][k]["by_anchor_dist"]]
            else:
                v, cnt = [], []
                for j in range(4):
                    e = np.concatenate([x["err"][k][x["road"]][(x["dist"][x["road"]] >= evaluate.BINS[j]) & (x["dist"][x["road"]] < evaluate.BINS[j + 1])] for x in R.values()])
                    v.append(np.abs(e).mean() if len(e) else np.nan); cnt.append(len(e))
            a.bar(np.arange(4) + 0.2 * (i - 1.5), v, 0.2, color=COL[k], label=NAMES[k])
        a.set_xticks(range(4)); a.set_xticklabels(labels); a.set_xlabel("distance to the nearest anchor (m of path)")
        a.set_title(n + (f" (n per bin {cnt})" if r is not None else ""), fontsize=8)
        a.grid(axis="y", alpha=0.3)
    ax[0].set_ylabel("mean |along-track error| (m)"); ax[0].legend(fontsize=8)
    fig.suptitle("Along-track error against distance to the nearest (accepted) curve anchor; correct-road samples only", fontsize=10)
    fig.tight_layout(); fig.savefig(FIGS / "error_vs_anchor_distance.png", dpi=120); plt.close(fig)


def fig_k_hist(R, amalfi=None):
    plt = _plt()
    names = list(R) + (["Amalfi"] if amalfi is not None else [])
    fig, ax = plt.subplots(1, len(names), figsize=(4.2 * len(names), 3.6))
    for a, n in zip(ax, names):
        if n == "Amalfi":
            kappa = amalfi["kappa"]; segs = amalfi["segs"]; raw = amalfi["raw_segs"]
        else:
            kappa = R[n]["kappa"]; segs = R[n]["segs"]; raw = R[n]["raw_segs"]
        k = np.array([s.k for s in segs if np.isfinite(s.k)]); kr = np.array([s.k for s in raw if np.isfinite(s.k)])
        hi = max(2.4 * kappa, np.nanpercentile(kr, 99)) if len(kr) else 2
        bins = np.linspace(0, hi, 50)
        a.hist(np.clip(kr, 0, hi), bins=bins, color="#cccccc", label="all consecutive pairs of the candidate anchors")
        a.hist(k, bins=bins, color="#1f5fbf", alpha=0.85, label="accepted segments (after merge)")
        a.axvline(kappa, color="#d62728", lw=1.2, label=f"global kappa {kappa:.2f}")
        a.axvspan(0.5 * kappa, 2 * kappa, color="#d62728", alpha=0.06)
        a.set_xlabel("k_i = L_map / L_vms"); a.set_title(f"{n}: median {np.median(k):.2f}, n {len(k)}", fontsize=9)
    ax[0].legend(fontsize=7); fig.tight_layout(); fig.savefig(FIGS / "k_histogram.png", dpi=120); plt.close(fig)


def fig_map_example(name="Roanne", min_len=300.0, rank="median"):
    """one straight before / after: GPS thin grey, route blue, quantum dots (orange map w/o match, purple video w/o match, green matched pair), anchors black diamonds,
    red ticks = error vectors (method position to GPS at the same video time, every 8 s)"""
    plt = _plt()
    from matplotlib.collections import LineCollection
    from matplotlib.lines import Line2D
    r = pickle.load(open(load.RES / f"analysis_{name}.pkl", "rb"))
    ctx = load.build_ctx(name)
    g, truth = exp.load(load.GPS_VIDEOS[name])
    acc = r["anchors"]; tt = r["tt"]
    cand = []
    for a, b in zip(acc[:-1], acc[1:]):
        if b.s - a.s < min_len:
            continue
        m = r["road"] & (tt >= a.t) & (tt <= b.t)
        if m.sum() < 20:
            continue
        gain = np.abs(r["err"]["viterbi"][m]).mean() - np.abs(r["err"]["step2+3"][m]).mean()
        cand.append((gain, a, b))
    cand.sort(key=lambda x: x[0])
    gain, a, b = cand[len(cand) // 2] if rank == "median" else cand[-1]
    s0, s1 = a.s - 150, b.s + 150
    sg = ctx.path.sg
    msk = (sg >= s0) & (sg <= s1)
    pxy = ctx.path.xy[msk]
    gm = (tt >= a.t - 15) & (tt <= b.t + 15)
    gps = truth.pos(np.arange(a.t - 15, b.t + 15, 1.0))
    lo = np.minimum(pxy.min(0), gps.min(0)) - 120; hi = np.maximum(pxy.max(0), gps.max(0)) + 120
    c = 0.5 * (lo + hi); half = np.maximum(0.5 * (hi - lo), 450.0); lo, hi = c - half, c + half
    # quanta: map turns on the path, video turns (apex positions at baseline / refined)
    mt = [t for t in analyse.map_turns(ctx) if s0 <= 0.5 * (t.s_start + t.s_end) <= s1]
    mxy = np.array([ctx.path.xy_at(0.5 * (t.s_start + t.s_end)) [0] for t in mt]) if mt else np.zeros((0, 2))
    vt = [d for d in r["src_last"] if "t" in d and s0 <= d["s_h"] <= s1]
    kept = {round(x.t, 3): x for x in acc}
    fig, axs = plt.subplots(1, 2, figsize=(14, 7.5))
    for ax, which in zip(axs, ("before", "after")):
        ax.add_collection(LineCollection(t2fig._net_lines(g, lo, hi), colors="#d9d9d9", linewidths=0.5, zorder=1))
        ax.plot(gps[:, 0], gps[:, 1], color="#8c8c8c", lw=0.8, zorder=2)
        ax.plot(pxy[:, 0], pxy[:, 1], color="#1f5fbf", lw=2.0, alpha=0.8, zorder=3)
        # position error vectors
        te = np.arange(np.ceil(a.t), b.t, 8.0)
        key = "viterbi" if which == "before" else "step2+3"
        sm = {"before": ctx.s_baseline(te), "after": None}[which]
        if which == "after":
            from . import segment
            sm, _ = segment.position(te, acc, ctx.D, ctx.gapfrac, ctx.kappa, ctx.path.sg[-1])
        mpos = ctx.path.xy_at(sm); gpos = truth.pos(te)
        for p, q in zip(mpos, gpos):
            ax.plot([p[0], q[0]], [p[1], q[1]], color="#d62728", lw=1.0, zorder=5)
        ax.scatter(mpos[:, 0], mpos[:, 1], s=14, marker="o", c="#1f5fbf", edgecolors="k", linewidths=0.3, zorder=6)
        used = set(); pairs = []; v_un = []
        for d in vt:
            x = kept.get(round(d["t"], 3))
            s_v = d["s_h"] + (d["delta"] if (which == "after" and x is not None) else 0.0)
            vxy = ctx.path.xy_at([s_v])[0]
            if x is not None and mt:
                j = int(np.argmin([abs(0.5 * (t.s_start + t.s_end) - x.s) for t in mt]))
                if abs(0.5 * (mt[j].s_start + mt[j].s_end) - x.s) <= 60 and j not in used:
                    used.add(j); pairs.append((mxy[j], vxy)); continue
            v_un.append(vxy)
        m_un = np.array([mxy[j] for j in range(len(mt)) if j not in used]).reshape(-1, 2)
        v_un = np.array(v_un).reshape(-1, 2)
        if len(m_un):
            ax.scatter(m_un[:, 0], m_un[:, 1], s=40, c=t2fig.C_MAP, edgecolors="k", linewidths=0.4, zorder=7)
        if len(v_un):
            ax.scatter(v_un[:, 0], v_un[:, 1], s=40, c=t2fig.C_VID, edgecolors="k", linewidths=0.4, zorder=8)
        for pm, pv in pairs:
            ax.plot([pm[0], pv[0]], [pm[1], pv[1]], color=t2fig.C_PAIR, lw=1.2, zorder=8)
            ax.scatter([pm[0], pv[0]], [pm[1], pv[1]], s=40, c=t2fig.C_PAIR, edgecolors="k", linewidths=0.4, zorder=9)
        for x in (a, b):
            ax.scatter(*ctx.path.xy_at([x.s])[0], marker="D", s=70, c="white", edgecolors="k", linewidths=1.4, zorder=10)
        ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_aspect("equal")
        e = np.abs(sm - np.interp(te, tt, r["s_gps"]))
        ax.set_title(f"{name}: {which}  (mean |along-track error| at the 8 s samples {e.mean():.1f} m)", fontsize=9)
        ax.text(0.995, 0.005, t2fig.ATTR, transform=ax.transAxes, ha="right", va="bottom", fontsize=7, bbox=dict(fc="white", alpha=0.8, lw=0))
        ax.set_xticks([]); ax.set_yticks([])
    h = [Line2D([0], [0], color="#8c8c8c", lw=1, label="GPS (thin reference line, scoring only)"), Line2D([0], [0], color="#1f5fbf", lw=2, label="decoded route"),
         Line2D([0], [0], marker="o", color="w", markerfacecolor="#1f5fbf", markeredgecolor="k", ms=6, label="method position every 8 s"),
         Line2D([0], [0], color="#d62728", lw=1, label="error vector to GPS at the same video time"),
         Line2D([0], [0], marker="o", color="w", markerfacecolor=t2fig.C_MAP, markeredgecolor="k", ms=8, label="map quantum, no match"),
         Line2D([0], [0], marker="o", color="w", markerfacecolor=t2fig.C_VID, markeredgecolor="k", ms=8, label="video quantum, no match"),
         Line2D([0], [0], marker="o", color=t2fig.C_PAIR, markerfacecolor=t2fig.C_PAIR, markeredgecolor="k", ms=8, label="matched pair (map + video joined)"),
         Line2D([0], [0], marker="D", color="w", markerfacecolor="white", markeredgecolor="k", ms=8, label="anchors bounding the straight")]
    fig.legend(handles=h, loc="lower center", ncol=4, fontsize=8, framealpha=0.9)
    fig.suptitle(f"One straight between two curve anchors ({b.s - a.s:.0f} m of path, k = {(b.s - a.s) / (ctx.D(b.t) - ctx.D(a.t)):.2f} against global kappa {ctx.kappa:.2f}); "
                 f"{'median' if rank == 'median' else 'largest'} gain among {len(cand)} straights of 300 m or more (gain {gain:.1f} m)", fontsize=9)
    fig.tight_layout(rect=(0, 0.08, 1, 0.95))
    fig.savefig(FIGS / f"map_straight_{name}.png", dpi=120); plt.close(fig)
    return dict(name=name, t0=a.t, t1=b.t, length=b.s - a.s, gain=float(gain), n_candidates=len(cand))


def main():
    R = load_all()
    fig_error_time(R); fig_error_dist(R)
    info = [fig_map_example(n) for n in ("Roanne", "Grimone")]  # before load.build_ctx('Amalfi'): that call installs the Amalfi vms config
    am = pickle.load(open(load.RES / "analysis_Amalfi.pkl", "rb"))
    ctx = load.build_ctx("Amalfi")
    from . import segment
    segs = segment.segments(am["acc"], ctx.D, ctx.gapfrac, ctx.kappa)
    raw = segment.segments(sorted(am["cand"], key=lambda a: a.t), ctx.D, ctx.gapfrac, ctx.kappa)
    fig_k_hist(R, dict(kappa=ctx.kappa, segs=segs, raw_segs=raw))
    print(info)


if __name__ == "__main__":
    main()
